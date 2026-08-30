'use strict';

// Adapter registry. Only one source today, but the collector talks to this
// rather than to Petrolmate directly so that swapping or adding a source does
// not mean rewriting collect.js.

const petrolmate = require('./petrolmate');

const SOURCES = { [petrolmate.NAME]: petrolmate };
const DEFAULT_SOURCE = petrolmate.NAME;

function get(name) {
  const s = SOURCES[name || DEFAULT_SOURCE];
  if (!s) throw new Error(`unknown source: ${name}. Known: ${Object.keys(SOURCES).join(', ')}`);
  return s;
}

module.exports = { SOURCES, DEFAULT_SOURCE, get };
