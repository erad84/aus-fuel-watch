'use strict';

/**
 * Build a daily Singapore Mogas 95 / Gasoil lead series for outlook turn timing.
 *
 * - Live levels: NYMEX Singapore Mogas 95 (AV01!) + Singapore Gasoil (SGB1!)
 *   delayed quotes via TradingView scanner (USD/bbl).
 * - FX: Yahoo Finance AUDUSD=X.
 * - History: reshape Brent (BZ=F) daily moves between AIP weekly AUD c/L anchors
 *   from outlook.json so week-endings match AIP and mid-week follows oil market.
 * - Latest day pinned to live CME settle converted to AUD c/L when available.
 *
 * Usage:
 *   node data/seed/fetch-cme-lead.js
 *   node data/seed/fetch-cme-lead.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const OUTLOOK_PATH = process.env.OUTLOOK_PATH || path.join(ROOT, 'docs', 'v1', 'outlook.json');
const OUT_PATH = process.env.LEAD_PATH || path.join(ROOT, 'docs', 'v1', 'lead.json');
const EMBED_PATH = process.env.LEAD_EMBED_PATH || path.join(ROOT, 'viewer', 'lead-data.js');
const DRY = process.argv.includes('--dry-run');
const SKIP_EMBED = process.argv.includes('--no-embed');

const LITRES_PER_BBL = 158.987;
const UA = 'AusFuelWatch/1.0 (+cme-lead curator; Mozilla/5.0)';

const SYMBOLS = {
  mogas95: 'NYMEX:AV01!',
  gasoil: 'NYMEX:SGB1!',
};

const DEFAULT_LAG = {
  default: 10,
  min: 5,
  max: 21,
  byState: {
    NSW: 10,
    VIC: 11,
    QLD: 9,
    WA: 7,
    SA: 10,
    TAS: 12,
    NT: 10,
    ACT: 10,
  },
};

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://www.tradingview.com/',
        },
        timeout: 60000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects < 8
        ) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchText(next, redirects + 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`${url} -> HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
  });
}

function fetchJsonPost(url, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Referer: 'https://www.tradingview.com/',
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`${url} -> HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
    req.write(body);
    req.end();
  });
}

function isoFromUnix(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function isoFromDayNum(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function usdBblToAudCpl(usd, audUsd) {
  if (!(usd > 0) || !(audUsd > 0)) return null;
  return Math.round(((usd / audUsd) / LITRES_PER_BBL) * 1000) / 10;
}

function audCplToUsdBbl(cpl, audUsd) {
  if (!(cpl > 0) || !(audUsd > 0)) return null;
  return Math.round(cpl * 0.01 * LITRES_PER_BBL * audUsd * 1000) / 1000;
}

async function fetchYahooDaily(symbol, range = '2y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${range}`;
  const raw = JSON.parse(await fetchText(url));
  const result = raw?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`Yahoo ${symbol}: no timestamps`);
  const closes = result.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(Number(c))) continue;
    map.set(isoFromUnix(result.timestamp[i]), Number(c));
  }
  return map;
}

async function fetchTvCloses(symbols) {
  const body = {
    symbols: { tickers: symbols, query: { types: [] } },
    columns: ['close', 'name', 'description', 'exchange'],
  };
  const data = await fetchJsonPost('https://scanner.tradingview.com/futures/scan', body);
  const out = {};
  for (const row of data?.data || []) {
    const sym = row.s;
    const close = row.d?.[0];
    if (sym && Number.isFinite(Number(close))) out[sym] = Number(close);
  }
  return out;
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    /* ignore */
  }
  return fallback;
}

function weekAnchors(outlook, key) {
  const weeks = Array.isArray(outlook?.weeks) ? outlook.weeks : [];
  return weeks
    .filter((w) => w?.weekEnding && w[key] != null && Number.isFinite(Number(w[key])))
    .map((w) => ({ date: w.weekEnding, cpl: Number(w[key]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Carry-forward nearest available value from a date→number map. */
function valueOnOrBefore(map, iso, maxLookback = 10) {
  const n0 = dayNum(iso);
  for (let i = 0; i <= maxLookback; i++) {
    const v = map.get(isoFromDayNum(n0 - i));
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Between consecutive AIP week anchors, reshape Brent path so endpoints match
 * AIP c/L and mid-week follows relative Brent moves.
 */
function reshapeSegment(startIso, startCpl, endIso, endCpl, brent) {
  const n0 = dayNum(startIso);
  const n1 = dayNum(endIso);
  if (n1 <= n0) return [];
  const dates = [];
  for (let n = n0; n <= n1; n++) {
    const iso = isoFromDayNum(n);
    const b = valueOnOrBefore(brent, iso, 5);
    if (b != null) dates.push({ date: iso, brent: b });
  }
  if (dates.length < 2) {
    return [
      { date: startIso, cpl: startCpl, source: 'aip_anchor' },
      { date: endIso, cpl: endCpl, source: 'aip_anchor' },
    ];
  }
  const b0 = dates[0].brent;
  const b1 = dates[dates.length - 1].brent;
  const brentSpan = b1 - b0;
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const { date, brent: b } = dates[i];
    let cpl;
    if (i === 0) cpl = startCpl;
    else if (i === dates.length - 1) cpl = endCpl;
    else if (Math.abs(brentSpan) < 1e-6) {
      const t = i / (dates.length - 1);
      cpl = startCpl + (endCpl - startCpl) * t;
    } else {
      cpl = startCpl + (endCpl - startCpl) * ((b - b0) / brentSpan);
    }
    out.push({
      date,
      cpl: Math.round(cpl * 10) / 10,
      source: i === 0 || i === dates.length - 1 ? 'aip_anchor' : 'brent_reshape',
    });
  }
  return out;
}

function buildCommodityDays(anchors, brent, fx, liveUsd, liveIso) {
  const byDate = new Map();
  if (!anchors.length) return byDate;

  for (let i = 0; i < anchors.length - 1; i++) {
    const seg = reshapeSegment(
      anchors[i].date,
      anchors[i].cpl,
      anchors[i + 1].date,
      anchors[i + 1].cpl,
      brent
    );
    for (const row of seg) byDate.set(row.date, row);
  }

  const last = anchors[anchors.length - 1];
  byDate.set(last.date, { date: last.date, cpl: last.cpl, source: 'aip_anchor' });

  const endIso = liveIso || [...brent.keys()].sort().at(-1);
  if (endIso && endIso > last.date) {
    const bLast = valueOnOrBefore(brent, last.date, 5);
    for (let n = dayNum(last.date) + 1; n <= dayNum(endIso); n++) {
      const iso = isoFromDayNum(n);
      const b = valueOnOrBefore(brent, iso, 5);
      if (b == null || bLast == null) continue;
      const cpl = Math.round(last.cpl * (b / bLast) * 10) / 10;
      byDate.set(iso, { date: iso, cpl, source: 'brent_extend' });
    }
  }

  if (liveUsd != null && liveIso) {
    const audUsd = valueOnOrBefore(fx, liveIso, 5);
    const cpl = usdBblToAudCpl(liveUsd, audUsd);
    if (cpl != null) {
      byDate.set(liveIso, {
        date: liveIso,
        cpl,
        usd: liveUsd,
        fx: audUsd,
        source: 'cme',
      });
      // Soft-scale the post-anchor extend so the path lands on CME without a cliff.
      const extendDates = [...byDate.keys()]
        .filter((d) => d > last.date && d < liveIso)
        .sort();
      if (extendDates.length && bLastScaleOk(byDate, last.date)) {
        const pre = byDate.get(extendDates[extendDates.length - 1])?.cpl;
        const start = last.cpl;
        if (pre != null && Math.abs(pre - start) > 1e-6) {
          /* leave brent path; CME pin is the authoritative last print */
        }
      }
    }
  }

  return byDate;
}

function bLastScaleOk(byDate, lastDate) {
  return byDate.has(lastDate);
}

function mergeDayMaps(mogasMap, gasoilMap, fx) {
  const dates = new Set([...mogasMap.keys(), ...gasoilMap.keys()]);
  const days = [...dates].sort().map((date) => {
    const m = mogasMap.get(date);
    const g = gasoilMap.get(date);
    const audUsd = valueOnOrBefore(fx, date, 5);
    const row = { date };
    if (m) {
      row.mogas95 = m.cpl;
      row.mogas95Source = m.source;
      if (m.usd != null) row.mogas95Usd = m.usd;
      else if (audUsd) row.mogas95Usd = audCplToUsdBbl(m.cpl, audUsd);
    }
    if (g) {
      row.gasoil = g.cpl;
      row.gasoilSource = g.source;
      if (g.usd != null) row.gasoilUsd = g.usd;
      else if (audUsd) row.gasoilUsd = audCplToUsdBbl(g.cpl, audUsd);
    }
    if (audUsd) row.fxAudUsd = Math.round(audUsd * 1e6) / 1e6;
    return row;
  });
  return days.filter((d) => d.mogas95 != null || d.gasoil != null);
}

function writeEmbed(lead) {
  const js = `window.LEAD_DATA=${JSON.stringify(lead)};\n`;
  fs.writeFileSync(EMBED_PATH, js);
}

async function main() {
  const outlook = loadJson(OUTLOOK_PATH, { weeks: [], lagDays: DEFAULT_LAG });
  const prev = loadJson(OUT_PATH, null);

  console.log('Fetching Yahoo AUDUSD + Brent…');
  const [fx, brent] = await Promise.all([
    fetchYahooDaily('AUDUSD=X', '2y'),
    fetchYahooDaily('BZ=F', '2y'),
  ]);
  console.log(`  FX days=${fx.size}  Brent days=${brent.size}`);

  let tv = {};
  try {
    console.log('Fetching TradingView NYMEX settles…');
    tv = await fetchTvCloses([SYMBOLS.mogas95, SYMBOLS.gasoil]);
    console.log(
      `  ${SYMBOLS.mogas95}=${tv[SYMBOLS.mogas95] ?? 'n/a'}  ${SYMBOLS.gasoil}=${
        tv[SYMBOLS.gasoil] ?? 'n/a'
      }`
    );
  } catch (e) {
    console.warn('TradingView quote failed:', e.message);
  }

  const today = new Date().toISOString().slice(0, 10);
  // Prefer last FX/Brent trading day for the live pin date.
  const liveIso =
    [...fx.keys()].filter((d) => d <= today).sort().at(-1) ||
    [...brent.keys()].filter((d) => d <= today).sort().at(-1) ||
    today;

  const mogasAnchors = weekAnchors(outlook, 'mogas95');
  const gasoilAnchors = weekAnchors(outlook, 'gasoil');
  console.log(`AIP anchors: mogas=${mogasAnchors.length} gasoil=${gasoilAnchors.length}`);

  const mogasMap = buildCommodityDays(
    mogasAnchors,
    brent,
    fx,
    tv[SYMBOLS.mogas95],
    liveIso
  );
  const gasoilMap = buildCommodityDays(
    gasoilAnchors,
    brent,
    fx,
    tv[SYMBOLS.gasoil],
    liveIso
  );

  // Preserve prior true CME pins if today's TV fetch failed.
  if (prev?.days?.length) {
    for (const row of prev.days) {
      if (row.mogas95Source === 'cme' && row.mogas95 != null && !mogasMap.has(row.date)) {
        mogasMap.set(row.date, {
          date: row.date,
          cpl: row.mogas95,
          usd: row.mogas95Usd,
          source: 'cme',
        });
      }
      if (row.mogas95Source === 'cme' && row.mogas95 != null && mogasMap.get(row.date)?.source !== 'cme') {
        // keep reconstructed unless we have a fresh live pin same day
        if (!(tv[SYMBOLS.mogas95] && row.date === liveIso)) {
          mogasMap.set(row.date, {
            date: row.date,
            cpl: row.mogas95,
            usd: row.mogas95Usd,
            source: 'cme',
          });
        }
      }
      if (row.gasoilSource === 'cme' && row.gasoil != null) {
        const cur = gasoilMap.get(row.date);
        if (!cur || (cur.source !== 'cme' && !(tv[SYMBOLS.gasoil] && row.date === liveIso))) {
          gasoilMap.set(row.date, {
            date: row.date,
            cpl: row.gasoil,
            usd: row.gasoilUsd,
            source: 'cme',
          });
        }
      }
    }
  }

  const days = mergeDayMaps(mogasMap, gasoilMap, fx);
  const lagDays = {
    ...DEFAULT_LAG,
    byState: {
      ...DEFAULT_LAG.byState,
      ...(outlook.lagDays?.byState || {}),
      ...(prev?.lagDays?.byState || {}),
    },
  };

  const lead = {
    source:
      'NYMEX Singapore Mogas 95 / Gasoil (Platts) delayed settles; history reshaped from AIP weekly + Brent; FX Yahoo AUDUSD',
    updated: today,
    symbols: SYMBOLS,
    lagDays,
    days,
    lastFetch: {
      at: new Date().toISOString(),
      liveIso,
      mogas95Usd: tv[SYMBOLS.mogas95] ?? null,
      gasoilUsd: tv[SYMBOLS.gasoil] ?? null,
      dayCount: days.length,
      mogasCmeDays: days.filter((d) => d.mogas95Source === 'cme').length,
      gasoilCmeDays: days.filter((d) => d.gasoilSource === 'cme').length,
    },
  };

  console.log(
    `Built ${days.length} days · CME pins mogas=${lead.lastFetch.mogasCmeDays} gasoil=${lead.lastFetch.gasoilCmeDays}`
  );
  if (DRY) {
    console.log(JSON.stringify(lead.lastFetch, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(lead, null, 2) + '\n');
  console.log('Wrote', OUT_PATH);
  if (!SKIP_EMBED) {
    writeEmbed(lead);
    console.log('Wrote', EMBED_PATH);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
