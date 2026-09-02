'use strict';

// Stations where E10 is more than N% below U91 at the same site.
// Usage: node --env-file=.env data/seed/e10-vs-u91.js [qld|sa] [threshold%]

const SOURCES = {
  qld: () => require('../lib/sources/fuelpricesqld'),
  sa: () => require('../lib/sources/safpis'),
};

const stateKey = (process.argv[2] || 'qld').toLowerCase();
const THRESHOLD = Number(process.argv[3] || 3) / 100;

async function main() {
  const src = SOURCES[stateKey];
  if (!src) throw new Error(`unknown state key: ${stateKey}`);

  const adapter = src();
  const snap = await adapter.fetchStations();
  const both = snap.stations.filter((s) => s.prices.U91 != null && s.prices.E10 != null);
  const hits = [];

  for (const s of both) {
    const u91C = s.prices.U91 / 10;
    const e10C = s.prices.E10 / 10;
    const pct = (u91C - e10C) / u91C;
    if (pct > THRESHOLD) {
      hits.push({
        name: s.name,
        brand: s.brand,
        address: s.address,
        postcode: s.postcode,
        suburb: s.suburb,
        u91: u91C,
        e10: e10C,
        savePct: Math.round(pct * 1000) / 10,
        saveC: Math.round((u91C - e10C) * 10) / 10,
      });
    }
  }

  hits.sort((a, b) => b.savePct - a.savePct);

  console.log(`${adapter.NAME}: ${snap.stations.length} stations, ${both.length} with both U91 and E10`);
  console.log(`E10 more than ${THRESHOLD * 100}% below U91: ${hits.length}`);

  for (const h of hits.slice(0, 20)) {
    console.log(
      `${h.savePct}% (${h.saveC}c)  U91 ${h.u91}c  E10 ${h.e10}c  ${h.brand}  ${h.name}  ${h.address} ${h.postcode || ''}`
    );
  }
  if (hits.length > 20) console.log(`... and ${hits.length - 20} more`);

  const rows = both
    .map((s) => {
      const u91C = s.prices.U91 / 10;
      const e10C = s.prices.E10 / 10;
      return { pct: ((u91C - e10C) / u91C) * 100, u91C, e10C, brand: s.brand, name: s.name };
    })
    .sort((a, b) => b.pct - a.pct);

  if (rows.length) {
    console.log('\n--- distribution ---');
    console.log(`E10 cheaper than U91: ${rows.filter((r) => r.pct > 0).length} / ${rows.length}`);
    console.log(`>2% cheaper: ${rows.filter((r) => r.pct > 2).length}`);
    console.log(`>3% cheaper: ${rows.filter((r) => r.pct > 3).length}`);
    console.log(`>4% cheaper: ${rows.filter((r) => r.pct > 4).length}`);
    if (rows[0]) {
      console.log(
        `max discount: ${rows[0].pct.toFixed(2)}%  U91 ${rows[0].u91C}  E10 ${rows[0].e10C}  ${rows[0].brand} ${rows[0].name}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
