'use strict';

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

// Used to decide which local calendar day a reading belongs to, and which
// scheduled run should record each state. Intl handles DST so the collector
// does not carry an offset table.
const TIMEZONES = {
  NSW: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  WA: 'Australia/Perth',
  TAS: 'Australia/Hobart',
  NT: 'Australia/Darwin',
  ACT: 'Australia/Sydney',
};

const LABELS = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  SA: 'South Australia',
  WA: 'Western Australia',
  TAS: 'Tasmania',
  NT: 'Northern Territory',
  ACT: 'Australian Capital Territory',
};

// Perth runs a weekly cycle and WA publishes tomorrow's price, so it gets
// exact one-day-ahead advice. The rest are handled by phase or percentile.
const WEEKLY_CYCLE = new Set(['WA']);

function localParts(date, state) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONES[state],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl can render midnight as "24" in some environments.
    hour: Number(parts.hour) % 24,
  };
}

module.exports = { STATES, TIMEZONES, LABELS, WEEKLY_CYCLE, localParts };
