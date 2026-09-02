'use strict';

// One-time local step. Reads the FuelRadar seed workbook, fits cycle params per
// state and fuel, and writes data/params.seed.json.
//
// This never runs in CI. The workbook itself is gitignored and is not
// republished; only the fitted params are committed.
//
// Usage: node data/seed/fit-params.js [path/to/Fuel seed data.xlsx]

const fs = require('fs');
const path = require('path');
const xlsx = require('../lib/xlsx');
const cyclefit = require('../lib/cyclefit');
const { FROM_SEED_SHEET } = require('../lib/fuels');
const { STATES } = require('../lib/states');

const CANDIDATES = [
  process.argv[2],
  path.join(__dirname, 'Fuel seed data.xlsx'),
  path.join(__dirname, '..', '..', '..', 'Fuel seed data.xlsx'),
].filter(Boolean);

function findWorkbook() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error(
    'seed workbook not found. Pass the path as an argument, or place it at data/seed/Fuel seed data.xlsx\nLooked in:\n  ' +
      CANDIDATES.join('\n  ')
  );
}

function parseSheetName(name) {
  const idx = name.indexOf(' ');
  if (idx === -1) return null;
  const state = name.slice(0, idx).trim().toUpperCase();
  const suffix = name.slice(idx + 1).trim().toUpperCase();
  if (!STATES.includes(state)) return null;
  if (!(suffix in FROM_SEED_SHEET)) return null;
  return { state, fuel: FROM_SEED_SHEET[suffix], suffix };
}

// Column A is an Excel date serial, column B is text like "180.0 c/L".
// Column C is a cumulative change against the first value, so it is ignored.
function readSeries(book, sheetName) {
  const out = [];
  for (const r of book.rows(sheetName)) {
    if (typeof r.A !== 'number') continue; // header row
    const cents = xlsx.parseCents(r.B);
    if (cents === null) continue;
    out.push({ date: xlsx.serialToISO(r.A), cents });
  }
  return out;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function main() {
  const wbPath = findWorkbook();
  console.log(`reading ${wbPath}\n`);
  const book = xlsx.open(wbPath);

  const params = {};
  const report = [];
  const skipped = [];

  for (const name of book.sheetNames()) {
    const parsed = parseSheetName(name);
    if (!parsed) {
      skipped.push(`${name} (unrecognised sheet name)`);
      continue;
    }
    if (parsed.fuel === null) {
      skipped.push(`${name} (fuel out of scope for v1)`);
      continue;
    }

    const series = readSeries(book, name);
    if (!series.length) {
      skipped.push(`${name} (no data rows)`);
      continue;
    }

    const f = cyclefit.fit(series);
    params[parsed.state] = params[parsed.state] || {};
    params[parsed.state][parsed.fuel] = {
      confidence: f.confidence,
      hasCycle: f.hasCycle,
      cycleLenDays: f.cycleLenDays,
      cycleStrength: f.cycleStrength,
      amplitude: f.amplitude,
      lastTurn: f.lastTurn,
      declineRatePerDay: f.declineRatePerDay,
      riseRatePerDay: f.riseRatePerDay,
      dowBias: f.dowBias,
      p10Offset: f.p10Offset,
      p90Offset: f.p90Offset,
      rangeSpread: f.rangeSpread,
      source: 'seed',
    };
    report.push({ state: parsed.state, fuel: parsed.fuel, ...f });
  }

  const first = report[0] || null;
  const out = {
    v: 1,
    fittedAt: new Date().toISOString(),
    fittedFrom: {
      workbook: path.basename(wbPath),
      provider: 'FuelRadar state-wide daily averages',
      granularity: 'state',
      start: first ? first.windowStart : null,
      end: first ? first.windowEnd : null,
    },
    note:
      'Derived cycle parameters only; the underlying seed series is not redistributed. ' +
      'Each entry is retired per state and fuel once the collector has observed a full cycle of its own.',
    states: params,
  };

  const dest = path.join(__dirname, '..', 'params.seed.local.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');

  console.log(
    'state fuel  days miss conf  period  r     cycles ampl  spread maxRise decline cheapest    turns'
  );
  for (const r of report) {
    const bias = r.dowBias || [];
    let cheapest = '-';
    if (bias.length === 7 && bias.every((x) => x !== null)) {
      const min = Math.min(...bias);
      cheapest = `${DOW[bias.indexOf(min)]} ${min.toFixed(1)}`;
    }
    console.log(
      [
        r.state.padEnd(4),
        r.fuel.padEnd(5),
        String(r.days).padStart(4),
        String(r.missing).padStart(4),
        (r.confidence || '-').padEnd(5),
        (r.cycleLenDays === null ? '-' : String(r.cycleLenDays)).padStart(6),
        String(r.cycleStrength === null ? '-' : r.cycleStrength).padStart(6),
        String(r.cyclesObserved === null ? '-' : r.cyclesObserved).padStart(6),
        (r.amplitude === null ? '-' : r.amplitude.toFixed(1)).padStart(5),
        (r.rangeSpread === null ? '-' : r.rangeSpread.toFixed(1)).padStart(6),
        (r.largestDailyRise === null ? '-' : r.largestDailyRise.toFixed(1)).padStart(7),
        (r.declineRatePerDay === null ? '-' : r.declineRatePerDay.toFixed(2)).padStart(7),
        cheapest.padStart(10),
        String(r.turns).padStart(5),
        r.hasCycle ? '' : `  [${r.reason}]`,
      ].join(' ')
    );
  }

  const byConf = report.reduce((acc, r) => {
    acc[r.confidence] = (acc[r.confidence] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nseries fitted: ${report.length}  ${JSON.stringify(byConf)}`);

  if (skipped.length) {
    console.log('\nskipped:');
    for (const s of skipped) console.log('  ' + s);
  }
  console.log(`\nwrote ${path.relative(process.cwd(), dest)}`);
}

main();
