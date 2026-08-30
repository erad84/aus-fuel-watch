'use strict';

// Fits the small set of cycle parameters the watch needs before it has collected
// enough history of its own. Everything here is derived analysis (period,
// amplitude, turning points), not a reproduction of any source series, which is
// why only these outputs get published.
//
// Why this is not spike detection. City-level fuel prices are a sawtooth: a 25c
// overnight hike then a slow decline. State-wide averages are not. Averaging
// across a whole state blends metro stations that hike on a Tuesday with
// regional ones that follow days or weeks later, so the hike is smeared out.
// Measured on the seed workbook, VIC U91 spans 54.9c over 88 days yet its
// largest single-day rise is only +4.5c. A day-over-day threshold finds nothing.
// So the cycle is recovered from periodicity in the differences plus turning
// points on a smoothed series.

const DAY_MS = 86400000;

function isoToDayNum(iso) {
  return Math.round(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
}

function dayNumToISO(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function round(n, dp) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// Expand a sparse series into one slot per calendar day so differences are only
// taken between genuinely adjacent days. Gaps stay null: the seed states plainly
// that missing periods are not interpolated, and filling them would manufacture
// movement that never happened.
function densify(series) {
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startNum = isoToDayNum(sorted[0].date);
  const endNum = isoToDayNum(sorted[sorted.length - 1].date);
  const values = new Array(endNum - startNum + 1).fill(null);
  for (const p of sorted) values[isoToDayNum(p.date) - startNum] = p.cents;
  return { startNum, values };
}

function denseDiffs(values) {
  const d = new Array(values.length - 1).fill(null);
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== null && values[i - 1] !== null) d[i - 1] = values[i] - values[i - 1];
  }
  return d;
}

// Centred 3-day mean. Just enough to stop single-day reporting noise from
// creating a false turning point, without blunting a real one.
function smooth3(values) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(values.length - 1, i + 1); k++) {
      if (values[k] === null) continue;
      sum += values[k];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function pearsonAtLag(d, lag) {
  const a = [];
  const b = [];
  for (let i = 0; i + lag < d.length; i++) {
    if (d[i] === null || d[i + lag] === null) continue;
    a.push(d[i]);
    b.push(d[i + lag]);
  }
  if (a.length < 8) return null;
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    va += x * x;
    vb += y * y;
  }
  if (va === 0 || vb === 0) return null;
  return num / Math.sqrt(va * vb);
}

// The shortest real retail cycle in Australia is Perth's weekly one, so lags
// below this are physically implausible and only ever pick up reporting noise.
const MIN_PERIOD_DAYS = 6;

// Correlation floor below which a "period" is indistinguishable from noise.
// Measured on the seed workbook, WA scores r=0.82 while every state-wide
// eastern series sits near 0.2, which is nothing.
const MIN_PERIOD_R = 0.45;

// Dominant period from the autocorrelation of first differences. Differencing
// matters: a crude-oil trend adds a near-constant drift to every difference,
// which correlation removes, so what is left is the repeating cycle. The raw
// level series would instead be dominated by the trend.
function findPeriod(diffs, maxLagCap) {
  const maxLag = Math.min(50, maxLagCap);
  const valid = [];
  for (let lag = MIN_PERIOD_DAYS; lag <= maxLag; lag++) {
    const r = pearsonAtLag(diffs, lag);
    if (r !== null) valid.push({ lag, r });
  }
  if (!valid.length) return { period: null, strength: null };

  const best = valid.reduce((m, x) => (x.r > m.r ? x : m), valid[0]);
  const strength = round(best.r, 3);
  if (best.r < MIN_PERIOD_R) return { period: null, strength };

  // Autocorrelation also peaks at multiples of the true period: WA scores 0.837
  // at lag 21 and 0.829 at lag 7, but the real cycle is weekly. Prefer a shorter
  // lag when it is nearly as strong AND is close to an integer divisor of the
  // best lag, which is what a genuine harmonic looks like. The divisor test is
  // what makes the loose correlation tolerance safe; an earlier version omitted
  // it and collapsed every weakly-correlated series onto the minimum lag.
  const byLag = new Map(valid.map((x) => [x.lag, x.r]));
  const harmonics = valid.filter((x) => {
    if (x.lag >= best.lag) return false;
    if (x.r < best.r * 0.9) return false;
    const prev = byLag.get(x.lag - 1);
    const next = byLag.get(x.lag + 1);
    if (!((prev === undefined || x.r >= prev) && (next === undefined || x.r >= next))) return false;
    return Math.abs(best.lag % x.lag) <= 1 || Math.abs((best.lag % x.lag) - x.lag) <= 1;
  });
  return { period: harmonics.length ? harmonics[0].lag : best.lag, strength };
}

function centredMA(values, window) {
  const half = (window - 1) / 2;
  const need = Math.ceil(window * 0.6);
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      if (values[k] === null) continue;
      sum += values[k];
      n++;
    }
    if (n >= need) out[i] = sum / n;
  }
  return out;
}

// Cycle amplitude has to be measured against the trend, not against the whole
// window. VIC U91 spans 44c over the seed window, but almost all of that is the
// underlying crude move rather than anything a driver can time. Subtracting a
// centred mean one period wide removes the trend and leaves the oscillation.
function cycleResidual(values, period) {
  const w = period % 2 ? period : period + 1;
  const ma = centredMA(values, w);
  const res = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== null && ma[i] !== null) res[i] = values[i] - ma[i];
  }
  return res;
}

// Swing filter. Walks the series tracking the running extreme and confirms a
// turning point once price retraces from it by at least minSwing. This finds the
// rounded turns of a state-wide average, which a threshold on daily change
// cannot see.
function zigzag(values, minSwing) {
  const pts = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== null) pts.push({ i, v: values[i] });
  if (pts.length < 3) return [];

  const pivots = [];
  let dir = 0;
  let ext = pts[0];
  let lowSoFar = pts[0];
  let highSoFar = pts[0];

  for (let k = 1; k < pts.length; k++) {
    const p = pts[k];
    if (dir === 1) {
      if (p.v >= ext.v) ext = p;
      else if (ext.v - p.v >= minSwing) {
        pivots.push({ idx: ext.i, type: 'peak', value: ext.v });
        dir = -1;
        ext = p;
      }
    } else if (dir === -1) {
      if (p.v <= ext.v) ext = p;
      else if (p.v - ext.v >= minSwing) {
        pivots.push({ idx: ext.i, type: 'trough', value: ext.v });
        dir = 1;
        ext = p;
      }
    } else {
      if (p.v < lowSoFar.v) lowSoFar = p;
      if (p.v > highSoFar.v) highSoFar = p;
      if (p.v - lowSoFar.v >= minSwing) {
        pivots.push({ idx: lowSoFar.i, type: 'trough', value: lowSoFar.v });
        dir = 1;
        ext = p;
      } else if (highSoFar.v - p.v >= minSwing) {
        pivots.push({ idx: highSoFar.i, type: 'peak', value: highSoFar.v });
        dir = -1;
        ext = p;
      }
    }
  }
  return pivots;
}

// Weekday effect, isolated from the cycle by subtracting a centred 7-day mean
// before averaging by weekday. Without detrending, a long climb would smear
// across weekdays and drown the real signal. Index 0 is Sunday.
function dayOfWeekBias(startNum, values) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (let i = 3; i < values.length - 3; i++) {
    if (values[i] === null) continue;
    let sum = 0;
    let n = 0;
    for (let k = i - 3; k <= i + 3; k++) {
      if (values[k] === null) continue;
      sum += values[k];
      n++;
    }
    if (n < 5) continue;
    const dow = new Date((startNum + i) * DAY_MS).getUTCDay();
    sums[dow] += values[i] - sum / n;
    counts[dow]++;
  }
  return sums.map((s, i) => (counts[i] ? round(s / counts[i], 2) : null));
}

/**
 * @param {{date: string, cents: number}[]} series
 * @returns fitted params. `confidence` is the field that matters: 'good' means
 *          the watch may quote cycle timing, 'fair' means direction and range
 *          only, 'none' means fall back to relative-to-recent labels.
 */
function fit(series) {
  const clean = series.filter((p) => p && typeof p.cents === 'number' && !Number.isNaN(p.cents));
  if (clean.length < 21) {
    return { confidence: 'none', hasCycle: false, reason: 'too few points', days: clean.length };
  }

  const { startNum, values } = densify(clean);
  const present = values.filter((v) => v !== null);
  const diffs = denseDiffs(values);
  const availDiffs = diffs.filter((d) => d !== null);

  const med = median(present);
  const p10 = quantile(present, 0.1);
  const p90 = quantile(present, 0.9);
  const spread = p90 - p10;

  const { period, strength } = findPeriod(diffs, Math.floor(values.length / 2));
  const cyclesObserved = period ? round(values.length / period, 1) : null;

  // Amplitude is measured on the detrended residual, so it reflects the part of
  // the movement a driver can actually time rather than the crude-oil trend.
  let amplitude = null;
  let residual = null;
  if (period) {
    residual = cycleResidual(values, period);
    const res = residual.filter((v) => v !== null);
    if (res.length >= period) {
      // Trim only the extreme tails. A sawtooth spends roughly one day in seven
      // at its peak, so 5 percent trimming would cut the peak off and understate
      // the amplitude that matters most.
      amplitude = quantile(res, 0.98) - quantile(res, 0.02);
    }
  }

  let confidence = 'none';
  if (period && strength >= 0.6 && cyclesObserved >= 4 && amplitude !== null && amplitude >= 8) {
    confidence = 'good';
  } else if (
    period &&
    strength >= MIN_PERIOD_R &&
    cyclesObserved >= 2.5 &&
    amplitude !== null &&
    amplitude >= 6
  ) {
    confidence = 'fair';
  }

  // Turning points: on the residual when a cycle is established, since that is
  // the cycle phase the watch needs. Otherwise on the smoothed level series,
  // which still answers the simpler question of whether prices are rising.
  const basis = confidence !== 'none' ? residual : smooth3(values);
  const basisPresent = basis.filter((v) => v !== null);
  const basisSpread =
    basisPresent.length > 4 ? quantile(basisPresent, 0.9) - quantile(basisPresent, 0.1) : spread;
  const minSwing = Math.max(3, 0.25 * basisSpread);
  const pivots = zigzag(basis, minSwing);

  const peakGaps = [];
  const troughGaps = [];
  let lastPeakIdx = null;
  let lastTroughIdx = null;
  for (const p of pivots) {
    if (p.type === 'peak') {
      if (lastPeakIdx !== null) peakGaps.push(p.idx - lastPeakIdx);
      lastPeakIdx = p.idx;
    } else {
      if (lastTroughIdx !== null) troughGaps.push(p.idx - lastTroughIdx);
      lastTroughIdx = p.idx;
    }
  }
  const pivotPeriod = median([...peakGaps, ...troughGaps]);

  const last = pivots.length ? pivots[pivots.length - 1] : null;
  const declines = availDiffs.filter((d) => d < 0);
  const rises = availDiffs.filter((d) => d > 0);

  let reason = null;
  if (confidence === 'none') {
    if (!period) reason = `no periodicity above r=${MIN_PERIOD_R} (best r=${strength})`;
    else if (cyclesObserved < 2.5) reason = `only ${cyclesObserved} cycles in window`;
    else if (amplitude === null) reason = 'amplitude not measurable';
    else reason = `cycle amplitude only ${round(amplitude, 1)}c`;
  }

  return {
    days: clean.length,
    missing: values.length - present.length,
    windowStart: dayNumToISO(startNum),
    windowEnd: dayNumToISO(startNum + values.length - 1),

    confidence,
    hasCycle: confidence !== 'none',
    reason,

    cycleLenDays: confidence !== 'none' ? period : null,
    cycleStrength: strength,
    cyclesObserved,
    pivotPeriod: pivotPeriod === null ? null : Math.round(pivotPeriod),
    amplitude: round(amplitude, 1),
    lastTurn: last ? { type: last.type, date: dayNumToISO(startNum + last.idx) } : null,
    turnBasis: confidence !== 'none' ? 'cycle' : 'trend',
    turns: pivots.length,

    minSwing: round(minSwing, 2),
    medianAbsDailyChange: round(median(availDiffs.map(Math.abs)), 2),
    declineRatePerDay: declines.length ? round(median(declines), 2) : null,
    riseRatePerDay: rises.length ? round(median(rises), 2) : null,
    largestDailyRise: availDiffs.length ? round(Math.max(...availDiffs), 1) : null,

    dowBias: dayOfWeekBias(startNum, values),
    p10Offset: round(p10 - med, 1),
    p90Offset: round(p90 - med, 1),
    rangeSpread: round(spread, 1),
  };
}

module.exports = { fit, median, quantile, isoToDayNum, dayNumToISO, zigzag, findPeriod };
