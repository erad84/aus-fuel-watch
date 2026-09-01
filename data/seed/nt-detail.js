'use strict';

// NT specifics that the generic verifier does not cover: the site's own region
// grouping, and whether PriceScheduled (the next 24-hour lock window) actually
// differs from the current price.
//
// Usage: node data/seed/nt-detail.js

const nt = require('../lib/sources/myfuelnt');

async function main() {
  const snap = await nt.fetchStations();
  for (const n of snap.notes) console.log(`note: ${n}`);

  const byRegion = {};
  let withScheduled = 0;
  let differing = 0;
  const examples = [];
  let noCoords = 0;
  let noPostcode = 0;

  for (const s of snap.stations) {
    const k = s.region || 'unknown';
    if (!byRegion[k]) byRegion[k] = { n: 0, metro: 0 };
    byRegion[k].n++;
    if (s.metro) byRegion[k].metro++;
    if (s.lat === null || s.lng === null) noCoords++;
    if (s.postcode === null) noPostcode++;

    if (s.scheduled) {
      withScheduled++;
      const a = s.prices.U91;
      const b = s.scheduled.U91;
      if (a && b && a !== b) {
        differing++;
        if (examples.length < 8) {
          examples.push(`${s.name} (${s.suburb}): now ${(a / 10).toFixed(1)}c, next ${(b / 10).toFixed(1)}c`);
        }
      }
    }
  }

  console.log('\nregion                 stations  in Greater Darwin');
  for (const [r, v] of Object.entries(byRegion).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${r.padEnd(20)} ${String(v.n).padStart(6)} ${String(v.metro).padStart(14)}`);
  }
  console.log(`\nmissing coordinates: ${noCoords}, missing postcode: ${noPostcode}`);
  console.log(`with a scheduled next-window price: ${withScheduled}`);
  console.log(`whose scheduled U91 differs from current: ${differing}`);
  for (const e of examples) console.log(`  ${e}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
