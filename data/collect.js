'use strict';

// Daily entry point for the scheduled job. One HTTP request covers the country.
//
// Writes are idempotent and only ever fill an empty slot, so re-running is safe
// and a retry can never overwrite a good reading with a worse one.
//
// Usage:
//   node data/collect.js              record states inside their local morning window
//   node data/collect.js --catchup    fill any still-empty slot regardless of local hour
//   node data/collect.js --dry-run    report what would change, write nothing

const fs = require('fs');
const path = require('path');
const sources = require('./lib/sources');
const history = require('./lib/history');
const cyclefit = require('./lib/cyclefit');
const { FUELS, PARAM_FALLBACK } = require('./lib/fuels');
const { STATES, localParts } = require('./lib/states');

// In CI the published data branch is checked out at ./docs, so this resolves to
// the same place it does locally.
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', 'docs');
const SEED_PARAMS = path.join(__dirname, 'params.seed.json');

// Record a state when its own clock says mid-morning. Prices for the day are
// published by then in every jurisdiction, and sampling at a consistent local
// hour stops the series from drifting between "yesterday's" and "today's" price.
const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 13;

// A state-wide mean built from fewer stations than this is not a state-wide
// mean. Catches Petrolmate's currently-degraded TAS feed, which reports 18
// stations against a real population of roughly 220.
const MIN_STATIONS = 25;

// Coverage may not fall below this share of what the feed has recently managed.
const MIN_COVERAGE_RATIO = 0.6;

// Widest believable one-day move, in tenths of a cent. Real hikes run 20-40c,
// so 45c leaves genuine spikes intact while rejecting feed glitches.
const MAX_DAILY_MOVE = 450;

const MIN_PLAUSIBLE = 500;
const MAX_PLAUSIBLE = 4000;

// Once our own series is this long, cycle params are refitted from it and the
// seeded values are retired for that state and fuel.
const REANCHOR_MIN_DAYS = 45;

function fmt(tenths) {
  return tenths === null || tenths === undefined ? '-' : (tenths / 10).toFixed(1);
}

// Returns null when the reading is acceptable, otherwise the reason to reject.
function checkReading(file, fuel, iso, reading, premiumInverted) {
  if (reading.avg === null) return 'avg missing or non-numeric';
  if (reading.avg < MIN_PLAUSIBLE || reading.avg > MAX_PLAUSIBLE) {
    return `avg ${fmt(reading.avg)}c outside plausible range`;
  }
  if (premiumInverted && (fuel === 'P95' || fuel === 'P98')) {
    return 'premium grades inverted (P95 above P98)';
  }
  if (reading.n !== null && reading.n < MIN_STATIONS) {
    return `only ${reading.n} stations`;
  }

  const medN = history.trailingMedian(file, fuel, iso, 14, 'n');
  if (medN !== null && reading.n !== null && reading.n < MIN_COVERAGE_RATIO * medN) {
    return `station count ${reading.n} below ${Math.round(MIN_COVERAGE_RATIO * 100)}% of trailing median ${medN}`;
  }

  const medAvg = history.trailingMedian(file, fuel, iso, 14, 'avg');
  if (medAvg !== null && Math.abs(reading.avg - medAvg) > MAX_DAILY_MOVE) {
    return `avg ${fmt(reading.avg)}c is ${fmt(Math.abs(reading.avg - medAvg))}c from trailing median ${fmt(medAvg)}c`;
  }
  return null;
}

function seriesFromFile(file, fuel) {
  const out = [];
  if (!file.start) return out;
  const s = file.fuels[fuel];
  const startNum = cyclefit.isoToDayNum(file.start);
  for (let i = 0; i < file.days; i++) {
    const v = s.avg[i];
    if (v === null || v === undefined) continue;
    out.push({ date: cyclefit.dayNumToISO(startNum + i), cents: v / 10 });
  }
  return out;
}

// Prefer params fitted from our own collected series once it is long enough.
// Until then use the seeded ones, and fall back across fuels where the seed had
// no series at all (the workbook has no premium diesel).
function resolveParams(file, seedForState) {
  const out = {};
  for (const fuel of FUELS) {
    const own = seriesFromFile(file, fuel);
    if (own.length >= REANCHOR_MIN_DAYS) {
      const f = cyclefit.fit(own);
      out[fuel] = {
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
        observedDays: own.length,
        source: 'observed',
      };
      continue;
    }

    const seeded = seedForState && (seedForState[fuel] || seedForState[PARAM_FALLBACK[fuel]]);
    if (seeded) {
      out[fuel] = { ...seeded, observedDays: own.length };
      if (!seedForState[fuel] && PARAM_FALLBACK[fuel]) {
        out[fuel].source = `seed:${PARAM_FALLBACK[fuel]}`;
      }
    } else {
      out[fuel] = { confidence: 'none', hasCycle: false, observedDays: own.length, source: 'none' };
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const catchup = args.includes('--catchup');
  const dryRun = args.includes('--dry-run');

  const source = sources.get(process.env.FUEL_SOURCE);
  const seed = fs.existsSync(SEED_PARAMS)
    ? JSON.parse(fs.readFileSync(SEED_PARAMS, 'utf8'))
    : { states: {} };

  console.log(`fetching ${source.URL}`);
  const snap = await source.fetchSnapshot();
  console.log(`source generated ${snap.generatedAt}, states: ${Object.keys(snap.states).join(' ')}`);

  const now = new Date();
  let changedFiles = 0;
  let wrote = 0;
  let rejected = 0;
  let skipped = 0;

  for (const state of STATES) {
    const readings = snap.states[state];
    if (!readings) {
      console.log(`${state}: absent from snapshot`);
      continue;
    }

    const { day, hour } = localParts(now, state);
    const inWindow = hour >= WINDOW_START_HOUR && hour <= WINDOW_END_HOUR;
    const file = history.load(DOCS_DIR, state);

    history.roll(DOCS_DIR, file, day);

    // Evaluated once per state because it is a statement about the sample as a
    // whole, not about one grade.
    const premiumInverted =
      readings.P95 &&
      readings.P98 &&
      readings.P95.avg !== null &&
      readings.P98.avg !== null &&
      readings.P95.avg > readings.P98.avg;

    const notes = [];
    for (const fuel of FUELS) {
      const reading = readings[fuel];
      if (!reading) continue;

      if (!history.isSlotEmpty(file, fuel, day)) {
        skipped++;
        continue;
      }
      if (!inWindow && !catchup) {
        skipped++;
        continue;
      }

      const reason = checkReading(file, fuel, day, reading, premiumInverted);
      if (reason) {
        // Counted once per local day, not once per attempt, so three runs a day
        // do not treble the tally and a retry does not rewrite the file.
        const rec = file.rejects[fuel] || { count: 0, last: null };
        if (!rec.last || rec.last.date !== day) {
          rec.count++;
          rec.last = { date: day, reason };
          file.rejects[fuel] = rec;
        }
        notes.push(`  reject ${fuel}: ${reason}`);
        rejected++;
        continue;
      }

      history.setDay(file, fuel, day, reading);
      notes.push(
        `  wrote ${fuel}: avg ${fmt(reading.avg)}c  min ${fmt(reading.min)}  max ${fmt(reading.max)}  n ${reading.n}`
      );
      wrote++;
    }

    file.params = resolveParams(file, seed.states[state]);
    file.generated = new Date().toISOString();
    file.sourceGeneratedAt = snap.generatedAt;
    file.attribution = snap.attribution;

    console.log(
      `${state}: local ${day} ${String(hour).padStart(2, '0')}h ${
        inWindow ? 'in-window' : catchup ? 'catch-up' : 'out-of-window'
      }, ${file.days} day(s) held`
    );
    for (const n of notes) console.log(n);

    if (!dryRun) {
      if (history.save(DOCS_DIR, file)) changedFiles++;
    }
  }

  if (!dryRun) {
    // Deliberately carries no timestamp: this is static metadata, and stamping
    // it would force a commit on every run. Freshness lives in the state files.
    const index = {
      v: history.SCHEMA,
      source: snap.attribution,
      windowDays: history.WINDOW_DAYS,
      units: 'tenths of a cent per litre',
      fuels: FUELS,
      states: STATES.map((s) => ({ code: s, file: `${s}.json` })),
    };
    const indexPath = path.join(DOCS_DIR, 'v1', 'index.json');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const next = JSON.stringify(index, null, 1) + '\n';
    if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8') !== next) {
      fs.writeFileSync(indexPath, next);
    }
  }

  console.log(
    `\n${dryRun ? '[dry run] ' : ''}wrote ${wrote}, rejected ${rejected}, skipped ${skipped}, files changed ${changedFiles}`
  );
}

main().catch((err) => {
  console.error(`collect failed: ${err.message}`);
  process.exit(1);
});
