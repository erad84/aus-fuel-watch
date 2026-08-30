'use strict';

// Petrolmate snapshot adapter.
//
// Uses /api/summary and nothing else. robots.txt disallows /api/ with an
// explicit `Allow: /api/summary`, so that one endpoint is the only part of the
// API a scheduled job should touch. It happens to return every state and fuel in
// a single ~3KB response, so one request per run covers the country. See
// petrolmate.md for the full probe notes.

const { FROM_PETROLMATE } = require('../fuels');

const URL = 'https://petrolmate.com.au/api/summary';

// Identifies the job so the operator can see who we are and get in touch.
const USER_AGENT =
  'AusFuelWatch/1.0 (Pebble watchapp; +https://github.com/erad84/aus-fuel-watch)';

const NAME = 'petrolmate';
const ATTRIBUTION = 'Petrolmate (petrolmate.com.au)';

function toTenths(cents) {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return null;
  return Math.round(cents * 10);
}

async function fetchSnapshot({ timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`petrolmate /api/summary returned HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.states !== 'object') {
    throw new Error('petrolmate /api/summary returned an unexpected shape');
  }

  const states = {};
  for (const [state, byFuel] of Object.entries(body.states)) {
    const out = {};
    for (const [srcFuel, v] of Object.entries(byFuel)) {
      const fuel = FROM_PETROLMATE[srcFuel];
      if (!fuel || !v) continue;
      out[fuel] = {
        avg: toTenths(v.avg),
        min: toTenths(v.min),
        max: toTenths(v.max),
        n: typeof v.stations === 'number' ? v.stations : null,
      };
    }
    states[state.toUpperCase()] = out;
  }

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    generatedAt: typeof body.generated_at === 'string' ? body.generated_at : null,
    fetchedAt: new Date().toISOString(),
    states,
  };
}

module.exports = { NAME, URL, USER_AGENT, ATTRIBUTION, fetchSnapshot };
