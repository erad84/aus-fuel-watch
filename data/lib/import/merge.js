'use strict';

const history = require('../history');
const { FUELS } = require('../fuels');
const { localParts } = require('../states');

/**
 * @param {string} docsDir
 * @param {string} state
 * @param {Map<string, Record<string,{avg,min,max,n}>} byDay iso -> fuel readings
 * @param {{onlyEmpty?: boolean, source?: string, granularity?: string}} opts
 */
function mergeStateDays(docsDir, state, byDay, opts) {
  const onlyEmpty = !opts || opts.onlyEmpty !== false;
  const file = history.load(docsDir, state);
  let slots = 0;

  for (const [iso, readings] of byDay) {
    for (const fuel of FUELS) {
      const r = readings[fuel];
      if (!r || r.avg === null) continue;
      if (onlyEmpty && !history.isSlotEmpty(file, fuel, iso)) continue;
      history.setDay(file, fuel, iso, r);
      slots++;
    }
  }

  if (slots > 0) {
    if (opts && opts.source) file.source = opts.source;
    if (opts && opts.granularity) file.granularity = opts.granularity;
    file.generated = new Date().toISOString();
    history.save(docsDir, file);
  }

  return { slots, days: byDay.size };
}

function trimAllStates(docsDir, states) {
  const today = localParts(new Date(), 'NSW').day;
  for (const state of states) {
    const file = history.load(docsDir, state);
    if (!file.start) continue;
    history.roll(docsDir, file, today);
    history.save(docsDir, file);
  }
}

function countFilledDays(docsDir, state) {
  const file = history.load(docsDir, state);
  if (!file.start || !file.days) return 0;
  let n = 0;
  for (let i = 0; i < file.days; i++) {
    if (file.fuels.U91.avg[i] !== null && file.fuels.U91.avg[i] !== undefined) n++;
  }
  return n;
}

module.exports = { mergeStateDays, trimAllStates, countFilledDays };
