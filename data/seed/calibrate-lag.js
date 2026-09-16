'use strict';

/**
 * Calibrate Singapore lead → AU retail lag for every state × scope × fuel
 * with enough live history. Writes docs/v1/lag-calib.json and merges trusted
 * preferred lags into lead.json lagDays.byState (metro/U91 when available).
 *
 * Archives are not mixed in (unscoped grain). Live scoped series only.
 *
 * Usage:
 *   node data/seed/calibrate-lag.js
 *   node data/seed/calibrate-lag.js --dry-run
 *   node data/seed/calibrate-lag.js --window 180
 */

const fs = require('fs');
const path = require('path');
const { STATES } = require('../lib/states');
const { FUELS } = require('../lib/fuels');
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

const SCOPES = ['metro', 'state', 'regional'];
/** Fuels with a Singapore lead series (LPG has none). */
const CALIB_FUELS = FUELS.filter((f) => f !== 'LPG');

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

const WINDOW_DAYS = argNum('--window', 180);

function leadKeyForFuel(fuel) {
  return fuel === 'DSL' || fuel === 'PDSL' ? 'gasoil' : 'mogas95';
}

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
  const fuels =
    file.scopes?.[scope] ||
    (scope === (file.defaultScope || file.granularity) ? file.fuels : null);
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

function sliceWindow(series, windowDays) {
  if (!series?.length) return [];
  return series.slice(Math.max(0, series.length - windowDays));
}

function leadByDateMap(lead, leadKey) {
  const map = new Map();
  for (const d of lead?.days || []) {
    const v = d?.[leadKey];
    if (v == null || !Number.isFinite(Number(v))) continue;
    map.set(d.date, Number(v));
  }
  return map;
}

/** Prefer metro/U91, else best non-soft corr for the state. */
function preferredLagForState(stateRows) {
  const metroU91 = stateRows?.metro?.U91;
  if (metroU91 && !metroU91.soft && Number.isFinite(metroU91.lag)) {
    return Math.round(metroU91.lag);
  }
  let best = null;
  for (const scope of SCOPES) {
    const fuels = stateRows?.[scope];
    if (!fuels) continue;
    for (const fuel of CALIB_FUELS) {
      const row = fuels[fuel];
      if (!row || row.soft || !Number.isFinite(row.lag)) continue;
      if (!best || row.corr > best.corr) best = row;
    }
  }
  return best ? Math.round(best.lag) : null;
}

function main() {
  const lead = loadJson(LEAD_PATH);
  if (!lead?.days?.length) {
    console.error('No lead.json days at', LEAD_PATH);
    process.exit(1);
  }

  const cfg = {
    min: lead.lagDays?.min ?? lagCalib.DEFAULT_LAG.min,
    max: lead.lagDays?.max ?? lagCalib.DEFAULT_LAG.max,
  };

  const leadMaps = {
    mogas95: leadByDateMap(lead, 'mogas95'),
    gasoil: leadByDateMap(lead, 'gasoil'),
  };

  const byState = {};
  let hitCount = 0;
  let missCount = 0;

  for (const state of STATES) {
    const file = loadJson(path.join(DOCS, 'v1', `${state}.json`));
    if (!file) {
      console.log(`${state}: missing file`);
      continue;
    }
    byState[state] = {};

    for (const scope of SCOPES) {
      for (const fuel of CALIB_FUELS) {
        const leadKey = leadKeyForFuel(fuel);
        const series = sliceWindow(expandScopeSeries(file, scope, fuel), WINDOW_DAYS);
        const leadByDate = leadMaps[leadKey];
        const pairs = [];
        for (const p of series) {
          const lv = leadByDate.get(p.date);
          if (lv == null) continue;
          pairs.push({ date: p.date, lead: lv, avg: p.avg });
        }
        const hit = lagCalib.calibrateFromPairs(pairs, cfg);
        if (!hit) {
          missCount++;
          continue;
        }
        hitCount++;
        if (!byState[state][scope]) byState[state][scope] = {};
        byState[state][scope][fuel] = {
          lag: hit.lag,
          corr: hit.corr,
          n: hit.n,
          soft: hit.soft,
          source: hit.source,
          leadKey,
          turns: hit.turns,
          pairs: pairs.length,
          days: series.length,
        };
        console.log(
          `${state}/${scope}/${fuel}: lag=${hit.lag}d r=${hit.corr} n=${hit.n} ` +
            `${hit.source}${hit.soft ? ' soft' : ''} lead=${leadKey} pairs=${pairs.length}`
        );
      }
    }
  }

  const lagByState = {
    ...(lagCalib.DEFAULT_LAG.byState || {}),
    ...(lead.lagDays?.byState || {}),
  };
  for (const state of STATES) {
    const pref = preferredLagForState(byState[state]);
    if (pref != null) lagByState[state] = pref;
  }

  const payload = {
    v: 2,
    source: 'lead.json vs live scoped state means (all state×scope×fuel)',
    updated: new Date().toISOString().slice(0, 10),
    windowDays: WINDOW_DAYS,
    scopes: SCOPES,
    fuels: CALIB_FUELS,
    lagDays: {
      default: lead.lagDays?.default ?? lagCalib.DEFAULT_LAG.default,
      min: cfg.min,
      max: cfg.max,
      byState: lagByState,
    },
    byState,
    generated: new Date().toISOString(),
    stats: { hitCount, missCount },
  };

  if (DRY) {
    console.log(JSON.stringify({ stats: payload.stats, lagDays: payload.lagDays }, null, 2));
    console.log(`Wrote dry-run summary (${hitCount} hits, ${missCount} misses)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH} (${hitCount} hits, ${missCount} misses)`);

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
