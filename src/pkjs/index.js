/**
 * Aus Fuel Watch — PebbleKit JS companion
 * Fetches GitHub Pages v1 data (3h cache), builds watch payload, handles GPS lists.
 */
var DATA_BASE = 'https://erad84.github.io/aus-fuel-watch';
var CONFIG_URL = DATA_BASE + '/viewer/settings.html';
var CACHE_PREFIX = 'afw.cache.';
var CACHE_META = 'afw.cacheMeta';
var PREFS_KEY = 'afw.userPrefs';
var AREA_KEY = 'afw.areaCenter';
var LAST_GOOD = 'afw.lastGoodPayload';
var MAX_AGE_MS = 3 * 60 * 60 * 1000;

/* Viewer defaults — do not load localStorage tune overrides */
var DIAL_MODEL = 'arcpath';
var DEFAULT_TURN_TUNE = { sensitivity: 85, minGapDays: 5, coarseness: 25, fftAssist: 0 };
var DEFAULT_ARCPATH_TUNE = {
  pathBase: 0.08,
  pathScale: 0.32,
  extremeEdge: 0.3,
  priorExtreme: 0.25,
  fftDial: 0.2,
};

var E10_ENERGY_RATIO = 0.97;
var LPG_ENERGY_RATIO = 0.75;

/** Capital GPO coords + metro radius (mirrors data/lib/regions.js). */
var CAPITALS = {
  NSW: { name: 'Sydney', lat: -33.8688, lng: 151.2093, radiusKm: 60 },
  VIC: { name: 'Melbourne', lat: -37.8136, lng: 144.9631, radiusKm: 60 },
  QLD: { name: 'Brisbane', lat: -27.4698, lng: 153.0251, radiusKm: 70 },
  SA: { name: 'Adelaide', lat: -34.9285, lng: 138.6007, radiusKm: 45 },
  WA: { name: 'Perth', lat: -31.9523, lng: 115.8613, radiusKm: 60 },
  TAS: { name: 'Hobart', lat: -42.8821, lng: 147.3272, radiusKm: 30 },
  NT: { name: 'Darwin', lat: -12.4634, lng: 130.8456, radiusKm: 30 },
  ACT: { name: 'Canberra', lat: -35.2809, lng: 149.13, radiusKm: 30 },
};

var DEG = Math.PI / 180;
var EARTH_KM = 6371;

/** Last successful geolocation for Near me lists. */
var lastGps = null;

function emptyPrefs() {
  return {
    v: 1,
    preferredFuel: 'U91',
    homeState: 'NSW',
    defaultScope: 'metro',
    periodDays: 90,
    favourites: [],
    defaultFavouriteId: null,
    excludeCostco: true,
    areaPostcode: null,
    areaSuburb: null,
    areaState: null,
    areaLabel: null,
    areaLat: null,
    areaLng: null,
    areaRadiusKm: 15,
    gpsRadiusKm: 15,
    watchTheme: 'dark',
  };
}

function loadPrefs() {
  try {
    var raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return emptyPrefs();
    var p = JSON.parse(raw);
    var base = emptyPrefs();
    Object.keys(base).forEach(function (k) {
      if (p[k] !== undefined && p[k] !== null) base[k] = p[k];
    });
    if (base.excludeCostco === undefined) base.excludeCostco = true;
    /* Restore suburb center from compact key if main prefs lost it */
    if (base.areaLat == null || base.areaLng == null) {
      try {
        var area = JSON.parse(localStorage.getItem(AREA_KEY) || 'null');
        if (area && area.areaLat != null && area.areaLng != null) {
          base.areaLat = area.areaLat;
          base.areaLng = area.areaLng;
          if (area.areaLabel) base.areaLabel = area.areaLabel;
          if (area.areaSuburb) base.areaSuburb = area.areaSuburb;
          if (area.areaPostcode) base.areaPostcode = area.areaPostcode;
          if (area.areaState) base.areaState = area.areaState;
          if (area.areaRadiusKm != null) base.areaRadiusKm = area.areaRadiusKm;
        }
      } catch (e2) {}
    }
    return base;
  } catch (e) {
    return emptyPrefs();
  }
}

function saveAreaCenter(p) {
  if (!p || p.areaLat == null || p.areaLng == null) return;
  try {
    localStorage.setItem(
      AREA_KEY,
      JSON.stringify({
        areaLat: p.areaLat,
        areaLng: p.areaLng,
        areaLabel: p.areaLabel || null,
        areaSuburb: p.areaSuburb || null,
        areaPostcode: p.areaPostcode || null,
        areaState: p.areaState || null,
        areaRadiusKm: p.areaRadiusKm != null ? p.areaRadiusKm : 15,
      })
    );
  } catch (e) {}
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {}
  saveAreaCenter(p);
  return p;
}

function cacheMeta() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_META) || '{}');
  } catch (e) {
    return {};
  }
}

function setCacheMeta(m) {
  try {
    localStorage.setItem(CACHE_META, JSON.stringify(m));
  } catch (e) {}
}

function cacheGet(key) {
  try {
    var raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data));
    var m = cacheMeta();
    m[key] = Date.now();
    setCacheMeta(m);
  } catch (e) {}
}

function cacheAge(key) {
  var m = cacheMeta();
  if (!m[key]) return Infinity;
  return Date.now() - m[key];
}

/** Local date+time for watch / settings, e.g. "17 Sep 22:07". */
function formatAsOfLocal(iso) {
  if (!iso) return '';
  var t = Date.parse(iso);
  if (!isFinite(t)) return String(iso).substring(0, 23);
  var d = new Date(t);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var day = d.getDate();
  var mon = months[d.getMonth()];
  var hh = ('0' + d.getHours()).slice(-2);
  var mm = ('0' + d.getMinutes()).slice(-2);
  return day + ' ' + mon + ' ' + hh + ':' + mm;
}

function clearCache() {
  var m = cacheMeta();
  Object.keys(m).forEach(function (k) {
    try {
      localStorage.removeItem(CACHE_PREFIX + k);
    } catch (e) {}
  });
  setCacheMeta({});
  try {
    localStorage.removeItem(LAST_GOOD);
  } catch (e) {}
}

function fetchJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  });
}

function fetchCached(path, force) {
  var key = path.replace(/^\//, '');
  if (!force) {
    var hit = cacheGet(key);
    /* 3h gate = time since last successful phone download. When past, watch
     * launch re-fetches Pages so settings/watch stay in sync. */
    if (hit && cacheAge(key) < MAX_AGE_MS) {
      return Promise.resolve(hit);
    }
  }
  return fetchJson(DATA_BASE + '/v1/' + key).then(function (data) {
    cacheSet(key, data);
    return data;
  });
}

/** Best timestamp for "data as of": prefer pipeline generated time over date-only snapshot.asOf. */
function resolveDataAsOf(stateFile) {
  if (!stateFile) return '';
  var gen = stateFile.generated || stateFile.updated || '';
  if (gen && String(gen).length > 10) return String(gen);
  var snap = stateFile.snapshot && stateFile.snapshot.asOf;
  return String(snap || gen || '');
}

function isCostcoBrand(brand) {
  return /costco/i.test(String(brand || ''));
}

function asciiSafe(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, '');
}

function primaryFuel(prefs) {
  var f = prefs.preferredFuel || 'U91';
  if (f === 'U91+E10' || f === 'U91+LPG') return 'U91';
  return f;
}

/** Alternate fuel when dual preference is selected; null otherwise. */
function dualAltFuel(prefs) {
  var f = prefs.preferredFuel || '';
  if (f === 'U91+E10') return 'E10';
  if (f === 'U91+LPG') return 'LPG';
  return null;
}

/** Energy-adjusted sort key (tenths). Lower = better value. */
function energyEffectiveTenths(fuel, tenths) {
  if (fuel === 'E10') return tenths / E10_ENERGY_RATIO;
  if (fuel === 'LPG') return tenths / LPG_ENERGY_RATIO;
  return tenths;
}

function pushFuelOffer(rows, priceMap, id, name, fuel, labelFuel) {
  var prices = priceMap && priceMap[id];
  var tenths = prices && prices[fuel];
  if (typeof tenths !== 'number' || !isFinite(tenths)) return;
  var winTenths = 0;
  /* Dual alt: only list when it beats same-station U91 on energy (then win% always applies).
   * Otherwise U91 is the better buy at that pump — listing E10/LPG without a win% is misleading. */
  if (labelFuel === 'E10' || labelFuel === 'LPG') {
    var u91 = prices && prices.U91;
    var ratio = labelFuel === 'E10' ? E10_ENERGY_RATIO : LPG_ENERGY_RATIO;
    if (typeof u91 === 'number' && u91 > 0 && ratio > 0) {
      var altEff = tenths / ratio;
      var eps = 0.5; /* tenths */
      if (altEff + eps < u91) {
        winTenths = Math.round(((u91 - altEff) / u91) * 1000);
        if (winTenths < 1) winTenths = 0;
      } else {
        return;
      }
    }
    /* No U91 at station: still list alt (no win% to compute) */
  }
  rows.push({
    p: tenths,
    sort: energyEffectiveTenths(fuel, tenths),
    n: name,
    f: labelFuel || '',
    w: winTenths > 0 ? winTenths : 0,
  });
}

/** One or two offers per station depending on U91+E10 / U91+LPG. */
function pushStationOffers(rows, prefs, priceMap, id, name) {
  var alt = dualAltFuel(prefs);
  if (alt) {
    pushFuelOffer(rows, priceMap, id, name, 'U91', 'U91');
    pushFuelOffer(rows, priceMap, id, name, alt, alt);
  } else {
    var fuel = primaryFuel(prefs);
    pushFuelOffer(rows, priceMap, id, name, fuel, fuel);
  }
}

function homeContext(prefs) {
  if (prefs.favourites && prefs.favourites.length) return 'favourites';
  if (prefs.areaLat != null && prefs.areaLng != null) return 'suburb';
  return 'scope';
}

function scopeTitle(prefs) {
  var st = prefs.homeState || 'NSW';
  var sc = prefs.defaultScope || 'metro';
  if (sc === 'state') return st;
  if (sc === 'regional') return st + ' Regional';
  return st + ' Metro';
}

/** ASCII-only titles — Unicode mid-dots blow up Pebble system fonts. */
function displayFuel(prefs) {
  return String(prefs.preferredFuel || primaryFuel(prefs) || 'U91');
}

function titleFor(prefs) {
  return (primaryFuel(prefs) + ' Cycle Stage').substring(0, 47);
}

function zoneLabel(prefs, kind) {
  if (kind === 'favs') return 'Favs';
  if (kind === 'suburb') {
    return asciiSafe(prefs.areaSuburb || prefs.areaLabel || 'Suburb').substring(0, 14);
  }
  return asciiSafe(scopeTitle(prefs)).substring(0, 16);
}

function shortStationName(name) {
  var s = asciiSafe(name).trim();
  if (s.length > 22) s = s.substring(0, 22);
  return s || 'Station';
}

function haversineKm(lat1, lng1, lat2, lng2) {
  var dLat = (lat2 - lat1) * DEG;
  var dLng = (lng2 - lng1) * DEG;
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function stationInMetro(meta, state) {
  var cap = CAPITALS[state];
  if (!cap || !meta || meta.lat == null || meta.lng == null) return false;
  var lat = Number(meta.lat);
  var lng = Number(meta.lng);
  if (!isFinite(lat) || !isFinite(lng)) return false;
  return haversineKm(lat, lng, cap.lat, cap.lng) <= (cap.radiusKm || 60);
}

/** Heuristic dial stage from mean series (c/L), matching viewer fallback. */
function inferDial(series, lastTurn) {
  if (!series || !series.length) {
    return { angle: 0, label: '-' };
  }
  var vals = series.filter(function (v) {
    return typeof v === 'number' && isFinite(v);
  });
  if (vals.length < 3) return { angle: 0, label: '-' };
  var last = vals[vals.length - 1];
  var prev = vals[vals.length - 2];
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var slope = last - prev;
  var label = 'Falling';
  var angle = 90;
  if (last >= max - (max - min) * 0.08) {
    label = 'Peak';
    angle = 0;
  } else if (last <= min + (max - min) * 0.08) {
    label = 'Bottom';
    angle = 180;
  } else if (slope > 0) {
    label = 'Rising';
    angle = 270;
  } else {
    label = 'Falling';
    angle = 90;
  }
  /* Bias with published lastTurn when present */
  if (lastTurn && lastTurn.type === 'peak' && slope <= 0 && label !== 'Bottom') {
    label = 'Falling';
    angle = 90;
  } else if (lastTurn && lastTurn.type === 'trough' && slope >= 0 && label !== 'Peak') {
    label = 'Rising';
    angle = 270;
  }
  /* Nudge angle within quadrant by position in range */
  var t = max > min ? (last - min) / (max - min) : 0.5;
  if (label === 'Falling') angle = 45 + Math.round((1 - t) * 90);
  if (label === 'Rising') angle = 225 + Math.round(t * 90);
  if (label === 'Peak') angle = Math.round((0.5 - t) * 40);
  if (label === 'Bottom') angle = 180 + Math.round((t - 0.5) * 40);
  angle = ((angle % 360) + 360) % 360;
  return { angle: angle, label: label };
}

/**
 * Published scopes are { avg:[], min:[], max:[], ... } in tenths c/L.
 * Legacy row arrays [{avg,min,max}, ...] still accepted.
 */
function scopeFuelBlock(stateFile, scope, fuel) {
  var block = stateFile && stateFile.scopes && stateFile.scopes[scope];
  if (!block) block = stateFile && stateFile.fuels;
  return block && block[fuel] ? block[fuel] : null;
}

/** Aligned avg series in c/L (null gaps preserved). */
function seriesMeansAligned(stateFile, scope, fuel) {
  var series = scopeFuelBlock(stateFile, scope, fuel);
  if (!series) return [];
  if (Array.isArray(series)) {
    return series.map(function (row) {
      if (row == null) return null;
      if (typeof row === 'number') return row / 10;
      if (typeof row.avg === 'number') return row.avg / 10;
      return null;
    });
  }
  var avg = series.avg;
  if (!avg || !avg.length) return [];
  return avg.map(function (v) {
    return typeof v === 'number' && isFinite(v) ? v / 10 : null;
  });
}

function seriesMeans(stateFile, scope, fuel) {
  return seriesMeansAligned(stateFile, scope, fuel).filter(function (v) {
    return v != null && isFinite(v);
  });
}

function seriesMinMaxTenths(stateFile, scope, fuel) {
  var series = scopeFuelBlock(stateFile, scope, fuel);
  var low = null;
  var high = null;
  if (!series) return { low: low, high: high };
  if (Array.isArray(series)) {
    series.forEach(function (row) {
      if (!row || typeof row === 'number') return;
      var mn = row.min != null ? row.min : row.avg;
      var mx = row.max != null ? row.max : row.avg;
      if (typeof mn === 'number' && isFinite(mn)) low = low == null ? mn : Math.min(low, mn);
      if (typeof mx === 'number' && isFinite(mx)) high = high == null ? mx : Math.max(high, mx);
    });
    return { low: low, high: high };
  }
  var period = 90;
  var mins = series.min || [];
  var maxs = series.max || [];
  var start = Math.max(0, mins.length - period);
  for (var i = start; i < mins.length; i++) {
    var mn2 = mins[i];
    var mx2 = maxs[i];
    if (typeof mn2 === 'number' && isFinite(mn2)) low = low == null ? mn2 : Math.min(low, mn2);
    if (typeof mx2 === 'number' && isFinite(mx2)) high = high == null ? mx2 : Math.max(high, mx2);
  }
  return { low: low, high: high };
}

function downsample(vals, n) {
  if (!vals.length) return { pts: [], min: 0, max: 1 };
  if (n < 2) n = 2;
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  if (max <= min) max = min + 1;
  var out = [];
  var len = vals.length;
  for (var i = 0; i < n; i++) {
    var idx = Math.round((i * (len - 1)) / (n - 1));
    var v = vals[idx];
    out.push(Math.round(((v - min) / (max - min)) * 255));
  }
  return { pts: out, min: Math.round(min * 10), max: Math.round(max * 10) };
}

/** Scale aligned c/L series (null gaps → 255) onto shared min/max tenths. */
function scaleSeries(valsCpl, n, minTenths, maxTenths) {
  var min = minTenths / 10;
  var max = maxTenths / 10;
  if (!(max > min)) max = min + 1;
  var out = [];
  var len = valsCpl.length;
  if (!len) return out;
  for (var i = 0; i < n; i++) {
    var idx = len === 1 ? 0 : Math.round((i * (len - 1)) / (n - 1));
    var v = valsCpl[idx];
    if (v == null || !isFinite(v)) {
      out.push(255);
      continue;
    }
    var s = Math.round(((v - min) / (max - min)) * 254);
    if (s < 0) s = 0;
    if (s > 254) s = 254;
    out.push(s);
  }
  return out;
}

function snapshotScope(stateFile, scope) {
  return (
    stateFile &&
    stateFile.snapshot &&
    stateFile.snapshot.scopes &&
    stateFile.snapshot.scopes[scope]
  );
}

function snapshotCheapest(stateFile, scope, fuel) {
  var snap = snapshotScope(stateFile, scope);
  var f = snap && snap.fuels && snap.fuels[fuel];
  return f && f.cheapest ? f.cheapest : null;
}

function snapshotCompare(stateFile, scope, key) {
  var snap = snapshotScope(stateFile, scope);
  if (!snap) return null;
  if (snap.compare && snap.compare[key]) return snap.compare[key];
  var u91 = snap.fuels && snap.fuels.U91;
  if (u91 && u91.compare && u91.compare[key]) return u91.compare[key];
  return null;
}

function tenthsToOneDecimal(tenths) {
  return (Math.round(Number(tenths)) / 10).toFixed(1);
}

function bestBuyFields(prefs, stateFile) {
  var scope = prefs.defaultScope || 'metro';
  var fuelPref = prefs.preferredFuel || 'U91';
  var fuel = primaryFuel(prefs);
  var compareLine = '';

  if (fuelPref === 'U91+E10' || fuelPref === 'U91+LPG') {
    var key = fuelPref === 'U91+E10' ? 'e10VsU91' : 'lpgVsU91';
    var c = snapshotCompare(stateFile, scope, key);
    var pick = c && c.pick ? c.pick : 'tie';
    var win = c && c.winPct != null ? Math.round(Number(c.winPct) * 10) / 10 : 0;
    /* Alt or U91 win: "E10 2.3%" / "U91 2.3%" — % drawn non-bold on watch */
    var bestLine = '';
    if (pick === 'tie') {
      bestLine = 'Even (energy-adj)';
    } else if (pick) {
      bestLine = pick + ' ' + win.toFixed(1) + '%';
    }
    var nameFuel = pick === 'tie' || !pick ? 'U91' : pick;
    var cheapDual = snapshotCheapest(stateFile, scope, nameFuel);
    if (prefs.excludeCostco && cheapDual && isCostcoBrand(cheapDual.brand)) {
      cheapDual = snapshotCheapest(stateFile, scope, 'U91');
      if (prefs.excludeCostco && cheapDual && isCostcoBrand(cheapDual.brand)) cheapDual = null;
    }
    return {
      BEST_LINE: bestLine.substring(0, 47),
      BEST_NAME: cheapDual
        ? asciiSafe(cheapDual.name || '').substring(0, 36)
        : 'No data',
      BEST_PRICE: cheapDual && cheapDual.price != null ? cheapDual.price : -1,
      COMPARE_LINE: zoneLabel(prefs, 'scope'),
      stationFuel: nameFuel,
    };
  }

  var cheap = snapshotCheapest(stateFile, scope, fuel);
  if (prefs.excludeCostco && cheap && isCostcoBrand(cheap.brand)) {
    cheap = null;
  }
  return {
    /* Fuel type always on price row; win% only for dual compare */
    BEST_LINE: fuel,
    BEST_NAME: cheap ? asciiSafe(cheap.name || '').substring(0, 36) : 'No data',
    BEST_PRICE: cheap && cheap.price != null ? cheap.price : -1,
    COMPARE_LINE: zoneLabel(prefs, 'scope'),
    stationFuel: fuel,
  };
}

/** Cheapest station: favourites first, then suburb radius, then state/scope snapshot list. */
function resolveWinningStation(prefs, catalog, priceMap) {
  if (!catalog || !priceMap) return null;
  var best = buildFavList(prefs, catalog, priceMap)[0];
  if (best) {
    best.zone = zoneLabel(prefs, 'favs');
    return best;
  }

  if (prefs.areaLat != null && prefs.areaLng != null) {
    var rSub = prefs.areaRadiusKm != null ? Number(prefs.areaRadiusKm) : 15;
    best = buildRadiusList(
      prefs,
      catalog,
      priceMap,
      Number(prefs.areaLat),
      Number(prefs.areaLng),
      rSub
    )[0];
    if (best) {
      best.zone = zoneLabel(prefs, 'suburb');
      return best;
    }
  }

  best = buildScopeList(prefs, catalog, priceMap)[0];
  if (best) best.zone = zoneLabel(prefs, 'scope');
  return best || null;
}

function applyWinningStation(buy, station) {
  if (!buy || !station || !(station.p >= 0)) return buy;
  buy.BEST_PRICE = station.p;
  buy.BEST_NAME = asciiSafe(station.n || '').substring(0, 36);
  if (station.zone) buy.COMPARE_LINE = String(station.zone).substring(0, 16);
  /* Price row: "{fuel}" or "{fuel} 2.3%" — % drawn non-bold on watch */
  var fuel = station.f || buy.stationFuel || '';
  if (!fuel) return buy;
  var pct = '';
  if (station.w > 0) {
    pct = ' ' + (station.w / 10).toFixed(1) + '%';
  } else {
    var bl = String(buy.BEST_LINE || '');
    var sp = bl.indexOf(' ');
    if (sp > 0 && bl.substring(0, sp) === fuel && bl.indexOf('%') > 0) {
      pct = bl.substring(sp);
    }
  }
  buy.BEST_LINE = (fuel + pct).substring(0, 47);
  return buy;
}

function parseIsoDate(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), iso: m[1] + '-' + m[2] + '-' + m[3] };
}

function addDaysIso(startIso, days) {
  var p = parseIsoDate(startIso);
  if (!p) return null;
  var dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  var y = dt.getUTCFullYear();
  var mo = dt.getUTCMonth() + 1;
  var d = dt.getUTCDate();
  return (
    y +
    '-' +
    (mo < 10 ? '0' : '') +
    mo +
    '-' +
    (d < 10 ? '0' : '') +
    d
  );
}

function formatDM(iso) {
  var p = parseIsoDate(iso);
  if (!p) return '';
  return p.d + '/' + p.mo;
}

function dayIndexIso(startIso, index) {
  return addDaysIso(startIso, index);
}

function latestDayIso(stateFile) {
  var asOf = stateFile && stateFile.snapshot && stateFile.snapshot.asOf;
  if (asOf) {
    var p = parseIsoDate(asOf);
    if (p) return p.iso;
  }
  var start = stateFile && stateFile.start;
  if (!start) return null;
  var scope = 'metro';
  var aligned = seriesMeansAligned(stateFile, scope, 'U91');
  if (!aligned.length) {
    aligned = seriesMeansAligned(stateFile, 'state', 'U91');
  }
  var last = -1;
  for (var i = 0; i < aligned.length; i++) {
    if (aligned[i] != null) last = i;
  }
  if (last < 0) return parseIsoDate(start) ? parseIsoDate(start).iso : null;
  return dayIndexIso(start, last);
}

/** Day file → { id: {U91:tenths,...} } */
function dayPriceMap(day) {
  var map = {};
  if (!day) return map;
  if (day.stations && typeof day.stations === 'object' && !Array.isArray(day.stations)) {
    Object.keys(day.stations).forEach(function (id) {
      map[id] = day.stations[id];
    });
    return map;
  }
  (day.s || []).forEach(function (row) {
    if (!row || !Array.isArray(row) || row.length < 2) return;
    map[row[0]] = row[1];
  });
  return map;
}

function catalogStations(catalog) {
  if (!catalog) return {};
  if (catalog.stations && typeof catalog.stations === 'object') return catalog.stations;
  return {};
}

function mapPool(items, concurrency, fn) {
  var results = new Array(items.length);
  var i = 0;
  function next() {
    if (i >= items.length) return Promise.resolve();
    var idx = i++;
    return Promise.resolve()
      .then(function () {
        return fn(items[idx], idx);
      })
      .then(function (r) {
        results[idx] = r;
        return next();
      });
  }
  var workers = [];
  var n = Math.min(concurrency, Math.max(1, items.length));
  for (var w = 0; w < n; w++) workers.push(next());
  return Promise.all(workers).then(function () {
    return results;
  });
}

function sampleDates(startIso, endIso, n) {
  var a = parseIsoDate(startIso);
  var b = parseIsoDate(endIso);
  if (!a || !b) return [];
  var t0 = Date.UTC(a.y, a.mo - 1, a.d);
  var t1 = Date.UTC(b.y, b.mo - 1, b.d);
  if (t1 < t0) return [a.iso];
  var days = Math.round((t1 - t0) / 86400000);
  var count = Math.min(n, days + 1);
  if (count < 1) return [];
  if (count === 1) return [a.iso];
  var out = [];
  for (var i = 0; i < count; i++) {
    var offset = Math.round((i * days) / (count - 1));
    out.push(addDaysIso(a.iso, offset));
  }
  return out;
}

var OUTLOOK_BAR_SCALE_CPL = 10;

function outlookCommodityKey(fuel) {
  return fuel === 'DSL' || fuel === 'PDSL' ? 'gasoil' : 'mogas95';
}

function outlookSignal(outlook, fuel) {
  if (!outlook || !outlook.weeks || fuel === 'LPG') return { dir: 0, str: 0 };
  var key = outlookCommodityKey(fuel);
  var weeks = outlook.weeks
    .filter(function (w) {
      return w && typeof w[key] === 'number' && isFinite(w[key]);
    })
    .map(function (w) {
      return { weekEnding: w.weekEnding, value: Number(w[key]) };
    })
    .sort(function (a, b) {
      return String(a.weekEnding).localeCompare(String(b.weekEnding));
    });
  if (weeks.length < 2) return { dir: 0, str: 0 };
  var toIdx = -1;
  for (var i = weeks.length - 1; i >= 1; i--) {
    if (Math.abs(weeks[i].value - weeks[i - 1].value) >= 0.05) {
      toIdx = i;
      break;
    }
  }
  if (toIdx < 1) toIdx = weeks.length - 1;
  var delta = weeks[toIdx].value - weeks[toIdx - 1].value;
  var dir = delta > 0.05 ? 2 : delta < -0.05 ? 1 : 0;
  var str = Math.round(Math.min(1, Math.abs(delta) / OUTLOOK_BAR_SCALE_CPL) * 100);
  return { dir: dir, str: str };
}

function sendDict(dict) {
  return new Promise(function (resolve, reject) {
    Pebble.sendAppMessage(
      dict,
      function () {
        resolve();
      },
      function (e) {
        reject(e);
      }
    );
  });
}

function buildMainPayload(prefs, stateFile, outlook, stationOverride) {
  var scope = prefs.defaultScope || 'metro';
  var fuel = primaryFuel(prefs);
  var means = seriesMeans(stateFile, scope, fuel);
  var params = stateFile.params && stateFile.params[fuel];
  var lastTurn = params && params.lastTurn ? params.lastTurn : null;
  var dial = inferDial(means.slice(-90), lastTurn);
  var buy = bestBuyFields(prefs, stateFile);
  if (stationOverride) applyWinningStation(buy, stationOverride);
  var mm = seriesMinMaxTenths(stateFile, scope, fuel);
  var low = mm.low;
  var high = mm.high;
  var barPrice = buy.BEST_PRICE;
  /* Prefer default favourite price on the rank bar when set */
  if (prefs.defaultFavouriteId && prefs.favourites && prefs.favourites.length) {
    var fav = null;
    for (var fi = 0; fi < prefs.favourites.length; fi++) {
      if (prefs.favourites[fi].id === prefs.defaultFavouriteId) {
        fav = prefs.favourites[fi];
        break;
      }
    }
    if (fav && fav.price != null && typeof fav.price === 'number') {
      barPrice = fav.price;
    }
  }

  var asOfRaw = resolveDataAsOf(stateFile);
  var asOf = formatAsOfLocal(asOfRaw) || String(asOfRaw).substring(0, 23);
  var glow = outlookSignal(outlook, fuel);

  return {
    TITLE: titleFor(prefs),
    FUEL: String(prefs.preferredFuel || fuel).substring(0, 15),
    HOME_CTX: homeContext(prefs),
    DIAL_ANGLE: dial.angle,
    DIAL_LABEL: String(dial.label).substring(0, 23),
    BAR_LOW: low != null ? low : 0,
    BAR_HIGH: high != null ? high : 1000,
    BAR_PRICE: barPrice,
    BEST_PRICE: buy.BEST_PRICE,
    BEST_LINE: buy.BEST_LINE,
    BEST_NAME: buy.BEST_NAME,
    COMPARE_LINE: String(buy.COMPARE_LINE || '').substring(0, 47),
    AS_OF: asOf.substring(0, 23),
    STALE: 0,
    OUTLOOK_DIR: glow.dir,
    OUTLOOK_STR: glow.str,
    THEME: prefs.watchTheme === 'light' ? 1 : 0,
  };
}

function pushMain(force) {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  return Promise.all([
    fetchCached(state + '.json', !!force),
    fetchCached('outlook.json', !!force).catch(function () {
      return null;
    }),
  ])
    .then(function (pair) {
      var stateFile = pair[0];
      var outlook = pair[1];
      return loadCatalogAndLatestDay(state, stateFile)
        .then(function (pack) {
          var station = resolveWinningStation(prefs, pack.catalog, pack.priceMap);
          return buildMainPayload(prefs, stateFile, outlook, station);
        })
        .catch(function () {
          return buildMainPayload(prefs, stateFile, outlook, null);
        })
        .then(function (payload) {
          try {
            localStorage.setItem(
              LAST_GOOD,
              JSON.stringify({ savedAt: new Date().toISOString(), payload: payload })
            );
          } catch (e) {}
          return sendDict(payload);
        });
    })
    .catch(function (err) {
      console.warn('pushMain', err);
      try {
        var lg = JSON.parse(localStorage.getItem(LAST_GOOD) || 'null');
        if (lg && lg.payload) {
          lg.payload.STALE = 1;
          return sendDict(lg.payload);
        }
      } catch (e2) {}
      return sendDict({
        TITLE: 'Offline',
        BEST_NAME: String(err.message || 'Error').substring(0, 36),
        STALE: 1,
      });
    });
}

function resolveFavourite(prefs) {
  var favs = prefs.favourites || [];
  if (!favs.length) return null;
  if (prefs.defaultFavouriteId) {
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].id === prefs.defaultFavouriteId) return favs[i];
    }
  }
  return favs[0];
}

function pushGraph(prefs, stateFile) {
  var fuel = primaryFuel(prefs);
  var scope = prefs.defaultScope || 'metro';
  var state = prefs.homeState || 'NSW';
  var aligned = seriesMeansAligned(stateFile, scope, fuel);
  var period = 90;
  var startIdx = Math.max(0, aligned.length - period);
  var nPts = 36;
  var stateVals = [];
  var dates = [];
  var span = Math.max(0, aligned.length - 1 - startIdx);
  for (var i = 0; i < nPts; i++) {
    var idx = startIdx + (span === 0 ? 0 : Math.round((i * span) / (nPts - 1)));
    stateVals.push(aligned[idx] != null && isFinite(aligned[idx]) ? aligned[idx] : null);
    dates.push(dayIndexIso(stateFile.start, idx));
  }
  var x0 = dates[0] ? formatDM(dates[0]) : '';
  var x1 = dates[dates.length - 1] ? formatDM(dates[dates.length - 1]) : '';
  var legend0 = scopeTitle(prefs).substring(0, 19);
  var fav = resolveFavourite(prefs);
  var legend1 = fav ? shortStationName(fav.name || fav.id).substring(0, 19) : '';

  var finish = function (stationVals) {
    var all = [];
    stateVals.forEach(function (v) {
      if (v != null && isFinite(v)) all.push(v);
    });
    (stationVals || []).forEach(function (v) {
      if (v != null && isFinite(v)) all.push(v);
    });
    var minT = 0;
    var maxT = 10;
    if (all.length) {
      minT = Math.round(Math.min.apply(null, all) * 10);
      maxT = Math.round(Math.max.apply(null, all) * 10);
      if (maxT <= minT) maxT = minT + 10;
    }
    var pts = scaleSeries(stateVals, nPts, minT, maxT);
    var pts2 =
      stationVals && stationVals.length ? scaleSeries(stationVals, nPts, minT, maxT) : [];
    return sendDict({
      GRAPH_TITLE: (fuel + ' - ' + period + ' days').substring(0, 47),
      GRAPH_LEGEND0: legend0,
      GRAPH_LEGEND1: legend1,
      GRAPH_X0: x0.substring(0, 7),
      GRAPH_X1: x1.substring(0, 7),
      GRAPH_MIN: minT,
      GRAPH_MAX: maxT,
      GRAPH_N: pts.length,
      GRAPH_PTS: pts,
      GRAPH_N2: pts2.length,
      GRAPH_PTS2: pts2,
    });
  };

  if (!fav || !fav.id) return finish(null);

  return mapPool(dates, 6, function (iso) {
    if (!iso) return Promise.resolve(null);
    return fetchCached('stations/' + state + '/days/' + iso + '.json', false).catch(function () {
      return null;
    });
  }).then(function (days) {
    var stationVals = [];
    for (var i = 0; i < days.length; i++) {
      var map = dayPriceMap(days[i]);
      var prices = map[fav.id];
      var tenths = prices && prices[fuel];
      if (typeof tenths === 'number' && isFinite(tenths)) stationVals.push(tenths / 10);
      else stationVals.push(null);
    }
    if (fav.name) legend1 = shortStationName(fav.name).substring(0, 19);
    return fetchCached('stations/' + state + '/catalog.json', false)
      .catch(function () {
        return null;
      })
      .then(function (catalog) {
        if (catalog) {
          var meta = catalogStations(catalog)[fav.id];
          if (meta && meta.name) legend1 = shortStationName(meta.name).substring(0, 19);
        }
        return finish(stationVals);
      });
  });
}

function requestGraph() {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  return fetchCached(state + '.json', false)
    .then(function (stateFile) {
      return pushGraph(prefs, stateFile);
    })
    .catch(function (err) {
      console.warn('pushGraph', err);
      return sendDict({
        GRAPH_TITLE: (primaryFuel(prefs) + ' - 90 days').substring(0, 47),
        GRAPH_LEGEND0: scopeTitle(prefs).substring(0, 19),
        GRAPH_LEGEND1: '',
        GRAPH_N: 0,
        GRAPH_PTS: [],
        GRAPH_N2: 0,
        GRAPH_PTS2: [],
      });
    });
}

function listTitleFor(kind, prefs) {
  var fuel = displayFuel(prefs).substring(0, 12);
  var base;
  if (kind === 'favs') base = 'Favs top 5';
  else if (kind === 'suburb') base = 'Suburb top 5';
  else if (kind === 'gps') base = 'Near me (GPS)';
  else base = scopeTitle(prefs) + ' top 5';
  if (fuel) return (base + ' - ' + fuel).substring(0, 39);
  return base.substring(0, 39);
}

function encodeListJson(rows) {
  var list = (rows || []).slice(0, 5).map(function (r) {
    /* Key order: p/f/w before n so a hard length cut keeps fuel + win% */
    var o = {
      p: typeof r.p === 'number' ? r.p : -1,
    };
    if (r.f) o.f = String(r.f).substring(0, 4);
    if (r.w > 0) o.w = Math.round(Number(r.w));
    o.n = asciiSafe(r.n || '?').substring(0, 28);
    return o;
  });
  var json = JSON.stringify(list);
  while (json.length > 500 && list.length) {
    var last = list[list.length - 1];
    if (last.n && last.n.length > 8) {
      last.n = last.n.substring(0, last.n.length - 2);
    } else {
      list.pop();
    }
    json = JSON.stringify(list);
  }
  return json.substring(0, 500);
}

function topByPrice(candidates, limit) {
  candidates.sort(function (a, b) {
    var as = a.sort != null ? a.sort : a.p;
    var bs = b.sort != null ? b.sort : b.p;
    if (as < 0 && bs < 0) return 0;
    if (as < 0) return 1;
    if (bs < 0) return -1;
    if (as !== bs) return as - bs;
    return a.p - b.p;
  });
  return candidates.filter(function (r) {
    return r.p >= 0;
  }).slice(0, limit || 5);
}

function buildFavList(prefs, catalog, priceMap) {
  var favs = prefs.favourites || [];
  var stations = catalogStations(catalog);
  var rows = [];
  for (var i = 0; i < favs.length; i++) {
    var f = favs[i];
    if (!f || !f.id) continue;
    var meta = stations[f.id] || {};
    var brand = f.brand || meta.brand || '';
    if (prefs.excludeCostco && isCostcoBrand(brand)) continue;
    pushStationOffers(rows, prefs, priceMap, f.id, f.name || meta.name || f.id);
  }
  return topByPrice(rows, 5);
}

function buildRadiusList(prefs, catalog, priceMap, lat, lng, radiusKm) {
  var stations = catalogStations(catalog);
  var rows = [];
  Object.keys(stations).forEach(function (id) {
    var meta = stations[id];
    if (!meta || meta.lat == null || meta.lng == null) return;
    if (prefs.excludeCostco && isCostcoBrand(meta.brand)) return;
    var dist = haversineKm(lat, lng, Number(meta.lat), Number(meta.lng));
    if (!(dist <= radiusKm)) return;
    pushStationOffers(rows, prefs, priceMap, id, meta.name || id);
  });
  return topByPrice(rows, 5);
}

function buildScopeList(prefs, catalog, priceMap) {
  var state = prefs.homeState || 'NSW';
  var scope = prefs.defaultScope || 'metro';
  var stations = catalogStations(catalog);
  var rows = [];
  Object.keys(stations).forEach(function (id) {
    var meta = stations[id];
    if (!meta) return;
    if (prefs.excludeCostco && isCostcoBrand(meta.brand)) return;
    var inMetro = stationInMetro(meta, state);
    if (scope === 'metro' && !inMetro) return;
    if (scope === 'regional' && inMetro) return;
    pushStationOffers(rows, prefs, priceMap, id, meta.name || id);
  });
  return topByPrice(rows, 5);
}

function loadCatalogAndLatestDay(state, stateFile) {
  var iso = latestDayIso(stateFile);
  var catalogP = fetchCached('stations/' + state + '/catalog.json', false).catch(function () {
    return null;
  });
  var dayP = iso
    ? fetchCached('stations/' + state + '/days/' + iso + '.json', false).catch(function () {
        return null;
      })
    : Promise.resolve(null);
  return Promise.all([catalogP, dayP]).then(function (pair) {
    return { catalog: pair[0], day: pair[1], priceMap: dayPriceMap(pair[1]) };
  });
}

function pushList(kind, gpsCoords) {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  var listKind = kind === 'suburb' ? 1 : kind === 'scope' ? 2 : kind === 'gps' ? 3 : 0;
  var title = listTitleFor(kind, prefs);

  return fetchCached(state + '.json', false)
    .then(function (stateFile) {
      return loadCatalogAndLatestDay(state, stateFile).then(function (pack) {
        var rows = [];
        if (kind === 'favs') {
          rows = buildFavList(prefs, pack.catalog, pack.priceMap);
        } else if (kind === 'suburb') {
          if (prefs.areaLat != null && prefs.areaLng != null) {
            var rSub = prefs.areaRadiusKm != null ? Number(prefs.areaRadiusKm) : 15;
            rows = buildRadiusList(
              prefs,
              pack.catalog,
              pack.priceMap,
              Number(prefs.areaLat),
              Number(prefs.areaLng),
              rSub
            );
          } else {
            rows = [];
          }
        } else if (kind === 'scope') {
          rows = buildScopeList(prefs, pack.catalog, pack.priceMap);
        } else if (kind === 'gps') {
          var coords = gpsCoords || lastGps;
          if (coords && coords.lat != null && coords.lng != null) {
            var rGps = prefs.gpsRadiusKm != null ? Number(prefs.gpsRadiusKm) : 15;
            rows = buildRadiusList(
              prefs,
              pack.catalog,
              pack.priceMap,
              Number(coords.lat),
              Number(coords.lng),
              rGps
            );
          } else if (prefs.areaLat != null && prefs.areaLng != null) {
            var rFb = prefs.areaRadiusKm != null ? Number(prefs.areaRadiusKm) : 15;
            rows = buildRadiusList(
              prefs,
              pack.catalog,
              pack.priceMap,
              Number(prefs.areaLat),
              Number(prefs.areaLng),
              rFb
            );
          } else {
            rows = buildScopeList(prefs, pack.catalog, pack.priceMap);
          }
        }
        return sendDict({
          LIST_KIND: listKind,
          LIST_TITLE: title.substring(0, 39),
          LIST_JSON: encodeListJson(rows),
        });
      });
    })
    .catch(function (err) {
      console.warn('pushList', err);
      return sendDict({
        LIST_KIND: listKind,
        LIST_TITLE: title.substring(0, 39),
        LIST_JSON: '[]',
      });
    });
}

function onReady() {
  console.log('AFW pkjs ready');
  Pebble.addEventListener('showConfiguration', function () {
    var prefs = loadPrefs();
    var state = prefs.homeState || 'NSW';
    var stateKey = state + '.json';
    var hit = cacheGet(stateKey);
    var asOfRaw = resolveDataAsOf(hit);
    var meta = cacheMeta();
    var downloadedAt = meta[stateKey] || '';
    var bust = String(Date.now());
    /* area* in query AND hash — some Pebble webviews drop long query strings */
    var areaQs =
      'areaLat=' +
      encodeURIComponent(prefs.areaLat != null ? prefs.areaLat : '') +
      '&areaLng=' +
      encodeURIComponent(prefs.areaLng != null ? prefs.areaLng : '') +
      '&areaLabel=' +
      encodeURIComponent(prefs.areaLabel || '') +
      '&areaSuburb=' +
      encodeURIComponent(prefs.areaSuburb || '') +
      '&areaPostcode=' +
      encodeURIComponent(prefs.areaPostcode || '') +
      '&areaState=' +
      encodeURIComponent(prefs.areaState || '') +
      '&areaRadiusKm=' +
      encodeURIComponent(prefs.areaRadiusKm != null ? prefs.areaRadiusKm : 15);
    var url =
      CONFIG_URL +
      '?v=' +
      bust +
      '&' +
      areaQs +
      '&dataBase=' +
      encodeURIComponent(DATA_BASE) +
      '&dataAsOf=' +
      encodeURIComponent(asOfRaw || '') +
      '&downloadedAt=' +
      encodeURIComponent(String(downloadedAt || '')) +
      '&prefs=' +
      encodeURIComponent(JSON.stringify(prefs)) +
      '#' +
      areaQs;
    Pebble.openURL(url);
  });

  Pebble.addEventListener('webviewclosed', function (e) {
    if (!e || !e.response) return;
    try {
      var raw = e.response;
      var decoded;
      try {
        decoded = JSON.parse(decodeURIComponent(raw));
      } catch (e1) {
        decoded = JSON.parse(raw);
      }
      if (decoded && typeof decoded === 'object') {
        if (decoded.clearCache) clearCache();
        var merged = Object.assign(loadPrefs(), decoded);
        delete merged.clearCache;
        savePrefs(merged);
        pushMain(!!decoded.clearCache);
      }
    } catch (err) {
      console.warn('webviewclosed', err);
    }
  });

  Pebble.addEventListener('appmessage', function (e) {
    var req = e.payload && e.payload.REQUEST;
    if (!req) return;
    if (req === 'refresh') pushMain(false);
    else if (req === 'graph' || req === 'graph_state' || req === 'graph_station') requestGraph();
    else if (req === 'list_favs') pushList('favs');
    else if (req === 'list_suburb') pushList('suburb');
    else if (req === 'list_scope') pushList('scope');
    else if (req === 'list_gps') {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            lastGps = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            };
            pushList('gps', lastGps);
          },
          function () {
            pushList('gps', lastGps);
          },
          { timeout: 8000, maximumAge: 60000 }
        );
      } else {
        pushList('gps', lastGps);
      }
    }
  });

  pushMain(false);
}

Pebble.addEventListener('ready', onReady);

/* Export for node tests */
if (typeof module !== 'undefined') {
  module.exports = {
    inferDial: inferDial,
    downsample: downsample,
    homeContext: homeContext,
    primaryFuel: primaryFuel,
    emptyPrefs: emptyPrefs,
    titleFor: titleFor,
    scopeTitle: scopeTitle,
    dayPriceMap: dayPriceMap,
    latestDayIso: latestDayIso,
  };
}
