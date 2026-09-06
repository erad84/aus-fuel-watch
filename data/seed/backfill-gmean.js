'use strict';

// Rebuild metro / regional / statewide series (incl. gmean + mode) from station
// day shards. Overwrites existing scope slots when recomputed.
//
//   node data/seed/backfill-gmean.js
//   DOCS_DIR=./docs node data/seed/backfill-gmean.js --dry-run

const fs = require('fs');
const path = require('path');
const history = require('../lib/history');
const stationHistory = require('../lib/stationHistory');
const { summarise } = require('../lib/aggregate');
const { metroOf } = require('../lib/regions');
const { FUELS } = require('../lib/fuels');
const { STATES } = require('../lib/states');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const dryRun = process.argv.includes('--dry-run');

function stationInMetro(meta, state) {
  if (!meta) return false;
  if (typeof meta.metro === 'boolean') return meta.metro;
  if (meta.lat != null && meta.lng != null) {
    return metroOf(Number(meta.lat), Number(meta.lng), state) === state;
  }
  return false;
}

function pricesByScope(dayFile, catalog, state, fuel) {
  const map = stationHistory.dayToMap(dayFile);
  const stations = catalog?.stations || {};
  const all = [];
  const metro = [];
  const regional = [];
  for (const [id, prices] of map) {
    const v = prices?.[fuel];
    if (typeof v !== 'number' || !(v > 0)) continue;
    all.push(v);
    if (stationInMetro(stations[id], state)) metro.push(v);
    else regional.push(v);
  }
  return { state: all, metro, regional };
}

function main() {
  console.log(`recompute scopes → ${DOCS_DIR}${dryRun ? ' (dry run)' : ''}`);
  let changed = 0;

  for (const state of STATES) {
    const daysDir = path.join(stationHistory.stationsRoot(DOCS_DIR), state, 'days');
    if (!fs.existsSync(daysDir)) {
      console.log(`  ${state}: no station days`);
      continue;
    }
    const file = history.load(DOCS_DIR, state);
    const catalog = stationHistory.loadCatalog(DOCS_DIR, state);
    let stateChanged = 0;
    const counts = { metro: 0, regional: 0, state: 0 };

    for (const name of fs.readdirSync(daysDir)) {
      if (!name.endsWith('.json')) continue;
      const iso = name.slice(0, -5);
      const day = stationHistory.loadDay(DOCS_DIR, state, iso);
      if (!day) continue;

      for (const fuel of FUELS) {
        const byScope = pricesByScope(day, catalog, state, fuel);
        for (const scope of history.SCOPES) {
          const prices = byScope[scope];
          if (!prices || !prices.length) continue;
          const stats = summarise(prices);
          if (!stats) continue;
          const existing = history.getDay(file, fuel, iso, scope);
          const same =
            existing &&
            existing.avg === stats.avg &&
            existing.gmean === stats.gmean &&
            existing.mode === stats.mode &&
            existing.med === stats.med &&
            existing.min === stats.min &&
            existing.max === stats.max &&
            existing.n === stats.n;
          if (same) continue;
          if (!dryRun) {
            history.setDay(
              file,
              fuel,
              iso,
              {
                avg: stats.avg,
                gmean: stats.gmean,
                mode: stats.mode,
                med: stats.med,
                min: stats.min,
                max: stats.max,
                n: stats.n,
              },
              scope
            );
          }
          stateChanged++;
          changed++;
          counts[scope]++;
        }
      }
    }

    if (stateChanged && !dryRun) {
      const hasMetro = (file.scopes.metro?.U91?.avg || []).some((v) => v != null);
      file.defaultScope = hasMetro ? 'metro' : 'state';
      history.syncPrimaryFuels(file);
      file.generated = new Date().toISOString();
      history.save(DOCS_DIR, file);
    }
    console.log(
      `  ${state}: Δ ${stateChanged} (metro ${counts.metro}, regional ${counts.regional}, state ${counts.state})`
    );
  }

  console.log(`\n${dryRun ? 'would change' : 'changed'} ${changed} scope slot(s)`);
}

main();
