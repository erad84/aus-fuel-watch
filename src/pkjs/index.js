/**
 * Aus Fuel Watch — PebbleKit JS companion
 * Fetches GitHub Pages v1 data (3h cache), builds watch payload, handles GPS lists.
 */
var DATA_BASE = 'https://erad84.github.io/aus-fuel-watch';
var CONFIG_URL = DATA_BASE + '/viewer/settings.html';
var CACHE_PREFIX = 'afw.cache.';
var CACHE_META = 'afw.cacheMeta';
var PREFS_KEY = 'afw.userPrefs';
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
    return base;
  } catch (e) {
    return emptyPrefs();
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {}
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
  if (!force && cacheAge(key) < MAX_AGE_MS) {
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
  }
  return fetchJson(DATA_BASE + '/v1/' + key).then(function (data) {
    cacheSet(key, data);
    return data;
  });
}

function isCostcoBrand(brand) {
  return /costco/i.test(String(brand || ''));
}

function primaryFuel(prefs) {
  var f = prefs.preferredFuel || 'U91';
  if (f === 'U91+E10' || f === 'U91+LPG') return 'U91';
  return f;
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

function titleFor(prefs) {
  var ctx = homeContext(prefs);
  var fuel = prefs.preferredFuel || 'U91';
  if (ctx === 'favourites') return 'Favourites · ' + fuel;
  if (ctx === 'suburb') return (prefs.areaLabel || prefs.areaSuburb || 'Suburb') + ' · ' + fuel;
  return scopeTitle(prefs) + ' · ' + fuel;
}

/** Heuristic dial stage from mean series (c/L), matching viewer fallback. */
function inferDial(series) {
  if (!series || !series.length) {
    return { angle: 0, label: '—' };
  }
  var vals = series.filter(function (v) {
    return typeof v === 'number' && isFinite(v);
  });
  if (vals.length < 3) return { angle: 0, label: '—' };
  var last = vals[vals.length - 1];
  var prev = vals[vals.length - 2];
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var mid = (min + max) / 2;
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
  /* Nudge angle within quadrant by position in range */
  var t = max > min ? (last - min) / (max - min) : 0.5;
  if (label === 'Falling') angle = 45 + Math.round((1 - t) * 90);
  if (label === 'Rising') angle = 225 + Math.round(t * 90);
  if (label === 'Peak') angle = Math.round((0.5 - t) * 40);
  if (label === 'Bottom') angle = 180 + Math.round((t - 0.5) * 40);
  angle = ((angle % 360) + 360) % 360;
  return { angle: angle, label: label };
}

function seriesMeans(stateFile, scope, fuel) {
  var block = stateFile && stateFile.scopes && stateFile.scopes[scope];
  var series = block && block[fuel];
  if (!series || !series.length) return [];
  return series
    .map(function (row) {
      if (row == null) return null;
      if (typeof row === 'number') return row / 10;
      if (typeof row.avg === 'number') return row.avg / 10;
      return null;
    })
    .filter(function (v) {
      return v != null;
    });
}

function downsample(vals, n) {
  if (!vals.length) return { pts: [], min: 0, max: 1 };
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

function snapshotCheapest(stateFile, scope, fuel) {
  var snap =
    stateFile &&
    stateFile.snapshot &&
    stateFile.snapshot.scopes &&
    stateFile.snapshot.scopes[scope];
  var f = snap && snap.fuels && snap.fuels[fuel];
  return f && f.cheapest ? f.cheapest : null;
}

function snapshotCompare(stateFile, scope, key) {
  var snap =
    stateFile &&
    stateFile.snapshot &&
    stateFile.snapshot.scopes &&
    stateFile.snapshot.scopes[scope];
  return snap && snap.compare && snap.compare[key] ? snap.compare[key] : null;
}

function compareLine(prefs, stateFile) {
  var scope = prefs.defaultScope || 'metro';
  var fuel = prefs.preferredFuel || 'U91';
  if (fuel === 'U91+E10') {
    var c = snapshotCompare(stateFile, scope, 'e10VsU91');
    if (!c) return '';
    var pick = c.pick || 'tie';
    var win = c.winPct != null ? Math.round(c.winPct * 10) / 10 : 0;
    if (pick === 'tie') return 'U91 ≈ E10';
    return pick + ' wins ' + win + '%';
  }
  if (fuel === 'U91+LPG') {
    var c2 = snapshotCompare(stateFile, scope, 'lpgVsU91');
    if (!c2) return '';
    var pick2 = c2.pick || 'tie';
    var win2 = c2.winPct != null ? Math.round(c2.winPct * 10) / 10 : 0;
    if (pick2 === 'tie') return 'U91 ≈ LPG';
    return pick2 + ' wins ' + win2 + '%';
  }
  return '';
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

function buildMainPayload(prefs, stateFile) {
  var scope = prefs.defaultScope || 'metro';
  var fuel = primaryFuel(prefs);
  var means = seriesMeans(stateFile, scope, fuel);
  var dial = inferDial(means.slice(-90));
  var cheap = snapshotCheapest(stateFile, scope, fuel);
  /* When excluding Costco, snapshot may include Costco — clear best if brand matches */
  if (prefs.excludeCostco && cheap && isCostcoBrand(cheap.brand)) {
    cheap = null;
  }
  var block = stateFile.scopes && stateFile.scopes[scope] && stateFile.scopes[scope][fuel];
  var low = null;
  var high = null;
  if (block && block.length) {
    block.forEach(function (row) {
      var mn = row && (row.min != null ? row.min : row.avg);
      var mx = row && (row.max != null ? row.max : row.avg);
      if (mn != null) low = low == null ? mn : Math.min(low, mn);
      if (mx != null) high = high == null ? mx : Math.max(high, mx);
    });
  }
  var barPrice = -1;
  if (prefs.defaultFavouriteId && prefs.favourites) {
    /* filled later from day file if available; use cheap as fallback marker */
  }
  if (cheap && cheap.price != null) barPrice = cheap.price;

  var asOf =
    (stateFile.snapshot && stateFile.snapshot.asOf) ||
    stateFile.updated ||
    '';

  return {
    TITLE: titleFor(prefs).substring(0, 47),
    FUEL: String(prefs.preferredFuel || fuel).substring(0, 15),
    HOME_CTX: homeContext(prefs),
    DIAL_ANGLE: dial.angle,
    DIAL_LABEL: dial.label,
    BAR_LOW: low != null ? low : 0,
    BAR_HIGH: high != null ? high : 1000,
    BAR_PRICE: barPrice,
    BEST_PRICE: cheap && cheap.price != null ? cheap.price : -1,
    BEST_NAME: cheap
      ? String(cheap.name || '')
          .substring(0, 36)
      : 'No data',
    COMPARE_LINE: compareLine(prefs, stateFile).substring(0, 47),
    AS_OF: String(asOf).substring(0, 23),
    STALE: 0,
    THEME: prefs.watchTheme === 'light' ? 1 : 0,
  };
}

function pushMain(force) {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  return fetchCached(state + '.json', !!force)
    .then(function (stateFile) {
      var payload = buildMainPayload(prefs, stateFile);
      try {
        localStorage.setItem(
          LAST_GOOD,
          JSON.stringify({ savedAt: new Date().toISOString(), payload: payload })
        );
      } catch (e) {}
      return sendDict(payload);
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

function pushGraph(kind) {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  var fuel = primaryFuel(prefs);
  var scope = prefs.defaultScope || 'metro';
  return fetchCached(state + '.json', false).then(function (stateFile) {
    var means = seriesMeans(stateFile, scope, fuel).slice(-90);
    var ds = downsample(means, 48);
    var pts = ds.pts;
    /* AppMessage byte array */
    return sendDict({
      GRAPH_KIND: kind === 'station' ? 1 : 0,
      GRAPH_MIN: ds.min,
      GRAPH_MAX: ds.max,
      GRAPH_N: pts.length,
      GRAPH_PTS: pts,
    });
  });
}

function listFromSnapshot(stateFile, scope, fuel, limit) {
  var c = snapshotCheapest(stateFile, scope, fuel);
  if (!c) return '[]';
  /* Snapshot only has one cheapest; duplicate shape for list until day-scan */
  return JSON.stringify([{ p: c.price, n: c.name || 'Station' }]);
}

function pushList(kind) {
  var prefs = loadPrefs();
  var state = prefs.homeState || 'NSW';
  var fuel = primaryFuel(prefs);
  var scope = prefs.defaultScope || 'metro';
  return fetchCached(state + '.json', false).then(function (stateFile) {
    var json = '[]';
    if (kind === 'favs' && prefs.favourites && prefs.favourites.length) {
      json = JSON.stringify(
        prefs.favourites.slice(0, 5).map(function (f) {
          return { p: -1, n: f.name || f.id };
        })
      );
    } else if (kind === 'suburb') {
      json = listFromSnapshot(stateFile, scope, fuel, 5);
    } else if (kind === 'scope') {
      json = listFromSnapshot(stateFile, scope, fuel, 5);
    } else if (kind === 'gps') {
      json = listFromSnapshot(stateFile, scope, fuel, 5);
    }
    var listKind =
      kind === 'suburb' ? 1 : kind === 'scope' ? 2 : kind === 'gps' ? 3 : 0;
    return sendDict({ LIST_KIND: listKind, LIST_JSON: json.substring(0, 500) });
  });
}

function onReady() {
  console.log('AFW pkjs ready');
  Pebble.addEventListener('showConfiguration', function () {
    var prefs = loadPrefs();
    var url =
      CONFIG_URL +
      '?prefs=' +
      encodeURIComponent(JSON.stringify(prefs)) +
      '&dataBase=' +
      encodeURIComponent(DATA_BASE);
    Pebble.openURL(url);
  });

  Pebble.addEventListener('webviewclosed', function (e) {
    if (!e || !e.response) return;
    try {
      var decoded = JSON.parse(decodeURIComponent(e.response));
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
    else if (req === 'graph_state') pushGraph('state');
    else if (req === 'graph_station') pushGraph('station');
    else if (req === 'list_favs') pushList('favs');
    else if (req === 'list_suburb') pushList('suburb');
    else if (req === 'list_scope') pushList('scope');
    else if (req === 'list_gps') {
      /* Prefer geolocation when available */
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          function () {
            pushList('gps');
          },
          function () {
            pushList('gps');
          },
          { timeout: 8000, maximumAge: 60000 }
        );
      } else {
        pushList('gps');
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
  };
}
