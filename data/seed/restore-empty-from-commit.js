'use strict';

// Restore aggregate days from an older data-branch commit into empty slots only.
// Used after an import overwrite dropped recent live-collect days.
//
//   node data/seed/restore-empty-from-commit.js 4041052
//   DOCS_DIR=./docs node data/seed/restore-empty-from-commit.js 4041052 --dry-run

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const history = require('../lib/history');
const { FUELS } = require('../lib/fuels');
const { STATES } = require('../lib/states');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const GIT = process.env.GIT_EXE || 'git';
const rev = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const skip = new Set(
  (process.argv.find((a) => a.startsWith('--skip=')) || '')
    .slice(7)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (!rev) {
  console.error('Usage: node data/seed/restore-empty-from-commit.js <git-rev> [--dry-run] [--skip=NT]');
  process.exit(1);
}

function gitShow(file) {
  try {
    return execFileSync(GIT, ['show', `${rev}:${file}`], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (_) {
    return null;
  }
}

function main() {
  console.log(`restore empty slots from ${rev} → ${DOCS_DIR}${dryRun ? ' (dry run)' : ''}`);
  let total = 0;

  for (const state of STATES) {
    if (skip.has(state)) {
      console.log(`  ${state}: skipped`);
      continue;
    }
    const raw = gitShow(`v1/${state}.json`);
    if (!raw) {
      console.log(`  ${state}: not in ${rev}`);
      continue;
    }
    const old = JSON.parse(raw);
    if (!old.start || !old.days) {
      console.log(`  ${state}: empty in ${rev}`);
      continue;
    }

    const file = history.load(DOCS_DIR, state);
    let slots = 0;
    const { isoToDayNum, dayNumToISO } = require('../lib/cyclefit');
    const start = isoToDayNum(old.start);

    for (let i = 0; i < old.days; i++) {
      const iso = dayNumToISO(start + i);
      for (const fuel of FUELS) {
        const s = old.fuels?.[fuel];
        if (!s || s.avg[i] == null) continue;
        if (!history.isSlotEmpty(file, fuel, iso)) continue;
        const reading = {
          avg: s.avg[i],
          gmean: s.gmean?.[i] ?? null,
          mode: s.mode?.[i] ?? null,
          med: s.med?.[i] ?? null,
          min: s.min[i],
          max: s.max[i],
          n: s.n[i],
        };
        if (!dryRun) history.setDay(file, fuel, iso, reading);
        slots++;
      }
    }

    if (slots && !dryRun) {
      file.generated = new Date().toISOString();
      if (old.source && (!file.source || file.source.includes('archive'))) {
        // keep current source if collect-attributed; else leave
      }
      history.roll(DOCS_DIR, file, require('../lib/states').localParts(new Date(), state).day);
      history.save(DOCS_DIR, file);
    }
    console.log(`  ${state}: restored ${slots} slot(s)`);
    total += slots;
  }

  console.log(`\n${dryRun ? 'would restore' : 'restored'} ${total} slot(s)`);
}

main();
