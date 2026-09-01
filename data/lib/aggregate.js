'use strict';

// Turns station-level rows into daily regional aggregates.
//
// The metro split is the reason this pivot was worth doing. A state-wide mean
// blends metro stations that hike on a Tuesday with regional ones that follow
// days or weeks later, which smears the price cycle into a smooth wave with no
// detectable edge. Averaging only the capital preserves the sawtooth.
//
// Median is carried alongside mean because a mean is dragged around by remote
// outliers, and p10 approximates "the good prices near me" better than min,
// which is a single station and jumps about.

const { metroOf } = require('./regions');
const { FUELS } = require('./fuels');

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function summarise(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    avg: Math.round(sum / sorted.length),
    med: median(sorted),
    p10: quantile(sorted, 0.1),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * @param {Array} stations normalised station records with `prices` in tenths
 * @returns {Object} state code -> { state: {fuel: stats}, metro: {fuel: stats} }
 */
function aggregate(stations) {
  const buckets = new Map();

  function bucket(state) {
    if (!buckets.has(state)) {
      buckets.set(state, { state: {}, metro: {} });
      for (const f of FUELS) {
        buckets.get(state).state[f] = [];
        buckets.get(state).metro[f] = [];
      }
    }
    return buckets.get(state);
  }

  for (const s of stations) {
    if (!s.state) continue;
    const b = bucket(s.state);
    // Prefer a jurisdiction's own metro grouping where it publishes one. MyFuel
    // NT's Darwin/Palmerston/Litchfield regions put 55 stations in Greater
    // Darwin against 50 for a 30km radius, and the regulator's boundary is the
    // one that matches how the market actually behaves.
    const inMetro =
      typeof s.metro === 'boolean' ? s.metro : metroOf(s.lat, s.lng, s.state) === s.state;
    for (const [fuel, price] of Object.entries(s.prices)) {
      if (!b.state[fuel]) continue;
      if (typeof price !== 'number') continue;
      b.state[fuel].push(price);
      if (inMetro) b.metro[fuel].push(price);
    }
  }

  const out = {};
  for (const [state, b] of buckets) {
    out[state] = { state: {}, metro: {} };
    for (const f of FUELS) {
      const st = summarise(b.state[f]);
      const me = summarise(b.metro[f]);
      if (st) out[state].state[f] = st;
      if (me) out[state].metro[f] = me;
    }
  }
  return out;
}

module.exports = { aggregate, summarise };
