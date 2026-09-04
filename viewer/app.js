/* Aus Fuel Watch — browser data viewer */

const DAY_MS = 86400000;
const E10_ENERGY_RATIO = 0.97;
const FUEL_LABELS = {
  U91: 'Unleaded 91',
  E10: 'E10',
  P95: 'Premium 95',
  P98: 'Premium 98',
  DSL: 'Diesel',
  PDSL: 'Premium diesel',
};
const PETROLMATE_FUEL = {
  ULP: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIESEL: 'DSL',
  PDIESEL: 'PDSL',
};
const CAPITALS = {
  NSW: { name: 'Sydney', lat: -33.8688, lng: 151.2093 },
  VIC: { name: 'Melbourne', lat: -37.8136, lng: 144.9631 },
  QLD: { name: 'Brisbane', lat: -27.4698, lng: 153.0251 },
  SA: { name: 'Adelaide', lat: -34.9285, lng: 138.6007 },
  WA: { name: 'Perth', lat: -31.9523, lng: 115.8613 },
  TAS: { name: 'Hobart', lat: -42.8821, lng: 147.3272 },
  NT: { name: 'Darwin', lat: -12.4634, lng: 130.8456 },
  ACT: { name: 'Canberra', lat: -35.2809, lng: 149.13 },
};

let stateFiles = {};
let historyChart = null;
let stationChart = null;
let map = null;
let markerLayer = null;
/** @type {Map<number|string, object>} */
let stationCache = new Map();
/** @type {Map<number|string, L.Marker>} */
let markerById = new Map();
let stationsLive = [];
let selectedStationId = null;
let stationFetchTimer = null;
let stationFetchInFlight = false;
const MIN_ZOOM_STATIONS = 11;
const MAX_STATIONS_PER_REQUEST = 50;
const MAX_RADIUS_M = 25000;
/** @type {Record<string, {date: string, prices: Record<string, number>}>} */
const stationSnapshots = {};

/** Series + params for chart hover → cycle dial sync */
let chartCycleCtx = {
  series: [],
  params: null,
  turns: [],
  state: null,
  latestStage: null,
  hoverIndex: null,
};

function isoToDayNum(iso) {
  return Math.round(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
}
function dayNumToISO(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function baseUrl() {
  return document.getElementById('dataBase').value.replace(/\/$/, '');
}

/** Petrolmate URLs: local /proxy first, then optional manual proxy, then direct (often CORS-blocked). */
async function fetchPetrolmate(kind, qs = '') {
  const manual = document.getElementById('stationProxy').value.trim().replace(/\/$/, '');
  const urls = [];

  if (manual) {
    urls.push(kind === 'summary' ? `${manual}/summary` : `${manual}/area?${qs}`);
  }
  if (location.protocol.startsWith('http')) {
    urls.push(
      kind === 'summary'
        ? `${location.origin}/proxy/summary`
        : `${location.origin}/proxy/area?${qs}`
    );
  }
  urls.push(
    kind === 'summary'
      ? 'https://petrolmate.com.au/api/summary'
      : `https://petrolmate.com.au/api/v1/stations/area?${qs}`
  );

  let lastErr;
  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function setStatus(msg) {
  document.getElementById('statusBar').textContent = msg;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function expandFileSeries(file, fuel) {
  const s = file.fuels?.[fuel];
  if (!file.start || !s) return [];
  const start = isoToDayNum(file.start);
  const out = [];
  for (let i = 0; i < file.days; i++) {
    if (s.avg[i] == null) continue;
    out.push({
      date: dayNumToISO(start + i),
      avg: s.avg[i] / 10,
      med: s.med?.[i] != null ? s.med[i] / 10 : null,
      min: s.min[i] / 10,
      max: s.max[i] / 10,
      n: s.n[i],
    });
  }
  return out;
}

function mergeArchiveIntoSeries(archiveByFuel, fuel, dayMap) {
  const arch = archiveByFuel[fuel];
  if (!arch) return;
  for (const [date, row] of Object.entries(arch)) {
    if (!dayMap[date]) {
      dayMap[date] = {
        date,
        avg: row.avg / 10,
        med: row.med != null ? row.med / 10 : null,
        min: row.min / 10,
        max: row.max / 10,
        n: row.n,
      };
    }
  }
}

async function loadArchivesForState(state) {
  const byFuel = {};
  const now = new Date();
  for (let m = 14; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      const data = await fetchJson(`${baseUrl()}/v1/archive/${month}.json`);
      const st = data.states?.[state];
      if (!st) continue;
      for (const [fuel, days] of Object.entries(st)) {
        byFuel[fuel] = { ...(byFuel[fuel] || {}), ...days };
      }
    } catch {
      /* archive month may not exist */
    }
  }
  return byFuel;
}

function buildMergedSeries(file, archiveByFuel, fuel) {
  const dayMap = {};
  mergeArchiveIntoSeries(archiveByFuel, fuel, dayMap);
  for (const p of expandFileSeries(file, fuel)) dayMap[p.date] = p;
  return Object.values(dayMap).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function sliceSeriesByPeriod(points, days) {
  if (!points.length) return [];
  const n = Number(days) || 90;
  return points.slice(Math.max(0, points.length - n));
}

function seriesStats(points) {
  if (!points.length) return null;
  const mins = points.map((p) => p.min).filter((v) => v != null);
  const maxs = points.map((p) => p.max).filter((v) => v != null);
  const latest = points[points.length - 1];
  return {
    latest,
    currentLow: latest.min ?? null,
    currentHigh: latest.max ?? null,
    periodLow: mins.length ? Math.min(...mins) : null,
    periodHigh: maxs.length ? Math.max(...maxs) : null,
    days: points.length,
  };
}

function scopeLabel(state, scope) {
  if (scope === 'metro') {
    const city = CAPITALS[state]?.name;
    return city ? `${city} metro` : `${state} metro`;
  }
  return state;
}

function selectedScope() {
  return document.getElementById('scopeSelect')?.value || 'metro';
}

function selectedPeriod() {
  return Number(document.getElementById('periodSelect')?.value || 90);
}

/**
 * Cycle stage from price heuristic (fallback when no peak/bottom markers).
 * Angle: 0° = peak (top), clockwise → falling (90°) → bottom (180°) → rising (270°).
 */
function inferCycleStage(points, params) {
  const base = { confidence: params?.confidence || 'none', angle: null, placed: false };
  if (points.length < 5) {
    return { ...base, stage: 'unknown', label: 'Not enough history' };
  }
  const avgs = points.map((p) => p.avg);
  const latest = avgs[avgs.length - 1];
  const minAvg = Math.min(...avgs);
  const maxAvg = Math.max(...avgs);
  const range = maxAvg - minAvg;
  if (range < 2.5) {
    return { ...base, stage: 'flat', label: 'Flat / weak movement' };
  }
  const pos = (latest - minAvg) / range;
  const tail = avgs.slice(-Math.min(5, avgs.length));
  const slope = (tail[tail.length - 1] - tail[0]) / Math.max(1, tail.length - 1);

  let stage;
  if (pos >= 0.78 && slope >= -0.15) stage = 'peak';
  else if (pos <= 0.22 && slope <= 0.15) stage = 'bottom';
  else if (slope < -0.25) stage = 'falling';
  else if (slope > 0.25) stage = 'rising';
  else if (params?.lastTurn?.type === 'peak' && slope < 0) stage = 'falling';
  else if (params?.lastTurn?.type === 'trough' && slope > 0) stage = 'rising';
  else stage = 'unknown';

  let angle;
  if (slope >= 0) angle = 180 + pos * 180;
  else angle = (1 - pos) * 180;
  angle = ((angle % 360) + 360) % 360;

  const labels = {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
    flat: 'Flat',
    unknown: 'Unclear',
  };
  return {
    stage,
    label: labels[stage],
    confidence: base.confidence,
    angle,
    placed: true,
  };
}

function stageFromDialAngle(angle) {
  const a = ((angle % 360) + 360) % 360;
  if (a < 45 || a >= 315) return 'peak';
  if (a < 135) return 'falling';
  if (a < 225) return 'bottom';
  return 'rising';
}

function seriesAvgAt(series, index) {
  const v = series?.[index]?.avg;
  return v != null ? v : null;
}

function clamp01(x) {
  if (Number.isNaN(x) || x == null) return 0;
  return Math.max(0, Math.min(1, x));
}

function priceRangeInSpan(series, from, to) {
  let lo = null;
  let hi = null;
  for (let i = from; i <= to; i++) {
    const v = seriesAvgAt(series, i);
    if (v == null) continue;
    if (lo == null || v < lo) lo = v;
    if (hi == null || v > hi) hi = v;
  }
  return { lo, hi };
}

/** Mean c/L change per day from a marker index to dataIndex (never before the marker). */
function slopeSinceMarker(series, dataIndex, markerIndex) {
  if (dataIndex <= markerIndex) return 0;
  const a = seriesAvgAt(series, markerIndex);
  const b = seriesAvgAt(series, dataIndex);
  if (a == null || b == null) return 0;
  return (b - a) / (dataIndex - markerIndex);
}

/** WA FuelWatch weekly sawtooth: ~2-day spike, ~5-day grind (period ≈ 7). */
const WA_CYCLE = { period: 7, riseDays: 2, fallDays: 5 };

/**
 * After last WA marker: predict dial from weekly periodicity, refined by
 * observed price since that marker (never look back before it).
 */
function waDialAfterLastMarker(series, dataIndex, prev) {
  const price = seriesAvgAt(series, dataIndex);
  const anchor = seriesAvgAt(series, prev.index);
  if (price == null || anchor == null) return null;

  const { riseDays, fallDays, period } = WA_CYCLE;
  const days = Math.max(0, dataIndex - prev.index);
  // Phase within the expected week starting at the last confirmed turn.
  const d = days % period;
  const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);
  const refAmp = Math.max(8, (hi ?? price) - (lo ?? price), Math.abs(price - anchor), 0.05);

  if (prev.type === 'trough') {
    // Expect: bottom → peak over riseDays, then peak → next bottom over fallDays.
    if (d <= riseDays) {
      const timeU = riseDays <= 0 ? 1 : d / riseDays;
      const priceU = clamp01((price - anchor) / refAmp);
      const u = clamp01(0.6 * timeU + 0.4 * priceU);
      return 180 + u * 180; // bottom → peak (rising arc)
    }
    const timeU = (d - riseDays) / fallDays;
    const peakEst = hi ?? Math.max(anchor, price);
    const priceU = clamp01((peakEst - price) / Math.max(0.05, peakEst - (lo ?? anchor)));
    const u = clamp01(0.6 * timeU + 0.4 * priceU);
    return u * 180; // peak → bottom (falling arc)
  }

  // prev === peak: expect peak → bottom over fallDays, then rise to next peak.
  if (d <= fallDays) {
    const timeU = fallDays <= 0 ? 1 : d / fallDays;
    const priceU = clamp01((anchor - price) / refAmp);
    const u = clamp01(0.6 * timeU + 0.4 * priceU);
    return u * 180; // peak → bottom
  }
  const timeU = (d - fallDays) / riseDays;
  const troughEst = lo ?? Math.min(anchor, price);
  const priceU = clamp01((price - troughEst) / Math.max(0.05, (hi ?? price) - troughEst));
  const u = clamp01(0.6 * timeU + 0.4 * priceU);
  return 180 + u * 180; // bottom → peak
}

/**
 * After the last confirmed marker: direction is price vs that line (and slope
 * since it — never lookback before the marker). Descending → falling→bottom;
 * rising → rising→peak. Flattening pulls toward the extremum.
 * WA: weekly FuelWatch periodicity predicts the stage after the last line.
 */
function dialAngleAfterLastMarker(series, dataIndex, prev, state) {
  if (state === 'WA') return waDialAfterLastMarker(series, dataIndex, prev);

  const price = seriesAvgAt(series, dataIndex);
  const anchor = seriesAvgAt(series, prev.index);
  if (price == null || anchor == null) return null;

  const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);
  const slope = slopeSinceMarker(series, dataIndex, prev.index);
  const move = price - anchor;
  const spanAmp = Math.max(0.05, (hi ?? price) - (lo ?? price));
  const refAmp = Math.max(5, spanAmp);
  const steepness = clamp01(Math.abs(slope) / Math.max(0.15, refAmp * 0.08));
  const flatness = 1 - steepness;

  const rising = move > 0.05 || (move >= 0 && slope > 0);
  const falling = move < -0.05 || (move <= 0 && slope < 0);

  if (rising && !falling) {
    const riseProg = clamp01(move / refAmp);
    const along = clamp01(0.35 * flatness + 0.65 * riseProg);
    return 270 + along * 90;
  }

  if (falling && !rising) {
    const dropProg = clamp01((-move) / refAmp);
    const along = clamp01(0.35 * flatness + 0.65 * dropProg);
    return 90 + along * 90;
  }

  return prev.type === 'trough' ? 180 : prev.type === 'peak' ? 0 : 180;
}

/**
 * Dial from price relative to surrounding peak/bottom marker prices.
 * Green→red: rising arc. Red→green: falling arc.
 * WA uses asymmetric weekly mapping (fast rise, slow fall).
 */
function inferCycleStageFromTurns(dataIndex, turns, series, params, state) {
  const base = {
    confidence: params?.confidence || 'none',
    angle: null,
    placed: false,
    source: turns?.length ? 'markers' : 'none',
  };
  const labels = {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
    unknown: 'Unclear',
  };
  if (!turns?.length || !series?.length || dataIndex == null || dataIndex < 0) {
    return { ...base, stage: 'unknown', label: labels.unknown };
  }

  const price = seriesAvgAt(series, dataIndex);
  if (price == null) return { ...base, stage: 'unknown', label: labels.unknown };

  const hit = turns.find((t) => t.index === dataIndex);
  if (hit) {
    if (hit.type === 'peak') {
      return { ...base, stage: 'peak', label: labels.peak, angle: 0, placed: true };
    }
    return { ...base, stage: 'bottom', label: labels.bottom, angle: 180, placed: true };
  }

  let prev = null;
  let next = null;
  for (const t of turns) {
    if (t.index < dataIndex) prev = t;
    else if (t.index > dataIndex) {
      next = t;
      break;
    }
  }

  let angle;
  if (prev && next) {
    const a = seriesAvgAt(series, prev.index);
    const b = seriesAvgAt(series, next.index);
    if (a == null || b == null || Math.abs(b - a) < 0.05) {
      return { ...base, stage: 'unknown', label: labels.unknown };
    }
    const dayProg = (dataIndex - prev.index) / Math.max(1, next.index - prev.index);
    if (prev.type === 'trough' && next.type === 'peak') {
      const priceProg = clamp01((price - a) / (b - a));
      // WA spike: price dominates (steep climb). Elsewhere: price only.
      const prog =
        state === 'WA'
          ? clamp01(0.85 * priceProg + 0.15 * dayProg)
          : priceProg;
      angle = 180 + prog * 180;
    } else if (prev.type === 'peak' && next.type === 'trough') {
      const priceProg = clamp01((a - price) / (a - b));
      // WA grind-down: blend time so dial tracks the long falling week.
      const prog =
        state === 'WA'
          ? clamp01(0.4 * priceProg + 0.6 * dayProg)
          : priceProg;
      angle = prog * 180;
    } else if (prev.type === 'trough') {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const progress = clamp01((price - lo) / Math.max(0.05, hi - lo));
      angle = 180 + progress * 180;
    } else {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const progress = clamp01((hi - price) / Math.max(0.05, hi - lo));
      angle = progress * 180;
    }
  } else if (prev && !next) {
    const a = dialAngleAfterLastMarker(series, dataIndex, prev, state);
    if (a == null) return { ...base, stage: 'unknown', label: labels.unknown };
    angle = a;
  } else if (!prev && next) {
    const anchor = seriesAvgAt(series, next.index);
    if (anchor == null) return { ...base, stage: 'unknown', label: labels.unknown };
    const { lo, hi } = priceRangeInSpan(series, 0, next.index);
    if (lo == null || hi == null || hi - lo < 0.05) {
      angle = next.type === 'peak' ? 270 : 90;
    } else if (next.type === 'peak') {
      const progress = clamp01((price - lo) / (hi - lo));
      angle = 180 + progress * 180;
    } else {
      const progress = clamp01((hi - price) / (hi - lo));
      angle = progress * 180;
    }
  } else {
    return { ...base, stage: 'unknown', label: labels.unknown };
  }

  angle = ((angle % 360) + 360) % 360;
  const stage = stageFromDialAngle(angle);
  return { ...base, stage, label: labels[stage], angle, placed: true };
}

function cycleStageForIndex(dataIndex) {
  const { series, params, turns, state } = chartCycleCtx;
  if (turns?.length) return inferCycleStageFromTurns(dataIndex, turns, series, params, state);
  if (!series?.length) return null;
  return inferCycleStage(series.slice(0, dataIndex + 1), params);
}

function cycleFitCaption(stage, state) {
  if (stage?.source === 'markers') {
    if (state === 'WA') return ' · WA weekly FuelWatch pattern';
    return '';
  }
  if (stage?.confidence && stage.confidence !== 'none') {
    return ` · fit ${stage.confidence}`;
  }
  return ' · no cycle fit';
}

/**
 * Zigzag swing filter on mean series.
 * Does not mark the open (unconfirmed) endpoint — tomorrow may extend the extreme.
 */
function findZigzagTurns(series, minSwingOpt) {
  const pts = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i]?.avg != null) pts.push({ i, v: series[i].avg });
  }
  if (pts.length < 5) return [];

  const vals = pts.map((p) => p.v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const spread = hi - lo;
  if (spread < 2.5) return [];
  const minSwing = minSwingOpt ?? Math.max(2.0, 0.14 * spread);

  const pivots = [];
  let dir = 0;
  let ext = pts[0];
  let lowSoFar = pts[0];
  let highSoFar = pts[0];

  for (let k = 1; k < pts.length; k++) {
    const p = pts[k];
    if (dir === 1) {
      if (p.v >= ext.v) ext = p;
      else if (ext.v - p.v >= minSwing) {
        pivots.push({ index: ext.i, type: 'peak' });
        dir = -1;
        ext = p;
      }
    } else if (dir === -1) {
      if (p.v <= ext.v) ext = p;
      else if (p.v - ext.v >= minSwing) {
        pivots.push({ index: ext.i, type: 'trough' });
        dir = 1;
        ext = p;
      }
    } else {
      if (p.v < lowSoFar.v) lowSoFar = p;
      if (p.v > highSoFar.v) highSoFar = p;
      if (p.v - lowSoFar.v >= minSwing) {
        pivots.push({ index: lowSoFar.i, type: 'trough' });
        dir = 1;
        ext = p;
      } else if (highSoFar.v - p.v >= minSwing) {
        pivots.push({ index: highSoFar.i, type: 'peak' });
        dir = -1;
        ext = p;
      }
    }
  }

  return pivots;
}

function isLocalExtremum(avgs, index, type, radius = 1) {
  const v = avgs[index];
  if (v == null) return false;
  const lo = Math.max(0, index - radius);
  const hi = Math.min(avgs.length - 1, index + radius);
  for (let i = lo; i <= hi; i++) {
    if (i === index || avgs[i] == null) continue;
    if (type === 'peak' && avgs[i] > v) return false;
    if (type === 'trough' && avgs[i] < v) return false;
  }
  return true;
}

/** Drop shallow noise troughs/peaks that aren't real local extrema. */
function filterTurnQuality(series, turns, minSwing) {
  const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
  const n = avgs.length;
  let out = turns.filter((t) => {
    // Never mark the last datum — the extreme may still be extending.
    if (t.index >= n - 1) return false;
    if (t.index === 0) return isLocalExtremum(avgs, 0, t.type, 1);
    return isLocalExtremum(avgs, t.index, t.type, 1);
  });

  // Require alternating peak/trough; if two same type in a row, keep the more extreme.
  out.sort((a, b) => a.index - b.index);
  const alt = [];
  for (const t of out) {
    const prev = alt[alt.length - 1];
    if (!prev || prev.type !== t.type) {
      alt.push(t);
      continue;
    }
    const prefer =
      t.type === 'peak'
        ? avgs[t.index] >= avgs[prev.index]
        : avgs[t.index] <= avgs[prev.index];
    if (prefer) alt[alt.length - 1] = t;
  }

  // Drop turns with tiny prominence vs neighbours of opposite type.
  return alt.filter((t, i) => {
    const prev = alt[i - 1];
    const next = alt[i + 1];
    let prom = 0;
    if (prev) prom = Math.max(prom, Math.abs(avgs[t.index] - avgs[prev.index]));
    if (next) prom = Math.max(prom, Math.abs(avgs[t.index] - avgs[next.index]));
    if (!prev && !next) return true;
    return prom >= Math.max(1.5, minSwing * 0.55);
  });
}

/** Same-type markers closer than minSep days → keep the stronger. */
function dedupeNearbyTurns(series, turns, minSep = 5) {
  const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
  const out = [];
  for (const t of [...turns].sort((a, b) => a.index - b.index)) {
    const prev = out[out.length - 1];
    if (prev && prev.type === t.type && t.index - prev.index < minSep) {
      const prefer =
        t.type === 'peak'
          ? avgs[t.index] >= avgs[prev.index]
          : avgs[t.index] <= avgs[prev.index];
      if (prefer) out[out.length - 1] = t;
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * Peak/bottom markers from confirmed zigzag swings only.
 * Incomplete end of series has no vertical line; dial uses price vs last marker.
 * WA: tune for the regular ~7-day FuelWatch sawtooth.
 */
function findChartCycleMarks(series, state) {
  const avgs = series.map((p) => p?.avg).filter((v) => v != null);
  if (avgs.length < 5) return { turns: [] };
  const spread = Math.max(...avgs) - Math.min(...avgs);
  // WA weekly swings are sharp but regular — slightly softer threshold, tighter dedupe.
  const minSwing =
    state === 'WA' ? Math.max(1.5, 0.1 * spread) : Math.max(2.0, 0.14 * spread);

  let turns = findZigzagTurns(series, minSwing);
  turns = filterTurnQuality(series, turns, minSwing);
  turns = dedupeNearbyTurns(series, turns, state === 'WA' ? 3 : 5);
  turns = turns.filter((t) => t.index < series.length - 1);
  turns.sort((a, b) => a.index - b.index);
  return { turns };
}

const cycleTurnLinesPlugin = {
  id: 'cycleTurnLines',
  afterDatasetsDraw(chart, _args, opts) {
    const turns = opts?.turns || [];
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    if (!xScale || !chartArea || !turns.length) return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    for (const t of turns) {
      const x = xScale.getPixelForValue(t.index);
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.strokeStyle = t.type === 'peak' ? '#ef4444' : '#22c55e';
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

function syncCycleDialFromHover(dataIndex) {
  if (dataIndex == null || dataIndex < 0) {
    if (chartCycleCtx.hoverIndex != null) {
      chartCycleCtx.hoverIndex = null;
      renderCycleDial(chartCycleCtx.latestStage);
    }
    return;
  }
  if (dataIndex === chartCycleCtx.hoverIndex) return;
  chartCycleCtx.hoverIndex = dataIndex;
  const series = chartCycleCtx.series;
  if (!series.length) return;
  const stage = cycleStageForIndex(dataIndex);
  renderCycleDial(stage, { asOf: series[dataIndex]?.date });
}

function resetCycleDialHover() {
  if (chartCycleCtx.hoverIndex == null) return;
  chartCycleCtx.hoverIndex = null;
  renderCycleDial(chartCycleCtx.latestStage);
}

function polarXY(cx, cy, r, angleDeg) {
  // 0° at top, clockwise (cycle dial convention).
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  const s = polarXY(cx, cy, r, startDeg);
  const e = polarXY(cx, cy, r, endDeg);
  const sweep = (endDeg - startDeg + 360) % 360;
  const large = sweep > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function renderCycleDial(stage, opts = {}) {
  const el = document.getElementById('cycleStages');
  if (!stage) {
    el.innerHTML = '';
    return;
  }

  const cx = 100;
  const cy = 100;
  const r = 62;

  // Peak arc wraps past 0° — draw as two segments.
  const arcSvg = [
    `<path class="arc-seg arc-peak" d="${arcPath(cx, cy, r, 315, 360)}" />`,
    `<path class="arc-seg arc-peak" d="${arcPath(cx, cy, r, 0, 45)}" />`,
    `<path class="arc-seg arc-falling" d="${arcPath(cx, cy, r, 45, 135)}" />`,
    `<path class="arc-seg arc-bottom" d="${arcPath(cx, cy, r, 135, 225)}" />`,
    `<path class="arc-seg arc-rising" d="${arcPath(cx, cy, r, 225, 315)}" />`,
  ].join('');

  const peak = polarXY(cx, cy, r + 22, 0);
  const falling = polarXY(cx, cy, r + 28, 90);
  const bottom = polarXY(cx, cy, r + 22, 180);
  const rising = polarXY(cx, cy, r + 28, 270);

  let marker = '';
  if (stage.placed && stage.angle != null) {
    const m = polarXY(cx, cy, r, stage.angle);
    marker = `<circle class="marker" cx="${m.x.toFixed(2)}" cy="${m.y.toFixed(2)}" r="7" />`;
  } else {
    marker = `<circle class="marker dim" cx="${cx}" cy="${cy}" r="6" />`;
  }

  const conf = cycleFitCaption(stage, opts.state ?? chartCycleCtx.state);
  const asOf = opts.asOf ? ` · ${opts.asOf}` : '';

  el.innerHTML = `
    <div class="cycle-dial-wrap" title="Price cycle position (collected series)">
      <svg class="cycle-dial" viewBox="-8 -4 216 208" role="img" aria-label="Cycle: ${stage.label}">
        <circle class="ring-track" cx="${cx}" cy="${cy}" r="${r}" />
        ${arcSvg}
        <circle class="hub" cx="${cx}" cy="${cy}" r="28" />
        <text class="cycle-label label-peak" x="${peak.x.toFixed(1)}" y="${peak.y.toFixed(1)}" dy="0.35em">Peak</text>
        <text class="cycle-label label-falling" x="${falling.x.toFixed(1)}" y="${falling.y.toFixed(1)}" dy="0.35em">Falling</text>
        <text class="cycle-label label-bottom" x="${bottom.x.toFixed(1)}" y="${bottom.y.toFixed(1)}" dy="0.35em">Bottom</text>
        <text class="cycle-label label-rising" x="${rising.x.toFixed(1)}" y="${rising.y.toFixed(1)}" dy="0.35em">Rising</text>
        ${marker}
      </svg>
    </div>
    <p class="cycle-meta"><strong>${stage.label}</strong>${asOf}${conf}</p>
  `;
}

function compareE10VsU91(u91, e10) {
  if (!u91 || !e10) return null;
  const priceDiscountPct = ((u91 - e10) / u91) * 100;
  const energyEquivSaving = u91 - e10 / E10_ENERGY_RATIO;
  // Energy-adjusted relative advantage vs the other fuel.
  const e10Effective = e10 / E10_ENERGY_RATIO;
  let pick;
  let winPct = 0;
  if (energyEquivSaving > 0.05) {
    pick = 'E10';
    winPct = ((u91 - e10Effective) / u91) * 100;
  } else if (energyEquivSaving < -0.05) {
    pick = 'U91';
    winPct = ((e10Effective - u91) / e10Effective) * 100;
  } else {
    pick = 'tie';
  }
  return { pick, priceDiscountPct, energyEquivSaving, winPct, u91, e10 };
}

function destroyChart(chart) {
  if (chart) chart.destroy();
  return null;
}

function lineVisibility() {
  return {
    avg: document.getElementById('showAvg')?.checked !== false,
    med: document.getElementById('showMed')?.checked !== false,
    min: document.getElementById('showMin')?.checked !== false,
    max: document.getElementById('showMax')?.checked !== false,
  };
}

function yBoundsFromVisible(citySeries, vis) {
  const vals = [];
  for (const p of citySeries) {
    if (vis.avg && p.avg != null) vals.push(p.avg);
    if (vis.med && p.med != null) vals.push(p.med);
    if (vis.min && p.min != null) vals.push(p.min);
    if (vis.max && p.max != null) vals.push(p.max);
  }
  if (!vals.length) return undefined;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(0.5, (hi - lo) * 0.08);
  // Snap axis ends to 0.1c so tick labels stay clean tenths.
  return {
    min: Math.floor((lo - pad) * 10) / 10,
    max: Math.ceil((hi + pad) * 10) / 10,
  };
}

function renderHistoryChart(labels, citySeries, statePoint, fuel, title, state, marks) {
  const ctx = document.getElementById('historyChart');
  historyChart = destroyChart(historyChart);

  const avgData = citySeries.map((p) => p.avg);
  const medData = citySeries.map((p) => p.med);
  const minData = citySeries.map((p) => p.min);
  const maxData = citySeries.map((p) => p.max);
  const vis = lineVisibility();
  const yBounds = yBoundsFromVisible(citySeries, vis);
  const turns = marks?.turns || [];

  const pointStyle = {
    pointRadius: 3,
    pointHoverRadius: 6,
    pointHitRadius: 10,
  };

  const datasets = [
    {
      label: 'Mean',
      data: avgData,
      borderColor: '#3d9cf5',
      backgroundColor: 'rgba(61, 156, 245, 0.1)',
      fill: false,
      tension: 0.2,
      hidden: !vis.avg,
      ...pointStyle,
    },
    {
      label: 'Median',
      data: medData,
      borderColor: '#a78bfa',
      backgroundColor: 'rgba(167, 139, 250, 0.1)',
      fill: false,
      tension: 0.2,
      hidden: !vis.med,
      ...pointStyle,
    },
    {
      label: 'Daily low',
      data: minData,
      borderColor: 'rgba(34, 197, 94, 0.75)',
      borderDash: [4, 4],
      tension: 0.2,
      hidden: !vis.min,
      ...pointStyle,
    },
    {
      label: 'Daily high',
      data: maxData,
      borderColor: 'rgba(239, 68, 68, 0.75)',
      borderDash: [4, 4],
      tension: 0.2,
      hidden: !vis.max,
      ...pointStyle,
    },
  ];

  if (statePoint) {
    datasets.push({
      label: 'State-wide now (Petrolmate)',
      data: labels.map((_, i) => (i === labels.length - 1 ? statePoint.avg : null)),
      borderColor: '#f59e0b',
      backgroundColor: '#f59e0b',
      pointRadius: 6,
      pointHoverRadius: 8,
      pointHitRadius: 12,
      showLine: false,
    });
  }

  historyChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    plugins: [cycleTurnLinesPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (_event, active) => {
        if (active?.length) syncCycleDialFromHover(active[0].index);
        else syncCycleDialFromHover(null);
      },
      plugins: {
        legend: { display: false },
        cycleTurnLines: { turns },
        title: {
          display: true,
          text: title || `${FUEL_LABELS[fuel] || fuel} — c/L`,
          color: '#e8edf4',
          font: { size: 14 },
        },
        tooltip: {
          callbacks: {
            label: (tipCtx) => {
              const v = tipCtx.parsed.y;
              if (v == null) return null;
              return `${tipCtx.dataset.label}: ${v.toFixed(1)}c`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b9cb3', maxTicksLimit: 12 } },
        y: {
          min: yBounds?.min,
          max: yBounds?.max,
          ticks: {
            color: '#8b9cb3',
            callback: (v) => `${Number(v).toFixed(1)}c`,
          },
          title: { display: true, text: 'c/L', color: '#8b9cb3' },
        },
      },
    },
  });

  const wrap = ctx.closest('.chart-wrap') || ctx.parentElement;
  if (wrap && !wrap._cycleLeaveBound) {
    wrap.addEventListener('mouseleave', resetCycleDialHover);
    wrap._cycleLeaveBound = true;
  }
}

function applyLineVisibility() {
  if (!historyChart) return;
  const vis = lineVisibility();
  const map = { Mean: vis.avg, Median: vis.med, 'Daily low': vis.min, 'Daily high': vis.max };
  historyChart.data.datasets.forEach((ds) => {
    if (Object.prototype.hasOwnProperty.call(map, ds.label)) ds.hidden = !map[ds.label];
  });
  const byLabel = Object.fromEntries(historyChart.data.datasets.map((ds) => [ds.label, ds.data]));
  const series = (byLabel.Mean || []).map((avg, i) => ({
    avg,
    med: byLabel.Median?.[i],
    min: byLabel['Daily low']?.[i],
    max: byLabel['Daily high']?.[i],
  }));
  const bounds = yBoundsFromVisible(series, vis);
  if (bounds) {
    historyChart.options.scales.y.min = bounds.min;
    historyChart.options.scales.y.max = bounds.max;
  } else {
    delete historyChart.options.scales.y.min;
    delete historyChart.options.scales.y.max;
  }
  historyChart.update();
}

function renderSummaryCards(stats, periodDays) {
  const el = document.getElementById('summaryCards');
  if (!stats) {
    el.innerHTML = '<p class="hint">No data for this fuel.</p>';
    return;
  }
  el.innerHTML = `
    <div class="summary-row"><span class="label">Latest mean</span><span class="value">${stats.latest.avg.toFixed(1)}c</span></div>
    <div class="summary-row"><span class="label">Latest median</span><span class="value">${stats.latest.med != null ? `${stats.latest.med.toFixed(1)}c` : '—'}</span></div>
    <div class="summary-row"><span class="label">Current low / high</span><span class="value">${stats.currentLow?.toFixed(1) ?? '—'} – ${stats.currentHigh?.toFixed(1) ?? '—'}c</span></div>
    <div class="summary-row"><span class="label">Period low / high (${periodDays}d)</span><span class="value">${stats.periodLow?.toFixed(1) ?? '—'} – ${stats.periodHigh?.toFixed(1) ?? '—'}c</span></div>
    <div class="summary-row"><span class="label">Stations (latest)</span><span class="value">${stats.latest.n ?? '—'}</span></div>
    <div class="summary-row"><span class="label">Days in chart</span><span class="value">${stats.days}</span></div>
  `;
}

function renderE10Box(file) {
  const box = document.getElementById('e10Compare');
  const u91 = file.fuels?.U91?.avg?.filter((v) => v != null).pop();
  const e10 = file.fuels?.E10?.avg?.filter((v) => v != null).pop();
  if (!u91 || !e10) {
    box.classList.add('hidden');
    return;
  }
  const u = u91 / 10;
  const e = e10 / 10;
  const cmp = compareE10VsU91(u, e);
  const best =
    cmp.pick === 'tie'
      ? 'Even (energy-adjusted)'
      : `${cmp.pick} by ${Math.abs(cmp.winPct).toFixed(1)}%`;
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="e10-head"><strong>E10 vs U91</strong></div>
    <p class="e10-note">Need ~3% pump price gap for E10 to win on energy density.</p>
    <p class="e10-prices">U91 ${u.toFixed(1)}c · E10 ${e.toFixed(1)}c (${cmp.priceDiscountPct.toFixed(1)}%)</p>
    <p class="e10-best"><strong>Best buy:</strong> ${best}</p>
  `;
}

async function fetchPetrolmateSummary(state) {
  const body = await fetchPetrolmate('summary');
  const st = body.states?.[state];
  if (!st) return null;
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    const fuel = PETROLMATE_FUEL[k];
    if (fuel && v?.avg != null) {
      out[fuel] = { avg: v.avg, min: v.min, max: v.max, n: v.stations };
    }
  }
  return out;
}

async function refreshCharts() {
  const state = document.getElementById('stateSelect').value;
  const fuel = document.getElementById('fuelSelect').value;
  const scope = selectedScope();
  const periodDays = selectedPeriod();
  const file = stateFiles[state];
  if (!file) return;

  const archive = await loadArchivesForState(state);
  const fullSeries = buildMergedSeries(file, archive, fuel);
  const series = sliceSeriesByPeriod(fullSeries, periodDays);
  const stats = seriesStats(series);
  const params = file.params?.[fuel];
  const marks = findChartCycleMarks(series, state);
  const cityStage = marks.turns.length
    ? inferCycleStageFromTurns(series.length - 1, marks.turns, series, params, state)
    : inferCycleStage(series, params);
  chartCycleCtx = {
    series,
    params,
    turns: marks.turns,
    state,
    latestStage: cityStage,
    hoverIndex: null,
  };

  const dataGran = file.granularity || 'state';
  const place = scopeLabel(state, scope);
  const chartTitleText = `${place} — ${FUEL_LABELS[fuel] || fuel}`;
  document.getElementById('chartTitle').textContent = chartTitleText;

  let hint =
    `Collected series is ${dataGran === 'metro' ? 'metro' : 'state-wide'} means. ` +
    `Showing last ${periodDays} days. Points are daily mean / median / low / high. ` +
    `Dotted: red = peak, green = bottom.`;
  if (scope !== dataGran) {
    hint +=
      scope === 'metro'
        ? ' · Scope set to metro; published file is state-wide (no separate metro series yet).'
        : ' · Scope set to whole state; published file is metro (state-wide history not stored).';
  }
  document.getElementById('seriesHint').textContent = hint;

  let statePoint = null;
  if (document.getElementById('overlaySummary').checked) {
    try {
      const summary = await fetchPetrolmateSummary(state);
      if (summary?.[fuel]) {
        statePoint = summary[fuel];
      }
    } catch (e) {
      console.warn('Petrolmate overlay:', e.message);
      document.getElementById('seriesHint').textContent +=
        ' · Live state overlay unavailable (use node viewer/serve.mjs).';
    }
  }

  renderHistoryChart(
    series.map((p) => p.date),
    series,
    statePoint,
    fuel,
    `${chartTitleText} (c/L)`,
    state,
    marks
  );
  renderSummaryCards(stats, periodDays);
  renderCycleDial(cityStage);
  renderE10Box(file);
}

async function loadAllStates() {
  setStatus('Loading index…');
  const index = await fetchJson(`${baseUrl()}/v1/index.json`);
  const select = document.getElementById('stateSelect');
  select.innerHTML = '';
  stateFiles = {};

  for (const st of index.states) {
    const code = st.code;
    select.innerHTML += `<option value="${code}">${code}</option>`;
    stateFiles[code] = await fetchJson(`${baseUrl()}/v1/${st.file}`);
  }

  setStatus(`Loaded ${index.states.length} states · window ${index.windowDays} days · ${index.source?.slice(0, 80)}…`);
  syncScopeDefaultFromFile();
  await refreshCharts();
}

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true }).setView([-33.87, 151.21], 10);
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 16,
    }
  ).addTo(map);
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: '',
      maxZoom: 16,
    }
  ).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  map.on('moveend zoomend', () => {
    updateMapZoomHint();
    scheduleStationFetch();
  });

  updateMapZoomHint();
}

function updateMapZoomHint() {
  const hint = document.getElementById('mapZoomHint');
  if (!hint || !map) return;
  hint.classList.toggle('hidden', map.getZoom() >= MIN_ZOOM_STATIONS);
}

function syncStationsSideHeight() {
  const mapBox = document.querySelector('.map-container');
  const side = document.querySelector('.stations-side');
  if (!mapBox || !side) return;
  const h = mapBox.clientHeight;
  if (h > 0) side.style.height = `${h}px`;
}

function syncMapToFuelGraphWidth() {
  const chartWrap = document.querySelector('.panel-chart .chart-wrap');
  const root = document.querySelector('.stations-panel') || document.documentElement;
  if (!chartWrap) return;
  const w = Math.round(chartWrap.getBoundingClientRect().width);
  if (w <= 0) return;
  root.style.setProperty('--fuel-graph-width', `${w}px`);
  syncStationsSideHeight();
  if (map) map.invalidateSize({ animate: false });
}

function watchMapSize() {
  const chartWrap = document.querySelector('.panel-chart .chart-wrap');
  if (!chartWrap || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    syncMapToFuelGraphWidth();
  });
  ro.observe(chartWrap);
}

function scheduleStationFetch() {
  if (!map || map.getZoom() < MIN_ZOOM_STATIONS) return;
  clearTimeout(stationFetchTimer);
  stationFetchTimer = setTimeout(() => {
    const c = map.getCenter();
    fetchStationsAround(c.lat, c.lng, { fromViewport: true });
  }, 450);
}

function pmFuelType(fuel) {
  return Object.entries(PETROLMATE_FUEL).find(([, v]) => v === fuel)?.[0] || 'ULP';
}

function stationFuelPrice(station, fuel) {
  const pm = pmFuelType(fuel);
  const row = station.fuels?.find((f) => f.type === pm);
  return row?.price ?? null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stationMarkerIcon(station, fuel, loaded) {
  const price = stationFuelPrice(station, fuel);
  const priceLabel = price != null ? `${price.toFixed(1)}c` : '—';
  const logo = window.brandLogoFor(station.brand);
  const effectiveLoaded = loaded && !stationFetchInFlight;
  const state = effectiveLoaded ? 'loaded' : 'pending';
  const active = selectedStationId === station.id ? ' active' : '';
  const showPrice = effectiveLoaded && price != null;

  return L.divIcon({
    className: 'station-div-icon',
    html: `
      <div class="station-marker ${state}${active}" data-id="${station.id}">
        ${showPrice ? `<span class="marker-price">${escapeHtml(priceLabel)}</span>` : ''}
        <div class="marker-pin-wrap">
          <div class="marker-pin-head">
            <img src="${logo}" alt="" />
          </div>
          <div class="marker-pin-tail"></div>
        </div>
      </div>
    `,
    iconSize: [52, 58],
    iconAnchor: [26, 58],
  });
}

function mergeStationsIntoCache(stations, markLoaded) {
  for (const st of stations) {
    if (!st.id) continue;
    const prev = stationCache.get(st.id);
    stationCache.set(st.id, {
      ...prev,
      ...st,
      loaded: markLoaded ? true : prev?.loaded || false,
    });
  }
}

function stationsInMapBounds() {
  if (!map) return [];
  const bounds = map.getBounds();
  const out = [];
  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng) continue;
    if (bounds.contains([st.lat, st.lng])) out.push(st);
  }
  out.sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
  return out;
}

function rebuildStationList() {
  const list = document.getElementById('stationList');
  const fuel = document.getElementById('fuelSelect').value;
  stationsLive = stationsInMapBounds();
  list.innerHTML = '';

  if (!stationsLive.length) {
    list.innerHTML = '<div class="station-item">No stations in view — pan/zoom or click a pin.</div>';
    return;
  }

  stationsLive.forEach((st) => {
    const price = stationFuelPrice(st, fuel);
    const priceStr = price != null ? `${price.toFixed(1)}c` : '—';
    const div = document.createElement('div');
    div.className = 'station-item';
    if (st.id === selectedStationId) div.classList.add('active');
    div.textContent = `${priceStr} · ${st.brand || ''} ${st.name}`;
    div.onclick = () => selectStationById(st.id);
    list.appendChild(div);
  });
}

function redrawStationMarkers() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  markerById.clear();

  const fuel = document.getElementById('fuelSelect').value;
  const bounds = map.getBounds();
  let count = 0;

  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng || !bounds.contains([st.lat, st.lng])) continue;
    if (count >= MAX_STATIONS_PER_REQUEST * 2) break;
    count++;

    const marker = L.marker([st.lat, st.lng], {
      icon: stationMarkerIcon(st, fuel, st.loaded),
      zIndexOffset: st.id === selectedStationId ? 1000 : 0,
    });

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      onStationPinClick(st);
    });

    marker.addTo(markerLayer);
    markerById.set(st.id, marker);
  }
}

function onStationPinClick(station) {
  selectStationById(station.id);
  fetchStationsAround(station.lat, station.lng, {
    anchorId: station.id,
    recenter: true,
  });
}

async function fetchStationsAround(lat, lng, opts = {}) {
  initMap();
  if (map.getZoom() < MIN_ZOOM_STATIONS && opts.fromViewport) return;

  const qs = `lat=${lat}&lng=${lng}&radius=${MAX_RADIUS_M}&limit=${MAX_STATIONS_PER_REQUEST}`;
  const list = document.getElementById('stationList');

  if (!opts.silent) {
    setStatus(`Loading stations within 25 km of ${lat.toFixed(3)}, ${lng.toFixed(3)}…`);
  }

  if (!stationFetchInFlight) {
    redrawStationMarkers();
  }

  stationFetchInFlight = true;
  redrawStationMarkers();
  if (!opts.fromViewport) {
    list.innerHTML = '<div class="station-item">Fetching stations…</div>';
  }

  try {
    const data = await fetchPetrolmate('area', qs);
    mergeStationsIntoCache(data.stations || [], true);
    if (opts.recenter) {
      map.setView([lat, lng], Math.max(map.getZoom(), 12));
    }
    redrawStationMarkers();
    rebuildStationList();
    if (!opts.silent) {
      setStatus(
        `Showing ${stationsInMapBounds().length} stations in view (${stationCache.size} cached in area).`
      );
    }
    if (opts.anchorId) selectStationById(opts.anchorId);
  } catch (err) {
    if (!opts.fromViewport) {
      list.innerHTML = `<div class="station-item">Failed: ${err.message}</div>`;
      setStatus(`Stations failed: ${err.message}`);
    }
  } finally {
    stationFetchInFlight = false;
    redrawStationMarkers();
    updateMapZoomHint();
    setTimeout(() => {
      syncMapToFuelGraphWidth();
    }, 100);
  }
}

function petrolmateFuelToCanon(type) {
  const m = { ULP: 'U91', E10: 'E10', PULP95: 'P95', PULP98: 'P98', DIESEL: 'DSL', PDIESEL: 'PDSL' };
  return m[type] || type;
}

function selectStationById(id) {
  const st = stationCache.get(id);
  if (!st) return;
  selectedStationId = id;
  redrawStationMarkers();
  rebuildStationList();

  const lines = [
    `<strong>${escapeHtml(st.brand || '')} ${escapeHtml(st.name || '')}</strong>`,
    `${escapeHtml(st.address || '')}, ${escapeHtml(st.suburb || '')} ${escapeHtml(st.state || '')}`,
    st.distance_m != null ? `Distance: ${st.distance_m}m` : '',
    '<table style="width:100%;margin-top:0.5rem"><tr><th>Fuel</th><th>c/L</th></tr>',
  ];
  const priceMap = {};
  for (const f of st.fuels || []) {
    const canon = petrolmateFuelToCanon(f.type);
    priceMap[canon] = f.price;
    lines.push(`<tr><td>${escapeHtml(f.name || f.type)}</td><td>${f.price?.toFixed(1) ?? '—'}</td></tr>`);
  }
  lines.push('</table>');

  if (priceMap.U91 && priceMap.E10) {
    const cmp = compareE10VsU91(priceMap.U91, priceMap.E10);
    if (cmp.pick === 'tie') {
      lines.push('<p><strong>Best buy:</strong> Even (energy-adjusted)</p>');
    } else {
      const other = cmp.pick === 'E10' ? 'U91' : 'E10';
      lines.push(
        `<p><strong>Best buy:</strong> ${cmp.pick} — ${Math.abs(cmp.winPct).toFixed(1)}% better than ${other}</p>`
      );
    }
  }

  const key = String(st.id);
  if (!stationSnapshots[key]) stationSnapshots[key] = [];
  stationSnapshots[key].push({
    date: new Date().toISOString().slice(0, 10),
    prices: { ...priceMap },
  });

  const fuel = document.getElementById('fuelSelect').value;
  const stage = inferCycleStage(
    stationSnapshots[key]
      .map((snap) => ({
        avg: snap.prices[fuel] ?? snap.prices.U91,
        min: snap.prices[fuel] ?? snap.prices.U91,
        max: snap.prices[fuel] ?? snap.prices.U91,
      }))
      .filter((p) => p.avg != null),
    null
  );
  lines.push(`<p>Cycle stage (session): <span class="badge ${stage.stage}">${stage.label}</span></p>`);

  document.getElementById('stationDetail').innerHTML = lines.join('');
  renderStationChart(key);
}

function goToCapital() {
  const code = document.getElementById('capitalSelect').value;
  const c = CAPITALS[code];
  document.getElementById('stateSelect').value = code;
  refreshCharts().catch(() => {});
  initMap();
  map.setView([c.lat, c.lng], 12);
  updateMapZoomHint();
  fetchStationsAround(c.lat, c.lng, { recenter: false });
}

function renderStationChart(stationKey) {
  const fuel = document.getElementById('fuelSelect').value;
  const snaps = stationSnapshots[stationKey] || [];
  const hint = document.getElementById('stationChartHint');
  const ctx = document.getElementById('stationChart');
  stationChart = destroyChart(stationChart);

  const points = snaps
    .map((s) => ({ date: s.date, v: s.prices[fuel] }))
    .filter((p) => p.v != null);

  if (points.length < 2) {
    hint.textContent = 'Need 2+ snapshots in this session for a station trend line.';
    return;
  }
  hint.textContent = `${points.length} snapshot(s) in this browser session.`;

  stationChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map((p) => p.date),
      datasets: [
        {
          label: fuel,
          data: points.map((p) => p.v),
          borderColor: '#a78bfa',
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: (v) => `${Number(v).toFixed(1)}c` } },
      },
    },
  });
}

function initCapitalSelect() {
  const sel = document.getElementById('capitalSelect');
  sel.innerHTML = Object.entries(CAPITALS)
    .map(([code, c]) => `<option value="${code}">${c.name} (${code})</option>`)
    .join('');
}

function syncScopeDefaultFromFile() {
  const state = document.getElementById('stateSelect').value;
  const file = stateFiles[state];
  if (!file) return;
  const sel = document.getElementById('scopeSelect');
  if (sel && file.granularity) sel.value = file.granularity === 'metro' ? 'metro' : 'state';
}

function init() {
  initCapitalSelect();
  initMap();

  const refresh = () => refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));

  document.getElementById('btnLoad').onclick = () =>
    loadAllStates().catch((e) => setStatus(`Error: ${e.message}`));
  document.getElementById('stateSelect').onchange = () => {
    syncScopeDefaultFromFile();
    refresh();
  };
  document.getElementById('scopeSelect').onchange = refresh;
  document.getElementById('periodSelect').onchange = refresh;
  document.getElementById('fuelSelect').onchange = () => {
    refresh();
    redrawStationMarkers();
    rebuildStationList();
  };
  document.getElementById('overlaySummary').onchange = refresh;
  document.getElementById('showAvg').onchange = () => applyLineVisibility();
  document.getElementById('showMed').onchange = () => applyLineVisibility();
  document.getElementById('showMin').onchange = () => applyLineVisibility();
  document.getElementById('showMax').onchange = () => applyLineVisibility();

  document.getElementById('btnLoadStations').onclick = () => goToCapital();

  window.addEventListener('resize', () => {
    syncMapToFuelGraphWidth();
  });
  watchMapSize();
  requestAnimationFrame(() => {
    syncMapToFuelGraphWidth();
  });
}

init();
