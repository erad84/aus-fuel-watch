'use strict';

// Per-station daily price history, kept separate from the phone-facing state
// aggregates in history.js.
//
// Layout:
//   docs/v1/stations/index.json
//   docs/v1/stations/{STATE}/catalog.json
//   docs/v1/stations/{STATE}/days/YYYY-MM-DD.json
//   docs/v1/stations/archive/YYYY-MM.json
//
// Day files store tenths-of-a-cent integers. Live collect freshens today's
// prices (overwrites fuels present in the census, keeps gaps). Import/backfill
// still fills empty fuels only.

const fs = require('fs');
const path = require('path');
const { FUELS } = require('./fuels');
const { isoToDayNum, dayNumToISO } = require('./cyclefit');
const history = require('./history');
const fuelwatch = require('./sources/fuelwatch');

const SCHEMA = 1;
const WINDOW_DAYS = history.WINDOW_DAYS;

function fuelwatchStationId(name, suburb) {
  return fuelwatch.stationId(name, suburb);
}

function stationsRoot(docsDir) {
  return path.join(docsDir, 'v1', 'stations');
}

function stateDir(docsDir, state) {
  return path.join(stationsRoot(docsDir), state);
}

function catalogPath(docsDir, state) {
  return path.join(stateDir(docsDir, state), 'catalog.json');
}

function dayPath(docsDir, state, iso) {
  return path.join(stateDir(docsDir, state), 'days', `${iso}.json`);
}

function archivePath(docsDir, month) {
  return path.join(stationsRoot(docsDir), 'archive', `${month}.json`);
}

function indexPath(docsDir) {
  return path.join(stationsRoot(docsDir), 'index.json');
}

/** Stable id for live adapters and archive rows that lack one. */
function ensureStationId(st) {
  if (st && st.id) return String(st.id);
  if (!st || !st.state) return null;
  const state = st.state;
  if (state === 'QLD' && (st.code != null || st._key != null)) {
    return `fuelpricesqld:QLD:${st.code != null ? st.code : st._key}`;
  }
  if (state === 'SA' && st.code != null) {
    return `safpis:SA:${st.code}`;
  }
  if (state === 'WA') {
    return fuelwatchStationId(st.name, st.suburb);
  }
  if (state === 'NT') {
    const key =
      st._key ||
      `${st.brand || st.name || ''}|${st.suburb || ''}|${st.postcode != null ? st.postcode : ''}`;
    return `archive:myfuelnt:NT:${key}`;
  }
  const pc = st.postcode != null ? st.postcode : '';
  const name = String(st.name || '').toLowerCase();
  return `archive:fuelcheck:${state}:${pc}:${name}`;
}

function emptyCatalog(state) {
  return {
    v: SCHEMA,
    state,
    generated: null,
    stations: {},
  };
}

function loadCatalog(docsDir, state) {
  const p = catalogPath(docsDir, state);
  if (!fs.existsSync(p)) return emptyCatalog(state);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.stations) parsed.stations = {};
    return parsed;
  } catch (_) {
    return emptyCatalog(state);
  }
}

function saveCatalog(docsDir, state, catalog) {
  const p = catalogPath(docsDir, state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  catalog.generated = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(catalog) + '\n');
}

function catalogMetaFromStation(st) {
  return {
    name: st.name || '',
    brand: st.brand || '',
    address: st.address || '',
    suburb: st.suburb || '',
    postcode: st.postcode != null ? st.postcode : null,
    lat: st.lat != null && Number.isFinite(Number(st.lat)) ? Number(st.lat) : null,
    lng: st.lng != null && Number.isFinite(Number(st.lng)) ? Number(st.lng) : null,
    code: st.code != null ? String(st.code) : null,
    metro: typeof st.metro === 'boolean' ? st.metro : undefined,
  };
}

function mergeCatalogEntry(prev, next) {
  if (!prev) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

function loadDay(docsDir, state, iso) {
  const p = dayPath(docsDir, state, iso);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function dayToMap(dayFile) {
  const map = new Map();
  if (!dayFile) return map;
  if (dayFile.stations && typeof dayFile.stations === 'object' && !Array.isArray(dayFile.stations)) {
    for (const [id, prices] of Object.entries(dayFile.stations)) map.set(id, { ...prices });
    return map;
  }
  for (const row of dayFile.s || []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    map.set(row[0], { ...row[1] });
  }
  return map;
}

function mapToDayFile(state, iso, map) {
  const s = [];
  for (const [id, prices] of map) {
    const slim = {};
    for (const f of FUELS) {
      if (prices[f] != null && Number.isFinite(prices[f])) slim[f] = prices[f];
    }
    if (Object.keys(slim).length) s.push([id, slim]);
  }
  s.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    v: SCHEMA,
    state,
    date: iso,
    units: 'tenths of a cent per litre',
    s,
  };
}

function isDayEmpty(docsDir, state, iso) {
  return !fs.existsSync(dayPath(docsDir, state, iso));
}

/**
 * Write one local calendar day of station prices for a state.
 *
 * opts.onlyEmpty (default true): import/backfill — skip if day exists; within a
 *   day only fill fuels that are still null.
 * opts.freshen (collect): merge into an existing day — overwrite any fuel present
 *   in this census; leave stations/fuels absent from the fetch unchanged.
 *
 * @returns {{ wrote: boolean, stations: number }}
 */
function writeDay(docsDir, state, iso, stations, opts) {
  const freshen = Boolean(opts && opts.freshen);
  const onlyEmpty = freshen ? false : !opts || opts.onlyEmpty !== false;
  if (!state || !iso || !stations || !stations.length) {
    return { wrote: false, stations: 0 };
  }
  const existed = !isDayEmpty(docsDir, state, iso);
  if (onlyEmpty && existed) {
    return { wrote: false, stations: 0 };
  }

  const map = existed ? dayToMap(loadDay(docsDir, state, iso)) : new Map();
  const catalog = loadCatalog(docsDir, state);
  let n = 0;
  let changed = 0;

  for (const st of stations) {
    if (!st || st.state !== state) continue;
    const id = ensureStationId(st);
    if (!id) continue;
    const prices = st.prices || {};
    const slim = {};
    for (const f of FUELS) {
      const v = prices[f];
      if (v != null && Number.isFinite(Number(v))) slim[f] = Math.round(Number(v));
    }
    if (!Object.keys(slim).length) continue;

    if (map.has(id)) {
      const prev = map.get(id);
      for (const [f, v] of Object.entries(slim)) {
        if (freshen) {
          if (prev[f] !== v) {
            prev[f] = v;
            changed++;
          }
        } else if (prev[f] == null) {
          prev[f] = v;
          changed++;
        }
      }
    } else {
      map.set(id, slim);
      changed += Object.keys(slim).length;
    }

    catalog.stations[id] = mergeCatalogEntry(catalog.stations[id], catalogMetaFromStation(st));
    n++;
  }

  if (!map.size) return { wrote: false, stations: 0 };
  // Existing day with nothing new (fill) or unchanged (freshen).
  if (existed && changed === 0) return { wrote: false, stations: 0 };

  const p = dayPath(docsDir, state, iso);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(mapToDayFile(state, iso, map)) + '\n');
  saveCatalog(docsDir, state, catalog);
  return { wrote: true, stations: n };
}

/**
 * Group station rows by state and write each state's local day.
 * Stations without .state are skipped.
 */
function writeStationsForDay(docsDir, isoByState, stations, opts) {
  const byState = new Map();
  for (const st of stations || []) {
    if (!st || !st.state) continue;
    if (!byState.has(st.state)) byState.set(st.state, []);
    byState.get(st.state).push(st);
  }

  const results = {};
  for (const [state, list] of byState) {
    const iso = typeof isoByState === 'string' ? isoByState : isoByState[state] || isoByState.get?.(state);
    if (!iso) continue;
    results[state] = writeDay(docsDir, state, iso, list, opts);
  }
  return results;
}

/**
 * Import many iso → station[] maps (archive backfill).
 * @param {Map<string, Array>|Object} stationsByDay
 */
function writeStationsByDay(docsDir, stationsByDay, opts) {
  let days = 0;
  let stations = 0;
  const entries =
    stationsByDay instanceof Map
      ? stationsByDay.entries()
      : Object.entries(stationsByDay || {});

  for (const [iso, list] of entries) {
    const byState = new Map();
    for (const st of list || []) {
      if (!st || !st.state) continue;
      if (!byState.has(st.state)) byState.set(st.state, []);
      byState.get(st.state).push(st);
    }
    for (const [state, rows] of byState) {
      const r = writeDay(docsDir, state, iso, rows, opts);
      if (r.wrote) {
        days++;
        stations += r.stations;
      }
    }
  }
  return { days, stations };
}

function archiveDayPayload(docsDir, state, iso) {
  const day = loadDay(docsDir, state, iso);
  if (!day) return null;
  const map = dayToMap(day);
  const obj = {};
  for (const [id, prices] of map) obj[id] = prices;
  return obj;
}

function rollState(docsDir, state, todayIso) {
  const daysDir = path.join(stateDir(docsDir, state), 'days');
  if (!fs.existsSync(daysDir)) return { archived: 0 };

  const keepFrom = dayNumToISO(isoToDayNum(todayIso) - (WINDOW_DAYS - 1));
  let archived = 0;

  for (const name of fs.readdirSync(daysDir)) {
    if (!name.endsWith('.json')) continue;
    const iso = name.slice(0, -5);
    if (iso >= keepFrom) continue;

    const payload = archiveDayPayload(docsDir, state, iso);
    if (payload && Object.keys(payload).length) {
      const month = iso.slice(0, 7);
      const p = archivePath(docsDir, month);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const existing = fs.existsSync(p)
        ? JSON.parse(fs.readFileSync(p, 'utf8'))
        : { v: SCHEMA, month, states: {} };
      existing.states[state] = existing.states[state] || {};
      existing.states[state][iso] = {
        ...(existing.states[state][iso] || {}),
        ...payload,
      };
      fs.writeFileSync(p, JSON.stringify(existing) + '\n');
      archived++;
    }
    fs.unlinkSync(path.join(daysDir, name));
  }
  return { archived };
}

function rollAll(docsDir, states, todayIso) {
  let archived = 0;
  for (const state of states) {
    archived += rollState(docsDir, state, todayIso).archived;
  }
  return { archived };
}

function writeIndex(docsDir, states) {
  const index = {
    v: SCHEMA,
    windowDays: WINDOW_DAYS,
    units: 'tenths of a cent per litre',
    path: 'stations/{STATE}/days/{YYYY-MM-DD}.json',
    catalog: 'stations/{STATE}/catalog.json',
    archive: 'stations/archive/{YYYY-MM}.json',
    states: states.map((code) => ({
      code,
      catalog: `${code}/catalog.json`,
      days: `${code}/days/`,
    })),
  };
  const p = indexPath(docsDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const next = JSON.stringify(index, null, 1) + '\n';
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== next) {
    fs.writeFileSync(p, next);
    return true;
  }
  return false;
}

function clearAll(docsDir) {
  const root = stationsRoot(docsDir);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = {
  SCHEMA,
  WINDOW_DAYS,
  ensureStationId,
  fuelwatchStationId,
  catalogPath,
  dayPath,
  loadCatalog,
  saveCatalog,
  loadDay,
  dayToMap,
  isDayEmpty,
  writeDay,
  writeStationsForDay,
  writeStationsByDay,
  rollState,
  rollAll,
  writeIndex,
  clearAll,
  stationsRoot,
};
