'use strict';

// Daily entry point for the scheduled job.
//
// Fetches station-level prices from official adapters, aggregates to state and
// capital-metro averages, and falls back to Petrolmate /api/summary only for
// jurisdictions without a station source yet (VIC, QLD).
//
// Writes are idempotent and only ever fill an empty slot.
//
// Usage:
//   node --env-file=.env data/collect.js
//   node --env-file=.env data/collect.js --catchup
//   node --env-file=.env data/collect.js --dry-run

const fs = require('fs');
const path = require('path');
const sources = require('./lib/sources');
const aggregate = require('./lib/aggregate');
const history = require('./lib/history');
const cyclefit = require('./lib/cyclefit');
const { FUELS } = require('./lib/fuels');
const { STATES, localParts } = require('./lib/states');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', 'docs');

const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 13;

const MIN_STATIONS = 25;
const MIN_STATIONS_SAMPLED = 10;
// FuelCheck under-reports these; verified against live API 2026-09-03.
const MIN_STATIONS_OVERRIDE = {
  TAS: { E10: 4 },
  ACT: { DSL: 10 },
};
const MIN_COVERAGE_RATIO = 0.6;
const MAX_DAILY_MOVE = 500;
const MIN_PLAUSIBLE = 500;
const MAX_PLAUSIBLE = 5000;
const REANCHOR_MIN_DAYS = 45;

function fmt(tenths) {
  return tenths === null || tenths === undefined ? '-' : (tenths / 10).toFixed(1);
}

function minStations(state, fuel, sampled) {
  const byFuel = MIN_STATIONS_OVERRIDE[state];
  if (byFuel && byFuel[fuel] !== undefined) return byFuel[fuel];
  return sampled ? MIN_STATIONS_SAMPLED : MIN_STATIONS;
}

function checkReading(file, fuel, iso, reading, premiumInverted, opts) {
  const sampled = opts && opts.sampled;
  const state = opts && opts.state;
  const minN = minStations(state, fuel, sampled);

  if (reading.avg === null) return 'avg missing or non-numeric';
  if (reading.avg < MIN_PLAUSIBLE || reading.avg > MAX_PLAUSIBLE) {
    return `avg ${fmt(reading.avg)}c outside plausible range`;
  }
  if (premiumInverted && (fuel === 'P95' || fuel === 'P98')) {
    return 'premium grades inverted (P95 above P98)';
  }
  if (reading.n !== null && reading.n < minN) {
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

function resolveParams(file) {
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
    } else {
      out[fuel] = { confidence: 'none', hasCycle: false, observedDays: own.length, source: 'none' };
    }
  }
  return out;
}

function statsToReading(s) {
  if (!s) return null;
  return { avg: s.avg, min: s.min, max: s.max, n: s.n };
}

async function fetchAllStations() {
  const stations = [];
  const attributions = [];
  const notes = [];
  const sampledStates = new Set();

  for (const adapter of sources.stationSources()) {
    try {
      const snap = await adapter.fetchStations();
      stations.push(...snap.stations);
      if (snap.attribution) attributions.push(snap.attribution);
      for (const st of snap.sampled || []) sampledStates.add(st);
      for (const n of snap.notes || []) notes.push(`${adapter.NAME}: ${n}`);
    } catch (err) {
      notes.push(`${adapter.NAME}: FAILED (${err.message})`);
    }
  }

  return { stations, attributions, notes, sampledStates };
}

function readingsFromAggregate(scopes, preferMetro) {
  const readings = {};
  for (const fuel of FUELS) {
    const s =
      preferMetro && scopes.metro[fuel]
        ? scopes.metro[fuel]
        : scopes.state[fuel] || scopes.metro[fuel];
    const r = statsToReading(s);
    if (r) readings[fuel] = r;
  }
  return readings;
}

function readingsFromPetrolmate(state, snap) {
  const byFuel = snap.states[state];
  if (!byFuel) return {};
  const readings = {};
  for (const fuel of FUELS) {
    const v = byFuel[fuel];
    if (!v) continue;
    readings[fuel] = {
      avg: v.avg,
      min: v.min,
      max: v.max,
      n: v.n,
    };
  }
  return readings;
}

async function main() {
  const args = process.argv.slice(2);
  const catchup = args.includes('--catchup');
  const dryRun = args.includes('--dry-run');

  const { stations, attributions, notes: srcNotes, sampledStates } = await fetchAllStations();
  console.log(`station rows: ${stations.length}`);
  for (const n of srcNotes) console.log(`  ${n}`);

  const agg = aggregate.aggregate(stations);
  const stationStates = new Set(Object.keys(agg));

  let petrolmateSnap = null;
  const needsFallback = STATES.some((st) => !stationStates.has(st));
  if (needsFallback) {
    try {
      petrolmateSnap = await sources.get('petrolmate').fetchSnapshot();
      console.log(
        `petrolmate fallback: generated ${petrolmateSnap.generatedAt}, states ${Object.keys(
          petrolmateSnap.states
        ).join(' ')}`
      );
    } catch (err) {
      console.log(`petrolmate fallback failed: ${err.message}`);
    }
  }

  const attributionParts = [...attributions];
  if (petrolmateSnap && petrolmateSnap.attribution) attributionParts.push(petrolmateSnap.attribution);

  const now = new Date();
  let changedFiles = 0;
  let wrote = 0;
  let rejected = 0;
  let skipped = 0;

  for (const state of STATES) {
    const scopes = agg[state];
    const fromStations = Boolean(scopes);
    const readings = fromStations
      ? readingsFromAggregate(scopes, true)
      : petrolmateSnap
      ? readingsFromPetrolmate(state, petrolmateSnap)
      : {};

    if (!Object.keys(readings).length) {
      console.log(`${state}: no readings`);
      continue;
    }

    const { day, hour } = localParts(now, state);
    const inWindow = hour >= WINDOW_START_HOUR && hour <= WINDOW_END_HOUR;
    const file = history.load(DOCS_DIR, state);

    history.roll(DOCS_DIR, file, day);

    const premiumInverted =
      readings.P95 &&
      readings.P98 &&
      readings.P95.avg !== null &&
      readings.P98.avg !== null &&
      readings.P95.avg > readings.P98.avg;

    const checkOpts = { sampled: sampledStates.has(state), state };
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

      const reason = checkReading(file, fuel, day, reading, premiumInverted, checkOpts);
      if (reason) {
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

    file.params = resolveParams(file);
    file.generated = new Date().toISOString();
    file.granularity = fromStations ? 'metro' : 'state';
    file.sourceGeneratedAt = petrolmateSnap ? petrolmateSnap.generatedAt : file.generated;
    file.attribution = attributionParts.join('; ');

    console.log(
      `${state}: local ${day} ${String(hour).padStart(2, '0')}h ${
        inWindow ? 'in-window' : catchup ? 'catch-up' : 'out-of-window'
      }, ${file.granularity} series, ${file.days} day(s) held`
    );
    for (const n of notes) console.log(n);

    if (!dryRun && history.save(DOCS_DIR, file)) changedFiles++;
  }

  if (!dryRun) {
    const index = {
      v: history.SCHEMA,
      source: attributionParts.join('; '),
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
