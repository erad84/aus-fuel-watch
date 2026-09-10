/* Aus Fuel Watch — watch-shaped user preferences (Clay / PebbleKit mirror). */
(function (global) {
  const STORAGE_KEY = 'afw.userPrefs';
  const LAST_GOOD_KEY = 'afw.lastGoodPayload';
  const SCOPES = new Set(['metro', 'regional', 'state']);
  const FUELS = new Set(['U91', 'E10', 'P95', 'P98', 'DSL', 'PDSL', 'LPG']);

  function emptyPrefs() {
    return {
      v: 1,
      preferredFuel: 'U91',
      homeState: null,
      defaultScope: 'metro',
      periodDays: 90,
      favourites: [],
      defaultFavouriteId: null,
      excludeCostco: false,
      areaPostcode: null,
      areaSuburb: null,
      areaState: null,
      areaLabel: null,
      areaLat: null,
      areaLng: null,
      areaRadiusKm: 15,
      graphLines: {
        avg: true,
        gmean: false,
        mode: false,
        med: false,
        min: true,
        max: true,
        areaMean: true,
        areaLow: true,
        areaHigh: true,
        favMean: true,
        favLow: true,
        favHigh: true,
        station: true,
      },
      turnLines: {
        state: true,
        suburb: true,
        fav: true,
        station: true,
      },
    };
  }

  function normalizeFavourite(raw) {
    if (!raw || raw.id == null || String(raw.id).trim() === '') return null;
    const id = String(raw.id);
    const stateRaw = raw.state != null ? String(raw.state).trim() : '';
    const state = stateRaw ? stateRaw.toUpperCase() : null;
    if (!state) return null;
    return {
      id,
      state,
      name: raw.name != null ? String(raw.name) : '',
      brand: raw.brand != null ? String(raw.brand) : '',
      suburb: raw.suburb != null ? String(raw.suburb) : '',
    };
  }

  function normalize(raw) {
    const base = emptyPrefs();
    if (!raw || typeof raw !== 'object') return base;
    if (raw.preferredFuel && FUELS.has(raw.preferredFuel)) {
      base.preferredFuel = raw.preferredFuel;
    }
    if (raw.homeState != null && String(raw.homeState).trim()) {
      base.homeState = String(raw.homeState).toUpperCase();
    }
    if (raw.defaultScope && SCOPES.has(raw.defaultScope)) {
      base.defaultScope = raw.defaultScope;
    }
    const pd = Number(raw.periodDays);
    if (pd === 30 || pd === 60 || pd === 90) base.periodDays = pd;
    const favs = Array.isArray(raw.favourites) ? raw.favourites : [];
    const seen = new Set();
    for (const f of favs) {
      const n = normalizeFavourite(f);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      base.favourites.push(n);
    }
    if (raw.defaultFavouriteId != null) {
      const did = String(raw.defaultFavouriteId);
      if (base.favourites.some((f) => f.id === did)) base.defaultFavouriteId = did;
    }
    if (!base.defaultFavouriteId && base.favourites.length) {
      base.defaultFavouriteId = base.favourites[0].id;
    }
    base.excludeCostco = !!raw.excludeCostco;
    if (raw.areaPostcode != null && String(raw.areaPostcode).trim()) {
      base.areaPostcode = String(raw.areaPostcode).trim();
    }
    if (raw.areaSuburb != null && String(raw.areaSuburb).trim()) {
      base.areaSuburb = String(raw.areaSuburb).trim();
    }
    if (raw.areaState != null && String(raw.areaState).trim()) {
      base.areaState = String(raw.areaState).trim().toUpperCase();
    }
    if (raw.areaLabel != null && String(raw.areaLabel).trim()) {
      base.areaLabel = String(raw.areaLabel).trim();
    }
    const alat = Number(raw.areaLat);
    const alng = Number(raw.areaLng);
    if (Number.isFinite(alat) && Number.isFinite(alng)) {
      base.areaLat = alat;
      base.areaLng = alng;
    }
    const ar = Number(raw.areaRadiusKm);
    if (Number.isFinite(ar) && ar >= 1 && ar <= 100) {
      base.areaRadiusKm = Math.round(ar);
    }
    if (raw.graphLines && typeof raw.graphLines === 'object') {
      for (const key of Object.keys(base.graphLines)) {
        if (Object.prototype.hasOwnProperty.call(raw.graphLines, key)) {
          base.graphLines[key] = !!raw.graphLines[key];
        }
      }
    }
    if (raw.turnLines && typeof raw.turnLines === 'object') {
      for (const key of Object.keys(base.turnLines)) {
        if (Object.prototype.hasOwnProperty.call(raw.turnLines, key)) {
          base.turnLines[key] = !!raw.turnLines[key];
        }
      }
    }
    return base;
  }

  function load() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return emptyPrefs();
      return normalize(JSON.parse(raw));
    } catch (_) {
      return emptyPrefs();
    }
  }

  function save(prefs) {
    const next = normalize(prefs);
    try {
      global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      /* ignore quota */
    }
    return next;
  }

  function update(partial) {
    return save({ ...load(), ...(partial || {}) });
  }

  function listFavourites() {
    return load().favourites.slice();
  }

  function getDefaultFavouriteId() {
    return load().defaultFavouriteId;
  }

  function getFavourite(id) {
    const sid = String(id);
    return load().favourites.find((f) => f.id === sid) || null;
  }

  function isFavourite(id) {
    return !!getFavourite(id);
  }

  function addFavourite(station) {
    const prefs = load();
    const entry = normalizeFavourite({
      id: station.id,
      state: station.state,
      name: station.name,
      brand: station.brand,
      suburb: station.suburb,
    });
    if (!entry) return prefs;
    if (prefs.favourites.some((f) => f.id === entry.id)) return prefs;
    prefs.favourites.push(entry);
    if (!prefs.defaultFavouriteId) prefs.defaultFavouriteId = entry.id;
    return save(prefs);
  }

  function removeFavourite(id) {
    const prefs = load();
    const sid = String(id);
    prefs.favourites = prefs.favourites.filter((f) => f.id !== sid);
    if (prefs.defaultFavouriteId === sid) {
      prefs.defaultFavouriteId = prefs.favourites[0]?.id || null;
    }
    return save(prefs);
  }

  function setDefaultFavourite(id) {
    const prefs = load();
    const sid = String(id);
    if (!prefs.favourites.some((f) => f.id === sid)) return prefs;
    prefs.defaultFavouriteId = sid;
    return save(prefs);
  }

  function exportJson() {
    return JSON.stringify(load(), null, 2);
  }

  function importJson(text) {
    const parsed = JSON.parse(text);
    return save(parsed);
  }

  function saveLastGood(payload) {
    try {
      global.localStorage?.setItem(
        LAST_GOOD_KEY,
        JSON.stringify({ savedAt: new Date().toISOString(), payload })
      );
    } catch (_) {
      /* ignore */
    }
  }

  function loadLastGood() {
    try {
      const raw = global.localStorage?.getItem(LAST_GOOD_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  global.UserPrefs = {
    STORAGE_KEY,
    LAST_GOOD_KEY,
    emptyPrefs,
    load,
    save,
    update,
    listFavourites,
    getDefaultFavouriteId,
    getFavourite,
    isFavourite,
    addFavourite,
    removeFavourite,
    setDefaultFavourite,
    exportJson,
    importJson,
    saveLastGood,
    loadLastGood,
  };
})(typeof window !== 'undefined' ? window : globalThis);
