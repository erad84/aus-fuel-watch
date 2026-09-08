'use strict';

// Enrich NSW/ACT station catalog coordinates.
// 1) Copy lat/lng from live FuelCheck catalog entries matched by name+postcode
//    (fallback: address+postcode).
// 2) Geocode remaining addresses via OpenStreetMap Nominatim (optional).
//
//   node data/seed/enrich-catalog-coords.js
//   DOCS_DIR=./docs node data/seed/enrich-catalog-coords.js --dry-run
//   DOCS_DIR=./docs node data/seed/enrich-catalog-coords.js --no-geocode

const fs = require('fs');
const path = require('path');
const stationHistory = require('../lib/stationHistory');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const dryRun = process.argv.includes('--dry-run');
const noGeocode = process.argv.includes('--no-geocode');
const STATES = process.argv.includes('--states')
  ? process.argv[process.argv.indexOf('--states') + 1].split(',').map((s) => s.trim().toUpperCase())
  : ['NSW', 'ACT'];

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'AusFuelWatch/1.0 (catalog coord enrich; local batch)';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function tokenScore(a, b) {
  const ta = new Set(
    String(a || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
  const tb = new Set(
    String(b || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function hasCoords(s) {
  return s && typeof s.lat === 'number' && typeof s.lng === 'number' && Number.isFinite(s.lat) && Number.isFinite(s.lng);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geocodeAddress(address, postcode) {
  const q = [address, postcode, 'Australia'].filter(Boolean).join(', ');
  if (!q || q.length < 8) return null;
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  if (!Array.isArray(body) || !body[0]) return null;
  const lat = Number(body[0].lat);
  const lng = Number(body[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, source: 'nominatim' };
}

function buildLiveIndexes(stations) {
  const byNamePc = new Map();
  const byAddrPc = new Map();
  for (const [id, s] of Object.entries(stations)) {
    if (!id.startsWith('fuelcheck:')) continue;
    if (!hasCoords(s)) continue;
    const pc = s.postcode != null ? Number(s.postcode) : null;
    const nk = `${pc}|${norm(s.name)}`;
    const ak = `${pc}|${norm(s.address)}`;
    if (!byNamePc.has(nk)) byNamePc.set(nk, []);
    byNamePc.get(nk).push({ id, s });
    if (norm(s.address)) {
      if (!byAddrPc.has(ak)) byAddrPc.set(ak, []);
      byAddrPc.get(ak).push({ id, s });
    }
  }
  return { byNamePc, byAddrPc };
}

function pickBest(candidates, archive) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const score = tokenScore(archive.address, c.s.address) * 2 + tokenScore(archive.name, c.s.name);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function matchLive(archive, indexes) {
  const pc = archive.postcode != null ? Number(archive.postcode) : null;
  const nk = `${pc}|${norm(archive.name)}`;
  let hits = indexes.byNamePc.get(nk) || [];
  if (hits.length) return { hit: pickBest(hits, archive), how: hits.length === 1 ? 'name+pc' : 'name+pc-ambig' };
  const ak = `${pc}|${norm(archive.address)}`;
  hits = indexes.byAddrPc.get(ak) || [];
  if (hits.length) return { hit: pickBest(hits, archive), how: hits.length === 1 ? 'addr+pc' : 'addr+pc-ambig' };
  return { hit: null, how: null };
}

async function enrichState(state) {
  const catalog = stationHistory.loadCatalog(DOCS_DIR, state);
  const stations = catalog.stations || {};
  const indexes = buildLiveIndexes(stations);

  let matched = 0;
  let geocoded = 0;
  let skipped = 0;
  let stillMissing = 0;
  const howCounts = {};

  const needGeocode = [];

  for (const [id, s] of Object.entries(stations)) {
    if (hasCoords(s)) {
      skipped++;
      continue;
    }
    if (!id.startsWith('archive:')) {
      stillMissing++;
      continue;
    }

    const { hit, how } = matchLive(s, indexes);
    if (hit) {
      s.lat = hit.s.lat;
      s.lng = hit.s.lng;
      s.coordSource = `live:${hit.id}`;
      matched++;
      howCounts[how] = (howCounts[how] || 0) + 1;
      continue;
    }
    needGeocode.push(id);
  }

  if (!noGeocode && needGeocode.length) {
    console.log(`  ${state}: geocoding ${needGeocode.length} leftover(s)…`);
    for (const id of needGeocode) {
      const s = stations[id];
      try {
        const g = await geocodeAddress(s.address || `${s.name} ${s.suburb || ''}`, s.postcode);
        await sleep(1100);
        if (g) {
          s.lat = g.lat;
          s.lng = g.lng;
          s.coordSource = g.source;
          geocoded++;
        } else {
          stillMissing++;
        }
      } catch (err) {
        console.log(`    geocode fail ${id}: ${err.message}`);
        stillMissing++;
        await sleep(1100);
      }
    }
  } else {
    stillMissing += needGeocode.length;
  }

  const withLl = Object.values(stations).filter(hasCoords).length;
  if (!dryRun) {
    catalog.stations = stations;
    stationHistory.saveCatalog(DOCS_DIR, state, catalog);
  }

  console.log(
    `  ${state}: matched ${matched} ${JSON.stringify(howCounts)}, geocoded ${geocoded}, ` +
      `still missing ${stillMissing}, coverage ${withLl}/${Object.keys(stations).length}` +
      (dryRun ? ' (dry run)' : '')
  );
  return { matched, geocoded, stillMissing, withLl, total: Object.keys(stations).length };
}

async function main() {
  console.log(`enrich-catalog-coords → ${DOCS_DIR}${dryRun ? ' (dry run)' : ''}${noGeocode ? ' (no geocode)' : ''}`);
  for (const state of STATES) {
    const p = path.join(stationHistory.stationsRoot(DOCS_DIR), state, 'catalog.json');
    if (!fs.existsSync(p)) {
      console.log(`  ${state}: no catalog`);
      continue;
    }
    await enrichState(state);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
