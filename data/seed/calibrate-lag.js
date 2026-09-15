'use strict';

/**
 * Calibrate Singapore lead → AU retail lag per state using ~180d of published
 * history (live window + monthly archives). Writes docs/v1/lag-calib.json and
 * merges trusted lags into lead.json lagDays.byState.
 *
 * Usage:
 *   node data/seed/calibrate-lag.js
 *   node data/seed/calibrate-lag.js --dry-run
 *   node data/seed/calibrate-lag.js --window 180
 */

const fs = require('fs');
const path = require('path');
const { STATES } = require('../lib/states');
const { isoToDayNum, dayNumToISO } = require('../lib/cyclefit');
const lagCalib = require('../lib/lagCalib');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = process.env.DOCS_DIR || path.join(ROOT, 'docs');
const LEAD_PATH = process.env.LEAD_PATH || path.join(DOCS, 'v1', 'lead.json');
const OUT_PATH = process.env.LAG_CALIB_PATH || path.join(DOCS, 'v1', 'lag-calib.json');
const EMBED_PATH =
  process.env.LEAD_EMBED_PATH || path.join(ROOT, 'viewer', 'lead-data.js');
const DRY = process.argv.includes('--dry-run');
const SKIP_EMBED = process.argv.includes('--no-embed');

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

const WINDOW_DAYS = argNum('--window', 180);
const FUEL = 'U91';
const LEAD_KEY = 'mogas95';

function loadJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeLeadEmbed(lead) {
  const body = `window.LEAD_DATA=${JSON.stringify(lead)};\n`;
  fs.writeFileSync(EMBED_PATH, body);
}

/** Expand scoped fuel series (tenths) to [{date, avg}] in c/L. */
function expandScopeSeries(file, scope, fuel) {
  const fuels = file.scopes?.[scope] || (scope === (file.defaultScope || file.granularity) ? file.fuels : null);
  const s = fuels?.[fuel];
  if (!file.start || !s?.avg?.length) return [];
  const start = isoToDayNum(file.start);
  const out = [];
  for (let i = 0; i < s.avg.length; i++) {
    const v = s.avg[i];
    if (v == null || !Number.isFinite(Number(v))) continue;
    out.push({ date: dayNumToISO(start + i), avg: Number(v) / 10 });
  }
  return out;
}

function pickScope(file) {
  for (const sc of ['metro', 'state', 'regional']) {
    if (expandScopeSeries(file, sc, FUEL).length >= 40) return sc;
  }
  return file.defaultScope || file.granularity || 'metro';
}

function mergeArchiveDays(docsDir, state, fuel, dayMap) {
  const now = new Date();
  for (let m = 0; m < 14; m++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const p = path.join(docsDir, 'v1', 'archive', `${month}.json`);
    const arch = loadJson(p);
    const days = arch?.states?.[state]?.[fuel];
    if (!days || typeof days !== 'object') continue;
    for (const [iso, row] of Object.entries(days)) {
      const avg = row?.avg;
      if (avg == null || !Number.isFinite(Number(avg))) continue;
      if (!dayMap.has(iso)) dayMap.set(iso, Number(avg) / 10);
    }
  }
}

function retailSeriesForState(docsDir, state, windowDays) {
  const file = loadJson(path.join(docsDir, 'v1', `${state}.json`));
  if (!file) return { series: [], scope: null };
  const scope = pickScope(file);
  const dayMap = new Map();
  mergeArchiveDays(docsDir, state, FUEL, dayMap);
  for (const p of expandScopeSeries(file, scope, FUEL)) {
    dayMap.set(p.date, p.avg);
  }
  const all = [...dayMap.entries()]
    .map(([date, avg]) => ({ date, avg }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const sliced = all.slice(Math.max(0, all.length - windowDays));
  return { series: sliced, scope };
}

function leadDaysFromFile(lead) {
  return (lead?.days || [])
    .filter((d) => d?.[LEAD_KEY] != null && Number.isFinite(Number(d[LEAD_KEY])))
    .map((d) => ({ date: d.date, value: Number(d[LEAD_KEY]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function main() {
  const lead = loadJson(LEAD_PATH);
  if (!lead?.days?.length) {
    console.error('No lead.json days at', LEAD_PATH);
    process.exit(1);
  }
  const leadDays = leadDaysFromFile(lead);
  const leadByDate = new Map(leadDays.map((d) => [d.date, d.value]));
  const cfg = {
    min: lead.lagDays?.min ?? lagCalib.DEFAULT_LAG.min,
    max: lead.lagDays?.max ?? lagCalib.DEFAULT_LAG.max,
  };

  const byState = {};
  const lagByState = {
    ...(lagCalib.DEFAULT_LAG.byState || {}),
    ...(lead.lagDays?.byState || {}),
  };

  for (const state of STATES) {
    const { series, scope } = retailSeriesForState(DOCS, state, WINDOW_DAYS);
    const pairs = [];
    for (const p of series) {
      const lv = leadByDate.get(p.date);
      if (lv == null) continue;
      pairs.push({ date: p.date, lead: lv, avg: p.avg });
    }
    const hit = lagCalib.calibrateFromPairs(pairs, cfg);
    if (!hit) {
      console.log(`${state}: no calib (pairs=${pairs.length} scope=${scope})`);
      continue;
    }
    byState[state] = {
      lag: hit.lag,
      corr: hit.corr,
      n: hit.n,
      soft: hit.soft,
      source: hit.source,
      scope,
      fuel: FUEL,
      leadKey: LEAD_KEY,
      turns: hit.turns,
    };
    if (!hit.soft) lagByState[state] = hit.lag;
    console.log(
      `${state}: lag=${hit.lag}d r=${hit.corr} n=${hit.n} ${hit.source}${hit.soft ? ' soft' : ''} scope=${scope} pairs=${pairs.length}`
    );
  }

  const payload = {
    source: 'lead.json vs published state means (metro preferred)',
    updated: new Date().toISOString().slice(0, 10),
    windowDays: WINDOW_DAYS,
    fuel: FUEL,
    leadKey: LEAD_KEY,
    lagDays: {
      default: lead.lagDays?.default ?? lagCalib.DEFAULT_LAG.default,
      min: cfg.min,
      max: cfg.max,
      byState: lagByState,
    },
    byState,
    generated: new Date().toISOString(),
  };

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log('Wrote', OUT_PATH);

  lead.lagDays = {
    default: payload.lagDays.default,
    min: payload.lagDays.min,
    max: payload.lagDays.max,
    byState: lagByState,
  };
  lead.lagCalibUpdated = payload.generated;
  fs.writeFileSync(LEAD_PATH, JSON.stringify(lead, null, 2) + '\n');
  console.log('Updated lagDays in', LEAD_PATH);

  if (!SKIP_EMBED) {
    writeLeadEmbed(lead);
    console.log('Wrote', EMBED_PATH);
  }
}

main();
