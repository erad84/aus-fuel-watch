'use strict';

// Read/modify/write for the published per-state files, plus the rolling window
// and monthly archive.
//
// Layout choice: one file per state so the phone downloads only what it needs.
// Prices are integers in tenths of a cent (2056 means 205.6 c/L) to keep the
// JSON compact and free of float noise.
//
// Scopes (metro / regional / state) live under `file.scopes`. Top-level
// `file.fuels` mirrors the default scope (prefer metro) for older readers.

const fs = require('fs');
const path = require('path');
const { FUELS } = require('./fuels');
const { isoToDayNum, dayNumToISO, median } = require('./cyclefit');

const WINDOW_DAYS = 90;
const SCHEMA = 1;
const SCOPES = ['metro', 'regional', 'state'];

function statePath(docsDir, state) {
  return path.join(docsDir, 'v1', `${state}.json`);
}

function archivePath(docsDir, month) {
  return path.join(docsDir, 'v1', 'archive', `${month}.json`);
}

function emptyFuelSeries(len) {
  const n = Math.max(0, len || 0);
  return {
    avg: new Array(n).fill(null),
    gmean: new Array(n).fill(null),
    mode: new Array(n).fill(null),
    med: new Array(n).fill(null),
    min: new Array(n).fill(null),
    max: new Array(n).fill(null),
    n: new Array(n).fill(null),
  };
}

function emptyFuels(len) {
  const fuels = {};
  for (const f of FUELS) fuels[f] = emptyFuelSeries(len);
  return fuels;
}

function emptyState(state) {
  const fuels = emptyFuels(0);
  return {
    v: SCHEMA,
    state,
    generated: null,
    source: 'Petrolmate (petrolmate.com.au)',
    units: 'tenths of a cent per litre',
    params: {},
    start: null,
    days: 0,
    fuels,
    scopes: {
      metro: fuels,
      regional: emptyFuels(0),
      state: emptyFuels(0),
    },
    defaultScope: 'metro',
    granularity: 'metro',
    rejects: {},
  };
}

function ensureExtraSeries(s) {
  const len = s.avg?.length || 0;
  if (!s.gmean) s.gmean = new Array(len).fill(null);
  else padTo(s.gmean, len);
  if (!s.mode) s.mode = new Array(len).fill(null);
  else padTo(s.mode, len);
  if (!s.med) s.med = new Array(len).fill(null);
  else padTo(s.med, len);
}

function scopeHasData(fuels) {
  if (!fuels) return false;
  for (const f of FUELS) {
    const avg = fuels[f]?.avg;
    if (!avg) continue;
    for (const v of avg) {
      if (v != null) return true;
    }
  }
  return false;
}

function pickDefaultScope(file) {
  if (
    file.defaultScope &&
    SCOPES.includes(file.defaultScope) &&
    scopeHasData(file.scopes?.[file.defaultScope])
  ) {
    return file.defaultScope;
  }
  for (const sc of ['metro', 'state', 'regional']) {
    if (scopeHasData(file.scopes?.[sc])) return sc;
  }
  return file.granularity === 'state' ? 'state' : 'metro';
}

function syncPrimaryFuels(file) {
  const sc = pickDefaultScope(file);
  file.defaultScope = sc;
  file.granularity = sc === 'regional' ? 'state' : sc;
  if (file.scopes?.[sc]) file.fuels = file.scopes[sc];
}

/** Ensure scopes exist; migrate legacy single-series files. */
function ensureScopes(file) {
  const len = Math.max(file.days || 0, file.fuels?.U91?.avg?.length || 0);
  if (!file.fuels) file.fuels = emptyFuels(len);

  for (const f of FUELS) {
    if (!file.fuels[f]) file.fuels[f] = emptyFuelSeries(len);
    else ensureExtraSeries(file.fuels[f]);
  }

  if (!file.scopes) file.scopes = {};

  const legacy = file.granularity === 'metro' ? 'metro' : 'state';
  if (!file.scopes[legacy]) {
    file.scopes[legacy] = file.fuels;
  }

  for (const sc of SCOPES) {
    if (!file.scopes[sc]) file.scopes[sc] = emptyFuels(len);
    for (const f of FUELS) {
      if (!file.scopes[sc][f]) file.scopes[sc][f] = emptyFuelSeries(len);
      else {
        ensureExtraSeries(file.scopes[sc][f]);
        padTo(file.scopes[sc][f].avg, len);
        padTo(file.scopes[sc][f].gmean, len);
        padTo(file.scopes[sc][f].mode, len);
        padTo(file.scopes[sc][f].med, len);
        padTo(file.scopes[sc][f].min, len);
        padTo(file.scopes[sc][f].max, len);
        padTo(file.scopes[sc][f].n, len);
      }
    }
  }

  syncPrimaryFuels(file);
}

function load(docsDir, state) {
  const p = statePath(docsDir, state);
  if (!fs.existsSync(p)) return emptyState(state);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  ensureScopes(parsed);
  return parsed;
}

function save(docsDir, file) {
  const p = statePath(docsDir, file.state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  ensureScopes(file);
  syncPrimaryFuels(file);

  if (fs.existsSync(p)) {
    try {
      const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
      const probe = {
        ...file,
        generated: prev.generated,
        sourceGeneratedAt: prev.sourceGeneratedAt,
      };
      if (JSON.stringify(probe) === JSON.stringify(prev)) return false;
    } catch (err) {
      // Unparseable file: fall through and replace it.
    }
  }

  fs.writeFileSync(p, JSON.stringify(file) + '\n');
  return true;
}

function indexOfDay(file, iso) {
  if (!file.start) return -1;
  return isoToDayNum(iso) - isoToDayNum(file.start);
}

function padTo(arr, len) {
  while (arr.length < len) arr.push(null);
}

function eachScopeFuels(file, fn) {
  ensureScopes(file);
  const seen = new Set();
  for (const sc of SCOPES) {
    const fuels = file.scopes[sc];
    if (!fuels || seen.has(fuels)) continue;
    seen.add(fuels);
    fn(fuels, sc);
  }
  if (file.fuels && !seen.has(file.fuels)) fn(file.fuels, file.defaultScope || 'metro');
}

function ensureDay(file, iso) {
  ensureScopes(file);

  if (!file.start) {
    file.start = iso;
    eachScopeFuels(file, (fuels) => {
      for (const f of FUELS) {
        fuels[f] = emptyFuelSeries(1);
      }
    });
    file.days = 1;
    syncPrimaryFuels(file);
    return 0;
  }

  let idx = indexOfDay(file, iso);
  if (idx < 0) {
    const shift = -idx;
    eachScopeFuels(file, (fuels) => {
      for (const f of FUELS) {
        const s = fuels[f];
        ensureExtraSeries(s);
        s.avg = new Array(shift).fill(null).concat(s.avg);
        s.gmean = new Array(shift).fill(null).concat(s.gmean || []);
        s.mode = new Array(shift).fill(null).concat(s.mode || []);
        s.med = new Array(shift).fill(null).concat(s.med);
        s.min = new Array(shift).fill(null).concat(s.min);
        s.max = new Array(shift).fill(null).concat(s.max);
        s.n = new Array(shift).fill(null).concat(s.n);
      }
    });
    file.start = iso;
    file.days = (file.days || 0) + shift;
    idx = 0;
  }

  const need = idx + 1;
  eachScopeFuels(file, (fuels) => {
    for (const f of FUELS) {
      const s = fuels[f];
      ensureExtraSeries(s);
      padTo(s.avg, need);
      padTo(s.gmean, need);
      padTo(s.mode, need);
      padTo(s.med, need);
      padTo(s.min, need);
      padTo(s.max, need);
      padTo(s.n, need);
    }
  });
  file.days = Math.max(file.days || 0, need);
  return idx;
}

function resolveScope(file, scope) {
  ensureScopes(file);
  if (scope && SCOPES.includes(scope)) return scope;
  return file.defaultScope || 'metro';
}

function fuelsFor(file, scope) {
  const sc = resolveScope(file, scope);
  return file.scopes[sc];
}

function getDay(file, fuel, iso, scope) {
  const idx = indexOfDay(file, iso);
  if (idx < 0 || idx >= file.days) return null;
  const fuels = fuelsFor(file, scope);
  const s = fuels?.[fuel];
  if (!s || s.avg[idx] === null || s.avg[idx] === undefined) return null;
  return {
    avg: s.avg[idx],
    gmean: s.gmean?.[idx] ?? null,
    mode: s.mode?.[idx] ?? null,
    med: s.med?.[idx] ?? null,
    min: s.min[idx],
    max: s.max[idx],
    n: s.n[idx],
  };
}

function isSlotEmpty(file, fuel, iso, scope) {
  return getDay(file, fuel, iso, scope) === null;
}

function setDay(file, fuel, iso, reading, scope) {
  const sc = resolveScope(file, scope);
  const idx = ensureDay(file, iso);
  const s = file.scopes[sc][fuel];
  ensureExtraSeries(s);
  s.avg[idx] = reading.avg;
  s.gmean[idx] = reading.gmean != null ? reading.gmean : null;
  s.mode[idx] = reading.mode != null ? reading.mode : null;
  s.med[idx] = reading.med != null ? reading.med : null;
  s.min[idx] = reading.min;
  s.max[idx] = reading.max;
  s.n[idx] = reading.n;
  syncPrimaryFuels(file);
}

function setGmean(file, fuel, iso, gmean, scope) {
  if (gmean == null || !Number.isFinite(gmean)) return;
  const sc = resolveScope(file, scope);
  const idx = ensureDay(file, iso);
  const s = file.scopes[sc][fuel];
  ensureExtraSeries(s);
  s.gmean[idx] = gmean;
  syncPrimaryFuels(file);
}

function setMode(file, fuel, iso, modeVal, scope) {
  const sc = resolveScope(file, scope);
  const idx = ensureDay(file, iso);
  const s = file.scopes[sc][fuel];
  ensureExtraSeries(s);
  if (modeVal == null || !Number.isFinite(modeVal)) {
    s.mode[idx] = null;
  } else {
    s.mode[idx] = modeVal;
  }
  syncPrimaryFuels(file);
}

function trailing(file, fuel, iso, days, scope) {
  const out = [];
  if (!file.start) return out;
  const end = isoToDayNum(iso) - 1;
  for (let d = end; d > end - days; d--) {
    const v = getDay(file, fuel, dayNumToISO(d), scope);
    if (v) out.push(v);
  }
  return out;
}

function trailingMedian(file, fuel, iso, days, key, scope) {
  const vals = trailing(file, fuel, iso, days, scope)
    .map((v) => v[key])
    .filter((v) => typeof v === 'number');
  return vals.length ? median(vals) : null;
}

function roll(docsDir, file, todayIso) {
  if (!file.start) return;
  ensureScopes(file);
  const keepFrom = isoToDayNum(todayIso) - (WINDOW_DAYS - 1);
  const startNum = isoToDayNum(file.start);
  const drop = keepFrom - startNum;
  if (drop <= 0) return;

  const archived = {};
  const primary = file.scopes[file.defaultScope] || file.fuels;
  for (let i = 0; i < Math.min(drop, file.days); i++) {
    const iso = dayNumToISO(startNum + i);
    const month = iso.slice(0, 7);
    archived[month] = archived[month] || {};
    for (const f of FUELS) {
      const s = primary[f];
      if (!s || s.avg[i] === null || s.avg[i] === undefined) continue;
      archived[month][f] = archived[month][f] || {};
      archived[month][f][iso] = {
        avg: s.avg[i],
        gmean: s.gmean?.[i] ?? null,
        mode: s.mode?.[i] ?? null,
        med: s.med?.[i] ?? null,
        min: s.min[i],
        max: s.max[i],
        n: s.n[i],
      };
    }
  }

  for (const [month, byFuel] of Object.entries(archived)) {
    const p = archivePath(docsDir, month);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, 'utf8'))
      : { v: SCHEMA, month, states: {} };
    existing.states[file.state] = existing.states[file.state] || {};
    for (const [fuel, days] of Object.entries(byFuel)) {
      existing.states[file.state][fuel] = {
        ...(existing.states[file.state][fuel] || {}),
        ...days,
      };
    }
    fs.writeFileSync(p, JSON.stringify(existing) + '\n');
  }

  eachScopeFuels(file, (fuels) => {
    for (const f of FUELS) {
      const s = fuels[f];
      ensureExtraSeries(s);
      s.avg = s.avg.slice(drop);
      s.gmean = (s.gmean || []).slice(drop);
      s.mode = (s.mode || []).slice(drop);
      s.med = s.med.slice(drop);
      s.min = s.min.slice(drop);
      s.max = s.max.slice(drop);
      s.n = s.n.slice(drop);
    }
  });
  file.start = dayNumToISO(startNum + drop);
  file.days = Math.max(0, file.days - drop);
  syncPrimaryFuels(file);
}

module.exports = {
  WINDOW_DAYS,
  SCHEMA,
  SCOPES,
  emptyState,
  emptyFuels,
  load,
  save,
  statePath,
  getDay,
  setDay,
  setGmean,
  setMode,
  isSlotEmpty,
  ensureDay,
  ensureScopes,
  fuelsFor,
  resolveScope,
  pickDefaultScope,
  syncPrimaryFuels,
  trailing,
  trailingMedian,
  roll,
};
