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

function seriesStats(points) {
  if (!points.length) return null;
  const avgs = points.map((p) => p.avg);
  const mins = points.map((p) => p.min).filter((v) => v != null);
  const maxs = points.map((p) => p.max).filter((v) => v != null);
  return {
    latest: points[points.length - 1],
    lowAvg: Math.min(...avgs),
    highAvg: Math.max(...avgs),
    lowStation: mins.length ? Math.min(...mins) : null,
    highStation: maxs.length ? Math.max(...maxs) : null,
    days: points.length,
  };
}

/**
 * Cycle stage: peak | falling | bottom | rising | flat | unknown
 */
function inferCycleStage(points, params) {
  if (points.length < 5) {
    return { stage: 'unknown', label: 'Not enough history', confidence: params?.confidence || 'none' };
  }
  const avgs = points.map((p) => p.avg);
  const latest = avgs[avgs.length - 1];
  const minAvg = Math.min(...avgs);
  const maxAvg = Math.max(...avgs);
  const range = maxAvg - minAvg;
  if (range < 2.5) {
    return { stage: 'flat', label: 'Flat / weak movement', confidence: params?.confidence || 'none' };
  }
  const pos = (latest - minAvg) / range;
  const tail = avgs.slice(-Math.min(5, avgs.length));
  const slope = (tail[tail.length - 1] - tail[0]) / tail.length;

  let stage;
  if (pos >= 0.78 && slope >= -0.15) stage = 'peak';
  else if (pos <= 0.22 && slope <= 0.15) stage = 'bottom';
  else if (slope < -0.25) stage = 'falling';
  else if (slope > 0.25) stage = 'rising';
  else if (params?.lastTurn?.type === 'peak' && slope < 0) stage = 'falling';
  else if (params?.lastTurn?.type === 'trough' && slope > 0) stage = 'rising';
  else stage = 'unknown';

  const labels = {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
    flat: 'Flat',
    unknown: 'Unclear',
  };
  return { stage, label: labels[stage], confidence: params?.confidence || 'none' };
}

function compareE10VsU91(u91, e10) {
  if (!u91 || !e10) return null;
  const priceDiscountPct = ((u91 - e10) / u91) * 100;
  const energyEquivSaving = u91 - e10 / E10_ENERGY_RATIO;
  let pick;
  if (energyEquivSaving > 0.05) pick = 'E10';
  else if (energyEquivSaving < -0.05) pick = 'U91';
  else pick = 'tie';
  return { pick, priceDiscountPct, energyEquivSaving, u91, e10 };
}

function destroyChart(chart) {
  if (chart) chart.destroy();
  return null;
}

function renderHistoryChart(labels, citySeries, statePoint, fuel) {
  const ctx = document.getElementById('historyChart');
  historyChart = destroyChart(historyChart);

  const avgData = citySeries.map((p) => p.avg);
  const minData = citySeries.map((p) => p.min);
  const maxData = citySeries.map((p) => p.max);

  const datasets = [
    {
      label: 'Average',
      data: avgData,
      borderColor: '#3d9cf5',
      backgroundColor: 'rgba(61, 156, 245, 0.1)',
      fill: false,
      tension: 0.2,
      pointRadius: labels.length > 40 ? 0 : 3,
    },
    {
      label: 'Daily low (station)',
      data: minData,
      borderColor: 'rgba(34, 197, 94, 0.6)',
      borderDash: [4, 4],
      pointRadius: 0,
      tension: 0.2,
    },
    {
      label: 'Daily high (station)',
      data: maxData,
      borderColor: 'rgba(239, 68, 68, 0.6)',
      borderDash: [4, 4],
      pointRadius: 0,
      tension: 0.2,
    },
  ];

  if (statePoint) {
    datasets.push({
      label: 'State-wide now (Petrolmate)',
      data: labels.map((_, i) => (i === labels.length - 1 ? statePoint.avg : null)),
      borderColor: '#f59e0b',
      backgroundColor: '#f59e0b',
      pointRadius: 6,
      showLine: false,
    });
  }

  historyChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b9cb3' } },
        title: { display: true, text: `${FUEL_LABELS[fuel] || fuel} — c/L`, color: '#e8edf4' },
      },
      scales: {
        x: { ticks: { color: '#8b9cb3', maxTicksLimit: 12 } },
        y: {
          ticks: { color: '#8b9cb3', callback: (v) => v + 'c' },
          title: { display: true, text: 'c/L', color: '#8b9cb3' },
        },
      },
    },
  });
}

function renderSummaryCards(stats, granularity) {
  const el = document.getElementById('summaryCards');
  if (!stats) {
    el.innerHTML = '<p class="hint">No data for this fuel.</p>';
    return;
  }
  const gLabel = granularity === 'metro' ? 'City (metro)' : 'State-wide';
  el.innerHTML = `
    <div class="card"><div class="label">Latest avg (${gLabel})</div><div class="value">${stats.latest.avg.toFixed(1)}c</div></div>
    <div class="card"><div class="label">Avg low / high</div><div class="value">${stats.lowAvg.toFixed(1)} – ${stats.highAvg.toFixed(1)}c</div></div>
    <div class="card"><div class="label">Station low / high</div><div class="value">${stats.lowStation?.toFixed(1) ?? '—'} – ${stats.highStation?.toFixed(1) ?? '—'}c</div></div>
    <div class="card"><div class="label">Stations (latest)</div><div class="value">${stats.latest.n ?? '—'}</div></div>
    <div class="card"><div class="label">Days in chart</div><div class="value">${stats.days}</div></div>
  `;
}

function renderCycleBadges(cityStage, stateStage, stationStage) {
  const el = document.getElementById('cycleStages');
  const row = (title, s) =>
    `<span class="badge ${s.stage}">${title}: ${s.label} <small>(${s.confidence})</small></span>`;
  el.innerHTML =
    row('Collected series', cityStage) +
    (stateStage ? row('State snapshot', stateStage) : '') +
    (stationStage ? row('Station', stationStage) : '');
}

function renderE10Box(file, stateCode) {
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
  box.classList.remove('hidden');
  box.innerHTML = `
    <strong>E10 vs U91 (${stateCode} latest collected)</strong><br>
    U91 ${u.toFixed(1)}c · E10 ${e.toFixed(1)}c (${cmp.priceDiscountPct.toFixed(1)}% cheaper on sign)<br>
  <strong>Best buy: ${cmp.pick === 'tie' ? 'Even' : cmp.pick}</strong>
  — energy-adjusted saving ${cmp.energyEquivSaving.toFixed(1)}c/L vs U91
  (need ~3% price gap for E10 to win).
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
  const file = stateFiles[state];
  if (!file) return;

  const archive = await loadArchivesForState(state);
  const series = buildMergedSeries(file, archive, fuel);
  const stats = seriesStats(series);
  const params = file.params?.[fuel];
  const cityStage = inferCycleStage(series, params);

  const granularity = file.granularity || 'state';
  const granLabel =
    granularity === 'metro'
      ? `Metro / city average (${CAPITALS[state]?.name || state})`
      : 'State-wide average';
  document.getElementById('seriesHint').textContent =
    `Collected series: ${granLabel}. Shaded band is daily min/max across stations. Archives merged when present.`;

  let statePoint = null;
  let stateStage = null;
  if (document.getElementById('overlaySummary').checked) {
    try {
      const summary = await fetchPetrolmateSummary(state);
      if (summary?.[fuel]) {
        statePoint = summary[fuel];
        stateStage = inferCycleStage(
          [{ avg: statePoint.avg, min: statePoint.min, max: statePoint.max }],
          file.params?.[fuel]
        );
        stateStage.label = 'Live snapshot only';
        stateStage.stage = 'unknown';
      }
    } catch (e) {
      console.warn('Petrolmate overlay:', e.message);
      document.getElementById('seriesHint').textContent +=
        ' · Live state overlay unavailable (use node viewer/serve.mjs).';
    }
  }

  renderHistoryChart(series.map((p) => p.date), series, statePoint, fuel);
  renderSummaryCards(stats, granularity);
  renderCycleBadges(cityStage, stateStage, null);
  renderE10Box(file, state);
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
    setTimeout(() => map.invalidateSize(), 100);
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
    lines.push(
      `<p><strong>Best buy:</strong> ${cmp.pick} (E10 ${cmp.priceDiscountPct.toFixed(1)}% below U91 on sign; energy-adj ${cmp.energyEquivSaving.toFixed(1)}c/L)</p>`
    );
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
        y: { ticks: { callback: (v) => v + 'c' } },
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

function init() {
  initCapitalSelect();
  initMap();

  document.getElementById('btnLoad').onclick = () => loadAllStates().catch((e) => setStatus(`Error: ${e.message}`));
  document.getElementById('stateSelect').onchange = () => refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
  document.getElementById('fuelSelect').onchange = () => {
    refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));
    redrawStationMarkers();
    rebuildStationList();
  };
  document.getElementById('overlaySummary').onchange = () => refreshCharts().catch((e) => setStatus(`Error: ${e.message}`));

  document.getElementById('btnLoadStations').onclick = () => goToCapital();
}

init();
