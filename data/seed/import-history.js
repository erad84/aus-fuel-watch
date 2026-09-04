'use strict';

// One-off backfill from official open-data archives into published state JSON.
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
const { STATES } = require('../lib/states');
const { mergeStateDays, trimAllStates, countFilledDays } = require('../lib/import/merge');
const nsw = require('../lib/import/nswFuelcheckArchive');
const qld = require('../lib/import/qldOpenData');
const nt = require('../lib/import/ntMyfuelArchive');
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

async function main() {
  console.log(`import-history: ${args.days}-day window → ${DOCS_DIR}`);
  console.log(`cache: ${CACHE_DIR}`);
  if (args.dryRun) console.log('dry run — no files written');

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (args.sources.has('nsw')) {
    console.log('\nNSW/ACT/TAS (FuelCheck archives)…');
    const { byState, localFiles, skippedXls } = await nsw.importNswActTas(CACHE_DIR, args.days);
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
  }

  if (args.sources.has('qld')) {
    console.log('\nQLD (open data CSV)…');
    const byState = await qld.importQld(CACHE_DIR, args.days);
    await applyImport('QLD archive', byState, qld.ATTRIBUTION, 'metro');
  }

  if (args.sources.has('nt')) {
    console.log('\nNT (MyFuel XLSX)…');
    const byState = await nt.importNt(CACHE_DIR, args.days);
    if (!byState.size) {
      console.log('  no XLSX files overlapped the window (check data.nt.gov.au for recent months)');
    }
    await applyImport('NT archive', byState, nt.ATTRIBUTION, 'metro');
  }

  if (args.sources.has('wa')) {
    console.log('\nWA (FuelWatch RSS + optional zip cache)…');
    const { byState, waCsv, waZips } = await wa.importWa(CACHE_DIR, args.days);
    if (waCsv) console.log(`  parsed ${waCsv} WA CSV file(s) from cache`);
    if (waZips) console.log(`  parsed ${waZips} WA zip file(s) from cache`);
    await applyImport('WA', byState, wa.ATTRIBUTION, 'metro');
    console.log(
      '  note: RSS only covers today/yesterday; for full WA backfill add FuelWatchRetail-*.csv.zip to',
      path.join(CACHE_DIR, 'wa')
    );
  }

  if (!args.dryRun) {
    trimAllStates(DOCS_DIR, STATES);
    const indexPath = path.join(DOCS_DIR, 'v1', 'index.json');
    const index = {
      v: history.SCHEMA,
      source: 'official open-data archives + collector',
      windowDays: history.WINDOW_DAYS,
      units: 'tenths of a cent per litre',
      fuels: require('../lib/fuels').FUELS,
      states: STATES.map((s) => ({ code: s, file: `${s}.json` })),
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
