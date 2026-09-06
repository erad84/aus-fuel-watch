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

/** Geometric mean of positive prices (tenths). Softens high outliers vs arithmetic mean. */
function geomean(values) {
  if (!values.length) return null;
  let logSum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !(v > 0)) continue;
    logSum += Math.log(v);
    n++;
  }
  if (!n) return null;
  return Math.round(Math.exp(logSum / n));
}

/**
 * Most common price (exact tenths). On a tie, pick the tied value nearest the median.
 * Returns null when every price is unique (no repeated mode).
 */
function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (!counts.size) return null;
  let bestCount = 0;
  for (const c of counts.values()) if (c > bestCount) bestCount = c;
  if (bestCount < 2) return null;
  const tied = [];
  for (const [v, c] of counts) if (c === bestCount) tied.push(v);
  if (tied.length === 1) return tied[0];
  const med = median([...values].sort((a, b) => a - b));
  tied.sort((a, b) => Math.abs(a - med) - Math.abs(b - med) || a - b);
  return tied[0];
}

function summarise(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    avg: Math.round(sum / sorted.length),
    gmean: geomean(sorted),
    mode: mode(sorted),
    med: median(sorted),
    p10: quantile(sorted, 0.1),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * @param {Array} stations normalised station records with `prices` in tenths
 * @returns {Object} state code -> {
 *   state: {fuel: stats},
 *   metro: {fuel: stats},
 *   regional: {fuel: stats}  // state stations outside metro
 * }
 */
function aggregate(stations) {
  const buckets = new Map();

  function bucket(state) {
    if (!buckets.has(state)) {
      buckets.set(state, { state: {}, metro: {}, regional: {} });
      for (const f of FUELS) {
        buckets.get(state).state[f] = [];
        buckets.get(state).metro[f] = [];
        buckets.get(state).regional[f] = [];
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
      else b.regional[fuel].push(price);
    }
  }

  const out = {};
  for (const [state, b] of buckets) {
    out[state] = { state: {}, metro: {}, regional: {} };
    for (const f of FUELS) {
      const st = summarise(b.state[f]);
      const me = summarise(b.metro[f]);
      const reg = summarise(b.regional[f]);
      if (st) out[state].state[f] = st;
      if (me) out[state].metro[f] = me;
      if (reg) out[state].regional[f] = reg;
    }
  }
  return out;
}

module.exports = { aggregate, summarise, geomean, mode };
