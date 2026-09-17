/* Aus Fuel Watch — slim Pebble config page */
(function () {
  const params = new URLSearchParams(location.search);
  const dataBase =
    params.get('dataBase') ||
    localStorage.getItem('afw.dataBase') ||
    'https://erad84.github.io/aus-fuel-watch';

  const SCOPE_COMBOS = [
    ['NSW', 'metro', 'NSW Metro'],
    ['NSW', 'regional', 'NSW Regional'],
    ['NSW', 'state', 'NSW'],
    ['VIC', 'metro', 'VIC Metro'],
    ['VIC', 'regional', 'VIC Regional'],
    ['VIC', 'state', 'VIC'],
    ['QLD', 'metro', 'QLD Metro'],
    ['QLD', 'regional', 'QLD Regional'],
    ['QLD', 'state', 'QLD'],
    ['SA', 'metro', 'SA Metro'],
    ['SA', 'regional', 'SA Regional'],
    ['SA', 'state', 'SA'],
    ['WA', 'metro', 'WA Metro'],
    ['WA', 'regional', 'WA Regional'],
    ['WA', 'state', 'WA'],
    ['ACT', 'state', 'ACT'],
    ['TAS', 'state', 'TAS'],
    ['NT', 'state', 'NT'],
  ];

  const CACHE_META = 'afw.cacheMeta';
  const CACHE_PREFIX = 'afw.cache.';
  const MAX_AGE_MS = 3 * 60 * 60 * 1000;

  let map = null;
  let markerLayer = null;
  let suburbCircle = null;
  let selectedStation = null;
  let suburbIndex = [];
  let stationCache = new Map();
  let clearCacheOnSave = false;

  function prefs() {
    return window.UserPrefs.load();
  }

  function fillScopeCombo() {
    const sel = document.getElementById('scopeCombo');
    sel.innerHTML = '';
    for (const [st, sc, label] of SCOPE_COMBOS) {
      const opt = document.createElement('option');
      opt.value = st + '|' + sc;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  function applyPrefsToForm(p) {
    document.getElementById('fuelSelect').value = p.preferredFuel || 'U91';
    const theme = document.getElementById('watchTheme');
    if (theme) theme.value = p.watchTheme === 'light' ? 'light' : 'dark';
    const combo = (p.homeState || 'NSW') + '|' + (p.defaultScope || 'metro');
    const sel = document.getElementById('scopeCombo');
    if ([...sel.options].some((o) => o.value === combo)) sel.value = combo;
    else sel.value = 'NSW|metro';
    document.getElementById('areaRadiusKm').value = p.areaRadiusKm || 15;
    document.getElementById('gpsRadiusKm').value = p.gpsRadiusKm || 15;
    document.getElementById('excludeCostco').checked = p.excludeCostco !== false;
    if (p.areaLabel) document.getElementById('suburbQuery').value = p.areaLabel;
    renderFavs();
    renderDefault();
    updateSuburbCircle();
  }

  function readFormPrefs() {
    const p = prefs();
    p.preferredFuel = document.getElementById('fuelSelect').value;
    const themeEl = document.getElementById('watchTheme');
    if (themeEl) p.watchTheme = themeEl.value === 'light' ? 'light' : 'dark';
    const [st, sc] = document.getElementById('scopeCombo').value.split('|');
    p.homeState = st;
    p.defaultScope = sc;
    p.areaRadiusKm = Math.max(1, Math.min(100, Number(document.getElementById('areaRadiusKm').value) || 15));
    p.gpsRadiusKm = Math.max(1, Math.min(100, Number(document.getElementById('gpsRadiusKm').value) || 15));
    p.excludeCostco = document.getElementById('excludeCostco').checked;
    return p;
  }

  function renderFavs() {
    const ul = document.getElementById('favList');
    const list = UserPrefs.listFavourites();
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="hint">None yet — pick from the map</li>';
      return;
    }
    for (const f of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(f.name || f.id)}${f.suburb ? ' · ' + escapeHtml(f.suburb) : ''}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Remove';
      btn.onclick = () => {
        UserPrefs.removeFavourite(f.id);
        renderFavs();
        renderDefault();
      };
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function renderDefault() {
    const el = document.getElementById('defaultStation');
    const id = UserPrefs.getDefaultFavouriteId();
    const f = id ? UserPrefs.getFavourite(id) : null;
    el.textContent = f ? f.name || f.id : 'None — set from map';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatAsOfLocal(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso).slice(0, 23);
    const d = new Date(t);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = d.getDate();
    const mon = months[d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${mon} ${hh}:${mm}`;
  }

  function updateCacheStatus() {
    const el = document.getElementById('cacheStatus');
    const p = readFormPrefs();
    const st = p.homeState || 'NSW';
    const stateKey = st + '.json';

    /* Companion (pkjs) localStorage is separate from this webview — prefer
     * asOf / download time passed in the settings URL from the watch. */
    const urlAsOf = params.get('dataAsOf') || '';
    const urlDownloaded = params.get('downloadedAt');
    let urlDownloadedAt = urlDownloaded ? Number(urlDownloaded) : NaN;

    let state = null;
    try {
      state = JSON.parse(localStorage.getItem(CACHE_PREFIX + stateKey) || 'null');
    } catch (_) {}
    const localAsOf =
      (state && (state.generated || state.updated)) ||
      (state && state.snapshot && state.snapshot.asOf) ||
      '';
    /* Prefer watch companion URL (what the watch actually shows). Webview
     * localStorage is a separate older cache and was winning here before. */
    let asOfRaw = urlAsOf || localAsOf;
    if (urlAsOf && localAsOf) {
      const tu = Date.parse(urlAsOf);
      const tl = Date.parse(localAsOf);
      if (Number.isFinite(tu) && Number.isFinite(tl) && tl > tu) asOfRaw = localAsOf;
      else asOfRaw = urlAsOf;
    }
    const asOfLabel = asOfRaw ? formatAsOfLocal(asOfRaw) : '';

    let meta = {};
    try {
      meta = JSON.parse(localStorage.getItem(CACHE_META) || '{}');
    } catch (_) {}
    let downloadedAt = meta[stateKey];
    if (Number.isFinite(urlDownloadedAt)) {
      if (typeof downloadedAt !== 'number' || urlDownloadedAt >= downloadedAt) {
        downloadedAt = urlDownloadedAt;
      }
    }

    if (!asOfLabel && (downloadedAt == null || typeof downloadedAt !== 'number')) {
      el.textContent = 'Cache: empty — tap Download latest';
      return;
    }
    let line = asOfLabel ? `Data as of ${asOfLabel}` : 'Data as of —';
    if (typeof downloadedAt === 'number') {
      const ageH = ((Date.now() - downloadedAt) / 3600000).toFixed(1);
      const fresh = Date.now() - downloadedAt < MAX_AGE_MS;
      line += fresh
        ? ` · downloaded ${ageH}h ago (fresh)`
        : ` · downloaded ${ageH}h ago (stale — open watch to refresh)`;
    } else {
      line += ' · not on phone yet';
    }
    el.textContent = line;
  }

  function clearAllCache() {
    let meta = {};
    try {
      meta = JSON.parse(localStorage.getItem(CACHE_META) || '{}');
    } catch (_) {}
    for (const k of Object.keys(meta)) {
      try {
        localStorage.removeItem(CACHE_PREFIX + k);
      } catch (_) {}
    }
    localStorage.removeItem(CACHE_META);
    localStorage.removeItem('afw.lastGoodPayload');
  }

  async function downloadLatest() {
    const btn = document.getElementById('btnDownloadLatest');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    clearAllCache();
    clearCacheOnSave = true;
    const p = readFormPrefs();
    UserPrefs.save(p);
    try {
      const st = p.homeState || 'NSW';
      await Promise.all([
        fetch(`${dataBase}/v1/index.json`).then((r) => r.json()),
        fetch(`${dataBase}/v1/${st}.json`).then((r) => r.json()),
      ]).then(([index, state]) => {
        const meta = {};
        localStorage.setItem(CACHE_PREFIX + 'index.json', JSON.stringify(index));
        localStorage.setItem(CACHE_PREFIX + st + '.json', JSON.stringify(state));
        meta['index.json'] = Date.now();
        meta[st + '.json'] = Date.now();
        localStorage.setItem(CACHE_META, JSON.stringify(meta));
        /* So status prefers this download over stale URL params from open. */
        params.set('dataAsOf', state.generated || state.updated || (state.snapshot && state.snapshot.asOf) || '');
        params.set('downloadedAt', String(Date.now()));
      });
      updateCacheStatus();
      const el = document.getElementById('cacheStatus');
      if (el) el.textContent += ' — Save & close to reload the watch';
    } catch (e) {
      document.getElementById('cacheStatus').textContent = 'Download failed: ' + e.message;
    }
    btn.disabled = false;
    btn.textContent = 'Download latest';
  }

  function closeToWatch(extra) {
    const p = Object.assign(readFormPrefs(), extra || {});
    UserPrefs.save(p);
    if (clearCacheOnSave) p.clearCache = true;
    const payload = encodeURIComponent(JSON.stringify(p));
    location.href = 'pebblejs://close#' + payload;
  }

  async function loadSuburbs() {
    const sources = [
      `${dataBase}/v1/au-suburbs.json`,
      'au-suburbs.json',
      'https://raw.githubusercontent.com/erad84/aus-fuel-watch/data/v1/au-suburbs.json',
    ];
    for (const url of sources) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        suburbIndex = ingestSuburbs(data);
        if (suburbIndex.length) return;
      } catch (_) {}
    }
    if (window.AFW_SUBURBS) {
      suburbIndex = ingestSuburbs(window.AFW_SUBURBS);
      if (suburbIndex.length) return;
    }
    console.warn('suburbs: no index loaded');
  }

  function ingestSuburbs(data) {
    const rows = data && data.suburbs ? data.suburbs : Array.isArray(data) ? data : [];
    return rows
      .map((row) => {
        const suburb = String(row.s || row.suburb || '').trim();
        const postcode = String(row.p ?? row.postcode ?? '').padStart(4, '0');
        const state = String(row.st || row.state || '').toUpperCase();
        const lat = Number(row.lat);
        const lng = Number(row.lng);
        if (!suburb || !postcode || postcode === '0000' || !state) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
          suburb,
          postcode,
          state,
          lat,
          lng,
          label: `${suburb} ${postcode} ${state}`,
        };
      })
      .filter(Boolean);
  }

  function searchSuburbs(q) {
    const query = String(q || '').trim().toLowerCase();
    if (query.length < 2) return [];
    const stFilter = (document.getElementById('scopeCombo')?.value || '').split('|')[0];
    const out = [];
    const starts = [];
    for (const row of suburbIndex) {
      if (stFilter && row.state !== stFilter) continue;
      const label = row.label.toLowerCase();
      const pc = String(row.postcode);
      if (pc.startsWith(query) || row.suburb.toLowerCase().startsWith(query)) {
        starts.push(row);
      } else if (label.includes(query)) {
        out.push(row);
      }
      if (starts.length + out.length >= 40) break;
    }
    return starts.concat(out).slice(0, 30);
  }

  function setSuburb(row) {
    UserPrefs.update({
      areaSuburb: row.suburb,
      areaPostcode: row.postcode,
      areaState: row.state,
      areaLabel: row.label,
      areaLat: row.lat,
      areaLng: row.lng,
    });
    document.getElementById('suburbQuery').value = row.label;
    document.getElementById('suburbSuggest').classList.remove('open');
    if (map && row.lat != null) {
      map.setView([row.lat, row.lng], 13);
      loadStationsInView();
    }
    updateSuburbCircle();
  }

  function updateSuburbCircle() {
    const p = prefs();
    if (suburbCircle) {
      map.removeLayer(suburbCircle);
      suburbCircle = null;
    }
    if (!map || p.areaLat == null || p.areaLng == null) return;
    const km = Number(document.getElementById('areaRadiusKm').value) || p.areaRadiusKm || 15;
    suburbCircle = L.circle([p.areaLat, p.areaLng], {
      radius: km * 1000,
      color: '#3d9cf5',
      weight: 2,
      fillOpacity: 0.08,
    }).addTo(map);
  }

  function initMap() {
    const p = prefs();
    const hasSuburb = p.areaLat != null && p.areaLng != null;
    const lat = hasSuburb ? Number(p.areaLat) : -33.8688;
    const lng = hasSuburb ? Number(p.areaLng) : 151.2093;
    /* Zoom 13+ is required for station pins to render */
    map = L.map('map').setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 18,
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on('moveend', () => {
      clearTimeout(initMap._t);
      initMap._t = setTimeout(loadStationsInView, 400);
    });
    updateSuburbCircle();
    if (!hasSuburb && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.setView([pos.coords.latitude, pos.coords.longitude], 13);
          loadStationsInView();
        },
        () => {
          loadStationsInView();
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
      );
    } else {
      loadStationsInView();
    }
  }

  function rankColor(pct) {
    const t = Math.max(0, Math.min(100, pct)) / 100;
    const stops = [
      [239, 68, 68],
      [255, 255, 255],
      [34, 197, 94],
    ];
    const i = t < 0.5 ? 0 : 1;
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const a = stops[i];
    const b = stops[i + 1];
    const rgb = a.map((c, j) => Math.round(c + (b[j] - c) * u));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  async function loadStationsInView() {
    if (!map || map.getZoom() < 13) {
      markerLayer.clearLayers();
      return;
    }
    const p = readFormPrefs();
    UserPrefs.save(p);
    const st = p.homeState || 'NSW';
    try {
      const catalog = await fetch(`${dataBase}/v1/stations/${st}/catalog.json`).then((r) => r.json());
      const index = await fetch(`${dataBase}/v1/index.json`).then((r) => r.json()).catch(() => null);
      let dayIso = null;
      /* resolve latest day via listing not available — try today-ish from state file */
      const stateFile = await fetch(`${dataBase}/v1/${st}.json`).then((r) => r.json());
      dayIso =
        (stateFile.snapshot && stateFile.snapshot.asOf && String(stateFile.snapshot.asOf).slice(0, 10)) ||
        null;
      if (!dayIso) return;
      const day = await fetch(`${dataBase}/v1/stations/${st}/days/${dayIso}.json`).then((r) => r.json());
      const priceById = {};
      const rows = Array.isArray(day.s) ? day.s : [];
      for (const row of rows) {
        if (Array.isArray(row) && row.length >= 2) priceById[row[0]] = row[1];
      }
      if (day.prices && typeof day.prices === 'object') {
        Object.assign(priceById, day.prices);
      }
      const bounds = map.getBounds();
      const fuel = (p.preferredFuel || 'U91').replace(/\+.*/, '');
      const prices = [];
      const visible = [];
      const stations = catalog.stations || catalog;
      for (const [id, meta] of Object.entries(stations)) {
        if (!meta || meta.lat == null || meta.lng == null) continue;
        if (p.excludeCostco && /costco/i.test(meta.brand || '')) continue;
        if (!bounds.contains([meta.lat, meta.lng])) continue;
        const pr = priceById[id] && priceById[id][fuel];
        const price = pr != null ? Number(pr) / 10 : null;
        visible.push({ id, meta, price, state: st });
        if (price != null) prices.push(price);
      }
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 1;
      markerLayer.clearLayers();
      for (const stn of visible) {
        let heat = '#3d9cf5';
        let cheapest = false;
        if (stn.price != null && max > min) {
          const pct =
            stn.price <= min ? 100 : Math.max(0, Math.min(100, ((max - stn.price) / (max - min)) * 100));
          heat = rankColor(pct);
          cheapest = stn.price === min;
        }
        if (cheapest) heat = '#e8c547';
        const logo = window.brandLogoFor ? brandLogoFor(stn.meta.brand) : '';
        const icon = L.divIcon({
          className: 'station-div-icon',
          html: `<div class="station-marker" style="--pin-heat:${heat}"><div class="marker-pin-wrap"><div class="marker-pin-head">${
            logo ? `<img src="${logo}" alt="" />` : ''
          }</div><div class="marker-pin-tail"></div></div></div>`,
          iconSize: [28, 38],
          iconAnchor: [14, 38],
        });
        const m = L.marker([stn.meta.lat, stn.meta.lng], { icon });
        m.on('click', () => {
          selectedStation = {
            id: stn.id,
            state: st,
            name: stn.meta.name || stn.meta.brand || stn.id,
            brand: stn.meta.brand || '',
            suburb: stn.meta.suburb || '',
          };
          document.getElementById('popupName').textContent =
            `${selectedStation.name}${stn.price != null ? ' · ' + stn.price.toFixed(1) + 'c' : ''}`;
          document.getElementById('stationPopup').classList.remove('hidden');
        });
        m.addTo(markerLayer);
        stationCache.set(stn.id, selectedStation);
      }
    } catch (e) {
      console.warn('stations', e);
    }
  }

  function init() {
    fillScopeCombo();
    let p = prefs();
    try {
      const injected = params.get('prefs');
      if (injected) {
        p = UserPrefs.save(JSON.parse(injected));
      }
    } catch (_) {}
    applyPrefsToForm(p);
    updateCacheStatus();
    initMap();
    loadSuburbs();

    document.getElementById('btnDownloadLatest').onclick = () => downloadLatest();
    document.getElementById('areaRadiusKm').onchange = () => {
      UserPrefs.update({ areaRadiusKm: Number(document.getElementById('areaRadiusKm').value) || 15 });
      updateSuburbCircle();
    };
    document.getElementById('suburbQuery').oninput = (ev) => {
      const box = document.getElementById('suburbSuggest');
      const rows = searchSuburbs(ev.target.value);
      box.innerHTML = '';
      if (!rows.length) {
        box.classList.remove('open');
        return;
      }
      box.classList.add('open');
      for (const row of rows) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = row.label;
        b.onclick = () => setSuburb(row);
        box.appendChild(b);
      }
    };
    document.getElementById('btnAddFav').onclick = () => {
      if (!selectedStation) return;
      UserPrefs.addFavourite(selectedStation);
      renderFavs();
    };
    document.getElementById('btnSetDefault').onclick = () => {
      if (!selectedStation) return;
      UserPrefs.addFavourite(selectedStation);
      UserPrefs.setDefaultFavourite(selectedStation.id);
      renderFavs();
      renderDefault();
    };
    document.getElementById('btnClearDefault').onclick = () => {
      const cur = prefs();
      cur.defaultFavouriteId = null;
      UserPrefs.save(cur);
      renderDefault();
    };
    document.getElementById('btnClosePopup').onclick = () => {
      document.getElementById('stationPopup').classList.add('hidden');
    };
    document.getElementById('btnSave').onclick = () => closeToWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
