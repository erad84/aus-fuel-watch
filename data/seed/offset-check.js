'use strict';

// Measures the level offset between the seed provider and the collector's own
// source, by comparing the last day of the seed workbook against the first day
// we collected. Cycle timing is level-independent so a constant offset is
// harmless, but a large one means the two sources are measuring different
// station populations and the seeded p10/p90 offsets should be treated with
// more caution for that state.
//
// Usage: node data/seed/offset-check.js [path/to/workbook.xlsx]

const fs = require('fs');
const path = require('path');
const xlsx = require('../lib/xlsx');
const history = require('../lib/history');
const { FROM_SEED_SHEET } = require('../lib/fuels');
const { STATES } = require('../lib/states');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const CANDIDATES = [
  process.argv[2],
  path.join(__dirname, 'Fuel seed data.xlsx'),
  path.join(__dirname, '..', '..', '..', 'Fuel seed data.xlsx'),
].filter(Boolean);

const wbPath = CANDIDATES.find((c) => fs.existsSync(c));
if (!wbPath) throw new Error('workbook not found');

const book = xlsx.open(wbPath);

// Last value of each seed series, keyed STATE/FUEL.
const seedLast = new Map();
for (const name of book.sheetNames()) {
  const sp = name.indexOf(' ');
  if (sp === -1) continue;
  const state = name.slice(0, sp).toUpperCase();
  const fuel = FROM_SEED_SHEET[name.slice(sp + 1).trim().toUpperCase()];
  if (!STATES.includes(state) || !fuel) continue;

  let last = null;
  for (const r of book.rows(name)) {
    if (typeof r.A !== 'number') continue;
    const cents = xlsx.parseCents(r.B);
    if (cents === null) continue;
    last = { date: xlsx.serialToISO(r.A), cents };
  }
  if (last) seedLast.set(`${state}/${fuel}`, last);
}

console.log('state fuel   seed date    seed    collected date  collected  offset');
const offsets = [];
for (const state of STATES) {
  const file = history.load(DOCS_DIR, state);
  if (!file.start) {
    console.log(`${state.padEnd(4)} (nothing collected yet)`);
    continue;
  }
  for (const fuel of ['U91', 'E10', 'P95', 'P98', 'DSL']) {
    const seed = seedLast.get(`${state}/${fuel}`);
    const got = history.getDay(file, fuel, file.start);
    if (!seed || !got) continue;
    const offset = got.avg / 10 - seed.cents;
    offsets.push({ state, fuel, offset });
    console.log(
      [
        state.padEnd(4),
        fuel.padEnd(5),
        seed.date,
        seed.cents.toFixed(1).padStart(7),
        '   ' + file.start,
        (got.avg / 10).toFixed(1).padStart(10),
        (offset >= 0 ? '+' : '') + offset.toFixed(1).padStart(6),
      ].join(' ')
    );
  }
}

if (offsets.length) {
  const sorted = offsets.map((o) => o.offset).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const worst = offsets.reduce((m, o) => (Math.abs(o.offset) > Math.abs(m.offset) ? o : m));
  console.log(`\nmedian offset ${med.toFixed(1)}c across ${offsets.length} series`);
  console.log(`largest ${worst.state}/${worst.fuel} at ${worst.offset.toFixed(1)}c`);
}
