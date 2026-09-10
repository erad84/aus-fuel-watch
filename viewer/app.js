/* Aus Fuel Watch - browser data viewer */

const DAY_MS = 86400000;
const E10_ENERGY_RATIO = 0.97;

/** Resolve viewer assets next to app.js (works for http:// and file://). */
const VIEWER_BASE = (() => {
  const scripts = document.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || '';
    if (/app\.js(\?|$)/i.test(src)) {
      return src.replace(/[^/]+$/, '');
    }
  }
  try {
    return new URL('.', window.location.href).href;
  } catch {
    return '';
  }
})();

function viewerAssetUrl(name) {
  try {
    return new URL(name, VIEWER_BASE || window.location.href).href;
  } catch {
    return name;
  }
}

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
  LPG: 'LPG',
};
const SCOPE_IDS = ['metro', 'regional', 'state'];
/** Disable a scope option when latest station count is below this. */
const MIN_SCOPE_N = 25;
const MIN_SCOPE_N_OVERRIDE = {
  TAS: { E10: 2 },
  ACT: { DSL: 10, regional: 5 },
  NT: { regional: 10 },
};
const MIN_SCOPE_N_LPG = 8;
const PETROLMATE_FUEL = {
  ULP: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIESEL: 'DSL',
  PDIESEL: 'PDSL',
};
const CAPITALS = {
  NSW: { name: 'Sydney', lat: -33.8688, lng: 151.2093, radiusKm: 60 },
  VIC: { name: 'Melbourne', lat: -37.8136, lng: 144.9631, radiusKm: 60 },
  QLD: { name: 'Brisbane', lat: -27.4698, lng: 153.0251, radiusKm: 70 },
  SA: { name: 'Adelaide', lat: -34.9285, lng: 138.6007, radiusKm: 45 },
  WA: { name: 'Perth', lat: -31.9523, lng: 115.8613, radiusKm: 60 },
  TAS: { name: 'Hobart', lat: -42.8821, lng: 147.3272, radiusKm: 30 },
  NT: { name: 'Darwin', lat: -12.4634, lng: 130.8456, radiusKm: 30 },
  ACT: { name: 'Canberra', lat: -35.2809, lng: 149.13, radiusKm: 30 },
};

const SUMMARY_FUELS = ['U91', 'E10', 'P95', 'P98', 'DSL', 'PDSL', 'LPG'];

/** True if catalog station is inside the capital metro radius for `state`. */
function stationInMetro(meta, state) {
  if (!meta || meta.lat == null || meta.lng == null) return false;
  const cap = CAPITALS[state];
  if (!cap) return false;
  return haversineKm(Number(meta.lat), Number(meta.lng), cap.lat, cap.lng) <= (cap.radiusKm || 60);
}

/** Filter stations to the selected scope (metro / regional / statewide). */
function stationMatchesScope(meta, state, scope) {
  if (!meta) return false;
  if (!scope || scope === 'state') return true;
  const inMetro = stationInMetro(meta, state);
  if (scope === 'metro') return inMetro;
  if (scope === 'regional') return !inMetro;
  return true;
}

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
const MIN_ZOOM_STATIONS = 13;
/** @type {Record<string, {date: string, prices: Record<string, number>}>} */
const stationSnapshots = {};

/** Published per-station history from docs/v1/stations/ */
const publishedStationCache = {
  catalogs: /** @type {Record<string, object>} */ ({}),
  days: /** @type {Record<string, object>} */ ({}),
  latestDay: /** @type {Record<string, string>} */ ({}),
};

/** Curated Singapore Mogas 95 / Gasoil weeks from docs/v1/outlook.json */
let outlookData = /** @type {{
  source?: string,
  updated?: string,
  lagDays?: { default: number, min: number, max: number },
  weeks?: Array<{ weekEnding: string, mogas95?: number|null, gasoil?: number|null, source?: string }>
} | null} */ (null);
/** @type {{ state: string, publishedId: string, byDate: Map<string, number>, daysLoaded: number } | null} */
let selectedPublishedHistory = null;
/** @type {{ mean: (number|null)[], low: (number|null)[], high: (number|null)[], peerCount: number, radiusKm: number } | null} */
let selectedAreaSeries = null;

/** Series + params for chart hover -> cycle dial sync */
let chartCycleCtx = {
  series: [],
  fullSeries: [],
  params: null,
  turns: [],
  fftOverlay: null,
  state: null,
  modelId: 'current',
  latestStage: null,
  /** Sticky last-hovered day; dial + yellow cursor stay here until another day is hovered. */
  selectedIndex: null,
};

/** Favourites-mean cycle context (parallel to scope chartCycleCtx). */
let favCycleCtx = {
  series: [],
  turns: [],
  fftOverlay: null,
  params: null,
  state: null,
  modelId: 'current',
  latestStage: null,
};

/** Area-mean cycle (suburb centre + radius), independent of selected station. */
let areaCycleCtx = {
  series: [],
  turns: [],
  fftOverlay: null,
  params: null,
  state: null,
  modelId: 'current',
  latestStage: null,
};

/** Selected-station fuel cycle (parallel dial + turn lines). */
let stationCycleCtx = {
  series: [],
  turns: [],
  params: null,
  state: null,
  modelId: 'current',
  latestStage: null,
};

/** @type {{ byDate: Map<string, {mean:number,low:number,high:number}>, daysWithData: number, stationCount: number } | null} */
let selectedFavouritesSeries = null;
/** Latest per-favourite prices for summary panels (c/L). */
let favouritesLatestSnapshot = /** @type {Array<{id:string,state:string,name:string,brand:string,suburb:string,price:number|null,prices:Record<string,number|null>}>} */ (
  []
);

/** Full AU suburb index from au-suburbs.json */
let suburbIndex = /** @type {Array<{suburb:string,postcode:string,state:string,label:string,lat:number,lng:number}>} */ (
  []
);
let suburbIndexLoaded = false;
/** Active favourite-area centre (from suburb pick). */
let selectedAreaCentre = /** @type {{ postcode: string|null, suburb: string|null, state: string|null, label: string|null, lat: number, lng: number } | null} */ (
  null
);

let prefsAppliedOnce = false;

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
  for (const id of ['graphViewFold', 'turnDetectFold', 'arcpathTune']) {
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
      `Path ~ ${lo}-${Math.min(100, hi)}% (rest arc), prior ${Math.round((t.priorExtreme ?? 0) * 100)}%, ` +
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
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
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
  if (fuel === 'LPG') return MIN_SCOPE_N_LPG;
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
  // Archives are a single legacy series - only overlay on the default/primary scope.
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
 * Angle: 0 deg = peak (top), clockwise -> falling (90 deg) -> bottom (180 deg) -> rising (270 deg).
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
 * Collapse overlapping candidates, then force peak<->trough alternation.
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
    const favTurns = opts?.favTurns || [];
    const areaTurns = opts?.areaTurns || [];
    const stationTurns = opts?.stationTurns || [];
    const vis = opts?.visibility || turnLineVisibility();
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    if (!xScale || !chartArea) return;

    const layers = [];
    if (vis.state) {
      layers.push({
        list: turns,
        dark: STATE_LINE_COLOR,
        light: STATE_LINE_COLOR_SOFT,
        width: 1.5,
      });
    }
    if (vis.suburb) {
      layers.push({
        list: areaTurns,
        dark: AREA_LINE_COLOR,
        light: AREA_LINE_COLOR_SOFT,
        width: 1.35,
      });
    }
    if (vis.fav) {
      layers.push({
        list: favTurns,
        dark: FAV_LINE_COLOR,
        light: FAV_LINE_COLOR_SOFT,
        width: 1.25,
      });
    }
    if (vis.station) {
      layers.push({
        list: stationTurns,
        dark: STATION_LINE_COLOR,
        light: 'rgba(239, 68, 68, 0.75)',
        width: 1.25,
      });
    }

    /** @type {Map<number, Array<{t: any, layer: any}>>} */
    const byIndex = new Map();
    for (const layer of layers) {
      for (const t of layer.list || []) {
        if (t?.index == null) continue;
        if (!byIndex.has(t.index)) byIndex.set(t.index, []);
        byIndex.get(t.index).push({ t, layer });
      }
    }

    ctx.save();
    for (const [index, items] of byIndex) {
      const baseX = xScale.getPixelForValue(index);
      items.forEach((item, i) => {
        const x = baseX + (i - (items.length - 1) / 2) * 2;
        if (x < chartArea.left || x > chartArea.right) return;
        const isPeak = item.t.type === 'peak';
        ctx.lineWidth = item.layer.width;
        ctx.strokeStyle = isPeak ? item.layer.dark : item.layer.light;
        ctx.setLineDash(isPeak ? [8, 4] : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      });
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

function scopeCycleTitle() {
  const scope = selectedScope();
  if (scope === 'metro') return 'Metro cycle';
  if (scope === 'regional') return 'Regional cycle';
  return 'Statewide cycle';
}

function updateScopeCycleHeading() {
  const el = document.getElementById('scopeCycleHeading');
  if (el) el.textContent = scopeCycleTitle();
}

function applySelectedDay(dataIndex) {
  const series = chartCycleCtx.series;
  if (!series?.length || dataIndex == null || dataIndex < 0) return;
  chartCycleCtx.selectedIndex = dataIndex;
  setHoverCursorLine(dataIndex);
  const stage = cycleStageForIndex(dataIndex);
  if (dataIndex === series.length - 1) chartCycleCtx.latestStage = stage;
  updateScopeCycleHeading();
  renderCycleDial(stage, {
    asOf: series[dataIndex]?.date,
    targetId: 'cycleStages',
    title: scopeCycleTitle(),
    modelId: chartCycleCtx.modelId,
  });
  const iso = series[dataIndex]?.date;
  applyFavouritesDialForDate(iso);
  applyAreaDialForDate(iso);
  applyStationDialForDate(iso);
}

function favCycleStageForDate(isoDate) {
  const series = favCycleCtx.series;
  if (!series?.length || !isoDate) return null;
  const idx = series.findIndex((p) => p?.date === isoDate);
  if (idx < 0) return null;
  return favCycleStageForIndex(idx);
}

function favCycleStageForIndex(dataIndex) {
  const { series, params, turns, state, modelId } = favCycleCtx;
  if (!series?.length || dataIndex == null || dataIndex < 0) return null;
  const id = modelId || effectiveCycleModelId(state || chartCycleCtx.state);
  if (window.CycleModels) {
    return CycleModels.stageAt(id, dataIndex, {
      series,
      turns: turns || [],
      params,
      state: state || chartCycleCtx.state,
    });
  }
  return inferCycleStage(series.slice(0, dataIndex + 1), params);
}

function applyFavouritesDialForDate(isoDate) {
  const series = favCycleCtx.series;
  const el = document.getElementById('favCycleStages');
  if (!el) return;
  if (!series?.length) {
    renderCycleDial(null, {
      targetId: 'favCycleStages',
      title: 'Favourites cycle',
      emptyHint: 'Add favourites to see a cycle dial',
    });
    return;
  }
  let idx = isoDate ? series.findIndex((p) => p?.date === isoDate) : -1;
  if (idx < 0) idx = series.length - 1;
  const stage = favCycleStageForIndex(idx);
  if (idx === series.length - 1) favCycleCtx.latestStage = stage;
  renderCycleDial(stage, {
    asOf: series[idx]?.date,
    targetId: 'favCycleStages',
    title: 'Favourites mean cycle',
    modelId: favCycleCtx.modelId,
    dialClass: 'fav',
  });
}

function areaCycleStageForIndex(dataIndex) {
  const { series, params, turns, state, modelId } = areaCycleCtx;
  if (!series?.length || dataIndex == null || dataIndex < 0) return null;
  const id = modelId || effectiveCycleModelId(state || chartCycleCtx.state);
  if (window.CycleModels) {
    return CycleModels.stageAt(id, dataIndex, {
      series,
      turns: turns || [],
      params,
      state: state || chartCycleCtx.state,
    });
  }
  return inferCycleStage(series.slice(0, dataIndex + 1), params);
}

function applyAreaDialForDate(isoDate) {
  const series = areaCycleCtx.series;
  if (!series?.length) {
    renderCycleDial(null, {
      targetId: 'areaCycleStages',
      title: 'Suburb cycle',
      emptyHint: 'Pick a suburb to see a suburb cycle dial',
    });
    return;
  }
  let idx = isoDate ? series.findIndex((p) => p?.date === isoDate) : -1;
  if (idx < 0) idx = series.length - 1;
  const stage = areaCycleStageForIndex(idx);
  if (idx === series.length - 1) areaCycleCtx.latestStage = stage;
  renderCycleDial(stage, {
    asOf: series[idx]?.date,
    targetId: 'areaCycleStages',
    title: 'Suburb cycle',
    modelId: areaCycleCtx.modelId,
  });
}

function stationCycleStageForIndex(dataIndex) {
  const { series, params, turns, state, modelId } = stationCycleCtx;
  if (!series?.length || dataIndex == null || dataIndex < 0) return null;
  const id = modelId || effectiveCycleModelId(state || chartCycleCtx.state);
  if (window.CycleModels) {
    return CycleModels.stageAt(id, dataIndex, {
      series,
      turns: turns || [],
      params,
      state: state || chartCycleCtx.state,
    });
  }
  return inferCycleStage(series.slice(0, dataIndex + 1), params);
}

function applyStationDialForDate(isoDate) {
  const series = stationCycleCtx.series;
  const el = document.getElementById('stationCycleStages');
  if (!el) return;
  if (!series?.length) {
    renderCycleDial(null, {
      targetId: 'stationCycleStages',
      title: 'Station cycle',
      emptyHint: 'Select a station with history for a station cycle dial',
    });
    return;
  }
  let idx = isoDate ? series.findIndex((p) => p?.date === isoDate) : -1;
  if (idx < 0) idx = series.length - 1;
  const stage = stationCycleStageForIndex(idx);
  if (idx === series.length - 1) stationCycleCtx.latestStage = stage;
  renderCycleDial(stage, {
    asOf: series[idx]?.date,
    targetId: 'stationCycleStages',
    title: 'Station cycle',
    modelId: stationCycleCtx.modelId,
    dialClass: 'station',
  });
}

function syncCycleDialFromHover(dataIndex) {
  // Ignore leave / empty hover - keep last selected day sticky.
  if (dataIndex == null || dataIndex < 0) return;
  if (dataIndex === chartCycleCtx.selectedIndex) return;
  applySelectedDay(dataIndex);
}

function polarXY(cx, cy, r, angleDeg) {
  // 0 deg at top, clockwise (cycle dial convention).
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
  const el = document.getElementById(opts.targetId || 'cycleStages');
  if (!el) return;
  if (!stage) {
    el.innerHTML = opts.emptyHint
      ? `<p class="hint">${escapeHtml(opts.emptyHint)}</p>`
      : '';
    return;
  }

  const cx = 100;
  const cy = 100;
  const r = 62;

  // Peak arc wraps past 0 deg - draw as two segments.
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
  const model =
    window.CycleModels &&
    CycleModels.get(opts.modelId || chartCycleCtx.modelId || selectedCycleModelId());
  const L = model?.dialLabels || {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
  };
  const title = opts.title || 'Price cycle position';
  const wrapClass = opts.dialClass ? `cycle-dial-wrap ${opts.dialClass}` : 'cycle-dial-wrap';

  el.innerHTML = `
    <div class="${wrapClass}" title="${escapeHtml(title)}">
      <svg class="cycle-dial" viewBox="-8 -4 216 208" role="img" aria-label="Cycle: ${escapeHtml(stage.label)}">
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
    <p class="cycle-meta"><strong>${escapeHtml(stage.label)}</strong>${asOf ? ` · ${escapeHtml(asOf)}` : ''}</p>
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

function formatE10PriceDiffPct(u91, e10) {
  if (u91 == null || e10 == null || !Number.isFinite(u91) || !Number.isFinite(e10) || u91 === 0) {
    return '';
  }
  // E10 cheaper than U91 -> negative %
  const pct = Math.round(((e10 - u91) / u91) * 1000) / 10;
  const sign = pct > 0 ? '+' : '';
  return `(${sign}${pct.toFixed(1)}%)`;
}

function e10BestBuyLine(cmp) {
  if (!cmp) return '';
  if (cmp.pick === 'tie') return 'Even (energy-adjusted)';
  return `${cmp.pick} by ${Math.abs(cmp.winPct).toFixed(1)}%`;
}

function e10BestBuyStationLine(cmp, uStationName, eStationName) {
  if (!cmp || cmp.pick === 'tie') return '';
  const name = cmp.pick === 'E10' ? eStationName : uStationName;
  if (!name) return '';
  return `<p class="e10-best-station">${escapeHtml(name)}</p>`;
}

function excludeCostcoEnabled() {
  return document.getElementById('excludeCostco')?.checked === true;
}

function isCostcoBrand(brand) {
  return /costco/i.test(String(brand || ''));
}

function brandExcludedFromArea(brand) {
  return excludeCostcoEnabled() && isCostcoBrand(brand);
}

function renderE10CompareInner(u, e, opts = {}) {
  const cmp = compareE10VsU91(u, e);
  if (!cmp) return '';
  const title = opts.title || 'E10 vs U91';
  const extra = opts.extraHtml || '';
  const stationLine = opts.hideBestBuy
    ? ''
    : e10BestBuyStationLine(cmp, opts.uStationName, opts.eStationName);
  const bestBuy = opts.hideBestBuy
    ? ''
    : `<p class="e10-best"><strong>Best buy:</strong> ${e10BestBuyLine(cmp)}</p>${stationLine}`;
  return `
      <div class="e10-head"><strong>${title}</strong></div>
      <p class="e10-note">E10 is 3% less energy-dense.</p>
      <p class="e10-note e10-prices">U91 ${u.toFixed(1)}c vs E10 ${e.toFixed(1)}c ${formatE10PriceDiffPct(u, e)}</p>
      ${bestBuy}
      ${extra}
  `;
}

function renderE10CompareHtml(u, e, opts = {}) {
  const inner = renderE10CompareInner(u, e, opts);
  if (!inner) return '';
  return `<div class="e10-box ${opts.className || ''}">${inner}</div>`;
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
    areaMean: document.getElementById('showAreaMean')?.checked !== false,
    areaLow: document.getElementById('showAreaLow')?.checked !== false,
    areaHigh: document.getElementById('showAreaHigh')?.checked !== false,
    station: document.getElementById('showStation')?.checked !== false,
    favMean: document.getElementById('showFavMean')?.checked !== false,
    favLow: document.getElementById('showFavLow')?.checked !== false,
    favHigh: document.getElementById('showFavHigh')?.checked !== false,
    mogas: document.getElementById('showMogas')?.checked !== false,
  };
}

function turnLineVisibility() {
  return {
    state: document.getElementById('showStateTurns')?.checked !== false,
    suburb: document.getElementById('showSuburbTurns')?.checked !== false,
    fav: document.getElementById('showFavTurns')?.checked !== false,
    station: document.getElementById('showStationTurns')?.checked !== false,
  };
}

function applyTurnLineVisibility() {
  if (!historyChart) return;
  const plug = historyChart.options.plugins.cycleTurnLines || {};
  historyChart.options.plugins.cycleTurnLines = {
    ...plug,
    visibility: turnLineVisibility(),
  };
  historyChart.update('none');
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
  let label = formatStationTitle(brand, name, 'Station');
  if (selectedPublishedHistory?.daysLoaded) {
    label += ` (${selectedPublishedHistory.daysLoaded}d hist)`;
  }
  return { label, data, showLine: n >= 2, pointCount: n };
}

const AREA_RADIUS_KM = 15;
/** Selected station — orange family. */
const STATION_LINE_COLOR = '#ef4444';
/** Suburb band — one purple shade (mean / low / high via dash style). */
const AREA_LINE_COLOR = '#a855f7';
const AREA_LINE_COLOR_SOFT = 'rgba(168, 85, 247, 0.75)';
/** Favourites list — same orange family as station. */
const FAV_LINE_COLOR = '#ea580c';
const FAV_LINE_COLOR_SOFT = 'rgba(234, 88, 12, 0.75)';
/** State / scope — one blue shade. */
const STATE_LINE_COLOR = '#3b82f6';
const STATE_LINE_COLOR_SOFT = 'rgba(59, 130, 246, 0.75)';
/** Singapore Mogas 95 / Gasoil overlay on fuel chart */
const MOGAS_LINE_COLOR = '#f59e0b';
const MOGAS_LINE_COLOR_SOFT = 'rgba(245, 158, 11, 0.85)';

/** @deprecated aliases kept for any leftover refs */
const AREA_MEAN_COLOR = AREA_LINE_COLOR;
const AREA_LOW_COLOR = AREA_LINE_COLOR_SOFT;
const AREA_HIGH_COLOR = AREA_LINE_COLOR_SOFT;
const DAILY_LOW_COLOR = STATE_LINE_COLOR_SOFT;
const DAILY_HIGH_COLOR = STATE_LINE_COLOR_SOFT;
const FAV_MEAN_COLOR = FAV_LINE_COLOR;
const FAV_LOW_COLOR = FAV_LINE_COLOR_SOFT;
const FAV_HIGH_COLOR = FAV_LINE_COLOR_SOFT;

const SERIES_BLUE = {
  mean: STATE_LINE_COLOR,
  median: STATE_LINE_COLOR_SOFT,
  gmean: STATE_LINE_COLOR_SOFT,
  mode: 'rgba(59, 130, 246, 0.55)',
};

/** Stations in catalog within radiusKm of centre (optional Costco filter). */
function peerIdsWithinKm(catalog, centerLat, centerLng, radiusKm) {
  const ids = [];
  if (!catalog?.stations) return ids;
  const skipCostco = excludeCostcoEnabled();
  for (const [id, meta] of Object.entries(catalog.stations)) {
    if (meta?.lat == null || meta?.lng == null) continue;
    if (skipCostco && isCostcoBrand(meta.brand)) continue;
    const lat = Number(meta.lat);
    const lng = Number(meta.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (haversineKm(centerLat, centerLng, lat, lng) <= radiusKm) ids.push(id);
  }
  return ids;
}

/**
 * Daily mean / low / high for published stations within radius of a geographic centre.
 */
async function loadAreaSeriesAroundCentre(centre, labels, fuel, radiusKm = AREA_RADIUS_KM) {
  const state =
    centre?.state ||
    document.getElementById('stateSelect')?.value ||
    chartCycleCtx.state;
  if (!state || !labels?.length || !centre || centre.lat == null || centre.lng == null) return null;

  const catalog = await loadPublishedCatalog(state);
  if (!catalog) return null;
  const peerIds = peerIdsWithinKm(catalog, Number(centre.lat), Number(centre.lng), radiusKm);
  if (peerIds.length < 1) return null;

  const uniqueDates = [...new Set(labels.filter(Boolean))];
  const concurrency = 8;
  for (let i = 0; i < uniqueDates.length; i += concurrency) {
    const chunk = uniqueDates.slice(i, i + concurrency);
    await Promise.all(chunk.map((iso) => loadPublishedDay(state, iso)));
  }

  const byDate = new Map();
  for (const iso of uniqueDates) {
    const day = publishedStationCache.days[`${state}|${iso}`];
    const vals = [];
    if (day) {
      for (const id of peerIds) {
        const tenths = pricesFromPublishedDay(day, id)?.[fuel];
        if (tenths != null && Number.isFinite(tenths)) vals.push(tenths / 10);
      }
    }
    if (!vals.length) continue;
    let sum = 0;
    let mn = vals[0];
    let mx = vals[0];
    for (const v of vals) {
      sum += v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    byDate.set(iso, {
      mean: Math.round((sum / vals.length) * 10) / 10,
      low: mn,
      high: mx,
    });
  }

  if (!byDate.size) return null;
  return {
    byDate,
    peerCount: peerIds.length,
    radiusKm,
    daysWithData: byDate.size,
    centre,
    label: centre.label || null,
  };
}

/** @deprecated use loadAreaSeriesAroundCentre */
async function loadAreaSeriesAroundStation(st, labels, fuel, radiusKm = AREA_RADIUS_KM) {
  if (!st || st.lat == null || st.lng == null) return null;
  return loadAreaSeriesAroundCentre(
    {
      lat: Number(st.lat),
      lng: Number(st.lng),
      label: st.name || 'Station',
      postcode: st.postcode != null ? String(st.postcode) : null,
      suburb: st.suburb || null,
    },
    labels,
    fuel,
    radiusKm
  );
}

/** Align date-keyed area stats onto the current chart label axis (index-safe). */
function areaSeriesForLabels(area, labels) {
  if (!area?.byDate || !labels?.length) return null;
  const mean = [];
  const low = [];
  const high = [];
  let daysWithData = 0;
  for (const iso of labels) {
    const row = area.byDate.get(iso);
    if (row) {
      mean.push(row.mean);
      low.push(row.low);
      high.push(row.high);
      daysWithData++;
    } else {
      mean.push(null);
      low.push(null);
      high.push(null);
    }
  }
  if (!daysWithData) return null;
  return {
    mean,
    low,
    high,
    peerCount: area.peerCount,
    radiusKm: area.radiusKm,
    daysWithData,
  };
}

function favouritesSeriesForLabels(fav, labels) {
  if (!fav?.byDate || !labels?.length) return null;
  const mean = [];
  const low = [];
  const high = [];
  let daysWithData = 0;
  for (const iso of labels) {
    const row = fav.byDate.get(iso);
    if (row) {
      mean.push(row.mean);
      low.push(row.low);
      high.push(row.high);
      daysWithData++;
    } else {
      mean.push(null);
      low.push(null);
      high.push(null);
    }
  }
  if (!daysWithData) return null;
  return {
    mean,
    low,
    high,
    stationCount: fav.stationCount,
    daysWithData,
  };
}

/**
 * Load mean/low/high across all favourites (any state) for chart labels.
 * Also fills favouritesLatestSnapshot for summary panels.
 */
async function loadFavouritesSeries(labels, fuel) {
  const favs = (window.UserPrefs?.listFavourites?.() || []).filter(
    (f) => !brandExcludedFromArea(f.brand)
  );
  favouritesLatestSnapshot = [];
  if (!favs.length || !labels?.length) {
    return null;
  }

  const byState = new Map();
  for (const f of favs) {
    if (!byState.has(f.state)) byState.set(f.state, []);
    byState.get(f.state).push(f);
  }

  const uniqueDates = [...new Set(labels.filter(Boolean))];
  const concurrency = 8;
  for (const [state] of byState) {
    for (let i = 0; i < uniqueDates.length; i += concurrency) {
      const chunk = uniqueDates.slice(i, i + concurrency);
      await Promise.all(chunk.map((iso) => loadPublishedDay(state, iso)));
    }
  }

  const byDate = new Map();
  const latestById = new Map();

  for (const iso of uniqueDates) {
    const vals = [];
    for (const f of favs) {
      const day = publishedStationCache.days[`${f.state}|${iso}`];
      const tenths = pricesFromPublishedDay(day, f.id)?.[fuel];
      if (tenths == null || !Number.isFinite(tenths)) continue;
      const cl = tenths / 10;
      vals.push(cl);
      latestById.set(f.id, { ...f, price: cl, date: iso });
    }
    if (!vals.length) continue;
    let sum = 0;
    let mn = vals[0];
    let mx = vals[0];
    for (const v of vals) {
      sum += v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    byDate.set(iso, {
      mean: Math.round((sum / vals.length) * 10) / 10,
      low: mn,
      high: mx,
    });
  }

  // Multi-fuel latest snapshot for E10/U91 compare (use last chart day with any reading).
  const lastIso = uniqueDates[uniqueDates.length - 1];
  for (const f of favs) {
    const prices = {};
    for (const fuelKey of ['U91', 'E10', 'P95', 'P98', 'DSL', 'PDSL', 'LPG']) {
      let found = null;
      for (let i = uniqueDates.length - 1; i >= 0; i--) {
        const day = publishedStationCache.days[`${f.state}|${uniqueDates[i]}`];
        const tenths = pricesFromPublishedDay(day, f.id)?.[fuelKey];
        if (tenths != null && Number.isFinite(tenths)) {
          found = tenths / 10;
          break;
        }
      }
      prices[fuelKey] = found;
    }
    const hit = latestById.get(f.id);
    favouritesLatestSnapshot.push({
      id: f.id,
      state: f.state,
      name: f.name,
      brand: f.brand,
      suburb: f.suburb,
      price: hit?.price ?? prices[fuel] ?? null,
      prices,
      date: hit?.date || lastIso,
    });
  }

  if (!byDate.size) return null;
  return {
    byDate,
    stationCount: favs.length,
    daysWithData: byDate.size,
  };
}

function favMeanPointSeries(labels, favAligned) {
  if (!favAligned?.mean?.length || !labels?.length) return [];
  return labels.map((date, i) => ({
    date,
    avg: favAligned.mean[i],
  }));
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
    .replace(/['']/g, '')
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
  if (!dayFile || stationId == null) return null;
  const sid = String(stationId);
  if (dayFile.stations) {
    if (dayFile.stations[stationId]) return dayFile.stations[stationId];
    if (dayFile.stations[sid]) return dayFile.stations[sid];
  }
  for (const row of dayFile.s || []) {
    if (Array.isArray(row) && String(row[0]) === sid) return row[1];
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
  const publishedId = catalog.stations?.[st.id]
    ? st.id
    : matchPublishedStationId(st, catalog);
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

function renderHistoryChart(labels, citySeries, fuel, title, state, marks) {
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
  const favTurns = marks?.favTurns || [];
  const stateFft = marks?.fftOverlay || null;
  const areaFft = marks?.areaFftOverlay || null;
  const favFft = marks?.favFftOverlay || null;
  const stationOverlay = selectedStationChartOverlay(labels, fuel);
  const areaSeries = areaSeriesForLabels(selectedAreaSeries, labels);
  const favSeries = favouritesSeriesForLabels(selectedFavouritesSeries, labels);
  const extraForBounds = [];
  if (vis.avg && stateFft?.curve) extraForBounds.push(stateFft.curve);
  if (vis.areaMean && areaFft?.curve) extraForBounds.push(areaFft.curve);
  if (vis.favMean && favFft?.curve) extraForBounds.push(favFft.curve);
  if (vis.station && stationOverlay) extraForBounds.push(stationOverlay.data);
  if (vis.areaMean && areaSeries?.mean) extraForBounds.push(areaSeries.mean);
  if (vis.areaLow && areaSeries?.low) extraForBounds.push(areaSeries.low);
  if (vis.areaHigh && areaSeries?.high) extraForBounds.push(areaSeries.high);
  if (vis.favMean && favSeries?.mean) extraForBounds.push(favSeries.mean);
  if (vis.favLow && favSeries?.low) extraForBounds.push(favSeries.low);
  if (vis.favHigh && favSeries?.high) extraForBounds.push(favSeries.high);
  const mogasOverlay = outlookSeriesForLabels(labels, fuel);
  if (vis.mogas && mogasOverlay?.data) extraForBounds.push(mogasOverlay.data);
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
      borderColor: SERIES_BLUE.mean,
      backgroundColor: 'rgba(59, 130, 246, 0.12)',
      borderWidth: 2.5,
      borderDash: [],
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.avg,
      ...pointStyle,
    },
    {
      label: 'Geomean',
      data: gmeanData,
      borderColor: SERIES_BLUE.gmean,
      backgroundColor: 'rgba(59, 130, 246, 0.08)',
      borderWidth: 2,
      borderDash: [],
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.gmean,
      ...pointStyle,
    },
    {
      label: 'Mode',
      data: modeData,
      borderColor: SERIES_BLUE.mode,
      backgroundColor: 'rgba(59, 130, 246, 0.08)',
      borderWidth: 2,
      borderDash: [],
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.mode,
      ...pointStyle,
    },
    {
      label: 'Median',
      data: medData,
      borderColor: SERIES_BLUE.median,
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      borderWidth: 2,
      borderDash: [],
      fill: false,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.med,
      ...pointStyle,
    },
    {
      label: 'Daily low',
      data: minData,
      borderColor: STATE_LINE_COLOR,
      backgroundColor: STATE_LINE_COLOR,
      borderDash: [2, 3],
      borderWidth: 1.75,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.min,
      ...pointStyle,
    },
    {
      label: 'Daily high',
      data: maxData,
      borderColor: STATE_LINE_COLOR,
      backgroundColor: STATE_LINE_COLOR,
      borderDash: [8, 4],
      borderWidth: 1.75,
      tension: 0.2,
      spanGaps: true,
      hidden: !vis.max,
      ...pointStyle,
    },
  ];

  const pushFftDataset = (overlay, labelPrefix, color, visKey, hidden) => {
    if (!overlay?.curve) return;
    const periodLabel = overlay.period
      ? `${labelPrefix} FFT ~${overlay.period.toFixed(0)}d`
      : `${labelPrefix} FFT`;
    datasets.push({
      label: periodLabel,
      visKey,
      data: overlay.curve,
      borderColor: color,
      borderDash: [6, 4],
      borderWidth: 1.75,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 8,
      tension: 0.35,
      fill: false,
      spanGaps: true,
      hidden,
    });
  };
  pushFftDataset(stateFft, 'State', STATE_LINE_COLOR, 'stateFft', !vis.avg);
  pushFftDataset(areaFft, 'Suburb', AREA_LINE_COLOR, 'areaFft', !vis.areaMean);
  pushFftDataset(favFft, 'Favourites', FAV_LINE_COLOR, 'favFft', !vis.favMean);

  if (areaSeries?.mean?.length) {
    datasets.push({
      label: `Suburb mean (${areaSeries.radiusKm} km, n~${areaSeries.peerCount})`,
      visKey: 'areaMean',
      data: areaSeries.mean,
      borderColor: AREA_LINE_COLOR,
      backgroundColor: AREA_LINE_COLOR,
      borderDash: [],
      borderWidth: 2,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.areaMean,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
    });
    datasets.push({
      label: 'Suburb low',
      data: areaSeries.low,
      borderColor: AREA_LINE_COLOR,
      backgroundColor: AREA_LINE_COLOR,
      borderDash: [2, 3],
      borderWidth: 1.5,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.areaLow,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 6,
    });
    datasets.push({
      label: 'Suburb high',
      data: areaSeries.high,
      borderColor: AREA_LINE_COLOR,
      backgroundColor: AREA_LINE_COLOR,
      borderDash: [8, 4],
      borderWidth: 1.5,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.areaHigh,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 6,
    });
  }

  if (favSeries?.mean?.length) {
    datasets.push({
      label: `Favourites mean (n=${favSeries.stationCount})`,
      visKey: 'favMean',
      data: favSeries.mean,
      borderColor: FAV_LINE_COLOR,
      backgroundColor: FAV_LINE_COLOR,
      borderDash: [],
      borderWidth: 2.25,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.favMean,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
    });
    datasets.push({
      label: 'Favourites low',
      visKey: 'favLow',
      data: favSeries.low,
      borderColor: FAV_LINE_COLOR,
      backgroundColor: FAV_LINE_COLOR,
      borderDash: [2, 3],
      borderWidth: 1.5,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.favLow,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 6,
    });
    datasets.push({
      label: 'Favourites high',
      visKey: 'favHigh',
      data: favSeries.high,
      borderColor: FAV_LINE_COLOR,
      backgroundColor: FAV_LINE_COLOR,
      borderDash: [8, 4],
      borderWidth: 1.5,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.favHigh,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHitRadius: 6,
    });
  }

  if (stationOverlay) {
    datasets.push({
      label: stationOverlay.label,
      visKey: 'station',
      data: stationOverlay.data,
      borderColor: STATION_LINE_COLOR,
      backgroundColor: STATION_LINE_COLOR,
      borderDash: [],
      borderWidth: 2.25,
      tension: 0.2,
      fill: false,
      spanGaps: true,
      hidden: !vis.station,
      showLine: stationOverlay.showLine,
      pointRadius: (ctx) => (ctx.raw != null ? 5 : 0),
      pointHoverRadius: 7,
      pointHitRadius: 12,
      pointBackgroundColor: STATION_LINE_COLOR,
      pointBorderColor: STATION_LINE_COLOR,
      pointBorderWidth: 1,
    });
  }

  if (mogasOverlay?.data?.length) {
    datasets.push({
      label: mogasOverlay.label,
      visKey: 'mogas',
      data: mogasOverlay.data,
      borderColor: MOGAS_LINE_COLOR,
      backgroundColor: MOGAS_LINE_COLOR_SOFT,
      borderDash: [4, 3],
      borderWidth: 2,
      tension: 0,
      stepped: 'before',
      fill: false,
      spanGaps: true,
      hidden: !vis.mogas,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
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
        cycleTurnLines: {
          turns,
          favTurns,
          areaTurns: marks?.areaTurns || [],
          stationTurns: marks?.stationTurns || [],
          visibility: turnLineVisibility(),
        },
        hoverCursorLine: { index: null },
        title: {
          display: true,
          text: title || `${FUEL_LABELS[fuel] || fuel} - c/L`,
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
    'Suburb low': vis.areaLow,
    'Suburb high': vis.areaHigh,
  };
  historyChart.data.datasets.forEach((ds) => {
    if (ds.visKey === 'station') {
      ds.hidden = !vis.station;
      return;
    }
    if (ds.visKey === 'areaMean' || ds.visKey === 'areaFft') {
      ds.hidden = !vis.areaMean;
      return;
    }
    if (ds.visKey === 'favMean' || ds.visKey === 'favFft') {
      ds.hidden = !vis.favMean;
      return;
    }
    if (ds.visKey === 'stateFft') {
      ds.hidden = !vis.avg;
      return;
    }
    if (ds.visKey === 'favLow') {
      ds.hidden = !vis.favLow;
      return;
    }
    if (ds.visKey === 'favHigh') {
      ds.hidden = !vis.favHigh;
      return;
    }
    if (ds.visKey === 'mogas') {
      ds.hidden = !vis.mogas;
      return;
    }
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
    .filter((ds) => {
      if (ds.hidden) return false;
      if (Object.prototype.hasOwnProperty.call(map, ds.label)) return false;
      return true;
    })
    .map((ds) => ds.data);
  if (vis.areaLow && byLabel['Suburb low']) extras.push(byLabel['Suburb low']);
  if (vis.areaHigh && byLabel['Suburb high']) extras.push(byLabel['Suburb high']);
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

function selectedAreaRadiusKm() {
  const raw = Number(document.getElementById('areaRadius')?.value);
  if (!Number.isFinite(raw)) return AREA_RADIUS_KM;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

function selectedFuelHeaderHtml() {
  const fuel = document.getElementById('fuelSelect')?.value;
  const label = FUEL_LABELS[fuel] || fuel;
  if (!label) return '';
  return `<h3 class="summary-fuel-heading">${escapeHtml(label)}</h3>`;
}

function formatDeltaCl(delta) {
  if (delta == null || !Number.isFinite(delta)) return '';
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  // Map delta onto dearest(0)→cheapest(100): dearer than mean = left/red.
  const scale = 12; // c/L span for full red↔green
  const pct = Math.max(0, Math.min(100, 50 - (rounded / scale) * 50));
  const color = rankBarGradientColor(pct);
  return `<span class="delta" style="color:${color}">(${sign}${rounded.toFixed(1)} c/L)</span>`;
}

/** Latest area mean/low/high for the selected station (c/L). */
function latestAreaSnapshot() {
  const area = selectedAreaSeries;
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  if (!area?.byDate?.size) return null;
  for (let i = labels.length - 1; i >= 0; i--) {
    const row = area.byDate.get(labels[i]);
    if (row && row.mean != null) {
      return { ...row, date: labels[i], peerCount: area.peerCount, radiusKm: area.radiusKm };
    }
  }
  // Fallback: last entry in byDate map insertion order
  let last = null;
  for (const [iso, row] of area.byDate) last = { ...row, date: iso };
  if (!last) return null;
  return { ...last, peerCount: area.peerCount, radiusKm: area.radiusKm };
}

/** Latest selected-station price for the active fuel (c/L). */
function latestSelectedStationPrice(fuel) {
  const st = getCachedStation(selectedStationId);
  if (!st) return null;
  const hist = selectedPublishedHistory;
  if (hist?.byDate?.size) {
    const labels = chartCycleCtx.series?.map((p) => p.date) || [];
    for (let i = labels.length - 1; i >= 0; i--) {
      const v = hist.byDate.get(labels[i]);
      if (v != null && Number.isFinite(v)) return { price: v, name: st.name || st.brand || 'Station' };
    }
  }
  const live = st.prices?.[fuel];
  if (live != null && Number.isFinite(Number(live))) {
    return { price: Number(live), name: st.name || st.brand || 'Station' };
  }
  return { price: null, name: st.name || st.brand || 'Station' };
}

/** Sample the dearest→cheapest bar gradient at 0–100 (left→right). */
function rankBarGradientColor(pct) {
  const t = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  const stops = [
    { t: 0, rgb: [239, 68, 68] }, // --peak
    { t: 0.5, rgb: [234, 179, 8] }, // #eab308
    { t: 1, rgb: [34, 197, 94] }, // --bottom
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const u = (t - a.t) / span;
  const rgb = a.rgb.map((c, i) => Math.round(c + (b.rgb[i] - c) * u));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function renderRankBarPriceRow(dearest, cheapest, stationPrice, pct) {
  const dearHtml =
    dearest != null && Number.isFinite(dearest)
      ? `${dearest.toFixed(1)}c`
      : '—';
  const cheapHtml =
    cheapest != null && Number.isFinite(cheapest)
      ? `${cheapest.toFixed(1)}c`
      : '—';
  const hasStation = stationPrice != null && Number.isFinite(stationPrice);
  const stationHtml = hasStation ? `${stationPrice.toFixed(1)}c` : '—';
  const stationColor = hasStation ? rankBarGradientColor(pct) : 'var(--muted)';
  return `
    <div class="area-rank-prices">
      <span class="rank-price dearest">${dearHtml}</span>
      <span class="rank-price station" style="color:${stationColor}">${stationHtml}</span>
      <span class="rank-price cheapest">${cheapHtml}</span>
    </div>
  `;
}

function renderAreaRankBar(stationPrice, areaLow, areaHigh, radiusKm) {
  const hasRange =
    stationPrice != null &&
    areaLow != null &&
    areaHigh != null &&
    Number.isFinite(stationPrice) &&
    Number.isFinite(areaLow) &&
    Number.isFinite(areaHigh) &&
    areaHigh > areaLow;
  let pct = 50;
  let markerClass = 'area-rank-marker dim';
  let markerStyle = `left:${pct.toFixed(1)}%`;
  if (hasRange) {
    // Left = dearest (high), right = cheapest (low)
    pct = ((areaHigh - stationPrice) / (areaHigh - areaLow)) * 100;
    pct = Math.max(0, Math.min(100, pct));
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  } else if (stationPrice != null && areaLow != null && areaHigh != null && areaHigh === areaLow) {
    pct = 50;
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  }
  return `
    <div class="area-rank-bar" role="img" aria-label="Station price vs suburb">
      <div class="area-rank-title">Station price vs suburb</div>
      <div class="bar-labels"><span class="dearest">Dearest</span><span class="cheapest">Cheapest</span></div>
      <div class="area-rank-track">
        <div class="${markerClass}" style="${markerStyle}"></div>
      </div>
      ${renderRankBarPriceRow(areaHigh, areaLow, stationPrice, pct)}
    </div>
  `;
}

function renderStateRankBar(stationPrice, stateLow, stateHigh) {
  const hasRange =
    stationPrice != null &&
    stateLow != null &&
    stateHigh != null &&
    Number.isFinite(stationPrice) &&
    Number.isFinite(stateLow) &&
    Number.isFinite(stateHigh) &&
    stateHigh > stateLow;
  let pct = 50;
  let markerClass = 'area-rank-marker dim';
  let markerStyle = `left:${pct.toFixed(1)}%`;
  if (hasRange) {
    pct = ((stateHigh - stationPrice) / (stateHigh - stateLow)) * 100;
    pct = Math.max(0, Math.min(100, pct));
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  } else if (
    stationPrice != null &&
    stateLow != null &&
    stateHigh != null &&
    stateHigh === stateLow
  ) {
    pct = 50;
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  }
  return `
    <div class="area-rank-bar" role="img" aria-label="Station price vs state">
      <div class="area-rank-title">Station price vs state (mean)</div>
      <div class="bar-labels"><span class="dearest">Dearest</span><span class="cheapest">Cheapest</span></div>
      <div class="area-rank-track">
        <div class="${markerClass}" style="${markerStyle}"></div>
      </div>
      ${renderRankBarPriceRow(stateHigh, stateLow, stationPrice, pct)}
    </div>
  `;
}

function outlookCommodityKey(fuel) {
  return fuel === 'DSL' ? 'gasoil' : 'mogas95';
}

function outlookCommodityLabel(fuel) {
  return fuel === 'DSL' ? 'Singapore Gasoil' : 'Singapore Mogas 95';
}

async function loadOutlookData() {
  if (window.OUTLOOK_DATA?.weeks?.length) {
    outlookData = window.OUTLOOK_DATA;
    return outlookData;
  }
  try {
    outlookData = await fetchJson(`${baseUrl()}/v1/outlook.json`);
  } catch (e) {
    console.warn('outlook.json:', e.message);
    outlookData = null;
  }
  return outlookData;
}

function outlookWeeksForFuel(fuel) {
  const key = outlookCommodityKey(fuel);
  const weeks = outlookData?.weeks || [];
  return weeks
    .filter((w) => w?.[key] != null && Number.isFinite(Number(w[key])))
    .map((w) => ({
      weekEnding: w.weekEnding,
      value: Number(w[key]),
      source: w.source || w.gasoilSource || null,
    }))
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
}

/** Step-forward weekly commodity onto daily chart labels (c/L). */
function outlookSeriesForLabels(labels, fuel) {
  const weeks = outlookWeeksForFuel(fuel);
  if (!labels?.length || !weeks.length) return null;
  let wi = -1;
  const data = labels.map((iso) => {
    while (wi + 1 < weeks.length && weeks[wi + 1].weekEnding <= iso) wi += 1;
    return wi >= 0 ? weeks[wi].value : null;
  });
  if (!data.some((v) => v != null)) return null;
  return {
    data,
    label: outlookCommodityLabel(fuel),
    lastWeek: weeks[weeks.length - 1],
  };
}

function outlookLagDays() {
  const d = outlookData?.lagDays;
  const def = Number(d?.default);
  if (Number.isFinite(def) && def > 0) return Math.round(def);
  return 10;
}

/**
 * Directional confidence 0..100 (Falling← →Rising) from recent weekly changes.
 */
function outlookTrendSignal(fuel) {
  const weeks = outlookWeeksForFuel(fuel);
  if (weeks.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < weeks.length; i++) {
    deltas.push(weeks[i].value - weeks[i - 1].value);
  }
  const recent = deltas.slice(-3);
  const last = recent[recent.length - 1];
  const meanAbs =
    recent.reduce((s, d) => s + Math.abs(d), 0) / Math.max(1, recent.length) || 1;
  const scale = Math.max(2, meanAbs * 1.5);
  let pct = 50 + (last / scale) * 50;
  pct = Math.max(0, Math.min(100, pct));
  const direction = last > 0.4 ? 'rising' : last < -0.4 ? 'falling' : 'flat';
  const confidence = Math.min(100, Math.round((Math.abs(last) / scale) * 100));

  let turnIdx = -1;
  for (let i = deltas.length - 1; i >= 1; i--) {
    if (deltas[i - 1] === 0) continue;
    if (Math.sign(deltas[i]) !== 0 && Math.sign(deltas[i - 1]) !== Math.sign(deltas[i])) {
      turnIdx = i;
      break;
    }
  }

  const lag = outlookLagDays();
  const lastWeekIso = weeks[weeks.length - 1].weekEnding;
  let etaHint;
  if (turnIdx >= 0) {
    const turnIso = weeks[turnIdx].weekEnding;
    const daysSince = Math.max(0, isoToDayNum(lastWeekIso) - isoToDayNum(turnIso));
    const remaining = Math.max(0, lag - daysSince);
    etaHint =
      remaining > 0
        ? `Singapore turned ~${daysSince}d ago · AU typically ~${lag}d behind · next turn ~${remaining}d`
        : `Singapore turned ~${daysSince}d ago · AU lag ~${lag}d may already be showing`;
  } else {
    const dirWord =
      direction === 'rising' ? 'rising' : direction === 'falling' ? 'falling' : 'flat';
    etaHint = `Tracking ${dirWord} · AU usually lags Singapore by ~${lag} days`;
  }

  return {
    pct,
    direction,
    confidence,
    lastDelta: Math.round(last * 10) / 10,
    lastValue: weeks[weeks.length - 1].value,
    lastWeekIso,
    source: weeks[weeks.length - 1].source,
    commodity: outlookCommodityLabel(fuel),
    etaHint,
    lag,
  };
}

function renderOutlookBarHtml(signal) {
  if (!signal) {
    return `<div class="area-rank-bar outlook-bar"><div class="area-rank-title">Outlook</div><p class="outlook-hint">No Singapore bench loaded. Run fetch-aip-outlook or check docs/v1/outlook.json.</p></div>`;
  }
  const pct = signal.pct;
  const markerClass = 'area-rank-marker';
  const dirLabel =
    signal.direction === 'rising'
      ? 'Rising'
      : signal.direction === 'falling'
        ? 'Falling'
        : 'Flat';
  return `
    <div class="area-rank-bar outlook-bar" role="img" aria-label="Outlook ${escapeHtml(signal.commodity)}">
      <div class="area-rank-title">Outlook · ${escapeHtml(signal.commodity)}</div>
      <div class="bar-labels"><span class="falling">Falling</span><span class="rising">Rising</span></div>
      <div class="area-rank-track">
        <div class="${markerClass}" style="left:${pct.toFixed(1)}%"></div>
      </div>
      <p class="outlook-hint">${escapeHtml(signal.etaHint)}</p>
      <p class="outlook-meta">${dirLabel} · Δ ${signal.lastDelta > 0 ? '+' : ''}${signal.lastDelta}c last week · ${signal.lastValue}c · week ${escapeHtml(signal.lastWeekIso)}${signal.source ? ` · ${escapeHtml(signal.source)}` : ''}</p>
    </div>
  `;
}

function renderOutlookBar() {
  const el = document.getElementById('outlookBar');
  if (!el) return;
  const fuel = document.getElementById('fuelSelect')?.value || 'U91';
  if (fuel === 'LPG') {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = renderOutlookBarHtml(outlookTrendSignal(fuel));
}

function latestFavouritesBand(fuel) {
  const rows = favouritesLatestSnapshot.filter(
    (r) => r.price != null && Number.isFinite(r.price)
  );
  if (!rows.length) {
    // Fall back to series last day
    const labels = chartCycleCtx.series?.map((p) => p.date) || [];
    const area = selectedFavouritesSeries;
    if (!area?.byDate?.size) return null;
    for (let i = labels.length - 1; i >= 0; i--) {
      const row = area.byDate.get(labels[i]);
      if (row) return { low: row.low, high: row.high, mean: row.mean, date: labels[i], count: area.stationCount };
    }
    return null;
  }
  let low = rows[0].price;
  let high = rows[0].price;
  let sum = 0;
  for (const r of rows) {
    sum += r.price;
    if (r.price < low) low = r.price;
    if (r.price > high) high = r.price;
  }
  return {
    low,
    high,
    mean: Math.round((sum / rows.length) * 10) / 10,
    count: rows.length,
    fuel,
  };
}

function bestFavouriteForFuel(fuel) {
  let best = null;
  for (const r of favouritesLatestSnapshot) {
    const p = r.prices?.[fuel] ?? (fuel === document.getElementById('fuelSelect')?.value ? r.price : null);
    if (p == null || !Number.isFinite(p)) continue;
    if (!best || p < best.price) {
      best = {
        id: r.id,
        name: r.name || r.brand || r.id,
        brand: r.brand,
        state: r.state,
        suburb: r.suburb,
        price: p,
      };
    }
  }
  return best;
}

function renderFavouritesRankBar(stationPrice, band) {
  const hasRange =
    stationPrice != null &&
    band &&
    band.low != null &&
    band.high != null &&
    Number.isFinite(stationPrice) &&
    Number.isFinite(band.low) &&
    Number.isFinite(band.high) &&
    band.high > band.low;
  let pct = 50;
  let markerClass = 'area-rank-marker dim';
  let markerStyle = `left:${pct.toFixed(1)}%`;
  const dear = band?.high ?? null;
  const cheap = band?.low ?? null;
  if (hasRange) {
    pct = ((band.high - stationPrice) / (band.high - band.low)) * 100;
    pct = Math.max(0, Math.min(100, pct));
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  } else if (stationPrice != null && band?.low != null && band.high === band.low) {
    pct = 50;
    markerClass = 'area-rank-marker';
    markerStyle = `left:${pct.toFixed(1)}%`;
  }
  return `
    <div class="area-rank-bar" role="img" aria-label="Station price vs favourites">
      <div class="area-rank-title">Station price vs favourites</div>
      <div class="bar-labels"><span class="dearest">Dearest</span><span class="cheapest">Cheapest</span></div>
      <div class="area-rank-track">
        <div class="${markerClass}" style="${markerStyle}"></div>
      </div>
      ${renderRankBarPriceRow(dear, cheap, stationPrice, pct)}
    </div>
  `;
}

function renderFavouritesE10Section() {
  const bestU91 = bestFavouriteForFuel('U91');
  const bestE10 = bestFavouriteForFuel('E10');
  const u = bestU91?.price ?? null;
  const e = bestE10?.price ?? null;
  if (u == null || e == null) return '';
  const uName = bestU91
    ? [formatStationTitle(bestU91.brand, bestU91.name), bestU91.suburb].filter(Boolean).join(' · ')
    : '';
  const eName = bestE10
    ? [formatStationTitle(bestE10.brand, bestE10.name), bestE10.suburb].filter(Boolean).join(' · ')
    : '';
  return renderE10CompareHtml(u, e, {
    title: 'E10 vs U91 (cheapest)',
    className: 'fav-e10-compare',
    uStationName: uName,
    eStationName: eName,
  });
}

function updateSummaryTitle() {
  const title = document.getElementById('summaryTitle');
  if (!title) return;
  const state = document.getElementById('stateSelect')?.value;
  if (!state) {
    title.textContent = 'Summary';
    return;
  }
  const scope = selectedScope();
  const scopeWord =
    scope === 'metro' ? 'Metro' : scope === 'regional' ? 'Regional' : 'Statewide';
  title.textContent = `${state} ${scopeWord} Summary`;
  updateScopeCycleHeading();
}

function updateAreaSummaryTitle() {
  const title = document.getElementById('areaSummaryTitle');
  if (!title) return;
  title.textContent = 'Suburb summary';
}

function areaSeriesStats(periodDays) {
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  const aligned = areaSeriesForLabels(selectedAreaSeries, labels);
  if (!aligned?.mean?.length) return null;
  const means = aligned.mean.filter((v) => v != null);
  if (!means.length) return null;
  const lows = aligned.low.filter((v) => v != null);
  const highs = aligned.high.filter((v) => v != null);
  let latestIdx = -1;
  for (let i = aligned.mean.length - 1; i >= 0; i--) {
    if (aligned.mean[i] != null) {
      latestIdx = i;
      break;
    }
  }
  return {
    latest: {
      avg: aligned.mean[latestIdx],
      low: aligned.low[latestIdx],
      high: aligned.high[latestIdx],
    },
    currentLow: aligned.low[latestIdx],
    currentHigh: aligned.high[latestIdx],
    periodLow: lows.length ? Math.min(...lows) : null,
    periodHigh: highs.length ? Math.max(...highs) : null,
    periodDays,
    peerCount: aligned.peerCount,
    radiusKm: aligned.radiusKm,
  };
}

function latestAreaFuelMeans() {
  const centre = selectedAreaCentre;
  if (!centre) return { u91: null, e10: null };
  const state =
    centre.state || document.getElementById('stateSelect')?.value || chartCycleCtx.state;
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog) return { u91: null, e10: null };
  const peerIds = peerIdsWithinKm(
    catalog,
    Number(centre.lat),
    Number(centre.lng),
    selectedAreaRadiusKm()
  );
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const day = publishedStationCache.days[`${state}|${labels[i]}`];
    if (!day) continue;
    const uVals = [];
    const eVals = [];
    for (const id of peerIds) {
      const prices = pricesFromPublishedDay(day, id);
      if (prices?.U91 != null) uVals.push(prices.U91 / 10);
      if (prices?.E10 != null) eVals.push(prices.E10 / 10);
    }
    if (!uVals.length && !eVals.length) continue;
    const avg = (arr) =>
      arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    return { u91: avg(uVals), e10: avg(eVals), date: labels[i] };
  }
  return { u91: null, e10: null };
}

function renderAreaE10Box() {
  const box = document.getElementById('areaE10Compare');
  if (!box) return;
  const uRow = cheapestAreaFuelPrice('U91');
  const eRow = cheapestAreaFuelPrice('E10');
  const u91 = uRow?.price ?? null;
  const e10 = eRow?.price ?? null;
  if (u91 == null || e10 == null) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = renderE10CompareInner(u91, e10, {
    title: 'E10 vs U91 (cheapest)',
    uStationName: [uRow?.name, uRow?.suburb].filter(Boolean).join(' · '),
    eStationName: [eRow?.name, eRow?.suburb].filter(Boolean).join(' · '),
  });
}

function normalizeStationTitlePart(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens used for brand/name overlap checks (drop noise like "logo"). */
function stationTitleTokens(s) {
  return normalizeStationTitlePart(s)
    .toLowerCase()
    .replace(/[^\w\s+&-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t !== 'logo' && t !== 'icon' && t !== 'the' && t !== 'and' && t !== 'pty' && t !== 'ltd');
}

function stationDisplayNameFromMeta(meta, fallbackId) {
  if (!meta) return fallbackId || 'Station';
  const brand = normalizeStationTitlePart(meta.brand);
  const name = normalizeStationTitlePart(meta.name);
  if (!brand && !name) return fallbackId || 'Station';
  if (!brand) return name;
  if (!name) return brand;

  const b = brand.toLowerCase();
  const n = name.toLowerCase();
  // Exact / full-phrase overlap
  if (
    n === b ||
    n.startsWith(`${b} `) ||
    n.endsWith(` ${b}`) ||
    n.includes(` ${b} `) ||
    b.startsWith(`${n} `)
  ) {
    return name;
  }

  const bTok = stationTitleTokens(brand);
  const nTok = stationTitleTokens(name);
  if (bTok.length && nTok.length) {
    // Shared leading tokens: "Metro Fuel" + "Metro Lansdowne", "EG Ampol" + "EG Ampol Werrington"
    let shared = 0;
    while (shared < bTok.length && shared < nTok.length && bTok[shared] === nTok[shared]) {
      shared += 1;
    }
    if (shared > 0) return name;

    // First meaningful brand token matches start of name: "24Xpress logo" + "24Xpress Lansvale"
    if (bTok[0] === nTok[0]) return name;

    // Any substantial brand token opens the name
    for (const t of bTok) {
      if (t.length >= 3 && (nTok[0] === t || n.startsWith(`${t} `))) return name;
    }
  }

  return `${brand} ${name}`.trim();
}

/** Prefer station name when it already embeds the brand (common in FuelCheck). */
function formatStationTitle(brand, name, fallback = 'Station') {
  return stationDisplayNameFromMeta({ brand, name }, fallback);
}

/** Cheapest published price for a fuel in the current state + scope (cached day). */
function cheapestPublishedFuelInState(fuel, state, scope = selectedScope()) {
  if (!state || !fuel) return null;
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog?.stations) return null;
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const iso = labels[i];
    const day = publishedStationCache.days[`${state}|${iso}`];
    if (!day) continue;
    let min = null;
    let minId = null;
    const consider = (id, tenths) => {
      if (tenths == null || !Number.isFinite(tenths)) return;
      const meta = catalog.stations[id];
      if (!meta) return;
      if (brandExcludedFromArea(meta.brand)) return;
      if (!stationMatchesScope(meta, state, scope)) return;
      const c = tenths / 10;
      if (min == null || c < min) {
        min = c;
        minId = id;
      }
    };
    if (day.stations) {
      for (const [id, prices] of Object.entries(day.stations)) {
        consider(id, prices?.[fuel]);
      }
    } else if (Array.isArray(day.s)) {
      for (const row of day.s) {
        if (!Array.isArray(row) || row.length < 2) continue;
        consider(row[0], row[1]?.[fuel]);
      }
    }
    if (min != null && minId != null) {
      const meta = catalog.stations[minId] || {};
      return {
        price: min,
        date: iso,
        stationId: minId,
        name: stationDisplayNameFromMeta(meta, minId),
        suburb: meta.suburb || '',
        brand: meta.brand || '',
        state,
      };
    }
  }
  return null;
}

/** High / low for selected fuel within current state+scope from the same day as cheapest. */
function publishedScopeFuelBand(fuel, state, scope = selectedScope()) {
  if (!state || !fuel) return null;
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog?.stations) return null;
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const iso = labels[i];
    const day = publishedStationCache.days[`${state}|${iso}`];
    if (!day) continue;
    let low = null;
    let high = null;
    const consider = (id, tenths) => {
      if (tenths == null || !Number.isFinite(tenths)) return;
      const meta = catalog.stations[id];
      if (!meta) return;
      if (brandExcludedFromArea(meta.brand)) return;
      if (!stationMatchesScope(meta, state, scope)) return;
      const c = tenths / 10;
      if (low == null || c < low) low = c;
      if (high == null || c > high) high = c;
    };
    if (day.stations) {
      for (const [id, prices] of Object.entries(day.stations)) {
        consider(id, prices?.[fuel]);
      }
    } else if (Array.isArray(day.s)) {
      for (const row of day.s) {
        if (!Array.isArray(row) || row.length < 2) continue;
        consider(row[0], row[1]?.[fuel]);
      }
    }
    if (low != null) return { low, high, date: iso };
  }
  return null;
}

function cheapestAreaFuelPrice(fuel) {
  const centre = selectedAreaCentre;
  if (!centre || centre.lat == null || centre.lng == null) return null;
  const state =
    centre.state || document.getElementById('stateSelect')?.value || chartCycleCtx.state;
  if (!state) return null;
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog) return null;
  const peerIds = peerIdsWithinKm(
    catalog,
    Number(centre.lat),
    Number(centre.lng),
    selectedAreaRadiusKm()
  );
  if (!peerIds.length) return null;
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const iso = labels[i];
    const day = publishedStationCache.days[`${state}|${iso}`];
    if (!day) continue;
    let min = null;
    let minId = null;
    for (const id of peerIds) {
      const tenths = pricesFromPublishedDay(day, id)?.[fuel];
      if (tenths == null || !Number.isFinite(tenths)) continue;
      const c = tenths / 10;
      if (min == null || c < min) {
        min = c;
        minId = id;
      }
    }
    if (min != null) {
      const meta = catalog.stations?.[minId] || {};
      return {
        price: min,
        date: iso,
        stationId: minId,
        name: stationDisplayNameFromMeta(meta, minId),
        suburb: meta.suburb || '',
        brand: meta.brand || '',
        state,
      };
    }
  }
  return null;
}

function latestAreaMeanForFuel(fuel) {
  const centre = selectedAreaCentre;
  if (!centre || centre.lat == null || centre.lng == null) return null;
  const state =
    centre.state || document.getElementById('stateSelect')?.value || chartCycleCtx.state;
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog) return null;
  const peerIds = peerIdsWithinKm(
    catalog,
    Number(centre.lat),
    Number(centre.lng),
    selectedAreaRadiusKm()
  );
  if (!peerIds.length) return null;
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const day = publishedStationCache.days[`${state}|${labels[i]}`];
    if (!day) continue;
    const vals = [];
    for (const id of peerIds) {
      const tenths = pricesFromPublishedDay(day, id)?.[fuel];
      if (tenths != null && Number.isFinite(tenths)) vals.push(tenths / 10);
    }
    if (vals.length) {
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }
  }
  return null;
}

function renderCheapestStationsBlock(rowsByFuel, opts = {}) {
  const lines = [];
  for (const fuel of SUMMARY_FUELS) {
    const row = rowsByFuel[fuel];
    if (!row) continue;
    const label = FUEL_LABELS[fuel] || fuel;
    const place = [row.name, row.suburb].filter(Boolean).join(' · ');
    lines.push(`
      <div class="cheap-fuel-row">
        <p class="cheap-fuel-line"><strong>${escapeHtml(label)}</strong> ${row.price.toFixed(1)}c</p>
        <p class="cheap-station-line">${escapeHtml(place)}</p>
      </div>
    `);
  }
  if (!lines.length) return '';
  const u = rowsByFuel.U91?.price ?? null;
  const e = rowsByFuel.E10?.price ?? null;
  const cmp = u != null && e != null ? compareE10VsU91(u, e) : null;
  if (cmp && !opts.hideBestBuy) {
    const uName = rowsByFuel.U91
      ? [rowsByFuel.U91.name, rowsByFuel.U91.suburb].filter(Boolean).join(' · ')
      : '';
    const eName = rowsByFuel.E10
      ? [rowsByFuel.E10.name, rowsByFuel.E10.suburb].filter(Boolean).join(' · ')
      : '';
    lines.push(`<p class="e10-best"><strong>Best buy:</strong> ${e10BestBuyLine(cmp)}</p>`);
    lines.push(e10BestBuyStationLine(cmp, uName, eName));
    lines.push(
      `<p class="e10-note e10-prices">U91 ${u.toFixed(1)}c vs E10 ${e.toFixed(1)}c ${formatE10PriceDiffPct(u, e)}</p>`
    );
  }
  const title = opts.title || 'Cheapest';
  return `
    <div class="scope-cheapest-stations">
      <div class="e10-head"><strong>${escapeHtml(title)}</strong></div>
      ${lines.join('')}
    </div>
  `;
}

function renderScopeCheapestStationsHtml(state) {
  const scope = selectedScope();
  const rows = {};
  for (const fuel of SUMMARY_FUELS) {
    const row = cheapestPublishedFuelInState(fuel, state, scope);
    if (row) rows[fuel] = row;
  }
  const scopeWord =
    scope === 'metro' ? 'metro' : scope === 'regional' ? 'regional' : 'statewide';
  return renderCheapestStationsBlock(rows, {
    title: `Cheapest in ${state || ''} ${scopeWord}`.trim(),
    hideBestBuy: true,
  });
}

function renderAreaCheapestStationsHtml() {
  if (!selectedAreaCentre) return '';
  const rows = {};
  for (const fuel of SUMMARY_FUELS) {
    const row = cheapestAreaFuelPrice(fuel);
    if (row) rows[fuel] = row;
  }
  return renderCheapestStationsBlock(rows, {
    title: `Cheapest in suburb (${selectedAreaRadiusKm()} km)`,
    hideBestBuy: true,
  });
}

function renderFavouritesCheapestStationsHtml() {
  const rows = {};
  for (const fuel of SUMMARY_FUELS) {
    const row = bestFavouriteForFuel(fuel);
    if (!row) continue;
    rows[fuel] = {
      price: row.price,
      name: formatStationTitle(row.brand, row.name, row.id),
      suburb: row.suburb || '',
      brand: row.brand || '',
    };
  }
  return renderCheapestStationsBlock(rows, {
    title: 'Cheapest in favourites',
    hideBestBuy: true,
  });
}

function countCatalogStationsInScope(state, scope = selectedScope()) {
  const catalog = publishedStationCache.catalogs[state];
  if (!catalog?.stations) return null;
  let n = 0;
  for (const meta of Object.values(catalog.stations)) {
    if (brandExcludedFromArea(meta.brand)) continue;
    if (!stationMatchesScope(meta, state, scope)) continue;
    n += 1;
  }
  return n;
}

function updateStateSummaryHint(stats) {
  const hint = document.getElementById('stateSummaryHint');
  if (!hint) return;
  const state = document.getElementById('stateSelect')?.value;
  if (!state) {
    hint.textContent = '';
    hint.classList.add('hidden');
    return;
  }
  const scope = selectedScope();
  const scopeWord =
    scope === 'metro' ? 'metro' : scope === 'regional' ? 'regional' : 'statewide';
  const n =
    countCatalogStationsInScope(state, scope) ??
    (stats?.latest?.n != null ? Number(stats.latest.n) : null);
  if (n != null) {
    hint.innerHTML = `${n} stations in ${scopeWord}${
      excludeCostcoEnabled()
        ? `<br /><span class="summary-hint-exclude">Costco excluded</span>`
        : ''
    }`;
  } else {
    hint.textContent = 'Loading scope stations…';
  }
  hint.classList.remove('hidden');
}

function updateFavSummaryHint() {
  const hint = document.getElementById('favSummaryHint');
  if (!hint) return;
  const n =
    favouritesLatestSnapshot?.length ||
    selectedFavouritesSeries?.stationCount ||
    (window.UserPrefs?.listFavourites?.() || []).filter((f) => !brandExcludedFromArea(f.brand))
      .length;
  if (!n) {
    hint.textContent = 'Add favourites to see summary stats.';
    hint.classList.remove('hidden');
    return;
  }
  hint.innerHTML = `${n} favourite station${n === 1 ? '' : 's'}${
    excludeCostcoEnabled()
      ? `<br /><span class="summary-hint-exclude">Costco excluded</span>`
      : ''
  }`;
  hint.classList.remove('hidden');
}

function favouritesSeriesStats(periodDays) {
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  const aligned = favouritesSeriesForLabels(selectedFavouritesSeries, labels);
  if (!aligned?.mean?.length) return null;
  const means = aligned.mean.filter((v) => v != null);
  if (!means.length) return null;
  const lows = aligned.low.filter((v) => v != null);
  const highs = aligned.high.filter((v) => v != null);
  let latestIdx = -1;
  for (let i = aligned.mean.length - 1; i >= 0; i--) {
    if (aligned.mean[i] != null) {
      latestIdx = i;
      break;
    }
  }
  return {
    latest: {
      avg: aligned.mean[latestIdx],
      low: aligned.low[latestIdx],
      high: aligned.high[latestIdx],
    },
    currentLow: aligned.low[latestIdx],
    currentHigh: aligned.high[latestIdx],
    periodLow: lows.length ? Math.min(...lows) : null,
    periodHigh: highs.length ? Math.max(...highs) : null,
    periodDays,
    stationCount: aligned.stationCount,
  };
}

async function ensureStateDayCachedForSummary(state) {
  if (!state) return;
  await loadPublishedCatalog(state);
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const day = await loadPublishedDay(state, labels[i]);
    if (day) return day;
  }
  return null;
}

function latestFavouritesMeanForFuel(fuel) {
  const vals = [];
  for (const r of favouritesLatestSnapshot) {
    const p = r.prices?.[fuel];
    if (p != null && Number.isFinite(p)) vals.push(p);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function renderAreaSummary(stats, periodDays) {
  updateAreaSummaryTitle();
  const cards = document.getElementById('areaSummaryCards');
  const hint = document.getElementById('areaSummaryHint');
  const bars = document.getElementById('areaRankBars');
  if (!cards) return;

  const fuel = document.getElementById('fuelSelect')?.value;
  const stInfo = latestSelectedStationPrice(fuel);
  const stationPrice = stInfo?.price ?? null;
  const areaSnap = latestAreaSnapshot();
  const areaStats = areaSeriesStats(periodDays);
  if (!selectedAreaCentre) {
    if (hint) {
      hint.textContent = 'Type a postcode or suburb to centre the suburb band.';
      hint.classList.remove('hidden');
    }
    cards.innerHTML = '<p class="hint">No suburb selected.</p>';
    if (bars) bars.innerHTML = '';
    renderAreaE10Box();
    applyAreaDialForDate(
      chartCycleCtx.series?.[chartCycleCtx.selectedIndex]?.date || null
    );
    return;
  }

  if (hint) {
    const n = areaStats?.peerCount ?? selectedAreaSeries?.peerCount;
    if (n != null) {
      hint.innerHTML = `${n} stations in radius${
        excludeCostcoEnabled()
          ? `<br /><span class="summary-hint-exclude">Costco excluded</span>`
          : ''
      }`;
    } else {
      hint.textContent = 'Loading suburb prices…';
    }
    hint.classList.remove('hidden');
  }

  if (!areaStats) {
    cards.innerHTML = '<p class="hint">No suburb prices in this period.</p>';
  } else {
    cards.innerHTML = `
      ${selectedFuelHeaderHtml()}
      <div class="summary-row"><span class="label">Current mean</span><span class="value">${areaStats.latest.avg.toFixed(1)}c</span></div>
      <div class="summary-row"><span class="label">Current low / high</span><span class="value">${areaStats.currentLow?.toFixed(1) ?? '-'} - ${areaStats.currentHigh?.toFixed(1) ?? '-'}c</span></div>
      <div class="summary-row"><span class="label">Period (${periodDays}d) low / high</span><span class="value">${areaStats.periodLow?.toFixed(1) ?? '-'} - ${areaStats.periodHigh?.toFixed(1) ?? '-'}c</span></div>
    `;
  }

  renderAreaE10Box();

  if (bars) {
    bars.innerHTML =
      renderAreaCheapestStationsHtml() +
      (stationPrice != null
        ? renderAreaRankBar(stationPrice, areaSnap?.low ?? null, areaSnap?.high ?? null)
        : '');
  }

  applyAreaDialForDate(
    chartCycleCtx.series?.[chartCycleCtx.selectedIndex]?.date || null
  );
}

function renderStateRankBars() {
  const el = document.getElementById('stateRankBars');
  if (!el) return;
  const fuel = document.getElementById('fuelSelect')?.value;
  const state = document.getElementById('stateSelect')?.value;
  const stInfo = latestSelectedStationPrice(fuel);
  const stationPrice = stInfo?.price ?? null;
  if (stationPrice == null) {
    el.innerHTML = '';
    return;
  }
  const band = publishedScopeFuelBand(fuel, state, selectedScope());
  const stats = seriesStats(chartCycleCtx.series || []);
  const low = band?.low ?? stats?.currentLow ?? null;
  const high = band?.high ?? stats?.currentHigh ?? null;
  el.innerHTML = renderStateRankBar(stationPrice, low, high);
}

function renderSummaryCards(stats, periodDays) {
  updateSummaryTitle();
  updateStateSummaryHint(stats);
  const el = document.getElementById('summaryCards');
  if (!stats) {
    el.innerHTML = '<p class="hint">No data for this fuel.</p>';
    renderOutlookBar();
    renderStateRankBars();
    renderAreaSummary(null, periodDays);
    renderFavouriteStationsSummary();
    renderStationSummary(null);
    return;
  }
  const fuel = document.getElementById('fuelSelect')?.value;
  const state = document.getElementById('stateSelect')?.value;
  const band = publishedScopeFuelBand(fuel, state, selectedScope());
  const currentLow = band?.low ?? stats.currentLow;
  const currentHigh = band?.high ?? stats.currentHigh;
  el.innerHTML = `
    ${selectedFuelHeaderHtml()}
    <div class="summary-row"><span class="label">Current mean</span><span class="value">${stats.latest.avg.toFixed(1)}c</span></div>
    <div class="summary-row"><span class="label">Current low / high</span><span class="value">${currentLow?.toFixed(1) ?? '-'} - ${currentHigh?.toFixed(1) ?? '-'}c</span></div>
    <div class="summary-row"><span class="label">Period (${periodDays}d) low / high</span><span class="value">${stats.periodLow?.toFixed(1) ?? '-'} - ${stats.periodHigh?.toFixed(1) ?? '-'}c</span></div>
  `;
  renderOutlookBar();
  renderStateRankBars();
  renderAreaSummary(stats, periodDays);
  renderFavouriteStationsSummary();
  renderStationSummary(stats);
}

function renderFavouriteStationsSummary() {
  const el = document.getElementById('favStationsSummary');
  if (!el) return;

  updateFavSummaryHint();

  const fuel = document.getElementById('fuelSelect')?.value;
  const periodDays = selectedPeriod();
  const favStats = favouritesSeriesStats(periodDays);
  const favBand = latestFavouritesBand(fuel);
  const stInfo = latestSelectedStationPrice(fuel);
  const stationPrice = stInfo?.price ?? null;
  const favE10 = renderFavouritesE10Section();
  const cheapestHtml = renderFavouritesCheapestStationsHtml();

  const mean =
    favStats?.latest?.avg ?? favBand?.mean ?? null;
  const currentLow = favStats?.currentLow ?? favBand?.low ?? null;
  const currentHigh = favStats?.currentHigh ?? favBand?.high ?? null;
  const periodLow = favStats?.periodLow ?? null;
  const periodHigh = favStats?.periodHigh ?? null;

  const meanRows =
    mean != null
      ? `
    ${selectedFuelHeaderHtml()}
    <div class="summary-row"><span class="label">Current mean</span><span class="value">${mean.toFixed(1)}c</span></div>
    <div class="summary-row"><span class="label">Current low / high</span><span class="value">${currentLow?.toFixed(1) ?? '-'} - ${currentHigh?.toFixed(1) ?? '-'}c</span></div>
    <div class="summary-row"><span class="label">Period (${periodDays}d) low / high</span><span class="value">${periodLow?.toFixed(1) ?? '-'} - ${periodHigh?.toFixed(1) ?? '-'}c</span></div>
  `
      : '';

  el.innerHTML = `
    <div class="station-fav-cycle">
      <h3 class="cycle-dial-heading">Favourites cycle</h3>
      <div id="favCycleStages" class="cycle-stages"></div>
    </div>
    ${meanRows}
    ${favE10}
    ${cheapestHtml}
    ${stationPrice != null ? renderFavouritesRankBar(stationPrice, favBand) : ''}
  `;

  applyFavouritesDialForDate(
    chartCycleCtx.series?.[chartCycleCtx.selectedIndex]?.date || null
  );
}

function renderStationSummary(stats) {
  const el = document.getElementById('stationSummary');
  if (!el) return;

  const fuel = document.getElementById('fuelSelect')?.value;
  const stInfo = latestSelectedStationPrice(fuel);

  if (!stInfo) {
    el.innerHTML = '<p class="hint">Select a station for station summary.</p>';
    return;
  }

  const st = getCachedStation(selectedStationId);
  const brandLogo = window.brandLogoFor?.(st?.brand || '');
  const nameLine = brandLogo
    ? `<p class="station-summary-name"><img class="brand-logo" src="${brandLogo}" alt="" />${escapeHtml(formatStationTitle(st?.brand, stInfo.name || st?.name))}</p>`
    : `<p class="station-summary-name">${escapeHtml(formatStationTitle(st?.brand, stInfo.name || st?.name))}</p>`;

  const isFav = st ? window.UserPrefs?.isFavourite?.(st.id) : false;
  const favBtn = `
    <div class="fav-actions-inline">
      <button type="button" class="btn-secondary" id="btnToggleFavourite">
        ${isFav ? 'Remove favourite' : 'Add favourite'}
      </button>
      ${
        isFav
          ? `<button type="button" class="btn-secondary" id="btnSetDefaultFavourite">Set as default</button>`
          : ''
      }
    </div>
  `;

  const fuelRows = [];
  for (const f of SUMMARY_FUELS) {
    const price = st ? stationFuelPrice(st, f) : null;
    if (price == null) continue;
    const favMean = latestFavouritesMeanForFuel(f);
    const delta = favMean != null ? price - favMean : null;
    const label = FUEL_LABELS[f] || f;
    fuelRows.push(`
      <div class="summary-row price-line">
        <span class="label fuel-label-stack">
          <span class="fuel-name">${escapeHtml(label)}</span>
        </span>
        <span class="value price-delta"><span class="price-main">${price.toFixed(1)}c</span>${formatDeltaCl(delta)}</span>
      </div>
    `);
  }

  const fuelBlock = fuelRows.length
    ? `
    <h3 class="station-fuel-heading">Fuel prices vs favourites</h3>
    ${fuelRows.join('')}`
    : '<p class="hint">No fuel prices for this station.</p>';

  el.innerHTML = `
    ${nameLine}
    ${favBtn}
    <div class="station-fav-cycle">
      <h3 class="cycle-dial-heading">Station cycle</h3>
      <div id="stationCycleStages" class="cycle-stages"></div>
    </div>
    ${fuelBlock}
    ${renderStationE10Box(st)}
  `;

  applyStationDialForDate(
    chartCycleCtx.series?.[chartCycleCtx.selectedIndex]?.date || null
  );

  document.getElementById('btnToggleFavourite')?.addEventListener('click', () => {
    toggleFavouriteForSelected().catch((e) => setStatus(`Favourite: ${e.message}`));
  });
  document.getElementById('btnSetDefaultFavourite')?.addEventListener('click', () => {
    if (selectedStationId == null) return;
    UserPrefs.setDefaultFavourite(selectedStationId);
    renderFavouritesList();
    renderFavouriteStationsSummary();
    renderStationSummary(seriesStats(chartCycleCtx.series || []));
  });
}

function renderStationE10Box(st) {
  if (!st) return '';
  if (brandExcludedFromArea(st.brand)) return '';
  const u = stationFuelPrice(st, 'U91');
  const e = stationFuelPrice(st, 'E10');
  if (u == null || e == null) return '';
  return renderE10CompareHtml(u, e, {
    className: 'station-e10',
  });
}

function renderE10Box(file) {
  const box = document.getElementById('e10Compare');
  if (!box) return;
  const state = document.getElementById('stateSelect')?.value || file?.state;
  const scope = selectedScope();
  const cheapU = cheapestPublishedFuelInState('U91', state, scope);
  const cheapE = cheapestPublishedFuelInState('E10', state, scope);
  const u = cheapU?.price ?? null;
  const e = cheapE?.price ?? null;
  if (u == null || e == null) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const uName = [cheapU.name, cheapU.suburb].filter(Boolean).join(' · ');
  const eName = [cheapE.name, cheapE.suburb].filter(Boolean).join(' · ');
  box.classList.remove('hidden');
  box.innerHTML =
    renderE10CompareInner(u, e, {
      title: 'E10 vs U91 (cheapest)',
      uStationName: uName,
      eStationName: eName,
    }) + renderScopeCheapestStationsHtml(state);
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
    state,
    modelId,
    latestStage: null,
    selectedIndex,
  };
  chartCycleCtx.latestStage = series.length
    ? cycleStageForIndex(series.length - 1)
    : null;

  const place = scopeLabel(state, scope);
  const chartTitleText = `${place} - ${FUEL_LABELS[fuel] || fuel}`;
  document.getElementById('chartTitle').textContent = chartTitleText;

  const turnParams = window.CycleModels?.resolveTurnDetectParams?.(state);
  const turnTune = window.CycleModels?.getTurnTune?.();
  const latestN = stats?.latest?.n;
  let hint =
    `Showing ${scopeLabel(state, scope)} series` +
    (latestN != null ? ` (n=${latestN})` : '') +
    `. Last ${periodDays} days. Means solid · lows dotted · highs dashed. ` +
    `Turn lines: highs dashed (darker), lows dotted (lighter) · blue scope / purple suburb / orange favourites. ` +
    `FFT assist: dashed curves match each mean (state / suburb / favs).`;
  if (turnTune) {
    hint +=
      ` (sens ${turnTune.sensitivity}, gap ${turnParams?.minGap ?? turnTune.minGapDays}d, coarse ${turnTune.coarseness}, FFT ${turnTune.fftAssist ?? 0}).`;
  } else {
    hint += '.';
  }
  if (!file.scopes) {
    hint += ' · Legacy single-series file (metro/regional/state not split yet).';
  }
  document.getElementById('seriesHint').textContent = hint;

  const labels = series.map((p) => p.date);

  await ensureSuburbIndex();

  // Station history overlay (independent of area centre).
  if (selectedStationId != null) {
    const st = getCachedStation(selectedStationId);
    if (st) {
      try {
        selectedPublishedHistory = await loadPublishedHistoryForStation(st, labels, fuel);
      } catch (err) {
        console.warn('Published station history:', err.message);
      }
    }
  }

  // Area band from postcode centre (not from selected station).
  try {
    if (selectedAreaCentre) {
      selectedAreaSeries = await loadAreaSeriesAroundCentre(
        selectedAreaCentre,
        labels,
        fuel,
        selectedAreaRadiusKm()
      );
    } else {
      selectedAreaSeries = null;
    }
  } catch (err) {
    console.warn('Area series:', err.message);
    selectedAreaSeries = null;
  }

  try {
    selectedFavouritesSeries = await loadFavouritesSeries(labels, fuel);
  } catch (err) {
    console.warn('Favourites series:', err.message);
    selectedFavouritesSeries = null;
  }

  const favAligned = favouritesSeriesForLabels(selectedFavouritesSeries, labels);
  const favPoints = favMeanPointSeries(labels, favAligned);
  const favMarks = favPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(favPoints, favPoints, state)
    : { turns: [], modelId, fftOverlay: null };
  marks.favTurns = favMarks.turns || [];
  marks.favFftOverlay = favMarks.fftOverlay || null;
  favCycleCtx = {
    series: favPoints,
    turns: favMarks.turns || [],
    fftOverlay: favMarks.fftOverlay || null,
    params: null,
    state,
    modelId: favMarks.modelId || modelId,
    latestStage: null,
  };
  favCycleCtx.latestStage = favPoints.length
    ? favCycleStageForIndex(favPoints.length - 1)
    : null;

  const areaAligned = areaSeriesForLabels(selectedAreaSeries, labels);
  const areaPoints = favMeanPointSeries(labels, areaAligned);
  const areaMarks = areaPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(areaPoints, areaPoints, state)
    : { turns: [], modelId, fftOverlay: null };
  areaCycleCtx = {
    series: areaPoints,
    turns: areaMarks.turns || [],
    fftOverlay: areaMarks.fftOverlay || null,
    params: null,
    state,
    modelId: areaMarks.modelId || modelId,
    latestStage: null,
  };
  areaCycleCtx.latestStage = areaPoints.length
    ? areaCycleStageForIndex(areaPoints.length - 1)
    : null;
  marks.areaTurns = areaMarks.turns || [];
  marks.areaFftOverlay = areaMarks.fftOverlay || null;

  const stationPoints = (() => {
    const overlay = selectedStationChartOverlay(labels, fuel);
    if (!overlay?.data?.length) return [];
    return labels.map((date, i) => ({ date, avg: overlay.data[i] }));
  })();
  const stationMarks = stationPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(stationPoints, stationPoints, state)
    : { turns: [], modelId };
  stationCycleCtx = {
    series: stationPoints,
    turns: stationMarks.turns || [],
    params: null,
    state,
    modelId: stationMarks.modelId || modelId,
    latestStage: null,
  };
  stationCycleCtx.latestStage = stationPoints.length
    ? stationCycleStageForIndex(stationPoints.length - 1)
    : null;
  marks.stationTurns = stationMarks.turns || [];

  renderHistoryChart(
    labels,
    series,
    fuel,
    `${chartTitleText} (c/L)`,
    state,
    marks
  );
  renderSummaryCards(stats, periodDays);
  if (selectedIndex != null) applySelectedDay(selectedIndex);
  else {
    updateScopeCycleHeading();
    renderCycleDial(chartCycleCtx.latestStage, {
      targetId: 'cycleStages',
      title: scopeCycleTitle(),
      modelId: chartCycleCtx.modelId,
    });
    applyFavouritesDialForDate(null);
    applyAreaDialForDate(null);
    applyStationDialForDate(null);
  }
  syncArcpathTuneVisibility();
  syncWaWeeklyAfterLastVisibility();
  renderE10Box(file);
  const stateForCheap = document.getElementById('stateSelect')?.value || file?.state;
  ensureStateDayCachedForSummary(stateForCheap)
    .then(() => {
      renderE10Box(file);
      const st = seriesStats(chartCycleCtx.series || []);
      if (st) renderSummaryCards(st, selectedPeriod());
      else {
        renderAreaSummary(null, selectedPeriod());
        renderFavouriteStationsSummary();
      }
    })
    .catch(() => {});
  renderFavouritesList();
  requestAnimationFrame(() => syncChartHeightToSummary());
}

async function loadAllStates() {
  setStatus('Loading index...');
  const index = await fetchJson(`${baseUrl()}/v1/index.json`);
  const select = document.getElementById('stateSelect');
  select.innerHTML = '';
  stateFiles = {};

  for (const st of index.states) {
    const code = st.code;
    select.innerHTML += `<option value="${code}">${code}</option>`;
    stateFiles[code] = await fetchJson(`${baseUrl()}/v1/${st.file}`);
  }

  await loadOutlookData();

  setStatus(`Loaded ${index.states.length} states · window ${index.windowDays} days · ${index.source?.slice(0, 80)}...`);
  applyUserPrefsToControls({ initial: !prefsAppliedOnce });
  prefsAppliedOnce = true;
  await refreshCharts();
  await maybeSelectDefaultFavourite();
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
    if (!map || map.getZoom() < MIN_ZOOM_STATIONS) {
      clearStationMarkers();
      rebuildStationList();
      return;
    }
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
  const side = document.querySelector('.stations-side');
  if (!side) return;
  // Favourites viewport is taller than the map; do not clip the side to map height.
  side.style.height = '';
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
    fetchPublishedStationsInView({ fromViewport: true });
  }, 450);
}

/** Nearest capital state, plus any capital inside a padded viewport. */
function statesForMapView() {
  if (!map) return [];
  const c = map.getCenter();
  let best = null;
  let bestKm = Infinity;
  for (const [code, cap] of Object.entries(CAPITALS)) {
    const km = haversineKm(c.lat, c.lng, cap.lat, cap.lng);
    if (km < bestKm) {
      bestKm = km;
      best = code;
    }
  }
  const out = new Set();
  if (best) out.add(best);
  const selected = document.getElementById('stateSelect')?.value;
  if (selected) out.add(selected);
  const bounds = map.getBounds().pad(0.2);
  for (const [code, cap] of Object.entries(CAPITALS)) {
    if (bounds.contains([cap.lat, cap.lng])) out.add(code);
  }
  return [...out];
}

async function resolveLatestStationDay(state) {
  if (publishedStationCache.latestDay[state]) return publishedStationCache.latestDay[state];
  const candidates = [];
  const file = stateFiles[state];
  if (file?.start && file.days) {
    const start = isoToDayNum(file.start);
    for (let i = file.days - 1; i >= Math.max(0, file.days - 21); i--) {
      candidates.push(dayNumToISO(start + i));
    }
  }
  const today = new Date();
  for (let d = 0; d < 10; d++) {
    const dt = new Date(today.getTime() - d * DAY_MS);
    const iso = dt.toISOString().slice(0, 10);
    if (!candidates.includes(iso)) candidates.push(iso);
  }
  for (const iso of candidates) {
    const day = await loadPublishedDay(state, iso);
    if (day && ((day.s && day.s.length) || (day.stations && Object.keys(day.stations).length))) {
      publishedStationCache.latestDay[state] = iso;
      return iso;
    }
  }
  return null;
}

function publishedDayPriceMap(dayFile) {
  const map = new Map();
  if (!dayFile) return map;
  if (dayFile.stations && typeof dayFile.stations === 'object' && !Array.isArray(dayFile.stations)) {
    for (const [id, prices] of Object.entries(dayFile.stations)) map.set(id, prices);
    return map;
  }
  for (const row of dayFile.s || []) {
    if (Array.isArray(row) && row.length >= 2) map.set(row[0], row[1]);
  }
  return map;
}

const PM_TYPE_FOR_FUEL = {
  U91: 'ULP',
  E10: 'E10',
  P95: 'PULP95',
  P98: 'PULP98',
  DSL: 'DIESEL',
  PDSL: 'PDIESEL',
};

function stationFromPublished(id, meta, pricesTenths, state) {
  if (!meta || meta.lat == null || meta.lng == null) return null;
  const lat = Number(meta.lat);
  const lng = Number(meta.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const prices = {};
  const fuels = [];
  for (const [fuel, tenths] of Object.entries(pricesTenths || {})) {
    if (tenths == null || !Number.isFinite(Number(tenths))) continue;
    const cents = Number(tenths) / 10;
    prices[fuel] = cents;
    fuels.push({
      type: PM_TYPE_FOR_FUEL[fuel] || fuel,
      name: FUEL_LABELS[fuel] || fuel,
      price: cents,
    });
  }
  return {
    id,
    name: meta.name || '',
    brand: meta.brand || '',
    address: meta.address || '',
    suburb: meta.suburb || '',
    postcode: meta.postcode != null ? meta.postcode : null,
    state: state || meta.state || '',
    lat,
    lng,
    prices,
    fuels,
    loaded: true,
    source: 'published',
  };
}

async function loadPublishedStationsForState(state) {
  const catalog = await loadPublishedCatalog(state);
  if (!catalog?.stations) return { stations: [], dayIso: null };
  const dayIso = await resolveLatestStationDay(state);
  if (!dayIso) return { stations: [], dayIso: null };
  const day = await loadPublishedDay(state, dayIso);
  const priceMap = publishedDayPriceMap(day);
  const stations = [];
  for (const [id, prices] of priceMap) {
    const meta = catalog.stations[id];
    const st = stationFromPublished(id, meta, prices, state);
    if (st) stations.push(st);
  }
  return { stations, dayIso };
}

function pmFuelType(fuel) {
  return Object.entries(PETROLMATE_FUEL).find(([, v]) => v === fuel)?.[0] || 'ULP';
}

function stationFuelPrice(station, fuel) {
  if (station?.prices && station.prices[fuel] != null && Number.isFinite(station.prices[fuel])) {
    return station.prices[fuel];
  }
  const pm = pmFuelType(fuel);
  const row = station?.fuels?.find((f) => f.type === pm);
  return row?.price ?? null;
}

/** Green (cheap) -> red (dear) for t in [0, 1]. */
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
  const priceLabel = price != null ? `${price.toFixed(1)}c` : '-';
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
  const fuel = document.getElementById('fuelSelect')?.value;
  const center = map.getCenter();
  const out = [];
  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng) continue;
    if (bounds.contains([st.lat, st.lng])) {
      out.push({
        ...st,
        distance_m: Math.round(haversineKm(center.lat, center.lng, st.lat, st.lng) * 1000),
      });
    }
  }
  out.sort((a, b) => {
    const pa = stationFuelPrice(a, fuel);
    const pb = stationFuelPrice(b, fuel);
    if (pa != null && pb != null && pa !== pb) return pa - pb;
    if (pa != null && pb == null) return -1;
    if (pa == null && pb != null) return 1;
    return (a.distance_m || 0) - (b.distance_m || 0);
  });
  return out;
}

function rebuildStationList() {
  const list = document.getElementById('stationList');
  if (!list) return;
  if (!map || map.getZoom() < MIN_ZOOM_STATIONS) {
    list.innerHTML =
      '<div class="station-item">Zoom in closer to load station pins.</div>';
    return;
  }
  const fuel = document.getElementById('fuelSelect').value;
  stationsLive = stationsInMapBounds();
  list.innerHTML = '';

  if (!stationsLive.length) {
    list.innerHTML = '<div class="station-item">No stations in view - pan/zoom or click a pin.</div>';
    return;
  }

  stationsLive.forEach((st) => {
    const price = stationFuelPrice(st, fuel);
    const priceStr = price != null ? `${price.toFixed(1)}c` : '-';
    const div = document.createElement('div');
    div.className = 'station-item';
    if (st.id === selectedStationId) div.classList.add('active');
    div.textContent = `${priceStr} · ${formatStationTitle(st.brand, st.name)}`;
    div.onclick = () => selectStationById(st.id);
    list.appendChild(div);
  });
}

function clearStationMarkers() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  markerById.clear();
}

function redrawStationMarkers() {
  if (!markerLayer || !map) return;
  if (map.getZoom() < MIN_ZOOM_STATIONS) {
    clearStationMarkers();
    return;
  }
  markerLayer.clearLayers();
  markerById.clear();

  const fuel = document.getElementById('fuelSelect').value;
  const bounds = map.getBounds();
  const visible = [];
  for (const st of stationCache.values()) {
    if (!st.lat || !st.lng || !bounds.contains([st.lat, st.lng])) continue;
    visible.push(st);
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
}

async function fetchStationsAround(lat, lng, opts = {}) {
  initMap();
  if (opts.recenter && Number.isFinite(lat) && Number.isFinite(lng)) {
    map.setView([lat, lng], Math.max(map.getZoom(), MIN_ZOOM_STATIONS));
  }
  return fetchPublishedStationsInView(opts);
}

async function fetchPublishedStationsInView(opts = {}) {
  initMap();
  if (map.getZoom() < MIN_ZOOM_STATIONS) {
    clearStationMarkers();
    rebuildStationList();
    updateMapZoomHint();
    return;
  }

  const list = document.getElementById('stationList');
  const states = statesForMapView();
  if (!opts.silent) {
    setStatus(`Loading published stations for ${states.join(', ') || 'map'}...`);
  }

  stationFetchInFlight = true;
  redrawStationMarkers();
  if (!opts.fromViewport) {
    list.innerHTML = '<div class="station-item">Fetching stations...</div>';
  }

  try {
    const results = await Promise.all(states.map((st) => loadPublishedStationsForState(st)));
    let added = 0;
    const days = [];
    for (const { stations, dayIso } of results) {
      if (dayIso) days.push(dayIso);
      mergeStationsIntoCache(stations, true);
      added += stations.length;
    }
    if (opts.recenter && opts.lat != null && opts.lng != null) {
      map.setView([opts.lat, opts.lng], Math.max(map.getZoom(), MIN_ZOOM_STATIONS));
    }
    redrawStationMarkers();
    rebuildStationList();
    if (!opts.silent) {
      const inView = stationsInMapBounds().length;
      const dayNote = days.length ? ` · prices ${[...new Set(days)].join(', ')}` : '';
      setStatus(
        `Showing ${inView} stations in view (${stationCache.size} loaded${dayNote}).`
      );
    }
    if (opts.anchorId) selectStationById(opts.anchorId);
    if (!added && !opts.fromViewport) {
      list.innerHTML =
        '<div class="station-item">No published stations with coordinates for this area.</div>';
    }
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
  let st = stationCache.get(id);
  if (!st) st = stationCache.get(String(id));
  if (!st) {
    for (const [k, v] of stationCache) {
      if (String(k) === String(id)) {
        st = v;
        break;
      }
    }
  }
  if (!st) return;
  selectedStationId = st.id;
  selectedPublishedHistory = null;

  if (map && st.lat != null && st.lng != null && Number.isFinite(Number(st.lat)) && Number.isFinite(Number(st.lng))) {
    initMap();
    const z = Math.max(map.getZoom(), MIN_ZOOM_STATIONS);
    map.setView([Number(st.lat), Number(st.lng)], z);
  }

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
  renderStateRankBars();
  renderFavouriteStationsSummary();
  renderStationSummary(seriesStats(chartCycleCtx.series || []));
  renderAreaSummary(seriesStats(chartCycleCtx.series || []), selectedPeriod());
}

function renderSelectedStationDetail(st) {
  const fuel = document.getElementById('fuelSelect').value;
  const scope = selectedScope();
  const place = scope === 'metro' ? 'metro' : 'state';

  const brandLogo = window.brandLogoFor?.(st.brand || '');
  const lines = [
    brandLogo ? `<img class="brand-logo detail-brand-logo" src="${brandLogo}" alt="" />` : '',
    `<strong>${escapeHtml(formatStationTitle(st.brand, st.name))}</strong>`,
    `${escapeHtml(st.address || '')}${st.suburb ? `, ${escapeHtml(st.suburb)}` : ''} ${escapeHtml(st.state || '')}`,
    st.source === 'published' ? '<p class="hint">Source: published station history</p>' : '',
    st.distance_m != null ? `Distance: ${st.distance_m}m` : '',
    '<table style="width:100%;margin-top:0.5rem"><tr><th>Fuel</th><th>c/L</th></tr>',
  ];
  const priceMap = {};
  if (st.prices && Object.keys(st.prices).length) {
    for (const [canon, price] of Object.entries(st.prices)) {
      priceMap[canon] = price;
      lines.push(
        `<tr><td>${escapeHtml(FUEL_LABELS[canon] || canon)}</td><td>${price?.toFixed(1) ?? '-'}</td></tr>`
      );
    }
  } else {
    for (const f of st.fuels || []) {
      const canon = petrolmateFuelToCanon(f.type);
      priceMap[canon] = f.price;
      lines.push(`<tr><td>${escapeHtml(f.name || f.type)}</td><td>${f.price?.toFixed(1) ?? '-'}</td></tr>`);
    }
  }
  lines.push('</table>');

  if (priceMap.U91 && priceMap.E10) {
    const cmp = compareE10VsU91(priceMap.U91, priceMap.E10);
    if (cmp.pick === 'tie') {
      lines.push('<p><strong>Best buy:</strong> Even (energy-adjusted)</p>');
    } else {
      const other = cmp.pick === 'E10' ? 'U91' : 'E10';
      lines.push(
        `<p><strong>Best buy:</strong> ${cmp.pick} - ${Math.abs(cmp.winPct).toFixed(1)}% better than ${other}</p>`
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
        `<p><strong>Vs ${place} average:</strong> below mean - ` +
          `${band.pct.toFixed(0)}th percentile from daily low ` +
          `(low ${band.min.toFixed(1)} -> mean ${band.avg.toFixed(1)}c)</p>`
      );
    } else {
      lines.push(
        `<p><strong>Vs ${place} average:</strong> above mean - ` +
          `${band.pct.toFixed(0)}th percentile from daily high ` +
          `(mean ${band.avg.toFixed(1)} -> high ${band.max.toFixed(1)}c)</p>`
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
        `(${nearby.cheapest.toFixed(1)}-${nearby.dearest.toFixed(1)}c)</p>`
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

  const isFav = window.UserPrefs?.isFavourite?.(st.id);
  lines.push(
    `<div class="fav-actions-inline">` +
      `<button type="button" class="btn-secondary" id="btnDetailToggleFavourite">${
        isFav ? 'Remove favourite' : 'Add favourite'
      }</button>` +
      (isFav
        ? `<button type="button" class="btn-secondary" id="btnDetailSetDefaultFavourite">Set as default</button>`
        : '') +
      `</div>`
  );

  document.getElementById('stationDetail').innerHTML = lines.join('');
  document.getElementById('btnDetailToggleFavourite')?.addEventListener('click', () => {
    toggleFavouriteForSelected().catch((e) => setStatus(`Favourite: ${e.message}`));
  });
  document.getElementById('btnDetailSetDefaultFavourite')?.addEventListener('click', () => {
    UserPrefs.setDefaultFavourite(st.id);
    renderFavouritesList();
    renderSelectedStationDetail(st);
    renderFavouriteStationsSummary();
    renderStationSummary(seriesStats(chartCycleCtx.series || []));
  });
}

/** Re-draw history chart station layer without a full data reload when possible. */
function refreshHistoryWithStationOverlay() {
  if (!chartCycleCtx.series?.length) return;
  const state = document.getElementById('stateSelect').value;
  const fuel = document.getElementById('fuelSelect').value;
  const series = chartCycleCtx.series;
  const labels = series.map((p) => p.date);
  const stationPoints = (() => {
    const overlay = selectedStationChartOverlay(labels, fuel);
    if (!overlay?.data?.length) return [];
    return labels.map((date, i) => ({ date, avg: overlay.data[i] }));
  })();
  const stationMarks = stationPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(stationPoints, stationPoints, state)
    : { turns: [], modelId: chartCycleCtx.modelId };
  stationCycleCtx = {
    series: stationPoints,
    turns: stationMarks.turns || [],
    params: null,
    state,
    modelId: stationMarks.modelId || chartCycleCtx.modelId,
    latestStage: null,
  };
  stationCycleCtx.latestStage = stationPoints.length
    ? stationCycleStageForIndex(stationPoints.length - 1)
    : null;
  const marks = {
    turns: chartCycleCtx.turns,
    modelId: chartCycleCtx.modelId,
    fftOverlay: chartCycleCtx.fftOverlay || null,
    areaFftOverlay: areaCycleCtx.fftOverlay || null,
    favFftOverlay: favCycleCtx.fftOverlay || null,
    favTurns: favCycleCtx.turns || [],
    areaTurns: areaCycleCtx.turns || [],
    stationTurns: stationCycleCtx.turns || [],
  };
  const place = scopeLabel(state, selectedScope());
  const chartTitleText = `${place} - ${FUEL_LABELS[fuel] || fuel}`;
  const selectedDate =
    chartCycleCtx.selectedIndex != null ? series[chartCycleCtx.selectedIndex]?.date : null;
  renderHistoryChart(
    labels,
    series,
    fuel,
    `${chartTitleText} (c/L)`,
    state,
    marks
  );
  if (selectedDate) {
    const idx = series.findIndex((p) => p?.date === selectedDate);
    if (idx >= 0) applySelectedDay(idx);
  } else if (chartCycleCtx.latestStage) {
    updateScopeCycleHeading();
    renderCycleDial(chartCycleCtx.latestStage, {
      targetId: 'cycleStages',
      title: scopeCycleTitle(),
      modelId: chartCycleCtx.modelId,
    });
    applyFavouritesDialForDate(null);
    applyAreaDialForDate(null);
    applyStationDialForDate(null);
  }
}

function goToCapital() {
  const code = document.getElementById('capitalSelect').value;
  const c = CAPITALS[code];
  document.getElementById('stateSelect').value = code;
  refreshCharts().catch(() => {});
  initMap();
  map.setView([c.lat, c.lng], MIN_ZOOM_STATIONS);
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
      labels[sc] + (n != null ? ` (n~${n})` : ok ? '' : ' - no data');
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
  if (!sel) return;
  const prefs = window.UserPrefs?.load?.();
  const wanted = prefs?.defaultScope || preferredScope(file, fuel);
  if (scopeIsAvailable(file, fuel, wanted)) sel.value = wanted;
  else sel.value = preferredScope(file, fuel);
}

function persistControlsToPrefs() {
  if (!window.UserPrefs) return;
  UserPrefs.update({
    preferredFuel: document.getElementById('fuelSelect')?.value || 'U91',
    homeState: document.getElementById('stateSelect')?.value || null,
    defaultScope: document.getElementById('scopeSelect')?.value || 'metro',
    periodDays: selectedPeriod(),
    excludeCostco: excludeCostcoEnabled(),
    areaRadiusKm: selectedAreaRadiusKm(),
    areaPostcode: selectedAreaCentre?.postcode || null,
    areaSuburb: selectedAreaCentre?.suburb || null,
    areaState: selectedAreaCentre?.state || null,
    areaLabel: selectedAreaCentre?.label || null,
    areaLat: selectedAreaCentre?.lat ?? null,
    areaLng: selectedAreaCentre?.lng ?? null,
    graphLines: {
      avg: document.getElementById('showAvg')?.checked !== false,
      gmean: document.getElementById('showGmean')?.checked === true,
      mode: document.getElementById('showMode')?.checked === true,
      med: document.getElementById('showMed')?.checked === true,
      min: document.getElementById('showMin')?.checked !== false,
      max: document.getElementById('showMax')?.checked !== false,
      areaMean: document.getElementById('showAreaMean')?.checked !== false,
      areaLow: document.getElementById('showAreaLow')?.checked !== false,
      areaHigh: document.getElementById('showAreaHigh')?.checked !== false,
      favMean: document.getElementById('showFavMean')?.checked !== false,
      favLow: document.getElementById('showFavLow')?.checked !== false,
      favHigh: document.getElementById('showFavHigh')?.checked !== false,
      station: document.getElementById('showStation')?.checked !== false,
      mogas: document.getElementById('showMogas')?.checked !== false,
    },
    turnLines: {
      state: document.getElementById('showStateTurns')?.checked !== false,
      suburb: document.getElementById('showSuburbTurns')?.checked !== false,
      fav: document.getElementById('showFavTurns')?.checked !== false,
      station: document.getElementById('showStationTurns')?.checked !== false,
    },
  });
}

function titleCaseSuburb(name) {
  return String(name || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function suburbLabel(row) {
  const name = titleCaseSuburb(row.suburb || row.s);
  const st = row.state || row.st;
  const pc = String(row.postcode || row.p || '').padStart(4, '0');
  return `${pc} ${name} · ${st}`;
}

function ingestSuburbPayload(data) {
  const rows = Array.isArray(data?.suburbs) ? data.suburbs : [];
  suburbIndex = rows
    .map((r) => {
      const suburb = String(r.suburb || r.s || '').trim();
      const postcode = String(r.postcode ?? r.p ?? '').padStart(4, '0');
      const state = String(r.state || r.st || '').toUpperCase();
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (!suburb || !postcode || postcode === '0000' || !state) return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        suburb,
        postcode,
        state,
        lat,
        lng,
        label: suburbLabel({ suburb, postcode, state }),
      };
    })
    .filter(Boolean);
  suburbIndexLoaded = suburbIndex.length > 0;
  return suburbIndex;
}

async function ensureSuburbIndex() {
  if (suburbIndexLoaded && suburbIndex.length) return suburbIndex;

  // Prefer embedded script (works with file:// — no local server required).
  if (window.AFW_SUBURBS) {
    ingestSuburbPayload(window.AFW_SUBURBS);
    if (suburbIndex.length) return suburbIndex;
  }

  const url = viewerAssetUrl('au-suburbs.json');
  try {
    const data = await fetchJson(url);
    ingestSuburbPayload(data);
    if (!suburbIndex.length) {
      console.warn('au-suburbs.json loaded but contained no rows', url);
    }
  } catch (err) {
    console.warn('au-suburbs.json:', err.message, url);
    suburbIndex = [];
    suburbIndexLoaded = false;
  }
  return suburbIndex;
}

function searchSuburbs(query, limit = 40) {
  const raw = String(query || '').trim();
  const cur = document.getElementById('stateSelect')?.value;

  if (!raw) {
    const rows = suburbIndex
      .filter((r) => !cur || r.state === cur)
      .slice()
      .sort(
        (a, b) =>
          a.postcode.localeCompare(b.postcode) ||
          a.suburb.localeCompare(b.suburb) ||
          a.state.localeCompare(b.state)
      );
    return rows.slice(0, limit);
  }

  const q = raw.toLowerCase();
  const digits = raw.replace(/\D/g, '');
  const text = q
    .replace(/\d+/g, ' ')
    .replace(/[·|,./]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const stateCodes = new Set(['act', 'nsw', 'nt', 'qld', 'sa', 'tas', 'vic', 'wa']);
  const textTokens = text
    ? text.split(/\s+/).filter((t) => t && !stateCodes.has(t))
    : [];
  const letterLen = textTokens.join('').length;
  if (digits.length < 1 && letterLen < 1) {
    // e.g. typed only a state code — show that state's suburbs
    const st = text.split(/\s+/).find((t) => stateCodes.has(t));
    if (st) {
      return suburbIndex
        .filter((r) => r.state.toLowerCase() === st)
        .sort((a, b) => a.postcode.localeCompare(b.postcode))
        .slice(0, limit);
    }
    return [];
  }

  const scored = [];
  for (const row of suburbIndex) {
    const sub = row.suburb.toLowerCase();
    let pcScore = -1;
    if (digits.length >= 1) {
      if (digits.length === 4 && row.postcode === digits) pcScore = 100;
      else if (row.postcode.startsWith(digits)) pcScore = 70 + digits.length * 6;
      else if (row.postcode.includes(digits)) pcScore = 35;
    }

    let nameScore = -1;
    if (textTokens.length) {
      const joined = textTokens.join(' ');
      if (sub === joined) nameScore = 100;
      else if (sub.startsWith(joined)) nameScore = 90;
      else if (textTokens.every((t) => sub.includes(t))) nameScore = 75;
      else if (textTokens.some((t) => sub.startsWith(t) || sub.includes(t))) nameScore = 55;
    }

    let score = -1;
    if (digits.length && textTokens.length) {
      if (pcScore >= 0 && nameScore >= 0) score = pcScore + nameScore;
      else if (pcScore >= 0) score = pcScore;
      else if (nameScore >= 0) score = nameScore;
    } else if (digits.length) {
      score = pcScore;
    } else {
      score = nameScore;
    }
    if (score < 0) continue;

    if (cur && row.state === cur) score += 5;
    scored.push({ score, row });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.row.postcode.localeCompare(b.row.postcode) ||
      a.row.suburb.localeCompare(b.row.suburb) ||
      a.row.state.localeCompare(b.row.state)
  );
  return scored.slice(0, limit).map((x) => x.row);
}

function findSuburbMatch(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const exact = suburbIndex.find((r) => r.label.toLowerCase() === lower);
  if (exact) return exact;
  const byPcName = suburbIndex.find((r) => {
    const name = titleCaseSuburb(r.suburb).toLowerCase();
    return (
      `${r.postcode} ${name}`.toLowerCase() === lower ||
      `${r.postcode} ${name} · ${r.state}`.toLowerCase() === lower
    );
  });
  if (byPcName) return byPcName;
  const hits = searchSuburbs(q, 1);
  return hits[0] || null;
}

function setSuburbCentreFromMatch(match, opts = {}) {
  if (!match) {
    selectedAreaCentre = null;
    if (!opts.skipPersist) persistControlsToPrefs();
    return;
  }
  selectedAreaCentre = {
    postcode: match.postcode,
    suburb: match.suburb,
    state: match.state || null,
    label: match.label,
    lat: match.lat,
    lng: match.lng,
  };
  const input = document.getElementById('suburbSearch');
  if (input && input.value !== match.label) input.value = match.label;
  if (!opts.skipPersist) persistControlsToPrefs();
}

function suburbComboEl() {
  return document.querySelector('.suburb-combo');
}

function setSuburbComboOpen(open) {
  const combo = suburbComboEl();
  const input = document.getElementById('suburbSearch');
  if (combo) combo.classList.toggle('is-open', !!open);
  if (input) input.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function hideSuburbSuggest() {
  const box = document.getElementById('suburbSuggest');
  if (box) {
    box.innerHTML = '';
    box.classList.add('hidden');
  }
  setSuburbComboOpen(false);
}

function renderSuburbSuggest(rows, opts = {}) {
  const box = document.getElementById('suburbSuggest');
  if (!box) return;
  const activeIdx = Math.max(0, Number(opts.activeIdx) || 0);
  if (!rows.length) {
    box.classList.remove('hidden');
    setSuburbComboOpen(true);
    box.innerHTML = '<div class="suburb-suggest-empty">No matching suburbs</div>';
    return;
  }
  box.classList.remove('hidden');
  setSuburbComboOpen(true);
  box.innerHTML = rows
    .map(
      (r, i) => `
      <button type="button" class="suburb-suggest-item${i === activeIdx ? ' active' : ''}" data-idx="${i}" role="option">
        <span class="pc">${escapeHtml(r.postcode)}</span>${escapeHtml(titleCaseSuburb(r.suburb))}
        <div class="meta">${escapeHtml(r.state)}</div>
      </button>`
    )
    .join('');
  box.querySelectorAll('.suburb-suggest-item').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const idx = Number(btn.getAttribute('data-idx'));
      const row = rows[idx];
      if (!row) return;
      setSuburbCentreFromMatch(row);
      hideSuburbSuggest();
      refreshAreaOverlaysOnly().catch((e) => setStatus(`Area: ${e.message}`));
    });
  });
  const active = box.querySelector('.suburb-suggest-item.active');
  if (active && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest' });
  }
}

async function refreshSuburbSuggest(query, activeIdx = 0) {
  const rows = await ensureSuburbIndex();
  if (!rows.length) {
    const box = document.getElementById('suburbSuggest');
    if (box) {
      box.classList.remove('hidden');
      setSuburbComboOpen(true);
      box.innerHTML =
        '<div class="suburb-suggest-empty">Suburb list failed to load. Hard-refresh so <code>au-suburbs-data.js</code> is present.</div>';
    }
    return [];
  }
  const hits = searchSuburbs(query, 40);
  renderSuburbSuggest(hits, { activeIdx: Math.min(activeIdx, Math.max(0, hits.length - 1)) });
  return hits;
}

async function refreshAreaOverlaysOnly() {
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  const fuel = document.getElementById('fuelSelect')?.value;
  const state = document.getElementById('stateSelect')?.value;
  try {
    if (selectedAreaCentre) {
      selectedAreaSeries = await loadAreaSeriesAroundCentre(
        selectedAreaCentre,
        labels,
        fuel,
        selectedAreaRadiusKm()
      );
    } else {
      selectedAreaSeries = null;
    }
  } catch (err) {
    console.warn('Area series:', err.message);
    selectedAreaSeries = null;
  }

  const areaAligned = areaSeriesForLabels(selectedAreaSeries, labels);
  const areaPoints = favMeanPointSeries(labels, areaAligned);
  const areaMarks = areaPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(areaPoints, areaPoints, state)
    : { turns: [], modelId: chartCycleCtx.modelId, fftOverlay: null };
  areaCycleCtx = {
    series: areaPoints,
    turns: areaMarks.turns || [],
    fftOverlay: areaMarks.fftOverlay || null,
    params: null,
    state,
    modelId: areaMarks.modelId || chartCycleCtx.modelId,
    latestStage: null,
  };
  areaCycleCtx.latestStage = areaPoints.length
    ? areaCycleStageForIndex(areaPoints.length - 1)
    : null;

  try {
    selectedFavouritesSeries = await loadFavouritesSeries(labels, fuel);
  } catch (err) {
    console.warn('Favourites series:', err.message);
  }
  const favAligned = favouritesSeriesForLabels(selectedFavouritesSeries, labels);
  const favPoints = favMeanPointSeries(labels, favAligned);
  const favMarks = favPoints.some((p) => p.avg != null)
    ? findChartCycleMarks(favPoints, favPoints, state)
    : { turns: [], modelId: chartCycleCtx.modelId, fftOverlay: null };
  favCycleCtx = {
    series: favPoints,
    turns: favMarks.turns || [],
    fftOverlay: favMarks.fftOverlay || null,
    params: null,
    state,
    modelId: favMarks.modelId || chartCycleCtx.modelId,
    latestStage: null,
  };
  favCycleCtx.latestStage = favPoints.length
    ? favCycleStageForIndex(favPoints.length - 1)
    : null;

  refreshHistoryWithStationOverlay();
  renderAreaSummary(seriesStats(chartCycleCtx.series || []), selectedPeriod());
  renderFavouriteStationsSummary();
  renderStationSummary(seriesStats(chartCycleCtx.series || []));
  updateStateSummaryHint(seriesStats(chartCycleCtx.series || []));
  renderE10Box(stateFiles[document.getElementById('stateSelect')?.value]);
}

function initSuburbSearchControls() {
  const input = document.getElementById('suburbSearch');
  const toggle = document.getElementById('suburbComboToggle');
  const combo = suburbComboEl();
  if (!input) return;
  let timer = null;
  let lastHits = [];
  let activeIdx = 0;

  const applyExact = () => {
    const match = findSuburbMatch(input.value);
    if (!match && input.value.trim()) {
      setStatus('No matching suburb or postcode');
      return;
    }
    setSuburbCentreFromMatch(match || null);
    hideSuburbSuggest();
    refreshAreaOverlaysOnly().catch((e) => setStatus(`Area: ${e.message}`));
  };

  const openList = async (fromQuery) => {
    lastHits = await refreshSuburbSuggest(
      fromQuery != null ? fromQuery : input.value,
      activeIdx
    );
    activeIdx = 0;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    activeIdx = 0;
    timer = setTimeout(async () => {
      lastHits = await refreshSuburbSuggest(input.value, 0);
    }, 60);
  });
  input.addEventListener('focus', async () => {
    await openList(input.value);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => hideSuburbSuggest(), 150);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!lastHits.length) return;
      ev.preventDefault();
      if (ev.key === 'ArrowDown') activeIdx = (activeIdx + 1) % lastHits.length;
      else activeIdx = (activeIdx - 1 + lastHits.length) % lastHits.length;
      renderSuburbSuggest(lastHits, { activeIdx });
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (lastHits.length) {
        const pick = lastHits[Math.min(activeIdx, lastHits.length - 1)] || lastHits[0];
        setSuburbCentreFromMatch(pick);
        hideSuburbSuggest();
        refreshAreaOverlaysOnly().catch((e) => setStatus(`Area: ${e.message}`));
      } else {
        applyExact();
      }
    } else if (ev.key === 'Escape') {
      hideSuburbSuggest();
    }
  });
  input.addEventListener('change', applyExact);

  toggle?.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const open = combo?.classList.contains('is-open');
    if (open) {
      hideSuburbSuggest();
    } else {
      input.focus();
      openList(input.value);
    }
  });
}

function applyUserPrefsToControls(opts = {}) {
  if (!window.UserPrefs) return;
  const prefs = UserPrefs.load();
  const fuelSel = document.getElementById('fuelSelect');
  const stateSel = document.getElementById('stateSelect');
  const scopeSel = document.getElementById('scopeSelect');
  const costco = document.getElementById('excludeCostco');
  const radius = document.getElementById('areaRadius');
  if (fuelSel && prefs.preferredFuel) fuelSel.value = prefs.preferredFuel;

  // On initial load, prefer the default favourite's state so we can select & zoom to it.
  const defaultFav =
    opts.initial && prefs.defaultFavouriteId
      ? prefs.favourites.find((f) => f.id === prefs.defaultFavouriteId)
      : null;
  const preferredState = defaultFav?.state || prefs.homeState;
  if (stateSel && preferredState && [...stateSel.options].some((o) => o.value === preferredState)) {
    stateSel.value = preferredState;
  }

  const state = stateSel?.value;
  const fuel = fuelSel?.value;
  const file = stateFiles[state];
  if (file) syncScopeOptions(file, fuel);
  if (scopeSel && prefs.defaultScope) {
    if (!file || scopeIsAvailable(file, fuel, prefs.defaultScope)) {
      scopeSel.value = prefs.defaultScope;
    } else if (file) {
      scopeSel.value = preferredScope(file, fuel);
    }
  } else if (opts.initial && file) {
    syncScopeDefaultFromFile();
  }
  if (costco) costco.checked = !!prefs.excludeCostco;
  if (radius && prefs.areaRadiusKm) radius.value = String(prefs.areaRadiusKm);
  const periodSel = document.getElementById('periodSelect');
  if (periodSel && prefs.periodDays) periodSel.value = String(prefs.periodDays);
  const lineMap = {
    avg: 'showAvg',
    gmean: 'showGmean',
    mode: 'showMode',
    med: 'showMed',
    min: 'showMin',
    max: 'showMax',
    areaMean: 'showAreaMean',
    areaLow: 'showAreaLow',
    areaHigh: 'showAreaHigh',
    favMean: 'showFavMean',
    favLow: 'showFavLow',
    favHigh: 'showFavHigh',
    station: 'showStation',
    mogas: 'showMogas',
  };
  if (prefs.graphLines) {
    for (const [key, id] of Object.entries(lineMap)) {
      const el = document.getElementById(id);
      if (el && Object.prototype.hasOwnProperty.call(prefs.graphLines, key)) {
        el.checked = !!prefs.graphLines[key];
      }
    }
  }
  const turnMap = {
    state: 'showStateTurns',
    suburb: 'showSuburbTurns',
    fav: 'showFavTurns',
    station: 'showStationTurns',
  };
  if (prefs.turnLines) {
    for (const [key, id] of Object.entries(turnMap)) {
      const el = document.getElementById(id);
      if (el && Object.prototype.hasOwnProperty.call(prefs.turnLines, key)) {
        el.checked = !!prefs.turnLines[key];
      }
    }
  }
  if (prefs.areaLat != null && prefs.areaLng != null) {
    const suburb = prefs.areaSuburb || '';
    const postcode = prefs.areaPostcode || '';
    const st = prefs.areaState || prefs.homeState || '';
    selectedAreaCentre = {
      postcode,
      suburb,
      state: st || null,
      label: suburb
        ? suburbLabel({ suburb, postcode, state: st || '' })
        : prefs.areaLabel || postcode,
      lat: prefs.areaLat,
      lng: prefs.areaLng,
    };
    const input = document.getElementById('suburbSearch');
    if (input && selectedAreaCentre.label) input.value = selectedAreaCentre.label;
  }
}

function getCachedStation(id) {
  if (id == null) return null;
  let st = stationCache.get(id);
  if (st) return st;
  st = stationCache.get(String(id));
  if (st) return st;
  for (const [k, v] of stationCache) {
    if (String(k) === String(id)) return v;
  }
  return null;
}

async function toggleFavouriteForSelected() {
  if (!window.UserPrefs) {
    setStatus('Favourites unavailable (userPrefs.js not loaded)');
    return;
  }
  const st = getCachedStation(selectedStationId);
  if (!st) {
    setStatus('Select a station before adding a favourite');
    return;
  }
  const state =
    (st.state && String(st.state).trim()) ||
    document.getElementById('stateSelect')?.value ||
    chartCycleCtx.state ||
    null;
  if (!state) {
    setStatus('Cannot favourite: no state on station');
    return;
  }

  try {
    if (UserPrefs.isFavourite(st.id)) {
      UserPrefs.removeFavourite(st.id);
      setStatus(`Removed favourite: ${st.name || st.id}`);
    } else {
      const next = UserPrefs.addFavourite({
        id: st.id,
        state,
        name: st.name,
        brand: st.brand,
        suburb: st.suburb,
      });
      if (!next.favourites.some((f) => String(f.id) === String(st.id))) {
        setStatus('Could not save favourite (missing id/state)');
        return;
      }
      setStatus(`Added favourite: ${st.name || st.id}`);
    }
  } catch (err) {
    setStatus(`Favourite failed: ${err.message}`);
    return;
  }

  // Update list / buttons immediately; chart series can catch up after.
  renderFavouritesList();
  renderFavouriteStationsSummary();
  renderStationSummary(seriesStats(chartCycleCtx.series || []));
  if (st) renderSelectedStationDetail(st);

  try {
    await refreshFavouritesOverlays();
  } catch (err) {
    console.warn('Favourites overlay refresh:', err);
    setStatus(`Favourite saved, but chart refresh failed: ${err.message}`);
  }
}

async function refreshFavouritesOverlays() {
  const labels = chartCycleCtx.series?.map((p) => p.date) || [];
  const fuel = document.getElementById('fuelSelect')?.value;
  try {
    selectedFavouritesSeries = await loadFavouritesSeries(labels, fuel);
  } catch (err) {
    console.warn('Favourites series:', err.message);
    selectedFavouritesSeries = null;
  }
  const favAligned = favouritesSeriesForLabels(selectedFavouritesSeries, labels);
  const favPoints = favMeanPointSeries(labels, favAligned);
  const state = document.getElementById('stateSelect')?.value;
  let favMarks = { turns: [], modelId: chartCycleCtx.modelId };
  try {
    if (favPoints.some((p) => p.avg != null)) {
      favMarks = findChartCycleMarks(favPoints, favPoints, state);
    }
  } catch (err) {
    console.warn('Favourites turns:', err.message);
  }
  favCycleCtx = {
    series: favPoints,
    turns: favMarks.turns || [],
    fftOverlay: favMarks.fftOverlay || null,
    params: null,
    state,
    modelId: favMarks.modelId || chartCycleCtx.modelId,
    latestStage: null,
  };
  favCycleCtx.latestStage = favPoints.length
    ? favCycleStageForIndex(favPoints.length - 1)
    : null;
  refreshHistoryWithStationOverlay();
  renderFavouriteStationsSummary();
  renderStationSummary(seriesStats(chartCycleCtx.series || []));
  renderFavouritesList();
}

function renderFavouritesList() {
  const el = document.getElementById('favouritesList');
  if (!el || !window.UserPrefs) return;
  const prefs = UserPrefs.load();
  const favs = prefs.favourites;
  if (!favs.length) {
    el.innerHTML = '<div class="fav-empty">No favourites yet. Select a station and add it.</div>';
    return;
  }
  el.innerHTML = favs
    .map((f) => {
      const isDefault = prefs.defaultFavouriteId === f.id;
      const logo = window.brandLogoFor?.(f.brand || '');
      const title = formatStationTitle(f.brand, f.name, f.id);
      return `
        <div class="fav-item${isDefault ? ' is-default' : ''}" data-fav-id="${escapeHtml(f.id)}">
          <div class="fav-item-main" data-action="jump">
            ${logo ? `<img class="brand-logo" src="${logo}" alt="" />` : ''}
            <div>
              <div>${escapeHtml(title)}${isDefault ? ' · Default' : ''}</div>
              <div class="fav-item-meta">${escapeHtml(f.suburb || '')} · ${escapeHtml(f.state)}</div>
            </div>
          </div>
          <div class="fav-item-actions">
            ${
              isDefault
                ? ''
                : `<button type="button" class="btn-secondary" data-action="default">Default</button>`
            }
            <button type="button" class="btn-secondary" data-action="remove">Remove</button>
          </div>
        </div>
      `;
    })
    .join('');

  el.querySelectorAll('.fav-item').forEach((item) => {
    const id = item.getAttribute('data-fav-id');
    item.querySelector('[data-action="jump"]')?.addEventListener('click', () => {
      jumpToFavourite(id).catch((e) => setStatus(`Favourite: ${e.message}`));
    });
    item.querySelector('[data-action="default"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      UserPrefs.setDefaultFavourite(id);
      renderFavouritesList();
    });
    item.querySelector('[data-action="remove"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      UserPrefs.removeFavourite(id);
      refreshFavouritesOverlays().catch((e) => setStatus(`Favourite: ${e.message}`));
    });
  });
}

async function ensureFavouriteInCache(fav) {
  if (!fav) return null;
  const existing = stationCache.get(fav.id);
  if (existing) return existing;
  const catalog = await loadPublishedCatalog(fav.state);
  const meta = catalog?.stations?.[fav.id];
  if (!meta) {
    const stub = {
      id: fav.id,
      name: fav.name,
      brand: fav.brand,
      suburb: fav.suburb,
      state: fav.state,
      prices: {},
      source: 'favourite',
    };
    stationCache.set(fav.id, stub);
    return stub;
  }
  const st = {
    id: fav.id,
    name: meta.name || fav.name,
    brand: meta.brand || fav.brand,
    suburb: meta.suburb || fav.suburb,
    address: meta.address || '',
    postcode: meta.postcode,
    lat: meta.lat,
    lng: meta.lng,
    state: fav.state,
    prices: {},
    source: 'published',
  };
  const latestIso =
    publishedStationCache.latestDay[fav.state] ||
    chartCycleCtx.series?.[chartCycleCtx.series.length - 1]?.date;
  if (latestIso) {
    const day = await loadPublishedDay(fav.state, latestIso);
    const prices = pricesFromPublishedDay(day, fav.id);
    if (prices) {
      for (const [k, tenths] of Object.entries(prices)) {
        if (tenths != null && Number.isFinite(tenths)) st.prices[k] = tenths / 10;
      }
    }
  }
  stationCache.set(fav.id, st);
  return st;
}

async function jumpToFavourite(id) {
  const fav = UserPrefs.getFavourite(id);
  if (!fav) return;
  const stateSel = document.getElementById('stateSelect');
  if (stateSel && fav.state && stateSel.value !== fav.state) {
    stateSel.value = fav.state;
    persistControlsToPrefs();
    syncScopeDefaultFromFile();
    syncWaWeeklyAfterLastVisibility();
    await refreshCharts();
  }
  const st = await ensureFavouriteInCache(fav);
  if (st?.lat != null && st?.lng != null) {
    initMap();
    const lat = Number(st.lat);
    const lng = Number(st.lng);
    const zoom = Math.max(MIN_ZOOM_STATIONS, 14);
    map.setView([lat, lng], zoom);
    await fetchStationsAround(lat, lng, {
      recenter: true,
      lat,
      lng,
      silent: true,
      anchorId: fav.id,
    });
    // Ensure selection + history even if viewport fetch missed the pin.
    if (getCachedStation(fav.id)) {
      await selectStationById(fav.id);
    }
  } else {
    await selectStationById(fav.id);
  }
}

async function maybeSelectDefaultFavourite() {
  if (!window.UserPrefs) return;
  const id = UserPrefs.getDefaultFavouriteId();
  if (!id) return;
  const fav = UserPrefs.getFavourite(id);
  if (!fav) return;
  try {
    await jumpToFavourite(id);
    if (map && getCachedStation(id)) {
      const st = getCachedStation(id);
      if (st?.lat != null && st?.lng != null) {
        map.setView([Number(st.lat), Number(st.lng)], Math.max(map.getZoom(), MIN_ZOOM_STATIONS, 14));
      }
    }
  } catch (err) {
    console.warn('Default favourite:', err.message);
  }
}

function init() {
  initCapitalSelect();
  initMap();
  populateCycleModelSelect();
  initTurnTuneControls();
  initWaWeeklyAfterLastControl();
  initArcpathTuneControls();
  initTuneFoldHeightSync();
  initSuburbSearchControls();
  ensureSuburbIndex()
    .then((rows) => {
      if (!rows.length) {
        console.warn('Suburb index empty after load');
      }
    })
    .catch((e) => console.warn('Suburb index:', e.message));
  renderFavouritesList();

  const refresh = () => {
    persistControlsToPrefs();
    return refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
  };

  document.getElementById('btnLoad').onclick = () =>
    loadAllStates().catch((e) => setStatus(`Error: ${e.message}`));
  document.getElementById('stateSelect').onchange = () => {
    persistControlsToPrefs();
    syncScopeDefaultFromFile();
    syncWaWeeklyAfterLastVisibility();
    refresh();
  };
  document.getElementById('scopeSelect').onchange = () => {
    persistControlsToPrefs();
    refresh();
  };
  document.getElementById('periodSelect').onchange = () => {
    persistControlsToPrefs();
    refresh();
  };
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
    persistControlsToPrefs();
    refresh();
    redrawStationMarkers();
    rebuildStationList();
    if (selectedStationId != null) {
      const st = stationCache.get(selectedStationId);
      if (st) selectStationById(st.id);
    }
  };
  const onGraphLineChange = () => {
    persistControlsToPrefs();
    applyLineVisibility();
  };
  const onTurnLineChange = () => {
    persistControlsToPrefs();
    applyTurnLineVisibility();
  };
  document.getElementById('showAvg').onchange = onGraphLineChange;
  document.getElementById('showGmean').onchange = onGraphLineChange;
  document.getElementById('showMode').onchange = onGraphLineChange;
  document.getElementById('showMed').onchange = onGraphLineChange;
  document.getElementById('showMin').onchange = onGraphLineChange;
  document.getElementById('showMax').onchange = onGraphLineChange;
  document.getElementById('showAreaMean').onchange = onGraphLineChange;
  document.getElementById('showAreaLow').onchange = onGraphLineChange;
  document.getElementById('showAreaHigh').onchange = onGraphLineChange;
  document.getElementById('showStation').onchange = onGraphLineChange;
  document.getElementById('showMogas')?.addEventListener('change', onGraphLineChange);
  document.getElementById('showFavMean').onchange = onGraphLineChange;
  document.getElementById('showFavLow').onchange = onGraphLineChange;
  document.getElementById('showFavHigh').onchange = onGraphLineChange;
  document.getElementById('showStateTurns').onchange = onTurnLineChange;
  document.getElementById('showSuburbTurns').onchange = onTurnLineChange;
  document.getElementById('showFavTurns').onchange = onTurnLineChange;
  document.getElementById('showStationTurns').onchange = onTurnLineChange;
  let areaRadiusTimer = null;
  const onAreaRadiusChange = () => {
    clearTimeout(areaRadiusTimer);
    areaRadiusTimer = setTimeout(() => {
      persistControlsToPrefs();
      refreshAreaOverlaysOnly().catch((e) => setStatus(`Area: ${e.message}`));
    }, 200);
  };
  document.getElementById('areaRadius').onchange = onAreaRadiusChange;
  document.getElementById('areaRadius').oninput = onAreaRadiusChange;

  document.getElementById('excludeCostco')?.addEventListener('change', () => {
    persistControlsToPrefs();
    refreshAreaOverlaysOnly().catch((e) => setStatus(`Area: ${e.message}`));
  });

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

  loadAllStates().catch((e) => setStatus(`Load failed: ${e.message}`));
}

init();
