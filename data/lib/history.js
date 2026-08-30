'use strict';

// Read/modify/write for the published per-state files, plus the rolling window
// and monthly archive.
//
// Layout choice: one file per state so the phone downloads only what it needs.
// Prices are integers in tenths of a cent (2056 means 205.6 c/L) to keep the
// JSON compact and free of float noise.

const fs = require('fs');
const path = require('path');
const { FUELS } = require('./fuels');
const { isoToDayNum, dayNumToISO, median } = require('./cyclefit');

const WINDOW_DAYS = 60;
const SCHEMA = 1;

function statePath(docsDir, state) {
  return path.join(docsDir, 'v1', `${state}.json`);
}

function archivePath(docsDir, month) {
  return path.join(docsDir, 'v1', 'archive', `${month}.json`);
}

function emptyState(state) {
  const fuels = {};
  for (const f of FUELS) fuels[f] = { avg: [], min: [], max: [], n: [] };
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
    rejects: {},
  };
}

function load(docsDir, state) {
  const p = statePath(docsDir, state);
  if (!fs.existsSync(p)) return emptyState(state);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Tolerate a fuel being added to the canonical list after the file was created.
  for (const f of FUELS) {
    if (!parsed.fuels[f]) parsed.fuels[f] = { avg: [], min: [], max: [], n: [] };
  }
  return parsed;
}

// Returns true only when something substantive changed. The freshness stamps are
// excluded from the comparison on purpose: they move on every run, and letting
// them force a write would mean a commit every single day even when the source
// had nothing new to say.
function save(docsDir, file) {
  const p = statePath(docsDir, file.state);
  fs.mkdirSync(path.dirname(p), { recursive: true });

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

  // Not pretty-printed: at 60 days the series arrays hold ~1400 numbers, and one
  // per line would roughly double what the phone downloads. Commit diffs become
  // single-line, which is an acceptable trade on a machine-read data branch.
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

// Grow the arrays so that `iso` has a slot, extending forwards or backwards.
function ensureDay(file, iso) {
  if (!file.start) {
    file.start = iso;
    for (const f of FUELS) {
      file.fuels[f].avg = [null];
      file.fuels[f].min = [null];
      file.fuels[f].max = [null];
      file.fuels[f].n = [null];
    }
    file.days = 1;
    return 0;
  }

  let idx = indexOfDay(file, iso);
  if (idx < 0) {
    // Backfilling before the current start: shift everything right.
    const shift = -idx;
    for (const f of FUELS) {
      const s = file.fuels[f];
      s.avg = new Array(shift).fill(null).concat(s.avg);
      s.min = new Array(shift).fill(null).concat(s.min);
      s.max = new Array(shift).fill(null).concat(s.max);
      s.n = new Array(shift).fill(null).concat(s.n);
    }
    file.start = iso;
    idx = 0;
  }

  const need = idx + 1;
  for (const f of FUELS) {
    padTo(file.fuels[f].avg, need);
    padTo(file.fuels[f].min, need);
    padTo(file.fuels[f].max, need);
    padTo(file.fuels[f].n, need);
  }
  file.days = Math.max(file.days || 0, need);
  return idx;
}

function getDay(file, fuel, iso) {
  const idx = indexOfDay(file, iso);
  if (idx < 0 || idx >= file.days) return null;
  const s = file.fuels[fuel];
  if (!s || s.avg[idx] === null || s.avg[idx] === undefined) return null;
  return { avg: s.avg[idx], min: s.min[idx], max: s.max[idx], n: s.n[idx] };
}

function isSlotEmpty(file, fuel, iso) {
  return getDay(file, fuel, iso) === null;
}

function setDay(file, fuel, iso, reading) {
  const idx = ensureDay(file, iso);
  const s = file.fuels[fuel];
  s.avg[idx] = reading.avg;
  s.min[idx] = reading.min;
  s.max[idx] = reading.max;
  s.n[idx] = reading.n;
}

// Trailing values for a fuel, most recent first, skipping gaps. Used by the
// sanity gates to compare a new reading against what the feed has been saying.
function trailing(file, fuel, iso, days) {
  const out = [];
  if (!file.start) return out;
  const end = isoToDayNum(iso) - 1;
  for (let d = end; d > end - days; d--) {
    const v = getDay(file, fuel, dayNumToISO(d));
    if (v) out.push(v);
  }
  return out;
}

function trailingMedian(file, fuel, iso, days, key) {
  const vals = trailing(file, fuel, iso, days)
    .map((v) => v[key])
    .filter((v) => typeof v === 'number');
  return vals.length ? median(vals) : null;
}

// Drop days that have fallen out of the rolling window, writing them to a
// monthly archive first so long-term cycle statistics keep improving even
// though the published file stays small.
function roll(docsDir, file, todayIso) {
  if (!file.start) return;
  const keepFrom = isoToDayNum(todayIso) - (WINDOW_DAYS - 1);
  const startNum = isoToDayNum(file.start);
  const drop = keepFrom - startNum;
  if (drop <= 0) return;

  const archived = {};
  for (let i = 0; i < Math.min(drop, file.days); i++) {
    const iso = dayNumToISO(startNum + i);
    const month = iso.slice(0, 7);
    archived[month] = archived[month] || {};
    for (const f of FUELS) {
      const s = file.fuels[f];
      if (s.avg[i] === null || s.avg[i] === undefined) continue;
      archived[month][f] = archived[month][f] || {};
      archived[month][f][iso] = { avg: s.avg[i], min: s.min[i], max: s.max[i], n: s.n[i] };
    }
  }

  for (const [month, byFuel] of Object.entries(archived)) {
    const p = archivePath(docsDir, month);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { v: SCHEMA, month, states: {} };
    existing.states[file.state] = existing.states[file.state] || {};
    for (const [fuel, days] of Object.entries(byFuel)) {
      existing.states[file.state][fuel] = { ...(existing.states[file.state][fuel] || {}), ...days };
    }
    fs.writeFileSync(p, JSON.stringify(existing) + '\n');
  }

  for (const f of FUELS) {
    const s = file.fuels[f];
    s.avg = s.avg.slice(drop);
    s.min = s.min.slice(drop);
    s.max = s.max.slice(drop);
    s.n = s.n.slice(drop);
  }
  file.start = dayNumToISO(startNum + drop);
  file.days = Math.max(0, file.days - drop);
}

module.exports = {
  WINDOW_DAYS,
  SCHEMA,
  load,
  save,
  statePath,
  getDay,
  setDay,
  isSlotEmpty,
  ensureDay,
  trailing,
  trailingMedian,
  roll,
};
