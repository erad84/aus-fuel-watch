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
    const defaultId = UserPrefs.getDefaultFavouriteId();
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="hint">None yet — pick from the map</li>';
      return;
    }
    for (const f of list) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'fav-name';
      name.textContent = `${f.name || f.id}${f.suburb ? ' · ' + f.suburb : ''}`;
      li.appendChild(name);

      const actions = document.createElement('span');
      actions.className = 'fav-actions';

      const setDef = document.createElement('button');
      setDef.type = 'button';
      setDef.className = 'secondary' + (f.id === defaultId ? ' is-default' : '');
      setDef.textContent = f.id === defaultId ? 'Default' : 'Set default';
      setDef.disabled = f.id === defaultId;
      setDef.onclick = () => {
        UserPrefs.setDefaultFavourite(f.id);
        renderFavs();
        renderDefault();
      };
      actions.appendChild(setDef);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Remove';
      btn.onclick = () => {
        UserPrefs.removeFavourite(f.id);
        renderFavs();
        renderDefault();
      };
      actions.appendChild(btn);

      li.appendChild(actions);
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
    seedSuburbIndex();
    const sources = [
      `${dataBase}/v1/au-suburbs.json`,
      'au-suburbs.json',
      'https://raw.githubusercontent.com/erad84/aus-fuel-watch/data/v1/au-suburbs.json',
    ];
    for (const url of sources) {
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
        const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
        if (t) clearTimeout(t);
        if (!r.ok) continue;
        const data = await r.json();
        const rows = ingestSuburbs(data);
        if (rows.length) {
          suburbIndex = rows;
          break;
        }
      } catch (_) {}
    }
    if (!suburbIndex.length && window.AFW_SUBURBS) {
      suburbIndex = ingestSuburbs(window.AFW_SUBURBS);
    }
    if (!suburbIndex.length) {
      console.warn('suburbs: no index loaded');
      return prefs();
    }
    const fixed = ensureSuburbCoords(prefs());
    if (map) {
      centerMapOnPrefs(fixed, { zoom: 14 });
      loadStationsInView();
    }
    return fixed;
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
    const target = { areaLat: row.lat, areaLng: row.lng, areaRadiusKm: prefs().areaRadiusKm };
    if (map && row.lat != null) {
      const el = document.getElementById('map');
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest', behavior: 'instant' in window ? 'instant' : 'auto' });
      }
      centerMapOnPrefs(target, { zoom: 14 });
      loadStationsInView();
    } else {
      updateSuburbCircle();
    }
  }

  let suburbCenterMarker = null;

  function updateSuburbCircle() {
    const p = prefs();
    if (suburbCircle) {
      if (map) map.removeLayer(suburbCircle);
      suburbCircle = null;
    }
    if (suburbCenterMarker) {
      if (map) map.removeLayer(suburbCenterMarker);
      suburbCenterMarker = null;
    }
    const c = suburbCoords(p);
    if (!map || !c) return;
    const km = Number(document.getElementById('areaRadiusKm').value) || p.areaRadiusKm || 15;
    suburbCircle = L.circle([c.lat, c.lng], {
      radius: km * 1000,
      color: '#3d9cf5',
      weight: 2,
      fillOpacity: 0.08,
    }).addTo(map);
    suburbCenterMarker = L.circleMarker([c.lat, c.lng], {
      radius: 5,
      color: '#fff',
      weight: 2,
      fillColor: '#3d9cf5',
      fillOpacity: 1,
    }).addTo(map);
  }

  function suburbCoords(p) {
    if (!p) return null;
    const lat = Number(p.areaLat);
    const lng = Number(p.areaLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    /* Australia bbox — reject garbage / missing coords */
    if (lat < -45 || lat > -8 || lng < 110 || lng > 155) return null;
    return { lat, lng };
  }

  /** Force suburb lat/lng to the geometric centre of the map container. */
  function hardCenterMap(lat, lng, zoom) {
    if (!map) return false;
    const z = Math.max(13, zoom == null ? 14 : zoom);
    const target = L.latLng(lat, lng);
    /* pan:false — default pan:true shifts centre when container size was wrong */
    map.invalidateSize({ animate: false, pan: false });
    map.setView(target, z, { animate: false });
    const size = map.getSize();
    if (size.x > 0 && size.y > 0) {
      const mid = map.containerPointToLatLng([size.x / 2, size.y / 2]);
      const a = map.project(target, z);
      const b = map.project(mid, z);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        map.panBy([dx, dy], { animate: false });
      }
    }
    return true;
  }

  function centerMapOnPrefs(p, opts) {
    if (!map) return false;
    const src = p || prefs();
    const c = suburbCoords(src);
    if (!c) return false;
    const zoom = opts && opts.zoom != null ? opts.zoom : 14;
    hardCenterMap(c.lat, c.lng, zoom);
    updateSuburbCircle();
    /* Re-apply after layout / webview chrome settles */
    clearTimeout(centerMapOnPrefs._t);
    centerMapOnPrefs._t = setTimeout(() => {
      hardCenterMap(c.lat, c.lng, zoom);
      updateSuburbCircle();
    }, 100);
    clearTimeout(centerMapOnPrefs._t2);
    centerMapOnPrefs._t2 = setTimeout(() => {
      hardCenterMap(c.lat, c.lng, zoom);
      updateSuburbCircle();
    }, 350);
    return true;
  }

  function findSuburbForPrefs(p) {
    if (!suburbIndex.length || !p) return null;
    const postcode = p.areaPostcode ? String(p.areaPostcode).padStart(4, '0') : '';
    const suburb = String(p.areaSuburb || '')
      .trim()
      .toLowerCase();
    const state = String(p.areaState || p.homeState || '')
      .trim()
      .toUpperCase();
    if (postcode && suburb) {
      const hit = suburbIndex.find(
        (r) =>
          r.postcode === postcode &&
          r.suburb.toLowerCase() === suburb &&
          (!state || r.state === state)
      );
      if (hit) return hit;
    }
    const labelCandidates = [p.areaLabel, document.getElementById('suburbQuery')?.value]
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
    for (const label of labelCandidates) {
      let hit = suburbIndex.find((r) => r.label.toLowerCase() === label);
      if (hit) return hit;
      hit = suburbIndex.find((r) => {
        const s = r.suburb.toLowerCase();
        return (
          label === s ||
          label === `${s} ${r.state.toLowerCase()}` ||
          label === `${s} ${r.postcode}` ||
          (label.startsWith(s + ' ') && (!state || r.state === state))
        );
      });
      if (hit) return hit;
    }
    if (suburb && state) {
      const hit = suburbIndex.find((r) => r.suburb.toLowerCase() === suburb && r.state === state);
      if (hit) return hit;
    }
    if (postcode) {
      const hit = suburbIndex.find((r) => r.postcode === postcode && (!state || r.state === state));
      if (hit) return hit;
    }
    return null;
  }

  function ensureSuburbCoords(p) {
    const cur = p || prefs();
    if (suburbCoords(cur)) return cur;
    const hit = findSuburbForPrefs(cur);
    if (!hit) return cur;
    return UserPrefs.update({
      areaSuburb: hit.suburb,
      areaPostcode: hit.postcode,
      areaState: hit.state,
      areaLabel: hit.label,
      areaLat: hit.lat,
      areaLng: hit.lng,
    });
  }

  function parseAreaFromHash() {
    const raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    try {
      if (raw.charAt(0) === '{') return JSON.parse(decodeURIComponent(raw));
    } catch (_) {}
    const sp = new URLSearchParams(raw);
    if (!sp.get('areaLat') && !sp.get('lat')) return null;
    return {
      areaLat: sp.get('areaLat') || sp.get('lat'),
      areaLng: sp.get('areaLng') || sp.get('lng'),
      areaLabel: sp.get('areaLabel') || sp.get('label') || '',
      areaSuburb: sp.get('areaSuburb') || sp.get('suburb') || '',
      areaPostcode: sp.get('areaPostcode') || sp.get('postcode') || '',
      areaState: sp.get('areaState') || sp.get('state') || '',
      areaRadiusKm: sp.get('areaRadiusKm') || sp.get('radius') || '',
    };
  }

  function applyAreaFields(p, src) {
    if (!src) return p;
    const next = Object.assign({}, p);
    const alat = src.areaLat != null && src.areaLat !== '' ? Number(src.areaLat) : NaN;
    const alng = src.areaLng != null && src.areaLng !== '' ? Number(src.areaLng) : NaN;
    if (Number.isFinite(alat) && Number.isFinite(alng)) {
      next.areaLat = alat;
      next.areaLng = alng;
    }
    if (src.areaLabel) next.areaLabel = String(src.areaLabel);
    if (src.areaSuburb) next.areaSuburb = String(src.areaSuburb);
    if (src.areaPostcode) next.areaPostcode = String(src.areaPostcode);
    if (src.areaState) next.areaState = String(src.areaState);
    const km = Number(src.areaRadiusKm);
    if (Number.isFinite(km) && km >= 1 && km <= 100) next.areaRadiusKm = Math.round(km);
    return next;
  }

  function applyAreaQueryParams(p) {
    let next = applyAreaFields(p || prefs(), {
      areaLat: params.get('areaLat'),
      areaLng: params.get('areaLng'),
      areaLabel: params.get('areaLabel'),
      areaSuburb: params.get('areaSuburb'),
      areaPostcode: params.get('areaPostcode'),
      areaState: params.get('areaState'),
      areaRadiusKm: params.get('areaRadiusKm'),
    });
    next = applyAreaFields(next, parseAreaFromHash());
    return next;
  }

  function seedSuburbIndex() {
    if (suburbIndex.length) return;
    if (window.AFW_SUBURBS) suburbIndex = ingestSuburbs(window.AFW_SUBURBS);
  }

  function initMap(initialPrefs) {
    const p = initialPrefs || prefs();
    const c = suburbCoords(p);
    const lat = c ? c.lat : -33.8688;
    const lng = c ? c.lng : 151.2093;
    const zoom = c ? 14 : 13;
    const wantsSuburb = !!(c || p.areaLabel || p.areaSuburb || p.areaPostcode);
    const el = document.getElementById('map');
    if (map) {
      map.remove();
      map = null;
      markerLayer = null;
      suburbCircle = null;
      suburbCenterMarker = null;
    }
    map = L.map(el, { fadeAnimation: false, zoomAnimation: false }).setView([lat, lng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 18,
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on('moveend', () => {
      clearTimeout(initMap._t);
      initMap._t = setTimeout(loadStationsInView, 400);
    });

    const finishCenter = () => {
      if (!map) return false;
      const latest = ensureSuburbCoords(prefs());
      if (centerMapOnPrefs(latest, { zoom: 14 })) {
        loadStationsInView();
        return true;
      }
      map.invalidateSize({ animate: false, pan: false });
      return false;
    };

    map.whenReady(() => {
      finishCenter();
      setTimeout(finishCenter, 100);
      setTimeout(finishCenter, 400);
    });

    if (!wantsSuburb && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (suburbCoords(prefs()) || document.getElementById('suburbQuery')?.value?.trim()) return;
          map.setView([pos.coords.latitude, pos.coords.longitude], 14, { animate: false });
          loadStationsInView();
        },
        () => loadStationsInView(),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
      );
    } else {
      loadStationsInView();
    }
  }

  /** Green (cheap) -> red (dear); matches viewer. */
  function priceHeatColor(t) {
    const x = Math.max(0, Math.min(1, t));
    const hue = 120 * (1 - x);
    return `hsl(${hue}, 72%, 42%)`;
  }

  function stationMarkerIcon(stn, extent, active) {
    const price = stn.price;
    const showLoaded = price != null;
    const isCheapest = showLoaded && extent && price === extent.min;
    const state = showLoaded ? 'loaded' : 'pending';
    const cheapest = isCheapest ? ' cheapest' : '';
    const activeCls = active ? ' active' : '';
    let heatStyle = '';
    if (showLoaded && extent && !isCheapest) {
      const t = extent.max === extent.min ? 0 : (price - extent.min) / (extent.max - extent.min);
      heatStyle = ` style="--pin-heat:${priceHeatColor(t)}"`;
    }
    const priceLabel = showLoaded ? `${price.toFixed(1)}c` : '';
    const logo = window.brandLogoFor ? brandLogoFor(stn.meta.brand) : '';
    return L.divIcon({
      className: 'station-div-icon',
      html: `
        <div class="station-marker ${state}${cheapest}${activeCls}" data-id="${escapeHtml(stn.id)}"${heatStyle}>
          ${showLoaded ? `<span class="marker-price">${escapeHtml(priceLabel)}</span>` : ''}
          <div class="marker-pin-wrap">
            <div class="marker-pin-head">${logo ? `<img src="${logo}" alt="" />` : ''}</div>
            <div class="marker-pin-tail"></div>
          </div>
        </div>
      `,
      iconSize: [52, 58],
      iconAnchor: [26, 58],
    });
  }

  async function loadStationsInView() {
    if (!map || map.getZoom() < 13) {
      if (markerLayer) markerLayer.clearLayers();
      return;
    }
    const p = readFormPrefs();
    UserPrefs.save(p);
    const st = p.homeState || 'NSW';
    try {
      const catalog = await fetch(`${dataBase}/v1/stations/${st}/catalog.json`).then((r) => r.json());
      const stateFile = await fetch(`${dataBase}/v1/${st}.json`).then((r) => r.json());
      const dayIso =
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
      const extent = prices.length
        ? { min: Math.min(...prices), max: Math.max(...prices) }
        : null;
      markerLayer.clearLayers();
      for (const stn of visible) {
        const active = selectedStation && selectedStation.id === stn.id;
        const icon = stationMarkerIcon(stn, extent, active);
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
          loadStationsInView();
        });
        m.addTo(markerLayer);
        stationCache.set(stn.id, selectedStation);
      }
    } catch (e) {
      console.warn('stations', e);
    }
  }

  async function init() {
    fillScopeCombo();
    seedSuburbIndex();
    let p = prefs();
    try {
      const injected = params.get('prefs');
      if (injected) {
        p = UserPrefs.save(JSON.parse(injected));
      }
    } catch (_) {}
    /* Query + hash area* params (hash survives better in some Pebble webviews) */
    p = UserPrefs.save(applyAreaQueryParams(p));
    p = ensureSuburbCoords(p);
    applyPrefsToForm(p);
    updateCacheStatus();
    /* Create map only after suburb coords are resolved */
    initMap(p);
    loadSuburbs().then((fixed) => {
      if (fixed && map) centerMapOnPrefs(fixed, { zoom: 14 });
    });

    document.getElementById('btnDownloadLatest').onclick = () => downloadLatest();
    document.getElementById('areaRadiusKm').onchange = () => {
      UserPrefs.update({ areaRadiusKm: Number(document.getElementById('areaRadiusKm').value) || 15 });
      updateSuburbCircle();
      centerMapOnPrefs(prefs(), { zoom: 14 });
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
      renderDefault();
    };
    document.getElementById('btnSetDefault').onclick = () => {
      if (!selectedStation) return;
      UserPrefs.addFavourite(selectedStation);
      UserPrefs.setDefaultFavourite(selectedStation.id);
      renderFavs();
      renderDefault();
    };
    document.getElementById('btnClearDefault').onclick = () => {
      UserPrefs.clearDefaultFavourite();
      renderFavs();
      renderDefault();
    };
    document.getElementById('btnClosePopup').onclick = () => {
      document.getElementById('stationPopup').classList.add('hidden');
      selectedStation = null;
      loadStationsInView();
    };
    document.getElementById('btnSave').onclick = () => closeToWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
