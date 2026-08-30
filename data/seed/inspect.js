'use strict';

// Scratch diagnostic: print a single seed series with day-over-day deltas so the
// shape of a state-wide average can be eyeballed against the detector's output.
//
// Usage: node data/seed/inspect.js "VIC U91" [path/to/workbook.xlsx]

const fs = require('fs');
const path = require('path');
const xlsx = require('../lib/xlsx');

const sheetName = process.argv[2] || 'VIC U91';
const CANDIDATES = [
  process.argv[3],
  path.join(__dirname, 'Fuel seed data.xlsx'),
  path.join(__dirname, '..', '..', '..', 'Fuel seed data.xlsx'),
].filter(Boolean);

const wbPath = CANDIDATES.find((c) => fs.existsSync(c));
if (!wbPath) throw new Error('workbook not found');

const book = xlsx.open(wbPath);
const rows = book.rows(sheetName);

const series = [];
for (const r of rows) {
  if (typeof r.A !== 'number') continue;
  const cents = xlsx.parseCents(r.B);
  if (cents === null) continue;
  series.push({ date: xlsx.serialToISO(r.A), cents });
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let prev = null;
let maxRise = 0;
let maxFall = 0;
for (const p of series) {
  const d = prev === null ? null : p.cents - prev;
  if (d !== null) {
    maxRise = Math.max(maxRise, d);
    maxFall = Math.min(maxFall, d);
  }
  const dow = DOW[new Date(p.date + 'T00:00:00Z').getUTCDay()];
  const bar = '#'.repeat(Math.max(0, Math.round((p.cents - 150) / 2)));
  console.log(
    `${p.date} ${dow} ${p.cents.toFixed(1).padStart(6)} ${
      d === null ? '     ' : (d >= 0 ? '+' : '') + d.toFixed(1).padStart(5)
    } ${bar}`
  );
  prev = p.cents;
}

const vals = series.map((p) => p.cents);
console.log(`\n${sheetName}: n=${series.length}`);
console.log(`min=${Math.min(...vals).toFixed(1)} max=${Math.max(...vals).toFixed(1)} range=${(Math.max(...vals) - Math.min(...vals)).toFixed(1)}`);
console.log(`largest single-day rise=+${maxRise.toFixed(1)} largest fall=${maxFall.toFixed(1)}`);
