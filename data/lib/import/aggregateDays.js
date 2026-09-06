'use strict';

const aggregate = require('../aggregate');
const history = require('../history');
const { FUELS } = require('../fuels');

function fuelReadingsFromStats(statsByFuel) {
  const readings = {};
  for (const fuel of FUELS) {
    const s = statsByFuel?.[fuel];
    if (!s) continue;
    readings[fuel] = {
      avg: s.avg,
      gmean: s.gmean,
      mode: s.mode,
      med: s.med,
      min: s.min,
      max: s.max,
      n: s.n,
    };
  }
  return readings;
}

/**
 * Build per-state daily readings from station rows grouped by ISO day.
 * Each day payload has metro / regional / state fuel maps.
 *
 * @param {Map<string, Array>} stationsByDay iso -> station rows
 * @param {{preferMetro?: boolean}} opts preferMetro kept for callers; all scopes are always filled
 * @returns {Map<string, Map<string, {metro,regional,state}>>} state -> (iso -> scoped readings)
 */
function readingsByStateAndDay(stationsByDay, opts) {
  const out = new Map();

  for (const [iso, stations] of stationsByDay) {
    const agg = aggregate.aggregate(stations);
    for (const [state, scopes] of Object.entries(agg)) {
      if (!out.has(state)) out.set(state, new Map());
      const payload = {
        metro: fuelReadingsFromStats(scopes.metro),
        regional: fuelReadingsFromStats(scopes.regional),
        state: fuelReadingsFromStats(scopes.state),
      };
      // Legacy flat map for callers that only expect fuel -> reading (primary scope).
      const preferMetro = !opts || opts.preferMetro !== false;
      const primary = preferMetro
        ? Object.keys(payload.metro).length
          ? payload.metro
          : payload.state
        : Object.keys(payload.state).length
        ? payload.state
        : payload.metro;
      Object.assign(payload, primary);
      if (Object.keys(primary).length || Object.keys(payload.metro).length || Object.keys(payload.state).length) {
        out.get(state).set(iso, payload);
      }
    }
  }

  return out;
}

module.exports = { readingsByStateAndDay, fuelReadingsFromStats };
