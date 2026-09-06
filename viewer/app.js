/* Aus Fuel Watch — browser data viewer */

const DAY_MS = 86400000;
const E10_ENERGY_RATIO = 0.97;

/** Tooltip Y follows the mouse; X stays near the hovered day column. */
if (typeof Chart !== 'undefined' && Chart.Tooltip?.positioners) {
  Chart.Tooltip.positioners.mouseHeight = function (items, eventPosition) {
    const base =
      typeof Chart.Tooltip.positioners.nearest === 'function'
        ? Chart.Tooltip.positioners.nearest.call(this, items, eventPosition)
        : null;
    return {
      x: base?.x ?? eventPosition.x,
      y: eventPosition.y,
    };
  };
}
const FUEL_LABELS = {
  U91: 'Unleaded 91',
  E10: 'E10',
  P95: 'Premium 95',
  P98: 'Premium 98',
  DSL: 'Diesel',
  PDSL: 'Premium diesel',
};
const SCOPE_IDS = ['metro', 'regional', 'state'];
/** Disable a scope option when latest station count is below this. */
const MIN_SCOPE_N = 25;
const MIN_SCOPE_N_OVERRIDE = {
  TAS: { E10: 2 },
  ACT: { DSL: 10, regional: 5 },
  NT: { regional: 10 },
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

/** Published per-station history from docs/v1/stations/ */
const publishedStationCache = {
  catalogs: /** @type {Record<string, object>} */ ({}),
  days: /** @type {Record<string, object>} */ ({}),
};
/** @type {{ state: string, publishedId: string, byDate: Map<string, number>, daysLoaded: number } | null} */
let selectedPublishedHistory = null;

/** Series + params for chart hover → cycle dial sync */
let chartCycleCtx = {
  series: [],
  fullSeries: [],
  params: null,
  turns: [],
  fftOverlay: null,
  statePoint: null,
  state: null,
  modelId: 'current',
  latestStage: null,
  /** Sticky last-hovered day; dial + yellow cursor stay here until another day is hovered. */
  selectedIndex: null,
};

function selectedCycleModelId() {
  const el = document.getElementById('cycleModelSelect');
  const raw = el?.value || localStorage.getItem(CycleModels.STORAGE_KEY) || CycleModels.DEFAULT_ID;
  return CycleModels.get(raw).id;
}

/** WA always uses the FuelWatch weekly model (Current), regardless of dropdown. */
function effectiveCycleModelId(state) {
  if (state === 'WA') return 'current';
  return selectedCycleModelId();
}

function populateCycleModelSelect() {
  const el = document.getElementById('cycleModelSelect');
  if (!el || !window.CycleModels) return;
  const saved = localStorage.getItem(CycleModels.STORAGE_KEY) || CycleModels.DEFAULT_ID;
  el.innerHTML = CycleModels.MODELS.map(
    (m) =>
      `<option value="${m.id}"${m.id === saved ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('');
}

function pct(n) {
  return `${Math.round(Number(n) * 100)}%`;
}

function applyTurnTuneToInputs() {
  if (!window.CycleModels?.getTurnTune) return;
  const t = CycleModels.getTurnTune();
  const sens = document.getElementById('tuneTurnSensitivity');
  const gap = document.getElementById('tuneTurnMinGap');
  const coarse = document.getElementById('tuneTurnCoarseness');
  const fft = document.getElementById('tuneTurnFft');
  if (sens) sens.value = String(t.sensitivity);
  if (gap) gap.value = String(t.minGapDays);
  if (coarse) coarse.value = String(t.coarseness);
  if (fft) fft.value = String(t.fftAssist ?? 0);
  updateTurnTuneLabels();
}

function updateTurnTuneLabels() {
  if (!window.CycleModels?.getTurnTune) return;
  const t = CycleModels.getTurnTune();
  const sensEl = document.getElementById('tuneTurnSensitivityVal');
  const gapEl = document.getElementById('tuneTurnMinGapVal');
  const coarseEl = document.getElementById('tuneTurnCoarsenessVal');
  const fftEl = document.getElementById('tuneTurnFftVal');
  if (sensEl) sensEl.textContent = String(t.sensitivity);
  if (gapEl) gapEl.textContent = `${t.minGapDays}d`;
  if (coarseEl) coarseEl.textContent = String(t.coarseness);
  if (fftEl) fftEl.textContent = String(t.fftAssist ?? 0);
}

let turnTuneRefreshTimer = null;
function onTurnTuneInput() {
  if (!window.CycleModels?.setTurnTune) return;
  CycleModels.setTurnTune({
    sensitivity: Number(document.getElementById('tuneTurnSensitivity')?.value),
    minGapDays: Number(document.getElementById('tuneTurnMinGap')?.value),
    coarseness: Number(document.getElementById('tuneTurnCoarseness')?.value),
    fftAssist: Number(document.getElementById('tuneTurnFft')?.value),
  });
  updateTurnTuneLabels();
  clearTimeout(turnTuneRefreshTimer);
  turnTuneRefreshTimer = setTimeout(() => {
    refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
  }, 120);
}

function initTurnTuneControls() {
  applyTurnTuneToInputs();
  for (const id of [
    'tuneTurnSensitivity',
    'tuneTurnMinGap',
    'tuneTurnCoarseness',
    'tuneTurnFft',
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.oninput = onTurnTuneInput;
  }
  const reset = document.getElementById('tuneTurnReset');
  if (reset) {
    reset.onclick = () => {
      CycleModels.resetTurnTune();
      applyTurnTuneToInputs();
      refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
    };
  }
}

function syncWaWeeklyAfterLastVisibility() {
  const label = document.getElementById('waWeeklyAfterLastLabel');
  if (!label) return;
  const state = document.getElementById('stateSelect')?.value;
  label.classList.toggle('hidden', state !== 'WA');
}

function initWaWeeklyAfterLastControl() {
  const el = document.getElementById('waWeeklyAfterLast');
  if (!el || !window.CycleModels?.waWeeklyAfterLastEnabled) return;
  el.checked = CycleModels.waWeeklyAfterLastEnabled();
  el.onchange = () => {
    CycleModels.setWaWeeklyAfterLast(el.checked);
    refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
  };
  syncWaWeeklyAfterLastVisibility();
}

function syncArcpathTuneVisibility() {
  const box = document.getElementById('arcpathTune');
  if (!box) return;
  const show = selectedCycleModelId() === 'arcpath';
  box.classList.toggle('hidden', !show);
  requestAnimationFrame(() => syncChartHeightToSummary());
}

function initTuneFoldHeightSync() {
  for (const id of ['turnDetectFold', 'arcpathTune']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('toggle', () => {
      requestAnimationFrame(() => syncChartHeightToSummary());
    });
  }
}

function applyArcpathTuneToInputs() {
  if (!window.CycleModels?.getArcpathTune) return;
  const t = CycleModels.getArcpathTune();
  const base = document.getElementById('tunePathBase');
  const scale = document.getElementById('tunePathScale');
  const edge = document.getElementById('tuneExtremeEdge');
  const prior = document.getElementById('tunePriorExtreme');
  const fftDial = document.getElementById('tuneFftDial');
  if (base) base.value = String(Math.round(t.pathBase * 100));
  if (scale) scale.value = String(Math.round(t.pathScale * 100));
  if (edge) edge.value = String(Math.round(t.extremeEdge * 100));
  if (prior) prior.value = String(Math.round((t.priorExtreme ?? 0) * 100));
  if (fftDial) fftDial.value = String(Math.round((t.fftDial ?? 0) * 100));
  updateArcpathTuneLabels();
}

function updateArcpathTuneLabels() {
  if (!window.CycleModels?.getArcpathTune) return;
  const t = CycleModels.getArcpathTune();
  const baseEl = document.getElementById('tunePathBaseVal');
  const scaleEl = document.getElementById('tunePathScaleVal');
  const edgeEl = document.getElementById('tuneExtremeEdgeVal');
  const priorEl = document.getElementById('tunePriorExtremeVal');
  const fftEl = document.getElementById('tuneFftDialVal');
  const hint = document.getElementById('tuneArcpathHint');
  if (baseEl) baseEl.textContent = pct(t.pathBase);
  if (scaleEl) scaleEl.textContent = pct(t.pathScale);
  if (edgeEl) edgeEl.textContent = pct(t.extremeEdge);
  if (priorEl) priorEl.textContent = pct(t.priorExtreme ?? 0);
  if (fftEl) fftEl.textContent = pct(t.fftDial ?? 0);
  if (hint) {
    const lo = Math.round(t.pathBase * 100);
    const hi = Math.round((t.pathBase + t.pathScale) * 100);
    hint.textContent =
      `Path ≈ ${lo}–${Math.min(100, hi)}% (rest arc), prior ${Math.round((t.priorExtreme ?? 0) * 100)}%, ` +
      `FFT dial ${Math.round((t.fftDial ?? 0) * 100)}%. Peak/bottom width ${Math.round(t.extremeEdge * 100)}%.`;
  }
}

function restageCycleDialFromTune() {
  const series = chartCycleCtx.series;
  if (!series?.length) return;
  const idx =
    chartCycleCtx.selectedIndex != null && chartCycleCtx.selectedIndex >= 0
      ? chartCycleCtx.selectedIndex
      : series.length - 1;
  const stage = cycleStageForIndex(idx);
  if (idx === series.length - 1) chartCycleCtx.latestStage = stage;
  renderCycleDial(stage, {
    asOf: series[idx]?.date,
  });
}

function onArcpathTuneInput() {
  if (!window.CycleModels?.setArcpathTune) return;
  const base = Number(document.getElementById('tunePathBase')?.value);
  const scale = Number(document.getElementById('tunePathScale')?.value);
  const edge = Number(document.getElementById('tuneExtremeEdge')?.value);
  const prior = Number(document.getElementById('tunePriorExtreme')?.value);
  const fftDial = Number(document.getElementById('tuneFftDial')?.value);
  CycleModels.setArcpathTune({
    pathBase: base / 100,
    pathScale: scale / 100,
    extremeEdge: edge / 100,
    priorExtreme: prior / 100,
    fftDial: fftDial / 100,
  });
  updateArcpathTuneLabels();
  restageCycleDialFromTune();
}

function initArcpathTuneControls() {
  applyArcpathTuneToInputs();
  syncArcpathTuneVisibility();
  for (const id of [
    'tunePathBase',
    'tunePathScale',
    'tuneExtremeEdge',
    'tunePriorExtreme',
    'tuneFftDial',
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.oninput = onArcpathTuneInput;
  }
  const reset = document.getElementById('tuneArcpathReset');
  if (reset) {
    reset.onclick = () => {
      CycleModels.resetArcpathTune();
      applyArcpathTuneToInputs();
      restageCycleDialFromTune();
    };
  }
}

/** Match history chart plot height so the chart panel bottom aligns with Summary. */
function syncChartHeightToSummary() {
  const summary = document.querySelector('.panel-summary');
  const chartPanel = document.querySelector('.panel-chart');
  const wrap = document.querySelector('.panel-chart .chart-wrap');
  if (!summary || !chartPanel || !wrap) return;
  if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
    wrap.style.height = '';
    historyChart?.resize();
    return;
  }
  const summaryH = summary.getBoundingClientRect().height;
  if (summaryH < 200) return;

  const panelStyle = getComputedStyle(chartPanel);
  const padY =
    (parseFloat(panelStyle.paddingTop) || 0) + (parseFloat(panelStyle.paddingBottom) || 0);
  let chrome = 0;
  for (const child of chartPanel.children) {
    if (child === wrap || child.classList?.contains('chart-wrap')) continue;
    const r = child.getBoundingClientRect();
    const cs = getComputedStyle(child);
    chrome += r.height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  const h = Math.max(200, Math.round(summaryH - padY - chrome));
  const next = `${h}px`;
  if (wrap.style.height !== next) wrap.style.height = next;
  historyChart?.resize();
}

function watchSummaryChartHeight() {
  const summary = document.querySelector('.panel-summary');
  if (!summary || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    syncChartHeightToSummary();
  });
  ro.observe(summary);
}

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
    cache: 'no-store',
    ...opts,
    headers: {
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function expandFileSeries(file, fuel, scope) {
  const fuels = fuelsForScope(file, scope);
  const s = fuels?.[fuel];
  if (!file.start || !s) return [];
  const start = isoToDayNum(file.start);
  let first = -1;
  let last = -1;
  for (let i = 0; i < file.days; i++) {
    if (
      s.avg[i] != null ||
      s.gmean?.[i] != null ||
      s.mode?.[i] != null ||
      s.med?.[i] != null ||
      s.min?.[i] != null ||
      s.max?.[i] != null
    ) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return [];

  const out = [];
  for (let i = first; i <= last; i++) {
    out.push({
      date: dayNumToISO(start + i),
      avg: s.avg[i] != null ? s.avg[i] / 10 : null,
      gmean: s.gmean?.[i] != null ? s.gmean[i] / 10 : null,
      mode: s.mode?.[i] != null ? s.mode[i] / 10 : null,
      med: s.med?.[i] != null ? s.med[i] / 10 : null,
      min: s.min?.[i] != null ? s.min[i] / 10 : null,
      max: s.max?.[i] != null ? s.max[i] / 10 : null,
      n: s.n?.[i] ?? null,
    });
  }
  return out;
}

function fuelsForScope(file, scope) {
  if (file.scopes?.[scope]) return file.scopes[scope];
  // Legacy single-series files: expose only under their published granularity.
  if (!file.scopes) {
    const legacy = file.granularity === 'metro' ? 'metro' : 'state';
    if (!scope || scope === legacy) return file.fuels;
    return null;
  }
  return null;
}

function latestScopeN(file, fuel, scope) {
  const s = fuelsForScope(file, scope)?.[fuel];
  if (!s?.n) return null;
  for (let i = s.n.length - 1; i >= 0; i--) {
    if (s.n[i] != null) return s.n[i];
  }
  return null;
}

function minScopeN(state, fuel, scope) {
  const byState = MIN_SCOPE_N_OVERRIDE[state];
  if (byState) {
    if (byState[fuel] !== undefined) return byState[fuel];
    if (scope === 'regional' && byState.regional !== undefined) return byState.regional;
  }
  return scope === 'regional' ? Math.min(MIN_SCOPE_N, 10) : MIN_SCOPE_N;
}

function scopeIsAvailable(file, fuel, scope) {
  if (!file.scopes) {
    const legacy = file.granularity === 'metro' ? 'metro' : 'state';
    if (scope !== legacy) return false;
  }
  const series = expandFileSeries(file, fuel, scope);
  if (!series.some((p) => p.avg != null)) return false;
  const n = latestScopeN(file, fuel, scope);
  if (n == null) return true;
  return n >= minScopeN(file.state, fuel, scope);
}

function preferredScope(file, fuel) {
  for (const sc of ['metro', 'state', 'regional']) {
    if (scopeIsAvailable(file, fuel, sc)) return sc;
  }
  return file.defaultScope || file.granularity || 'metro';
}

function mergeArchiveIntoSeries(archiveByFuel, fuel, dayMap) {
  const arch = archiveByFuel[fuel];
  if (!arch) return;
  for (const [date, row] of Object.entries(arch)) {
    if (!dayMap[date]) {
      dayMap[date] = {
        date,
        avg: row.avg / 10,
        gmean: row.gmean != null ? row.gmean / 10 : null,
        mode: row.mode != null ? row.mode / 10 : null,
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

function buildMergedSeries(file, archiveByFuel, fuel, scope) {
  const dayMap = {};
  const sc = scope || file.defaultScope || file.granularity || 'metro';
  // Archives are a single legacy series — only overlay on the default/primary scope.
  const primary = file.defaultScope || file.granularity || 'metro';
  if (sc === primary || !file.scopes) {
    mergeArchiveIntoSeries(archiveByFuel, fuel, dayMap);
  }
  for (const p of expandFileSeries(file, fuel, sc)) dayMap[p.date] = p;
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
  let latest = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]?.avg != null) {
      latest = points[i];
      break;
    }
  }
  if (!latest) latest = points[points.length - 1];
  return {
    latest,
    currentLow: latest.min ?? null,
    currentHigh: latest.max ?? null,
    periodLow: mins.length ? Math.min(...mins) : null,
    periodHigh: maxs.length ? Math.max(...maxs) : null,
    days: points.filter((p) => p.avg != null).length,
  };
}

function scopeLabel(state, scope) {
  if (scope === 'metro') {
    const city = CAPITALS[state]?.name;
    return city ? `${city} metro` : `${state} metro`;
  }
  if (scope === 'regional') {
    return `${state} regional`;
  }
  return `${state} statewide`;
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
  const avgs = points.map((p) => p.avg).filter((v) => v != null);
  if (avgs.length < 5) {
    return { ...base, stage: 'unknown', label: 'Not enough history' };
  }
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

function cycleStageForIndex(dataIndex) {
  const { series, params, turns, state, modelId } = chartCycleCtx;
  if (!series?.length || dataIndex == null || dataIndex < 0) return null;
  const id = modelId || effectiveCycleModelId(state);
  // Dial must use the same series + peak/bottom turns as the chart lines,
  // otherwise hover/latest stages jump independently of the markers.
  if (window.CycleModels) {
    return CycleModels.stageAt(id, dataIndex, {
      series,
      turns: turns || [],
      params,
      state,
    });
  }
  return inferCycleStage(series.slice(0, dataIndex + 1), params);
}

function turnAvg(avgs, t) {
  return t?.index != null ? avgs[t.index] : null;
}

function isStrongerTurn(avgs, candidate, incumbent) {
  const a = turnAvg(avgs, candidate);
  const b = turnAvg(avgs, incumbent);
  if (candidate.type === 'peak') return (a ?? -Infinity) >= (b ?? -Infinity);
  return (a ?? Infinity) <= (b ?? Infinity);
}

/**
 * Collapse overlapping candidates, then force peak↔trough alternation.
 * Sliding windows often emit peak-peak / trough-trough pairs; keep the
 * stronger extreme so chart lines stay a coherent cycle.
 */
function consolidateVisibleTurns(series, turns, minSep) {
  const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
  const sorted = [...turns].sort(
    (a, b) => a.index - b.index || String(a.type).localeCompare(String(b.type))
  );
  const nearby = [];
  for (const t of sorted) {
    const prev = nearby[nearby.length - 1];
    if (prev && prev.index === t.index && prev.type === t.type) continue;
    if (prev && prev.type === t.type && t.index - prev.index < minSep) {
      if (isStrongerTurn(avgs, t, prev)) nearby[nearby.length - 1] = t;
      continue;
    }
    nearby.push(t);
  }

  const alt = [];
  for (const t of nearby) {
    const prev = alt[alt.length - 1];
    if (prev && prev.type === t.type) {
      if (isStrongerTurn(avgs, t, prev)) alt[alt.length - 1] = t;
      continue;
    }
    alt.push(t);
  }
  return alt;
}

/**
 * Peak/bottom lines from turn-detect sliders on the visible Period series.
 * Dial + prior-extreme use these same turns (no separate cycle window).
 */
function findChartCycleMarks(fullSeries, visibleSeries, state) {
  if (!window.CycleModels) {
    return { turns: [], modelId: 'current' };
  }
  const id = effectiveCycleModelId(state);
  let turns = CycleModels.findTurns(id, visibleSeries, state) || [];
  const params = CycleModels.resolveTurnDetectParams?.(state);
  const minSep = params?.minGap ?? 5;
  turns = consolidateVisibleTurns(visibleSeries, turns, minSep);

  let fftOverlay = null;
  const tune = CycleModels.getTurnTune?.();
  if ((tune?.fftAssist ?? 0) > 0 && CycleModels.buildFftChartOverlay) {
    fftOverlay = CycleModels.buildFftChartOverlay(visibleSeries);
  }
  return { turns, modelId: id, fftOverlay };
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

/** Yellow dotted cursor for the hovered / selected day. */
const hoverCursorLinePlugin = {
  id: 'hoverCursorLine',
  afterDatasetsDraw(chart, _args, opts) {
    const idx = opts?.index;
    if (idx == null || idx < 0) return;
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    if (!xScale || !chartArea) return;
    const x = xScale.getPixelForValue(idx);
    if (x < chartArea.left || x > chartArea.right) return;

    ctx.save();
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function setHoverCursorLine(dataIndex) {
  if (!historyChart) return;
  const plug = historyChart.options.plugins.hoverCursorLine || {};
  const next = dataIndex != null && dataIndex >= 0 ? dataIndex : null;
  if (plug.index === next) return;
  historyChart.options.plugins.hoverCursorLine = { index: next };
  historyChart.update('none');
}

function applySelectedDay(dataIndex) {
  const series = chartCycleCtx.series;
  if (!series?.length || dataIndex == null || dataIndex < 0) return;
  chartCycleCtx.selectedIndex = dataIndex;
  setHoverCursorLine(dataIndex);
  const stage = cycleStageForIndex(dataIndex);
  if (dataIndex === series.length - 1) chartCycleCtx.latestStage = stage;
  renderCycleDial(stage, {
    asOf: series[dataIndex]?.date,
  });
}

function syncCycleDialFromHover(dataIndex) {
  // Ignore leave / empty hover — keep last selected day sticky.
  if (dataIndex == null || dataIndex < 0) return;
  if (dataIndex === chartCycleCtx.selectedIndex) return;
  applySelectedDay(dataIndex);
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

  const asOf = opts.asOf || '';
  const model = window.CycleModels && CycleModels.get(chartCycleCtx.modelId || selectedCycleModelId());
  const L = model?.dialLabels || {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
  };

  el.innerHTML = `
    <div class="cycle-dial-wrap" title="Price cycle position (collected series)">
      <svg class="cycle-dial" viewBox="-8 -4 216 208" role="img" aria-label="Cycle: ${stage.label}">
        <circle class="ring-track" cx="${cx}" cy="${cy}" r="${r}" />
        ${arcSvg}
        <circle class="hub" cx="${cx}" cy="${cy}" r="28" />
        <text class="cycle-label label-peak" x="${peak.x.toFixed(1)}" y="${peak.y.toFixed(1)}" dy="0.35em">${L.peak}</text>
        <text class="cycle-label label-falling" x="${falling.x.toFixed(1)}" y="${falling.y.toFixed(1)}" dy="0.35em">${L.falling}</text>
        <text class="cycle-label label-bottom" x="${bottom.x.toFixed(1)}" y="${bottom.y.toFixed(1)}" dy="0.35em">${L.bottom}</text>
        <text class="cycle-label label-rising" x="${rising.x.toFixed(1)}" y="${rising.y.toFixed(1)}" dy="0.35em">${L.rising}</text>
        ${marker}
      </svg>
    </div>
    <p class="cycle-meta"><strong>${stage.label}</strong>${asOf ? ` · ${asOf}` : ''}</p>
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
    gmean: document.getElementById('showGmean')?.checked === true,
    mode: document.getElementById('showMode')?.checked === true,
    med: document.getElementById('showMed')?.checked !== false,
    min: document.getElementById('showMin')?.checked !== false,
    max: document.getElementById('showMax')?.checked !== false,
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Align selected station live + session + published prices onto chart date labels. */
function selectedStationChartOverlay(labels, fuel) {
  if (selectedStationId == null || !labels?.length) return null;
  const st = stationCache.get(selectedStationId);
  if (!st) return null;
  const fuelKey = fuel || document.getElementById('fuelSelect').value;
  const byDate = new Map();

  if (selectedPublishedHistory?.byDate) {
    for (const [d, v] of selectedPublishedHistory.byDate) {
      if (v != null && Number.isFinite(v)) byDate.set(d, v);
    }
  }
  for (const snap of stationSnapshots[String(st.id)] || []) {
    const v = snap.prices?.[fuelKey];
    if (v != null && Number.isFinite(v) && snap.date) byDate.set(snap.date, v);
  }
  const live = stationFuelPrice(st, fuelKey);
  if (live != null && Number.isFinite(live)) {
    byDate.set(labels[labels.length - 1], live);
  }
  const data = labels.map((d) => (byDate.has(d) ? byDate.get(d) : null));
  const n = data.filter((v) => v != null).length;
  if (!n) return null;
  const brand = (st.brand || '').trim();
  const name = (st.name || '').trim();
  let label = [brand, name].filter(Boolean).join(' ') || 'Station';
  if (selectedPublishedHistory?.daysLoaded) {
    label += ` (${selectedPublishedHistory.daysLoaded}d hist)`;
  }
  return { label, data, showLine: n >= 2, pointCount: n };
}

async function loadPublishedCatalog(state) {
  if (!state) return null;
  if (publishedStationCache.catalogs[state]) return publishedStationCache.catalogs[state];
  try {
    const cat = await fetchJson(`${baseUrl()}/v1/stations/${state}/catalog.json`);
    publishedStationCache.catalogs[state] = cat;
    return cat;
  } catch (_) {
    publishedStationCache.catalogs[state] = null;
    return null;
  }
}

async function loadPublishedDay(state, iso) {
  const key = `${state}|${iso}`;
  if (Object.prototype.hasOwnProperty.call(publishedStationCache.days, key)) {
    return publishedStationCache.days[key];
  }
  try {
    const day = await fetchJson(`${baseUrl()}/v1/stations/${state}/days/${iso}.json`);
    publishedStationCache.days[key] = day;
    return day;
  } catch (_) {
    publishedStationCache.days[key] = null;
    return null;
  }
}

function normMatchText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuelwatchIdFromParts(name, suburb) {
  return `fuelwatch:WA:${normMatchText(name)}|${normMatchText(suburb)}`;
}

/** Match map/live pin to published catalog: GPS first, then WA name+suburb (+postcode). */
function matchPublishedStationId(pmStation, catalog) {
  if (!pmStation || !catalog?.stations) return null;

  const lat = Number(pmStation.lat);
  const lng = Number(pmStation.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let bestId = null;
    let bestKm = 0.08; // 80 m
    for (const [id, meta] of Object.entries(catalog.stations)) {
      if (meta?.lat == null || meta?.lng == null) continue;
      const km = haversineKm(lat, lng, Number(meta.lat), Number(meta.lng));
      if (km < bestKm) {
        bestKm = km;
        bestId = id;
      }
    }
    if (bestId) return bestId;
  }

  // WA FuelWatch: retail archives + RSS share trading-name|suburb ids.
  const name = pmStation.name || '';
  const suburb = pmStation.suburb || '';
  const pc =
    pmStation.postcode != null && String(pmStation.postcode).trim() !== ''
      ? Number(pmStation.postcode)
      : null;

  const directId = fuelwatchIdFromParts(name, suburb);
  if (catalog.stations[directId]) return directId;

  const nName = normMatchText(name);
  const nSuburb = normMatchText(suburb);
  let postcodeHit = null;
  let suburbHit = null;

  for (const [id, meta] of Object.entries(catalog.stations)) {
    const mName = normMatchText(meta.name);
    const mSuburb = normMatchText(meta.suburb);
    const mPc = meta.postcode != null ? Number(meta.postcode) : null;

    if (nName && mName === nName && nSuburb && mSuburb === nSuburb) return id;

    if (Number.isFinite(pc) && mPc === pc && nName && mName === nName) {
      postcodeHit = id;
    }
    if (nSuburb && mSuburb === nSuburb && nName && (mName.includes(nName) || nName.includes(mName))) {
      suburbHit = id;
    }
  }
  return postcodeHit || suburbHit || null;
}

function pricesFromPublishedDay(dayFile, stationId) {
  if (!dayFile || !stationId) return null;
  if (dayFile.stations && dayFile.stations[stationId]) return dayFile.stations[stationId];
  for (const row of dayFile.s || []) {
    if (Array.isArray(row) && row[0] === stationId) return row[1];
  }
  return null;
}

/**
 * Load published tenths prices for a map station, convert to c/L for the chart fuel.
 * @returns {Promise<{ state: string, publishedId: string, byDate: Map<string, number>, daysLoaded: number } | null>}
 */
async function loadPublishedHistoryForStation(st, labels, fuel) {
  const state =
    st.state ||
    document.getElementById('stateSelect')?.value ||
    chartCycleCtx.state;
  if (!state || !labels?.length) return null;

  const catalog = await loadPublishedCatalog(state);
  if (!catalog) return null;
  const publishedId = matchPublishedStationId(st, catalog);
  if (!publishedId) return null;

  const byDate = new Map();
  const uniqueDates = [...new Set(labels.filter(Boolean))];
  const concurrency = 8;
  for (let i = 0; i < uniqueDates.length; i += concurrency) {
    const chunk = uniqueDates.slice(i, i + concurrency);
    const days = await Promise.all(chunk.map((iso) => loadPublishedDay(state, iso)));
    days.forEach((day, j) => {
      const prices = pricesFromPublishedDay(day, publishedId);
      const tenths = prices?.[fuel];
      if (tenths != null && Number.isFinite(tenths)) {
        byDate.set(chunk[j], tenths / 10);
      }
    });
  }

  return {
    state,
    publishedId,
    byDate,
    daysLoaded: byDate.size,
  };
}

function stationVsLatestBand(price, latest) {
  if (price == null || !latest) return null;
  const avg = latest.avg;
  const min = latest.min;
  const max = latest.max;
  if (avg == null || min == null || max == null) return null;
  if (price <= avg) {
    const span = avg - min;
    const pct = span > 1e-6 ? ((price - min) / span) * 100 : 0;
    return {
      side: 'below',
      pct: Math.max(0, Math.min(100, pct)),
      avg,
      min,
      max,
    };
  }
  const span = max - avg;
  const pct = span > 1e-6 ? ((max - price) / span) * 100 : 0;
  return {
    side: 'above',
    pct: Math.max(0, Math.min(100, pct)),
    avg,
    min,
    max,
  };
}

function rankStationWithinKm(station, fuel, radiusKm = 25) {
  if (!station?.lat || !station?.lng) return null;
  const peers = [];
  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng) continue;
    const km = haversineKm(station.lat, station.lng, st.lat, st.lng);
    if (km > radiusKm) continue;
    const price = stationFuelPrice(st, fuel);
    if (price == null || !Number.isFinite(price)) continue;
    peers.push({ id: st.id, price, km });
  }
  if (!peers.length) return null;
  peers.sort((a, b) => a.price - b.price || a.km - b.km);
  const idx = peers.findIndex((p) => p.id === station.id);
  if (idx < 0) return null;
  return {
    rank: idx + 1,
    total: peers.length,
    price: peers[idx].price,
    cheapest: peers[0].price,
    dearest: peers[peers.length - 1].price,
    radiusKm,
  };
}

function yBoundsFromVisible(citySeries, vis, extraSeries) {
  const vals = [];
  for (const p of citySeries) {
    if (vis.avg && p.avg != null) vals.push(p.avg);
    if (vis.gmean && p.gmean != null) vals.push(p.gmean);
    if (vis.mode && p.mode != null) vals.push(p.mode);
    if (vis.med && p.med != null) vals.push(p.med);
    if (vis.min && p.min != null) vals.push(p.min);
    if (vis.max && p.max != null) vals.push(p.max);
  }
  if (extraSeries) {
    for (const series of extraSeries) {
      if (!series) continue;
      for (const v of series) {
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
    }
  }
  if (!vals.length) return undefined;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(0.5, (hi - lo) * 0.08);
  return {
    min: Math.floor((lo - pad) * 10) / 10,
    max: Math.ceil((hi + pad) * 10) / 10,
  };
}

function renderHistoryChart(labels, citySeries, statePoint, fuel, title, state, marks) {
  const ctx = document.getElementById('historyChart');
  historyChart = destroyChart(historyChart);

  const avgData = citySeries.map((p) => p.avg);
  const gmeanData = citySeries.map((p) => p.gmean);
  const modeData = citySeries.map((p) => p.mode);
  const medData = citySeries.map((p) => p.med);
  const minData = citySeries.map((p) => p.min);
  const maxData = citySeries.map((p) => p.max);
  const vis = lineVisibility();
  const turns = marks?.turns || [];
  const fftCurve = marks?.fftOverlay?.curve;
  const stationOverlay = selectedStationChartOverlay(labels, fuel);
  const extraForBounds = [];
  if (fftCurve) extraForBounds.push(fftCurve);
  if (stationOverlay) extraForBounds.push(stationOverlay.data);
  const yBounds = yBoundsFromVisible(citySeries, vis, extraForBounds.length ? extraForBounds : null);

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
      spanGaps: true,
      hidden: !vis.avg,
      ...pointStyle,
    },
    {
      label: 'Geomean',
      data: gmeanData,
      borderColor: '#fbbf24',
      backgroundColor: 'rgba(251, 191, 36, 0.12)',
      borderDash: [6, 3],
      borderWidth: 2,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.gmean,
      ...pointStyle,
    },
    {
      label: 'Mode',
      data: modeData,
      borderColor: '#2dd4bf',
      backgroundColor: 'rgba(45, 212, 191, 0.12)',
      borderDash: [2, 2],
      borderWidth: 2,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.mode,
      ...pointStyle,
    },
    {
      label: 'Median',
      data: medData,
      borderColor: '#a78bfa',
      backgroundColor: 'rgba(167, 139, 250, 0.1)',
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.med,
      ...pointStyle,
    },
    {
      label: 'Daily low',
      data: minData,
      borderColor: 'rgba(34, 197, 94, 0.75)',
      borderDash: [4, 4],
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.min,
      ...pointStyle,
    },
    {
      label: 'Daily high',
      data: maxData,
      borderColor: 'rgba(239, 68, 68, 0.75)',
      borderDash: [4, 4],
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.max,
      ...pointStyle,
    },
  ];

  if (fftCurve) {
    const periodLabel = marks.fftOverlay?.period
      ? `FFT ~${marks.fftOverlay.period.toFixed(0)}d`
      : 'FFT cycle';
    datasets.push({
      label: periodLabel,
      data: fftCurve,
      borderColor: '#2dd4bf',
      borderDash: [6, 4],
      borderWidth: 1.75,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 8,
      tension: 0.35,
      fill: false,
    });
  }

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

  if (stationOverlay) {
    datasets.push({
      label: stationOverlay.label,
      data: stationOverlay.data,
      borderColor: '#ef4444',
      backgroundColor: '#ef4444',
      borderWidth: 2,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      showLine: stationOverlay.showLine,
      pointRadius: (ctx) => (ctx.raw != null ? 5 : 0),
      pointHoverRadius: 7,
      pointHitRadius: 12,
      pointBackgroundColor: '#ef4444',
      pointBorderColor: '#fecaca',
      pointBorderWidth: 1,
    });
  }

  historyChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    plugins: [cycleTurnLinesPlugin, hoverCursorLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (_event, active) => {
        if (active?.length) syncCycleDialFromHover(active[0].index);
      },
      plugins: {
        legend: { display: false },
        cycleTurnLines: { turns },
        hoverCursorLine: { index: null },
        title: {
          display: true,
          text: title || `${FUEL_LABELS[fuel] || fuel} — c/L`,
          color: '#e8edf4',
          font: { size: 14 },
        },
        tooltip: {
          position: 'mouseHeight',
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
}

function applyLineVisibility() {
  if (!historyChart) return;
  const vis = lineVisibility();
  const map = {
    Mean: vis.avg,
    Geomean: vis.gmean,
    Mode: vis.mode,
    Median: vis.med,
    'Daily low': vis.min,
    'Daily high': vis.max,
  };
  historyChart.data.datasets.forEach((ds) => {
    if (Object.prototype.hasOwnProperty.call(map, ds.label)) ds.hidden = !map[ds.label];
  });
  const byLabel = Object.fromEntries(historyChart.data.datasets.map((ds) => [ds.label, ds.data]));
  const series = (byLabel.Mean || []).map((avg, i) => ({
    avg,
    gmean: byLabel.Geomean?.[i],
    mode: byLabel.Mode?.[i],
    med: byLabel.Median?.[i],
    min: byLabel['Daily low']?.[i],
    max: byLabel['Daily high']?.[i],
  }));
  const extras = historyChart.data.datasets
    .filter((ds) => !Object.prototype.hasOwnProperty.call(map, ds.label))
    .map((ds) => ds.data);
  const bounds = yBoundsFromVisible(series, vis, extras.length ? extras : null);
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
    <div class="summary-row"><span class="label">Latest geomean</span><span class="value">${stats.latest.gmean != null ? `${stats.latest.gmean.toFixed(1)}c` : '—'}</span></div>
    <div class="summary-row"><span class="label">Latest mode</span><span class="value">${stats.latest.mode != null ? `${stats.latest.mode.toFixed(1)}c` : '—'}</span></div>
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
  const periodDays = selectedPeriod();

  // Always re-fetch the active state file so publishes show up without a full reload.
  try {
    const index = await fetchJson(`${baseUrl()}/v1/index.json`);
    const entry = index.states?.find((s) => s.code === state);
    const fileName = entry?.file || `${state}.json`;
    stateFiles[state] = await fetchJson(`${baseUrl()}/v1/${fileName}`);
  } catch (err) {
    console.warn('State refresh failed, using cached file:', err.message);
  }

  const file = stateFiles[state];
  if (!file) return;

  syncScopeOptions(file, fuel);
  const scope = selectedScope();

  const archive = await loadArchivesForState(state);
  const fullSeries = buildMergedSeries(file, archive, fuel, scope);
  const series = sliceSeriesByPeriod(fullSeries, periodDays);
  const stats = seriesStats(series);
  const params = file.params?.[fuel];
  const marks = findChartCycleMarks(fullSeries, series, state);
  const modelId = marks.modelId || effectiveCycleModelId(state);
  const prevDate =
    chartCycleCtx.selectedIndex != null
      ? chartCycleCtx.series?.[chartCycleCtx.selectedIndex]?.date
      : null;
  let selectedIndex = series.length ? series.length - 1 : null;
  if (prevDate && series.length) {
    const kept = series.findIndex((p) => p?.date === prevDate);
    if (kept >= 0) selectedIndex = kept;
  }
  chartCycleCtx = {
    series,
    fullSeries,
    params,
    turns: marks.turns,
    fftOverlay: marks.fftOverlay || null,
    statePoint: null,
    state,
    modelId,
    latestStage: null,
    selectedIndex,
  };
  chartCycleCtx.latestStage = series.length
    ? cycleStageForIndex(series.length - 1)
    : null;

  const place = scopeLabel(state, scope);
  const chartTitleText = `${place} — ${FUEL_LABELS[fuel] || fuel}`;
  document.getElementById('chartTitle').textContent = chartTitleText;

  const turnParams = window.CycleModels?.resolveTurnDetectParams?.(state);
  const turnTune = window.CycleModels?.getTurnTune?.();
  const fftOverlay = marks.fftOverlay;
  const latestN = stats?.latest?.n;
  let hint =
    `Showing ${scopeLabel(state, scope)} series` +
    (latestN != null ? ` (n=${latestN})` : '') +
    `. Last ${periodDays} days. Points are daily mean / geomean / median / low / high. ` +
    `Dotted: red = peak, green = bottom`;
  if (turnTune) {
    hint +=
      ` (sens ${turnTune.sensitivity}, gap ${turnParams?.minGap ?? turnTune.minGapDays}d, coarse ${turnTune.coarseness}, FFT ${turnTune.fftAssist ?? 0}`;
    if (fftOverlay?.period) {
      hint += ` → teal ~${fftOverlay.period.toFixed(0)}d curve`;
    }
    hint += ').';
  } else {
    hint += '.';
  }
  if (!file.scopes) {
    hint += ' · Legacy single-series file (metro/regional/state not split yet).';
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
  chartCycleCtx.statePoint = statePoint;

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
  if (selectedIndex != null) applySelectedDay(selectedIndex);
  else renderCycleDial(chartCycleCtx.latestStage);
  syncArcpathTuneVisibility();
  syncWaWeeklyAfterLastVisibility();
  renderE10Box(file);
  requestAnimationFrame(() => syncChartHeightToSummary());
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
    redrawStationMarkers();
    rebuildStationList();
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

/** Green (cheap) → red (dear) for t in [0, 1]. */
function priceHeatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  const hue = 120 * (1 - x);
  return `hsl(${hue}, 72%, 42%)`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stationMarkerIcon(station, fuel, loaded, extent) {
  const price = stationFuelPrice(station, fuel);
  const priceLabel = price != null ? `${price.toFixed(1)}c` : '—';
  const logo = window.brandLogoFor(station.brand);
  const showLoaded = loaded && price != null;
  const isCheapest = showLoaded && extent && price === extent.min;
  const state = showLoaded ? 'loaded' : 'pending';
  const cheapest = isCheapest ? ' cheapest' : '';
  const active = selectedStationId === station.id ? ' active' : '';
  const showPrice = showLoaded;

  let heatStyle = '';
  if (showLoaded && extent && !isCheapest) {
    const t = extent.max === extent.min ? 0 : (price - extent.min) / (extent.max - extent.min);
    const color = priceHeatColor(t);
    heatStyle = ` style="--pin-heat:${color}"`;
  }

  return L.divIcon({
    className: 'station-div-icon',
    html: `
      <div class="station-marker ${state}${cheapest}${active}" data-id="${station.id}"${heatStyle}>
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
  if (!markerLayer || !map) return;
  markerLayer.clearLayers();
  markerById.clear();

  const fuel = document.getElementById('fuelSelect').value;
  const bounds = map.getBounds();
  const visible = [];
  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng || !bounds.contains([st.lat, st.lng])) continue;
    visible.push(st);
    if (visible.length >= MAX_STATIONS_PER_REQUEST * 2) break;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const st of visible) {
    if (!st.loaded) continue;
    const price = stationFuelPrice(st, fuel);
    if (price == null || !Number.isFinite(price)) continue;
    if (price < min) min = price;
    if (price > max) max = price;
  }
  const extent =
    Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;

  for (const st of visible) {
    const price = stationFuelPrice(st, fuel);
    const isCheapest =
      st.loaded && extent && price != null && price === extent.min;
    const marker = L.marker([st.lat, st.lng], {
      icon: stationMarkerIcon(st, fuel, st.loaded, extent),
      zIndexOffset:
        st.id === selectedStationId ? 1000 : isCheapest ? 500 : 0,
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

async function selectStationById(id) {
  const st = stationCache.get(id);
  if (!st) return;
  selectedStationId = id;
  selectedPublishedHistory = null;
  redrawStationMarkers();
  rebuildStationList();
  renderSelectedStationDetail(st);
  renderStationChart(String(st.id));

  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  const fuel = document.getElementById('fuelSelect').value;
  try {
    selectedPublishedHistory = await loadPublishedHistoryForStation(st, labels, fuel);
  } catch (err) {
    console.warn('Published station history:', err.message);
    selectedPublishedHistory = null;
  }

  if (selectedPublishedHistory?.daysLoaded) {
    const detail = document.getElementById('stationDetail');
    if (detail) {
      detail.innerHTML +=
        `<p class="hint">Published history: ${selectedPublishedHistory.daysLoaded} day(s) matched in catalog.</p>`;
    }
  }

  refreshHistoryWithStationOverlay();
  renderStationChart(String(st.id));
}

function renderSelectedStationDetail(st) {
  const fuel = document.getElementById('fuelSelect').value;
  const scope = selectedScope();
  const place = scope === 'metro' ? 'metro' : 'state';

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
  const today = new Date().toISOString().slice(0, 10);
  const lastSnap = stationSnapshots[key][stationSnapshots[key].length - 1];
  if (!lastSnap || lastSnap.date !== today || JSON.stringify(lastSnap.prices) !== JSON.stringify(priceMap)) {
    stationSnapshots[key].push({
      date: today,
      prices: { ...priceMap },
    });
  }

  const price = priceMap[fuel] ?? stationFuelPrice(st, fuel);
  const latest = chartCycleCtx.series?.[chartCycleCtx.series.length - 1];
  const band = stationVsLatestBand(price, latest);
  if (band && price != null) {
    if (band.side === 'below') {
      lines.push(
        `<p><strong>Vs ${place} average:</strong> below mean — ` +
          `${band.pct.toFixed(0)}th percentile from daily low ` +
          `(low ${band.min.toFixed(1)} → mean ${band.avg.toFixed(1)}c)</p>`
      );
    } else {
      lines.push(
        `<p><strong>Vs ${place} average:</strong> above mean — ` +
          `${band.pct.toFixed(0)}th percentile from daily high ` +
          `(mean ${band.avg.toFixed(1)} → high ${band.max.toFixed(1)}c)</p>`
      );
    }
  } else if (price != null) {
    lines.push(`<p class="hint">Load chart data to compare against the ${place} daily range.</p>`);
  }

  const nearby = rankStationWithinKm(st, fuel, 25);
  if (nearby) {
    lines.push(
      `<p><strong>Within ${nearby.radiusKm}&nbsp;km:</strong> ` +
        `#${nearby.rank} of ${nearby.total} for ${escapeHtml(FUEL_LABELS[fuel] || fuel)} ` +
        `(${nearby.cheapest.toFixed(1)}–${nearby.dearest.toFixed(1)}c)</p>`
    );
  } else if (price != null) {
    lines.push('<p class="hint">No nearby station prices loaded yet for a 25&nbsp;km ranking.</p>');
  }

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
}

/** Re-draw history chart station layer without a full data reload when possible. */
function refreshHistoryWithStationOverlay() {
  if (!chartCycleCtx.series?.length) return;
  const state = document.getElementById('stateSelect').value;
  const fuel = document.getElementById('fuelSelect').value;
  const series = chartCycleCtx.series;
  const marks = {
    turns: chartCycleCtx.turns,
    modelId: chartCycleCtx.modelId,
    fftOverlay: chartCycleCtx.fftOverlay || null,
  };
  const place = scopeLabel(state, selectedScope());
  const chartTitleText = `${place} — ${FUEL_LABELS[fuel] || fuel}`;
  const selectedDate =
    chartCycleCtx.selectedIndex != null ? series[chartCycleCtx.selectedIndex]?.date : null;
  renderHistoryChart(
    series.map((p) => p.date),
    series,
    chartCycleCtx.statePoint || null,
    fuel,
    `${chartTitleText} (c/L)`,
    state,
    marks
  );
  if (selectedDate) {
    const idx = series.findIndex((p) => p?.date === selectedDate);
    if (idx >= 0) applySelectedDay(idx);
  } else if (chartCycleCtx.latestStage) {
    renderCycleDial(chartCycleCtx.latestStage);
  }
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

  const byDate = new Map();
  if (selectedPublishedHistory?.byDate) {
    for (const [d, v] of selectedPublishedHistory.byDate) {
      if (v != null) byDate.set(d, v);
    }
  }
  for (const s of snaps) {
    const v = s.prices?.[fuel];
    if (v != null && s.date) byDate.set(s.date, v);
  }

  const points = [...byDate.entries()]
    .map(([date, v]) => ({ date, v }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (points.length < 2) {
    hint.textContent = selectedPublishedHistory
      ? 'Matched a published station but need 2+ priced days for a trend line.'
      : 'Need 2+ published or session prices for a station trend line.';
    return;
  }
  const histN = selectedPublishedHistory?.daysLoaded || 0;
  hint.textContent =
    histN > 0
      ? `${points.length} day(s) (${histN} from published history).`
      : `${points.length} snapshot(s) in this browser session.`;

  stationChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map((p) => p.date),
      datasets: [
        {
          label: fuel,
          data: points.map((p) => p.v),
          borderColor: '#ef4444',
          tension: 0.2,
          pointRadius: 3,
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

function syncScopeOptions(file, fuel) {
  const sel = document.getElementById('scopeSelect');
  if (!sel || !file) return;
  const labels = {
    metro: 'Metro',
    regional: 'Regional',
    state: 'Whole state',
  };
  let current = sel.value;
  for (const opt of sel.options) {
    const sc = opt.value;
    const ok = scopeIsAvailable(file, fuel, sc);
    opt.disabled = !ok;
    const n = latestScopeN(file, fuel, sc);
    opt.textContent =
      labels[sc] + (n != null ? ` (n≈${n})` : ok ? '' : ' — no data');
  }
  if (!scopeIsAvailable(file, fuel, current)) {
    current = preferredScope(file, fuel);
    sel.value = current;
  }
}

function syncScopeDefaultFromFile() {
  const state = document.getElementById('stateSelect').value;
  const fuel = document.getElementById('fuelSelect').value;
  const file = stateFiles[state];
  if (!file) return;
  syncScopeOptions(file, fuel);
  const sel = document.getElementById('scopeSelect');
  if (sel) sel.value = preferredScope(file, fuel);
}

function init() {
  initCapitalSelect();
  initMap();
  populateCycleModelSelect();
  initTurnTuneControls();
  initWaWeeklyAfterLastControl();
  initArcpathTuneControls();
  initTuneFoldHeightSync();

  const refresh = () => refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));

  document.getElementById('btnLoad').onclick = () =>
    loadAllStates().catch((e) => setStatus(`Error: ${e.message}`));
  document.getElementById('stateSelect').onchange = () => {
    syncScopeDefaultFromFile();
    syncWaWeeklyAfterLastVisibility();
    refresh();
  };
  document.getElementById('scopeSelect').onchange = refresh;
  document.getElementById('periodSelect').onchange = refresh;
  document.getElementById('cycleModelSelect').onchange = () => {
    const id = document.getElementById('cycleModelSelect').value;
    try {
      localStorage.setItem(CycleModels.STORAGE_KEY, id);
    } catch (_) {
      /* ignore */
    }
    syncArcpathTuneVisibility();
    refresh();
  };
  document.getElementById('fuelSelect').onchange = () => {
    const state = document.getElementById('stateSelect').value;
    const fuel = document.getElementById('fuelSelect').value;
    const file = stateFiles[state];
    if (file) syncScopeOptions(file, fuel);
    refresh();
    redrawStationMarkers();
    rebuildStationList();
    if (selectedStationId != null) {
      const st = stationCache.get(selectedStationId);
      if (st) selectStationById(st.id);
    }
  };
  document.getElementById('overlaySummary').onchange = refresh;
  document.getElementById('showAvg').onchange = () => applyLineVisibility();
  document.getElementById('showGmean').onchange = () => applyLineVisibility();
  document.getElementById('showMode').onchange = () => applyLineVisibility();
  document.getElementById('showMed').onchange = () => applyLineVisibility();
  document.getElementById('showMin').onchange = () => applyLineVisibility();
  document.getElementById('showMax').onchange = () => applyLineVisibility();

  document.getElementById('btnLoadStations').onclick = () => goToCapital();

  window.addEventListener('resize', () => {
    syncMapToFuelGraphWidth();
    syncChartHeightToSummary();
  });
  watchMapSize();
  watchSummaryChartHeight();
  requestAnimationFrame(() => {
    syncMapToFuelGraphWidth();
    syncChartHeightToSummary();
  });
}

init();
