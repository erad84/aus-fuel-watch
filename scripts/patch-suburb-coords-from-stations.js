#!/usr/bin/env node
/**
 * Patch au-suburbs lat/lng using station name matches (catalog suburb is often empty)
 * and sibling-aware exclusion (PENRITH vs SOUTH PENRITH / PENRITH SOUTH).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const states = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

function loadSuburbs() {
  const src = fs.readFileSync(path.join(root, 'viewer/au-suburbs-data.js'), 'utf8');
  const i = src.indexOf('{');
  const j = src.lastIndexOf('}');
  return JSON.parse(src.slice(i, j + 1));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatchesSuburb(stationName, suburb, siblings) {
  const name = String(stationName || '').toUpperCase();
  const sub = String(suburb || '').toUpperCase();
  if (!sub || !name) return false;
  if (!new RegExp('\\b' + escapeRe(sub).replace(/\s+/g, '\\s+') + '\\b').test(name)) return false;
  for (const sib of siblings) {
    const s = String(sib || '').toUpperCase();
    if (!s || s === sub || s.length <= sub.length) continue;
    if (new RegExp('\\b' + escapeRe(s).replace(/\s+/g, '\\s+') + '\\b').test(name)) return false;
  }
  return true;
}

function loadStationsByState() {
  const out = {};
  for (const st of states) {
    const p = path.join(root, 'docs/v1/stations', st, 'catalog.json');
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    out[st] = Object.values(raw.stations || raw);
  }
  return out;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

const data = loadSuburbs();
const byState = loadStationsByState();

/** siblings per STATE|POSTCODE */
const siblingsByPc = new Map();
for (const row of data.suburbs || []) {
  const key = String(row.st).toUpperCase() + '|' + String(row.p).padStart(4, '0');
  if (!siblingsByPc.has(key)) siblingsByPc.set(key, []);
  siblingsByPc.get(key).push(String(row.s).toUpperCase());
}

let patched = 0;
const samples = [];

for (const row of data.suburbs || []) {
  const st = String(row.st || '').toUpperCase();
  const sub = String(row.s || '').toUpperCase();
  const pc = String(row.p || '').padStart(4, '0');
  const stations = byState[st] || [];
  const siblings = siblingsByPc.get(st + '|' + pc) || [sub];
  let n = 0;
  let lat = 0;
  let lng = 0;
  for (const meta of stations) {
    if (!meta || meta.lat == null || meta.lng == null) continue;
    const metaSub = String(meta.suburb || '').trim().toUpperCase();
    const match =
      metaSub === sub ||
      nameMatchesSuburb(meta.name, sub, siblings) ||
      (metaSub && nameMatchesSuburb(metaSub, sub, siblings));
    if (!match) continue;
    /* Prefer same postcode when available */
    if (meta.postcode != null && String(meta.postcode).padStart(4, '0') !== pc) continue;
    const a = Number(meta.lat);
    const b = Number(meta.lng);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    n += 1;
    lat += a;
    lng += b;
  }
  if (n < 1) continue;
  const nextLat = round4(lat / n);
  const nextLng = round4(lng / n);
  const oldLat = Number(row.lat);
  const oldLng = Number(row.lng);
  const moved =
    !Number.isFinite(oldLat) ||
    !Number.isFinite(oldLng) ||
    Math.hypot(oldLat - nextLat, oldLng - nextLng) > 0.002;
  row.lat = nextLat;
  row.lng = nextLng;
  patched++;
  if (moved && samples.length < 15) {
    samples.push({ suburb: row.s, postcode: row.p, state: row.st, from: [oldLat, oldLng], to: [nextLat, nextLng], n });
  }
}

data.v = (Number(data.v) || 1) + 1;
data.source =
  'schappim/australian-postcodes + station-name centroids (sibling-aware)';
data.note = 's=suburb p=postcode st=state';
data.patchedAt = new Date().toISOString();
data.patchedCount = patched;

const json = JSON.stringify(data);
fs.writeFileSync(path.join(root, 'viewer/au-suburbs-data.js'), 'window.AFW_SUBURBS=' + json + ';\n');
fs.writeFileSync(path.join(root, 'viewer/au-suburbs.json'), json);
fs.mkdirSync(path.join(root, 'docs/v1'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/v1/au-suburbs.json'), json);

console.log('patched', patched, 'total', (data.suburbs || []).length);
console.log('samples', JSON.stringify(samples, null, 2));
for (const name of ['PENRITH', 'EMU PLAINS', 'SOUTH PENRITH', 'JAMISONTOWN']) {
  console.log(name, (data.suburbs || []).find((r) => r.s === name && r.st === 'NSW'));
}
