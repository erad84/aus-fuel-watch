'use strict';

const aggregate = require('../aggregate');
const { FUELS } = require('../fuels');

/**
 * Build per-state daily readings from station rows grouped by ISO day.
 * @param {Map<string, Array>} stationsByDay iso -> station rows
 * @param {{preferMetro?: boolean}} opts
 * @returns {Map<string, Map<string, Record>>} state -> (iso -> fuel readings)
 */
function readingsByStateAndDay(stationsByDay, opts) {
  const preferMetro = opts && opts.preferMetro;
  const out = new Map();

  for (const [iso, stations] of stationsByDay) {
    const agg = aggregate.aggregate(stations);
    for (const [state, scopes] of Object.entries(agg)) {
      if (!out.has(state)) out.set(state, new Map());
      const readings = {};
      for (const fuel of FUELS) {
        const s =
          preferMetro && scopes.metro[fuel]
            ? scopes.metro[fuel]
            : scopes.state[fuel] || scopes.metro[fuel];
        if (!s) continue;
        readings[fuel] = {
          avg: s.avg,
          min: s.min,
          max: s.max,
          n: s.n,
        };
      }
      if (Object.keys(readings).length) out.get(state).set(iso, readings);
    }
  }

  return out;
}

module.exports = { readingsByStateAndDay };
