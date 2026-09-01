'use strict';

// Fetches one source and prints its coverage and aggregates, so an adapter can
// be checked against reality before it is wired into the collector.
//
// Usage: node --env-file=.env data/seed/verify-source.js fuelcheck

const { aggregate } = require('../lib/aggregate');
const { metroOf, CAPITALS } = require('../lib/regions');
const { FUELS } = require('../lib/fuels');

const SOURCES = {
  fuelcheck: () => require('../lib/sources/fuelcheck'),
  fuelwatch: () => require('../lib/sources/fuelwatch'),
  myfuelnt: () => require('../lib/sources/myfuelnt'),
  safpis: () => require('../lib/sources/safpis'),
  fuelpricesqld: () => require('../lib/sources/fuelpricesqld'),
};

function c(tenths) {
  return tenths === null || tenths === undefined ? '-' : (tenths / 10).toFixed(1);
}

async function main() {
  const name = process.argv[2] || 'fuelcheck';
  const load = SOURCES[name];
  if (!load) {
    console.error(`unknown source: ${name}. Known: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }

  const snap = await load().fetchStations();
  console.log(`source: ${snap.source}`);
  console.log(`licence: ${snap.licence}`);
  for (const n of snap.notes || []) console.log(`  note: ${n}`);
  console.log(`stations with prices: ${snap.stations.length}\n`);

  const byState = {};
  const metroCount = {};
  let noCoords = 0;
  for (const s of snap.stations) {
    byState[s.state] = (byState[s.state] || 0) + 1;
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') noCoords++;
    const inMetro =
      typeof s.metro === 'boolean' ? s.metro : metroOf(s.lat, s.lng, s.state) === s.state;
    if (inMetro) metroCount[s.state] = (metroCount[s.state] || 0) + 1;
  }

  console.log('jurisdiction  stations  in metro  capital');
  for (const [st, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${st.padEnd(4)} ${String(n).padStart(9)} ${String(metroCount[st] || 0).padStart(9)}   ${
        CAPITALS[st] ? CAPITALS[st].name : '?'
      }`
    );
  }
  if (noCoords) console.log(`  (${noCoords} stations missing coordinates)`);

  const agg = aggregate(snap.stations);
  console.log('\n--- aggregates, cents per litre ---');
  console.log('state scope  fuel   n     avg    med    p10    min    max');
  for (const [state, scopes] of Object.entries(agg)) {
    for (const scope of ['state', 'metro']) {
      for (const fuel of FUELS) {
        const s = scopes[scope][fuel];
        if (!s) continue;
        console.log(
          `${state.padEnd(5)} ${scope.padEnd(6)} ${fuel.padEnd(5)} ${String(s.n).padStart(5)} ${c(
            s.avg
          ).padStart(6)} ${c(s.med).padStart(6)} ${c(s.p10).padStart(6)} ${c(s.min).padStart(
            6
          )} ${c(s.max).padStart(6)}`
        );
      }
    }
  }

  // The headline check for the pivot: does the capital differ from the state?
  console.log('\n--- metro vs state-wide gap (U91) ---');
  for (const [state, scopes] of Object.entries(agg)) {
    const st = scopes.state.U91;
    const me = scopes.metro.U91;
    if (!st || !me) continue;
    console.log(
      `  ${state.padEnd(4)} state ${c(st.avg)}c (n=${st.n})  metro ${c(me.avg)}c (n=${
        me.n
      })  gap ${((me.avg - st.avg) / 10).toFixed(1)}c`
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
