'use strict';

const history = require('../history');
const stationHistory = require('../stationHistory');
const { FUELS } = require('../fuels');
const { localParts } = require('../states');

function isScopedPayload(payload) {
  return Boolean(payload && (payload.metro || payload.regional || payload.state));
}

/**
 * @param {string} docsDir
 * @param {string} state
 * @param {Map<string, Object>} byDay iso -> fuel readings OR scoped {metro,regional,state}
 * @param {{onlyEmpty?: boolean, source?: string, granularity?: string}} opts
 */
function mergeStateDays(docsDir, state, byDay, opts) {
  const onlyEmpty = !opts || opts.onlyEmpty !== false;
  const file = history.load(docsDir, state);
  let slots = 0;

  for (const [iso, payload] of byDay) {
    if (isScopedPayload(payload)) {
      for (const scope of history.SCOPES) {
        const readings = payload[scope];
        if (!readings) continue;
        for (const fuel of FUELS) {
          const r = readings[fuel];
          if (!r || r.avg === null) continue;
          if (onlyEmpty && !history.isSlotEmpty(file, fuel, iso, scope)) continue;
          history.setDay(file, fuel, iso, r, scope);
          slots++;
        }
      }
    } else {
      const scope =
        opts && opts.granularity === 'metro'
          ? 'metro'
          : opts && opts.granularity === 'state'
          ? 'state'
          : file.defaultScope || 'metro';
      for (const fuel of FUELS) {
        const r = payload[fuel];
        if (!r || r.avg === null) continue;
        if (onlyEmpty && !history.isSlotEmpty(file, fuel, iso, scope)) continue;
        history.setDay(file, fuel, iso, r, scope);
        slots++;
      }
    }
  }

  if (slots > 0) {
    if (opts && opts.source) file.source = opts.source;
    if (opts && opts.granularity === 'metro') file.defaultScope = 'metro';
    else if (opts && opts.granularity === 'state') file.defaultScope = 'state';
    history.syncPrimaryFuels(file);
    file.generated = new Date().toISOString();
    history.save(docsDir, file);
  }

  return { slots, days: byDay.size };
}

/**
 * Persist archive station rows (iso → station[]) into docs/v1/stations/.
 * @param {string} docsDir
 * @param {Map<string, Array>} stationsByDay
 * @param {{onlyEmpty?: boolean}} opts
 */
function mergeStationDays(docsDir, stationsByDay, opts) {
  if (!stationsByDay || !stationsByDay.size) return { days: 0, stations: 0 };
  return stationHistory.writeStationsByDay(docsDir, stationsByDay, opts);
}

function trimAllStates(docsDir, states) {
  const today = localParts(new Date(), 'NSW').day;
  for (const state of states) {
    const file = history.load(docsDir, state);
    if (!file.start) continue;
    history.roll(docsDir, file, today);
    history.save(docsDir, file);
  }
  stationHistory.rollAll(docsDir, states, today);
  stationHistory.writeIndex(docsDir, states);
}

function countFilledDays(docsDir, state) {
  const file = history.load(docsDir, state);
  if (!file.start || !file.days) return 0;
  let n = 0;
  const fuels = history.fuelsFor(file, file.defaultScope);
  for (let i = 0; i < file.days; i++) {
    if (fuels.U91.avg[i] !== null && fuels.U91.avg[i] !== undefined) n++;
  }
  return n;
}

module.exports = { mergeStateDays, mergeStationDays, trimAllStates, countFilledDays };
