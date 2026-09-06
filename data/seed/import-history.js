'use strict';

// One-off backfill from official open-data archives into published state JSON
// and per-station day shards under docs/v1/stations/.
//
//   node data/seed/import-history.js
//   node data/seed/import-history.js --days 90 --sources nsw,qld,nt,wa
//   DOCS_DIR=./docs node data/seed/import-history.js --dry-run
//
// Fills empty daily slots only (does not overwrite live collector data).
// Downloads are cached under data/seed/.import-cache/ (gitignored).

const fs = require('fs');
const path = require('path');
const history = require('../lib/history');
const stationHistory = require('../lib/stationHistory');
const { STATES } = require('../lib/states');
const {
  mergeStateDays,
  mergeStationDays,
  trimAllStates,
  countFilledDays,
} = require('../lib/import/merge');
const nsw = require('../lib/import/nswFuelcheckArchive');
const qld = require('../lib/import/qldOpenData');
const nt = require('../lib/import/ntMyfuelArchive');
const ntTrends = require('../lib/import/ntMyfuelTrends');
const wa = require('../lib/import/waFuelwatch');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const CACHE_DIR =
  process.env.IMPORT_CACHE || path.join(__dirname, '.import-cache');

function parseArgs(argv) {
  const out = {
    days: history.WINDOW_DAYS,
    sources: new Set(['nsw', 'qld', 'nt', 'wa']),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--days' && argv[i + 1]) out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--sources' && argv[i + 1]) {
      out.sources = new Set(
        argv[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
    } else if (a.startsWith('--sources=')) {
      out.sources = new Set(a.slice(9).split(',').map((s) => s.trim().toLowerCase()));
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

async function applyImport(label, byState, source, granularity) {
  let totalSlots = 0;
  for (const [state, byDay] of byState) {
    if (!STATES.includes(state)) continue;
    if (args.dryRun) {
      console.log(`  ${state}: would merge ${byDay.size} day(s) from ${label}`);
      continue;
    }
    const { slots, days } = mergeStateDays(DOCS_DIR, state, byDay, {
      onlyEmpty: true,
      source,
      granularity,
    });
    console.log(`  ${state}: merged ${slots} slot(s) across ${days} day(s)`);
    totalSlots += slots;
  }
  return totalSlots;
}

function applyStationImport(label, stationsByDay) {
  if (!stationsByDay || !stationsByDay.size) {
    console.log(`  stations (${label}): none`);
    return;
  }
  if (args.dryRun) {
    console.log(`  stations (${label}): would write ${stationsByDay.size} day shard(s)`);
    return;
  }
  const { days, stations } = mergeStationDays(DOCS_DIR, stationsByDay, { onlyEmpty: true });
  console.log(`  stations (${label}): wrote ${days} new day shard(s), ${stations} outlet rows`);
}

async function main() {
  console.log(`import-history: ${args.days}-day window → ${DOCS_DIR}`);
  console.log(`cache: ${CACHE_DIR}`);
  if (args.dryRun) console.log('dry run — no files written');

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (args.sources.has('nsw')) {
    console.log('\nNSW/ACT/TAS (FuelCheck archives)…');
    const { byState, stationsByDay, localFiles, skippedXls } = await nsw.importNswActTas(
      CACHE_DIR,
      args.days
    );
    if (localFiles) console.log(`  parsed ${localFiles} local file(s) from cache/nsw/`);
    if (skippedXls && skippedXls.length) {
      console.log(
        `  skipped legacy .xls (convert to .xlsx or .csv): ${skippedXls.join(', ')}`
      );
    }
    if (!byState.size) {
      console.log(
        '  no data in window — drop FuelCheck CSV/XLSX into',
        path.join(CACHE_DIR, 'nsw'),
        '(or wait for Data.NSW monthly publish)'
      );
    }
    await applyImport('NSW archive', byState, nsw.ATTRIBUTION, 'state');
    applyStationImport('NSW archive', stationsByDay);
  }

  if (args.sources.has('qld')) {
    console.log('\nQLD (open data CSV)…');
    const { byState, stationsByDay } = await qld.importQld(CACHE_DIR, args.days);
    await applyImport('QLD archive', byState, qld.ATTRIBUTION, 'metro');
    applyStationImport('QLD archive', stationsByDay);
  }

  if (args.sources.has('nt')) {
    console.log('\nNT (MyFuel CKAN XLSX)…');
    const { byState, stationsByDay, meta } = await nt.importNt(CACHE_DIR, args.days);
    if (!byState.size) {
      console.log(
        `  no rows in window ${meta.window.startIso}…${meta.window.endIso}` +
          ` (${meta.packages} CKAN packages, ${meta.xlsxTried} XLSX tried)`
      );
      if (meta.latestTitle) {
        console.log(
          `  newest on data.nt.gov.au: "${meta.latestTitle}"` +
            (meta.latestModified ? ` (modified ${meta.latestModified.slice(0, 10)})` : '')
        );
      }
    } else {
      console.log(`  filled ${meta.daysFilled} day(s) from archive`);
    }
    await applyImport('NT archive', byState, nt.ATTRIBUTION, 'metro');
    applyStationImport('NT archive', stationsByDay);

    console.log('\nNT (MyFuel Trends JSON, ~28-day metro avg)…');
    const trends = await ntTrends.importNtTrends(args.days);
    const tm = trends.meta;
    console.log(
      `  period=${tm.period} regions=${tm.regionsOk}/3 days=${tm.daysFilled} (${tm.note})`
    );
    for (const err of tm.regionErrors) console.log(`  region warn: ${err}`);
    if (!trends.byState.size) {
      console.log('  no Trends rows in window');
    }
    await applyImport('NT Trends', trends.byState, ntTrends.ATTRIBUTION, 'metro');
    // Trends API is regional averages only — no per-station rows.
  }

  if (args.sources.has('wa')) {
    console.log('\nWA (FuelWatch RSS + optional zip cache)…');
    const { byState, stationsByDay, waCsv, waZips } = await wa.importWa(CACHE_DIR, args.days);
    if (waCsv) console.log(`  parsed ${waCsv} WA CSV file(s) from cache`);
    if (waZips) console.log(`  parsed ${waZips} WA zip file(s) from cache`);
    await applyImport('WA', byState, wa.ATTRIBUTION, 'metro');
    applyStationImport('WA', stationsByDay);
    console.log(
      '  note: RSS only covers today/yesterday; for full WA backfill add FuelWatchRetail-*.csv.zip to',
      path.join(CACHE_DIR, 'wa')
    );
  }

  if (!args.dryRun) {
    trimAllStates(DOCS_DIR, STATES);
    stationHistory.writeIndex(DOCS_DIR, STATES);
    const indexPath = path.join(DOCS_DIR, 'v1', 'index.json');
    const index = {
      v: history.SCHEMA,
      source: 'official open-data archives + collector',
      windowDays: history.WINDOW_DAYS,
      units: 'tenths of a cent per litre',
      fuels: require('../lib/fuels').FUELS,
      states: STATES.map((s) => ({ code: s, file: `${s}.json` })),
      stations: {
        index: 'stations/index.json',
        note: 'Per-station daily prices (not downloaded by the watch)',
      },
    };
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');

    console.log('\nFilled U91 days per state:');
    for (const st of STATES) {
      console.log(`  ${st}: ${countFilledDays(DOCS_DIR, st)} / ${args.days}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
