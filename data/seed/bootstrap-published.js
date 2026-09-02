'use strict';

// Wipes published v1 state files to empty windows (no seed history).
// Use before restarting collection from live feeds only.
//
//   node data/seed/bootstrap-published.js
//   DOCS_DIR=./docs node data/seed/bootstrap-published.js

const fs = require('fs');
const path = require('path');
const history = require('../lib/history');
const { FUELS } = require('../lib/fuels');
const { STATES } = require('../lib/states');

const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
const archiveDir = path.join(DOCS_DIR, 'v1', 'archive');

if (fs.existsSync(archiveDir)) {
  for (const name of fs.readdirSync(archiveDir)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(archiveDir, name));
  }
}

for (const state of STATES) {
  const file = history.emptyState(state);
  file.rejects = {};
  file.params = {};
  for (const fuel of FUELS) {
    file.params[fuel] = { confidence: 'none', hasCycle: false, observedDays: 0, source: 'none' };
  }
  const p = history.statePath(DOCS_DIR, state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file) + '\n');
  console.log(`reset ${state}`);
}

const indexPath = path.join(DOCS_DIR, 'v1', 'index.json');
const index = {
  v: history.SCHEMA,
  source: '',
  windowDays: history.WINDOW_DAYS,
  units: 'tenths of a cent per litre',
  fuels: FUELS,
  states: STATES.map((s) => ({ code: s, file: `${s}.json` })),
};
fs.writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');
console.log(`reset index → ${DOCS_DIR}`);
