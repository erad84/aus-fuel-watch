/* Cycle stage models for the viewer dial + peak/bottom lines.
 * Plain script: exposes window.CycleModels
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'afw.cycleModel';
  const DEFAULT_ID = 'current';

  const LABELS = {
    peak: 'Peak',
    falling: 'Falling',
    bottom: 'Bottom',
    rising: 'Rising',
    unknown: 'Unclear',
    flat: 'Flat',
  };

  const BAND_LABELS = {
    peak: 'High',
    falling: 'Falling',
    bottom: 'Low',
    rising: 'Rising',
    unknown: 'Unclear',
    flat: 'Flat',
  };

  function seriesAvgAt(series, index) {
    const v = series?.[index]?.avg;
    return v != null ? v : null;
  }

  function clamp01(x) {
    if (Number.isNaN(x) || x == null) return 0;
    return Math.max(0, Math.min(1, x));
  }

  function stageFromDialAngle(angle) {
    const a = ((angle % 360) + 360) % 360;
    if (a < 45 || a >= 315) return 'peak';
    if (a < 135) return 'falling';
    if (a < 225) return 'bottom';
    return 'rising';
  }

  function priceRangeInSpan(series, from, to) {
    let lo = null;
    let hi = null;
    for (let i = from; i <= to; i++) {
      const v = seriesAvgAt(series, i);
      if (v == null) continue;
      if (lo == null || v < lo) lo = v;
      if (hi == null || v > hi) hi = v;
    }
    return { lo, hi };
  }

  function localDaySlope(series, dataIndex) {
    if (dataIndex <= 0) return 0;
    let j = dataIndex - 1;
    while (j >= 0 && seriesAvgAt(series, j) == null) j--;
    if (j < 0) return 0;
    const a = seriesAvgAt(series, j);
    const b = seriesAvgAt(series, dataIndex);
    if (a == null || b == null) return 0;
    return (b - a) / Math.max(1, dataIndex - j);
  }

  function pathSlopeFromMarker(series, dataIndex, markerIndex) {
    if (dataIndex <= markerIndex) return 0;
    const a = seriesAvgAt(series, markerIndex);
    const b = seriesAvgAt(series, dataIndex);
    if (a == null || b == null) return 0;
    return (b - a) / (dataIndex - markerIndex);
  }

  function steepDayForAmp(amp) {
    return Math.max(1.2, Math.abs(amp) * 0.12);
  }

  function priorOppositeTurn(turns, prev) {
    if (!turns?.length || !prev) return null;
    const want = prev.type === 'trough' ? 'peak' : 'trough';
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.index < prev.index && t.type === want) return t;
    }
    return null;
  }

  function packStage(angle, labels, extra) {
    const a = ((angle % 360) + 360) % 360;
    const stage = stageFromDialAngle(a);
    return {
      stage,
      label: labels[stage] || LABELS[stage],
      angle: a,
      placed: true,
      source: 'markers',
      confidence: 'none',
      ...(extra || {}),
    };
  }

  function unknownStage(labels) {
    return {
      stage: 'unknown',
      label: labels.unknown || LABELS.unknown,
      angle: null,
      placed: false,
      source: 'none',
      confidence: 'none',
    };
  }

  function findZigzagTurns(series, minSwingOpt) {
    const pts = [];
    for (let i = 0; i < series.length; i++) {
      if (series[i]?.avg != null) pts.push({ i, v: series[i].avg });
    }
    if (pts.length < 5) return [];

    const vals = pts.map((p) => p.v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const spread = hi - lo;
    if (spread < 2.5) return [];
    const minSwing = minSwingOpt ?? Math.max(2.0, 0.14 * spread);

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
          pivots.push({ index: ext.i, type: 'peak' });
          dir = -1;
          ext = p;
        }
      } else if (dir === -1) {
        if (p.v <= ext.v) ext = p;
        else if (p.v - ext.v >= minSwing) {
          pivots.push({ index: ext.i, type: 'trough' });
          dir = 1;
          ext = p;
        }
      } else {
        if (p.v < lowSoFar.v) lowSoFar = p;
        if (p.v > highSoFar.v) highSoFar = p;
        if (p.v - lowSoFar.v >= minSwing) {
          pivots.push({ index: lowSoFar.i, type: 'trough' });
          dir = 1;
          ext = p;
        } else if (highSoFar.v - p.v >= minSwing) {
          pivots.push({ index: highSoFar.i, type: 'peak' });
          dir = -1;
          ext = p;
        }
      }
    }
    return pivots;
  }

  function isLocalExtremum(avgs, index, type, radius = 1) {
    const v = avgs[index];
    if (v == null) return false;
    const lo = Math.max(0, index - radius);
    const hi = Math.min(avgs.length - 1, index + radius);
    for (let i = lo; i <= hi; i++) {
      if (i === index || avgs[i] == null) continue;
      if (type === 'peak' && avgs[i] > v) return false;
      if (type === 'trough' && avgs[i] < v) return false;
    }
    return true;
  }

  function filterTurnQuality(series, turns, minSwing, promScale = 1) {
    const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
    const n = avgs.length;
    let out = turns.filter((t) => {
      if (t.index >= n - 1) return false;
      if (t.index === 0) return isLocalExtremum(avgs, 0, t.type, 1);
      return isLocalExtremum(avgs, t.index, t.type, 1);
    });

    out.sort((a, b) => a.index - b.index);
    const alt = [];
    for (const t of out) {
      const prev = alt[alt.length - 1];
      if (!prev || prev.type !== t.type) {
        alt.push(t);
        continue;
      }
      const prefer =
        t.type === 'peak'
          ? avgs[t.index] >= avgs[prev.index]
          : avgs[t.index] <= avgs[prev.index];
      if (prefer) alt[alt.length - 1] = t;
    }

    const scale = Math.max(0.35, Math.min(2.5, promScale || 1));
    const minProm = Math.max(1.0, (minSwing || 2) * 0.45 * scale);
    return alt.filter((t, i) => {
      const prev = alt[i - 1];
      const next = alt[i + 1];
      const v = avgs[t.index];
      if (v == null) return false;
      if (prev && next) {
        const opp = Math.min(Math.abs(v - avgs[prev.index]), Math.abs(v - avgs[next.index]));
        return opp >= minProm * 0.5;
      }
      return true;
    });
  }

  function dedupeNearbyTurns(series, turns, minSep = 5) {
    const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
    const out = [];
    for (const t of [...turns].sort((a, b) => a.index - b.index)) {
      const prev = out[out.length - 1];
      if (prev && prev.type === t.type && t.index - prev.index < minSep) {
        const prefer =
          t.type === 'peak'
            ? avgs[t.index] >= avgs[prev.index]
            : avgs[t.index] <= avgs[prev.index];
        if (prefer) out[out.length - 1] = t;
      } else {
        out.push(t);
      }
    }
    return out;
  }

  // Peak/bottom line frequency (replaces cycle-window lookback).
  const TURN_TUNE_KEY = 'afw.turnTune';
  const DEFAULT_TURN_TUNE = {
    sensitivity: 85, // 0–100: higher → more lines
    minGapDays: 5, // 3–21
    coarseness: 25, // 1–100: higher → fewer lines (scales swing + gap)
    fftAssist: 0, // 0–100: FFT period/phase influence on turns
  };

  function numOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampTurnTune(t) {
    return {
      sensitivity: Math.max(0, Math.min(100, Math.round(numOr(t.sensitivity, DEFAULT_TURN_TUNE.sensitivity)))),
      minGapDays: Math.max(3, Math.min(21, Math.round(numOr(t.minGapDays, DEFAULT_TURN_TUNE.minGapDays)))),
      coarseness: Math.max(1, Math.min(100, Math.round(numOr(t.coarseness, DEFAULT_TURN_TUNE.coarseness)))),
      fftAssist: Math.max(0, Math.min(100, Math.round(numOr(t.fftAssist, DEFAULT_TURN_TUNE.fftAssist)))),
    };
  }

  function loadTurnTune() {
    try {
      const raw = global.localStorage?.getItem(TURN_TUNE_KEY);
      if (!raw) return { ...DEFAULT_TURN_TUNE };
      return clampTurnTune({ ...DEFAULT_TURN_TUNE, ...JSON.parse(raw) });
    } catch (_) {
      return { ...DEFAULT_TURN_TUNE };
    }
  }

  let turnTune = loadTurnTune();

  function getTurnTune() {
    return { ...turnTune };
  }

  function setTurnTune(partial) {
    turnTune = clampTurnTune({ ...turnTune, ...(partial || {}) });
    try {
      global.localStorage?.setItem(TURN_TUNE_KEY, JSON.stringify(turnTune));
    } catch (_) {
      /* ignore */
    }
    return getTurnTune();
  }

  function resetTurnTune() {
    return setTurnTune({ ...DEFAULT_TURN_TUNE });
  }

  /** Resolve swing / gap / prominence from the turn sliders. */
  function resolveTurnDetectParams(state) {
    const t = turnTune;
    const sens = t.sensitivity / 100;
    const coarse = t.coarseness / 100;
    const swingMult = (2.1 - 1.6 * sens) * (0.75 + 0.85 * coarse);
    const gapMult = 0.75 + 0.9 * coarse;
    const promScale = 0.55 + 1.0 * coarse;
    const minGap = Math.max(2, Math.round(t.minGapDays * gapMult));
    return { swingMult, minGap, promScale, fftAssist: t.fftAssist / 100, raw: { ...t } };
  }

  /**
   * DFT on linearly-detrended means. Returns dominant cycle in ~6–45 day band
   * (period, strength 0–1, bin k, phase, n, indexMap series→sample).
   */
  function findDominantFftCycle(series) {
    const pts = [];
    for (let i = 0; i < series.length; i++) {
      const v = seriesAvgAt(series, i);
      if (v != null) pts.push({ i, v });
    }
    const n = pts.length;
    if (n < 16) return null;

    let sumT = 0;
    let sumV = 0;
    let sumTT = 0;
    let sumTV = 0;
    for (let t = 0; t < n; t++) {
      sumT += t;
      sumV += pts[t].v;
      sumTT += t * t;
      sumTV += t * pts[t].v;
    }
    const denom = n * sumTT - sumT * sumT;
    const slope = Math.abs(denom) < 1e-12 ? 0 : (n * sumTV - sumT * sumV) / denom;
    const intercept = (sumV - slope * sumT) / n;
    const xs = pts.map((p, t) => p.v - (intercept + slope * t));

    const minPeriod = 6;
    const maxPeriod = Math.min(45, Math.floor(n / 2));
    let best = null;
    let powerSum = 0;
    const powers = [];

    for (let k = 1; k <= Math.floor(n / 2); k++) {
      const period = n / k;
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / n;
      for (let t = 0; t < n; t++) {
        re += xs[t] * Math.cos(w * t);
        im -= xs[t] * Math.sin(w * t);
      }
      const power = re * re + im * im;
      powerSum += power;
      if (period < minPeriod || period > maxPeriod) continue;
      powers.push(power);
      const phase = Math.atan2(im, re);
      if (!best || power > best.power) {
        best = { k, period, power, phase, re, im };
      }
    }
    if (!best || powerSum < 1e-12) return null;

    const strength = best.power / powerSum;
    // Require a clear peak vs other in-band bins.
    const sorted = [...powers].sort((a, b) => b - a);
    const second = sorted[1] ?? 0;
    const peakRatio = second > 1e-12 ? best.power / second : 10;
    if (strength < 0.06 && peakRatio < 1.25) return null;

    const indexToSample = new Map(pts.map((p, t) => [p.i, t]));
    return {
      period: best.period,
      strength: Math.min(1, strength * Math.min(2, peakRatio / 1.2)),
      k: best.k,
      phase: best.phase,
      re: best.re,
      im: best.im,
      n,
      slope,
      intercept,
      indexToSample,
    };
  }

  /**
   * Reconstruct dominant FFT sinusoid + linear trend onto the price series
   * (null where the day had no mean). For chart overlay.
   */
  function fftCycleCurve(series, fft) {
    if (!series?.length || !fft?.indexToSample) return null;
    const amp = (2 / fft.n) * Math.sqrt(fft.re * fft.re + fft.im * fft.im);
    if (!(amp > 0) || !Number.isFinite(amp)) return null;
    const data = series.map(() => null);
    for (const [seriesIdx, t] of fft.indexToSample.entries()) {
      const ang = (2 * Math.PI * fft.k * t) / fft.n + fft.phase;
      data[seriesIdx] = fft.intercept + fft.slope * t + amp * Math.cos(ang);
    }
    return data;
  }

  /** Dominant cycle + price curve for the chart (null if weak / disabled). */
  function buildFftChartOverlay(series) {
    const fft = findDominantFftCycle(series);
    if (!fft) return null;
    const curve = fftCycleCurve(series, fft);
    if (!curve) return null;
    return {
      curve,
      period: fft.period,
      strength: fft.strength,
    };
  }

  /** -1..+1: +1 = turn type aligns with FFT crest (peak) or trough (bottom). */
  function fftPhaseAlign(turn, fft) {
    if (!fft) return 0;
    const t = fft.indexToSample.get(turn.index);
    if (t == null) return 0;
    const ang = (2 * Math.PI * fft.k * t) / fft.n + fft.phase;
    const c = Math.cos(ang);
    return turn.type === 'peak' ? c : -c;
  }

  /**
   * Prefer FFT-aligned extremes when merging same-type neighbours; soft-drop
   * poorly aligned turns when assist + strength are high.
   */
  function fftAssistTurns(series, turns, fft, weight) {
    if (!fft || weight <= 0 || !turns?.length) return turns || [];
    const avgs = series.map((p) => (p?.avg != null ? p.avg : null));
    const w = clamp01(weight) * clamp01(fft.strength * 2.2);

    const scored = [...turns]
      .sort((a, b) => a.index - b.index)
      .map((t) => {
        const extreme = t.type === 'peak' ? avgs[t.index] ?? -Infinity : -(avgs[t.index] ?? Infinity);
        const align = fftPhaseAlign(t, fft);
        return { ...t, _score: extreme + w * 12 * align, _align: align };
      });

    // Merge nearby same-type, preferring FFT-aligned extremes.
    const merged = [];
    const sameSep = Math.max(3, Math.round(fft.period * 0.4));
    for (const t of scored) {
      const prev = merged[merged.length - 1];
      if (prev && prev.type === t.type && t.index - prev.index < sameSep) {
        if (t._score > prev._score) merged[merged.length - 1] = t;
        continue;
      }
      merged.push(t);
    }

    const dropThresh = -0.15 - 0.35 * w;
    let out = merged.filter((t) => t._align >= dropThresh || w < 0.25);
    if (out.length < 2 && merged.length >= 2) out = merged;

    // Enforce alternation keeping higher score.
    const alt = [];
    for (const t of out) {
      const prev = alt[alt.length - 1];
      if (prev && prev.type === t.type) {
        if (t._score > prev._score) alt[alt.length - 1] = t;
        continue;
      }
      alt.push(t);
    }
    return alt.map(({ index, type }) => ({ index, type }));
  }

  function zigzagTurns(series, state) {
    const avgs = series.map((p) => p?.avg).filter((v) => v != null);
    if (avgs.length < 5) return [];
    const spread = Math.max(...avgs) - Math.min(...avgs);
    const { swingMult, minGap, promScale, fftAssist } = resolveTurnDetectParams(state);
    const baseSwing =
      state === 'WA' ? Math.max(1.5, 0.1 * spread) : Math.max(2.0, 0.14 * spread);
    const minSwing = Math.max(0.8, baseSwing * swingMult);

    const fft = fftAssist > 0 ? findDominantFftCycle(series) : null;
    let gap = minGap;
    if (fft && fft.strength > 0.08) {
      const fftGap = Math.max(3, Math.round(fft.period * 0.5));
      gap = Math.round(minGap * (1 - fftAssist) + fftGap * fftAssist);
    }

    let turns = findZigzagTurns(series, minSwing);
    turns = filterTurnQuality(series, turns, minSwing, promScale);
    turns = dedupeNearbyTurns(series, turns, gap);
    turns = fftAssistTurns(series, turns, fft, fftAssist);
    turns = turns.filter((t) => t.index < series.length - 1);
    turns.sort((a, b) => a.index - b.index);
    return turns;
  }

  function firstDiffs(series) {
    const diffs = [];
    let prev = null;
    for (let i = 0; i < series.length; i++) {
      const v = seriesAvgAt(series, i);
      if (v == null) {
        prev = null;
        continue;
      }
      if (prev != null) diffs.push(v - prev);
      prev = v;
    }
    return diffs;
  }

  function pearsonAtLag(xs, lag) {
    if (xs.length <= lag + 2) return null;
    const n = xs.length - lag;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i];
      sy += xs[i + lag];
    }
    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx;
      const b = xs[i + lag] - my;
      num += a * b;
      va += a * a;
      vb += b * b;
    }
    if (va < 1e-12 || vb < 1e-12) return null;
    return num / Math.sqrt(va * vb);
  }

  function findPeriodAcf(series) {
    const diffs = firstDiffs(series);
    const maxLag = Math.min(50, Math.floor(diffs.length / 2));
    const MIN_PERIOD_DAYS = 6;
    const MIN_PERIOD_R = 0.35;
    const valid = [];
    for (let lag = MIN_PERIOD_DAYS; lag <= maxLag; lag++) {
      const r = pearsonAtLag(diffs, lag);
      if (r !== null) valid.push({ lag, r });
    }
    if (!valid.length) return { period: null, strength: null };
    const best = valid.reduce((m, x) => (x.r > m.r ? x : m), valid[0]);
    if (best.r < MIN_PERIOD_R) return { period: null, strength: best.r };
    const byLag = new Map(valid.map((x) => [x.lag, x.r]));
    const harmonics = valid.filter((x) => {
      if (x.lag >= best.lag) return false;
      if (x.r < best.r * 0.9) return false;
      const prev = byLag.get(x.lag - 1);
      const next = byLag.get(x.lag + 1);
      if (!((prev === undefined || x.r >= prev) && (next === undefined || x.r >= next))) return false;
      return Math.abs(best.lag % x.lag) <= 1 || Math.abs((best.lag % x.lag) - x.lag) <= 1;
    });
    return {
      period: harmonics.length ? harmonics[0].lag : best.lag,
      strength: best.r,
    };
  }

  function quantileSorted(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function rollingPercentile(series, index, window, q) {
    const lo = Math.max(0, index - window + 1);
    const vals = [];
    for (let i = lo; i <= index; i++) {
      const v = seriesAvgAt(series, i);
      if (v != null) vals.push(v);
    }
    if (vals.length < 5) return null;
    vals.sort((a, b) => a - b);
    return quantileSorted(vals, q);
  }

  const WA_CYCLE = { period: 7, riseDays: 2, fallDays: 5 };

  const WA_WEEKLY_AFTER_LAST_KEY = 'afw.waWeeklyAfterLast';
  let waWeeklyAfterLast = false;
  try {
    const raw = global.localStorage?.getItem(WA_WEEKLY_AFTER_LAST_KEY);
    if (raw === '0' || raw === 'false') waWeeklyAfterLast = false;
    else if (raw === '1' || raw === 'true') waWeeklyAfterLast = true;
  } catch (_) {
    /* ignore */
  }

  function waWeeklyAfterLastEnabled() {
    return waWeeklyAfterLast;
  }

  function setWaWeeklyAfterLast(on) {
    waWeeklyAfterLast = !!on;
    try {
      global.localStorage?.setItem(WA_WEEKLY_AFTER_LAST_KEY, waWeeklyAfterLast ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
    return waWeeklyAfterLast;
  }

  function waDialAfterLastMarker(series, dataIndex, prev) {
    const price = seriesAvgAt(series, dataIndex);
    const anchor = seriesAvgAt(series, prev.index);
    if (price == null || anchor == null) return null;

    const { riseDays, fallDays, period } = WA_CYCLE;
    const days = Math.max(0, dataIndex - prev.index);
    const d = days % period;
    const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);
    const refAmp = Math.max(8, (hi ?? price) - (lo ?? price), Math.abs(price - anchor), 0.05);

    if (prev.type === 'trough') {
      if (d <= riseDays) {
        const timeU = riseDays <= 0 ? 1 : d / riseDays;
        const priceU = clamp01((price - anchor) / refAmp);
        const u = clamp01(0.6 * timeU + 0.4 * priceU);
        return 180 + u * 180;
      }
      const timeU = (d - riseDays) / fallDays;
      const peakEst = hi ?? Math.max(anchor, price);
      const priceU = clamp01((peakEst - price) / Math.max(0.05, peakEst - (lo ?? anchor)));
      const u = clamp01(0.6 * timeU + 0.4 * priceU);
      return u * 180;
    }

    if (d <= fallDays) {
      const timeU = fallDays <= 0 ? 1 : d / fallDays;
      const priceU = clamp01((anchor - price) / refAmp);
      const u = clamp01(0.6 * timeU + 0.4 * priceU);
      return u * 180;
    }
    const timeU = (d - fallDays) / riseDays;
    const troughEst = lo ?? Math.min(anchor, price);
    const priceU = clamp01((price - troughEst) / Math.max(0.05, (hi ?? price) - troughEst));
    const u = clamp01(0.6 * timeU + 0.4 * priceU);
    return 180 + u * 180;
  }

  function dialAngleCurrentAfterLast(series, dataIndex, prev, oppositePrice) {
    const price = seriesAvgAt(series, dataIndex);
    const anchor = seriesAvgAt(series, prev.index);
    if (price == null || anchor == null) return null;

    const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);
    const local = localDaySlope(series, dataIndex);
    const path = pathSlopeFromMarker(series, dataIndex, prev.index);

    if (prev.type === 'trough') {
      const peakTarget =
        oppositePrice != null
          ? oppositePrice
          : anchor + Math.max(8, (hi ?? price) - anchor, 0.05);
      const amp = Math.max(0.05, peakTarget - anchor);
      const priceProg = (price - anchor) / amp;
      const steep = steepDayForAmp(amp);
      const FLAT = 0.3;

      if (price <= anchor + 0.05 && local <= FLAT) return 180;

      const riseStr = local > FLAT ? clamp01(local / steep) : 0;
      const pathAssist =
        path > 0.15 && priceProg < 0.85 ? clamp01(path / (steep * 0.5)) * 0.45 : 0;
      const risingStrength = Math.max(riseStr, pathAssist);
      const stillRising =
        local > FLAT || (path > 0.15 && local >= -0.15 && priceProg < 0.85);

      if (stillRising && risingStrength > 0.08) {
        const priceAngle = 180 + clamp01(priceProg) * 180;
        if (priceProg >= 0.85 || price >= peakTarget - 0.3) {
          return 270 + (1 - risingStrength) * 45;
        }
        const peakCap = 315 - risingStrength * 50;
        return Math.min(priceAngle, Math.max(180, peakCap));
      }

      if (local >= -FLAT) return 180 + clamp01(priceProg) * 180;

      const rallyHi = Math.max(peakTarget, hi ?? price, price);
      const drop = clamp01((rallyHi - price) / Math.max(0.05, rallyHi - anchor));
      return drop * 180;
    }

    const troughTarget =
      oppositePrice != null
        ? oppositePrice
        : anchor - Math.max(8, anchor - (lo ?? price), 0.05);
    const amp = Math.max(0.05, anchor - troughTarget);
    const priceProg = (anchor - price) / amp;
    const steep = steepDayForAmp(amp);
    const FLAT = 0.3;

    if (price >= anchor - 0.05 && local >= -FLAT) return 0;

    const fallStr = local < -FLAT ? clamp01((-local) / steep) : 0;
    const pathAssist =
      path < -0.15 && priceProg < 0.85 ? clamp01((-path) / (steep * 0.5)) * 0.45 : 0;
    const fallingStrength = Math.max(fallStr, pathAssist);
    const stillFalling =
      local < -FLAT || (path < -0.15 && local <= 0.15 && priceProg < 0.85);

    if (stillFalling && fallingStrength > 0.08) {
      const priceAngle = clamp01(priceProg) * 180;
      if (priceProg >= 0.85 || price <= troughTarget + 0.3) {
        return 90 + (1 - fallingStrength) * 45;
      }
      const maxAngle = 135 + (1 - fallingStrength) * 45;
      return Math.min(Math.max(priceAngle, 0), maxAngle);
    }

    if (local <= FLAT) return clamp01(priceProg) * 180;

    const dipLo = Math.min(troughTarget, lo ?? price, price);
    const rise = clamp01((price - dipLo) / Math.max(0.05, anchor - dipLo));
    return 180 + rise * 180;
  }

  function dialAngleArcAfterLast(series, dataIndex, prev, oppositePrice) {
    const price = seriesAvgAt(series, dataIndex);
    const anchor = seriesAvgAt(series, prev.index);
    if (price == null || anchor == null) return null;
    const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);

    if (prev.type === 'trough') {
      const peakTarget =
        oppositePrice != null
          ? Math.max(oppositePrice, anchor + 0.05)
          : anchor + Math.max(8, (hi ?? price) - anchor, 0.05);
      const amp = Math.max(0.05, peakTarget - anchor);
      if (price <= anchor + 0.05) return 180;
      return 180 + clamp01((price - anchor) / amp) * 180;
    }

    const troughTarget =
      oppositePrice != null
        ? Math.min(oppositePrice, anchor - 0.05)
        : anchor - Math.max(8, anchor - (lo ?? price), 0.05);
    const amp = Math.max(0.05, anchor - troughTarget);
    if (price >= anchor - 0.05) return 0;
    return clamp01((anchor - price) / amp) * 180;
  }

  function dialAnglePathAfterLast(series, dataIndex, prev, oppositePrice) {
    const price = seriesAvgAt(series, dataIndex);
    const anchor = seriesAvgAt(series, prev.index);
    if (price == null || anchor == null) return null;
    const local = localDaySlope(series, dataIndex);
    const path = pathSlopeFromMarker(series, dataIndex, prev.index);
    const { lo, hi } = priceRangeInSpan(series, prev.index, dataIndex);
    const oppAmp =
      oppositePrice != null
        ? Math.abs(oppositePrice - anchor)
        : Math.max(5, (hi ?? price) - (lo ?? price), Math.abs(price - anchor));
    const steep = steepDayForAmp(oppAmp);
    const FLAT = 0.3;

    if (prev.type === 'trough') {
      if (price <= anchor + 0.05 && local <= FLAT) return 180;
      const riseStr = Math.max(
        local > FLAT ? clamp01(local / steep) : 0,
        path > 0.1 ? clamp01(path / (steep * 0.5)) * 0.5 : 0
      );
      if (riseStr > 0.08 || local > FLAT) {
        return 270 + (1 - riseStr) * 45;
      }
      if (local < -FLAT) {
        const rallyHi = Math.max(hi ?? price, price, oppositePrice ?? price);
        return clamp01((rallyHi - price) / Math.max(0.05, rallyHi - anchor)) * 180;
      }
      const peakTarget = oppositePrice != null ? oppositePrice : hi ?? price;
      return 180 + clamp01((price - anchor) / Math.max(0.05, peakTarget - anchor)) * 180;
    }

    if (price >= anchor - 0.05 && local >= -FLAT) return 0;
    const fallStr = Math.max(
      local < -FLAT ? clamp01((-local) / steep) : 0,
      path < -0.1 ? clamp01((-path) / (steep * 0.5)) * 0.5 : 0
    );
    if (fallStr > 0.08 || local < -FLAT) {
      return 90 + (1 - fallStr) * 45;
    }
    if (local > FLAT) {
      const dipLo = Math.min(lo ?? price, price, oppositePrice ?? price);
      return 180 + clamp01((price - dipLo) / Math.max(0.05, anchor - dipLo)) * 180;
    }
    const troughTarget = oppositePrice != null ? oppositePrice : lo ?? price;
    return clamp01((anchor - price) / Math.max(0.05, anchor - troughTarget)) * 180;
  }

  function dialAnglePriorExtreme(series, dataIndex, prev, extremePrice) {
    const price = seriesAvgAt(series, dataIndex);
    const anchor = seriesAvgAt(series, prev.index);
    if (price == null || anchor == null || extremePrice == null) return null;

    if (prev.type === 'trough') {
      const hi = Math.max(extremePrice, anchor + 0.05);
      const amp = Math.max(0.05, hi - anchor);
      if (price <= anchor + 0.05) return 180;
      return 180 + clamp01((price - anchor) / amp) * 180;
    }

    const lo = Math.min(extremePrice, anchor - 0.05);
    const amp = Math.max(0.05, anchor - lo);
    if (price >= anchor - 0.05) return 0;
    return clamp01((anchor - price) / amp) * 180;
  }

  function angleBetweenTurns(series, dataIndex, prev, next, state, priceOnly) {
    const a = seriesAvgAt(series, prev.index);
    const b = seriesAvgAt(series, next.index);
    const price = seriesAvgAt(series, dataIndex);
    if (a == null || b == null || price == null || Math.abs(b - a) < 0.05) return null;
    const dayProg = (dataIndex - prev.index) / Math.max(1, next.index - prev.index);

    if (prev.type === 'trough' && next.type === 'peak') {
      const priceProg = clamp01((price - a) / (b - a));
      const prog =
        !priceOnly && state === 'WA'
          ? clamp01(0.85 * priceProg + 0.15 * dayProg)
          : priceProg;
      return 180 + prog * 180;
    }
    if (prev.type === 'peak' && next.type === 'trough') {
      const priceProg = clamp01((a - price) / (a - b));
      const prog =
        !priceOnly && state === 'WA'
          ? clamp01(0.4 * priceProg + 0.6 * dayProg)
          : priceProg;
      return prog * 180;
    }
    if (prev.type === 'trough') {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return 180 + clamp01((price - lo) / Math.max(0.05, hi - lo)) * 180;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return clamp01((hi - price) / Math.max(0.05, hi - lo)) * 180;
  }

  /** Blend two dial angles (degrees, same clockwise-from-top convention) via unit vectors. */
  function blendDialAngles(aDeg, bDeg, weightB) {
    const w = clamp01(weightB);
    const toRad = (d) => ((d - 90) * Math.PI) / 180; // match polarXY: 0° at top, clockwise
    const ax = Math.cos(toRad(aDeg));
    const ay = Math.sin(toRad(aDeg));
    const bx = Math.cos(toRad(bDeg));
    const by = Math.sin(toRad(bDeg));
    const x = (1 - w) * ax + w * bx;
    const y = (1 - w) * ay + w * by;
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return aDeg;
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    return ((deg % 360) + 360) % 360;
  }

  // Arc+path hybrid tune (percentages exposed in the viewer).
  const ARCPATH_TUNE_KEY = 'afw.arcpathTune';
  const DEFAULT_ARCPATH_TUNE = {
    pathBase: 0.08,
    pathScale: 0.32,
    extremeEdge: 0.3,
    priorExtreme: 0.25,
    fftDial: 0.2,
  };

  function clampTune(t) {
    return {
      pathBase: Math.max(0, Math.min(0.5, Number(t.pathBase) || 0)),
      pathScale: Math.max(0, Math.min(0.8, Number(t.pathScale) || 0)),
      // Must stay < 0.5 so Peak and Bottom bands do not overlap.
      extremeEdge: Math.max(0.15, Math.min(0.49, Number(t.extremeEdge) || 0.25)),
      priorExtreme: Math.max(0, Math.min(0.8, Number(t.priorExtreme) || 0)),
      fftDial: Math.max(0, Math.min(0.8, Number(t.fftDial) || 0)),
    };
  }

  function loadArcpathTune() {
    try {
      const raw = global.localStorage?.getItem(ARCPATH_TUNE_KEY);
      if (!raw) return { ...DEFAULT_ARCPATH_TUNE };
      return clampTune({ ...DEFAULT_ARCPATH_TUNE, ...JSON.parse(raw) });
    } catch (_) {
      return { ...DEFAULT_ARCPATH_TUNE };
    }
  }

  let arcpathTune = loadArcpathTune();

  function getArcpathTune() {
    return { ...arcpathTune };
  }

  function setArcpathTune(partial) {
    arcpathTune = clampTune({ ...arcpathTune, ...(partial || {}) });
    try {
      global.localStorage?.setItem(ARCPATH_TUNE_KEY, JSON.stringify(arcpathTune));
    } catch (_) {
      /* ignore */
    }
    return getArcpathTune();
  }

  function resetArcpathTune() {
    return setArcpathTune({ ...DEFAULT_ARCPATH_TUNE });
  }

  function arcpathPathWeight(series, dataIndex, markerIndex) {
    const { pathBase, pathScale } = arcpathTune;
    const local = Math.abs(localDaySlope(series, dataIndex));
    const path =
      markerIndex != null
        ? Math.abs(pathSlopeFromMarker(series, dataIndex, markerIndex))
        : 0;
    const steep = steepDayForAmp(8);
    const steepness = Math.max(
      clamp01(local / steep),
      clamp01(path / (steep * 0.5)) * 0.5
    );
    return clamp01(pathBase + pathScale * steepness);
  }

  /**
   * Remap linear 0→1 progress so more of the price range sits in Peak/Bottom
   * stage bands (each band is 90° / 180° = 0.25 of a leg). Does not change dial art.
   */
  function expandExtremeProgress(u, edgeFrac) {
    const x = clamp01(u);
    const edge = Math.max(0.15, Math.min(0.49, edgeFrac ?? arcpathTune.extremeEdge));
    const band = 0.25;
    if (x <= edge) return band * (x / edge);
    if (x >= 1 - edge) return 1 - band + band * ((x - (1 - edge)) / edge);
    return band + (1 - 2 * band) * ((x - edge) / (1 - 2 * edge));
  }

  /** Widen Peak/Bottom reaction on a 180° rising (180→360) or falling (0→180) leg. */
  function widenArcpathLegAngle(angle) {
    const a = ((angle % 360) + 360) % 360;
    if (a >= 180) {
      return 180 + expandExtremeProgress((a - 180) / 180) * 180;
    }
    return expandExtremeProgress(a / 180) * 180;
  }

  /**
   * Map FFT phase at dataIndex onto the cycle dial:
   * crest → Peak (0°), trough → Bottom (180°), falling/rising halves in between.
   */
  function dialAngleFromFft(dataIndex, fft) {
    if (!fft?.indexToSample) return null;
    const t = fft.indexToSample.get(dataIndex);
    if (t == null) return null;
    const ang = (2 * Math.PI * fft.k * t) / fft.n + fft.phase;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    if (s >= 0) {
      // Peak → Bottom (falling)
      return ((1 - c) / 2) * 180;
    }
    // Bottom → Peak (rising)
    return 180 + ((1 + c) / 2) * 180;
  }

  /** Blend arc + path, then prior-extreme, then FFT phase. */
  function blendArcPathPrior(arcA, pathA, extremeA, fftA, series, dataIndex, markerIndex, fftStrength) {
    let mixed = null;
    if (arcA != null && pathA != null) {
      mixed = blendDialAngles(arcA, pathA, arcpathPathWeight(series, dataIndex, markerIndex));
    } else {
      mixed = arcA ?? pathA;
    }

    const wExt = arcpathTune.priorExtreme;
    if (mixed == null) {
      mixed = extremeA;
    } else if (extremeA != null && wExt > 0) {
      mixed = blendDialAngles(mixed, extremeA, wExt);
    }

    const wFft = arcpathTune.fftDial * clamp01((fftStrength ?? 1) * 1.6);
    if (mixed == null) {
      mixed = fftA;
    } else if (fftA != null && wFft > 0) {
      mixed = blendDialAngles(mixed, fftA, wFft);
    }

    if (mixed == null) return null;
    return widenArcpathLegAngle(mixed);
  }

  function dialAngleArcPathAfterLast(series, dataIndex, prev, oppositePrice, fft) {
    const arcA = dialAngleArcAfterLast(series, dataIndex, prev, oppositePrice);
    const pathA = dialAnglePathAfterLast(series, dataIndex, prev, oppositePrice);
    const extA = dialAnglePriorExtreme(series, dataIndex, prev, oppositePrice);
    const fftA = dialAngleFromFft(dataIndex, fft);
    return blendArcPathPrior(
      arcA,
      pathA,
      extA,
      fftA,
      series,
      dataIndex,
      prev.index,
      fft?.strength
    );
  }

  function stageFromTurnsCore(dataIndex, turns, series, state, labels, mode) {
    if (!turns?.length || !series?.length || dataIndex == null || dataIndex < 0) {
      return unknownStage(labels);
    }
    const price = seriesAvgAt(series, dataIndex);
    if (price == null) return unknownStage(labels);

    const hit = turns.find((t) => t.index === dataIndex);
    if (hit) {
      if (hit.type === 'peak') return packStage(0, labels);
      return packStage(180, labels);
    }

    let prev = null;
    let next = null;
    for (const t of turns) {
      if (t.index < dataIndex) prev = t;
      else if (t.index > dataIndex) {
        next = t;
        break;
      }
    }

    const fft =
      mode === 'arcpath' && arcpathTune.fftDial > 0 ? findDominantFftCycle(series) : null;

    let angle;
    if (prev && next) {
      const arcAngle = angleBetweenTurns(series, dataIndex, prev, next, state, true);
      if (arcAngle == null) return unknownStage(labels);
      if (mode === 'arc') {
        angle = arcAngle;
      } else if (mode === 'path') {
        let pathAngle = arcAngle;
        const local = localDaySlope(series, dataIndex);
        if (prev.type === 'trough' && next.type === 'peak' && local > 0.5) {
          pathAngle = Math.min(arcAngle, 300);
        }
        if (prev.type === 'peak' && next.type === 'trough' && local < -0.5) {
          pathAngle = Math.max(arcAngle, 60);
        }
        angle = pathAngle;
      } else if (mode === 'arcpath') {
        let pathAngle = arcAngle;
        const local = localDaySlope(series, dataIndex);
        if (prev.type === 'trough' && next.type === 'peak' && local > 0.5) {
          pathAngle = Math.min(arcAngle, 330);
        }
        if (prev.type === 'peak' && next.type === 'trough' && local < -0.5) {
          pathAngle = Math.max(arcAngle, 30);
        }
        const opp = priorOppositeTurn(turns, prev);
        const oppPrice = opp ? seriesAvgAt(series, opp.index) : null;
        const extA = dialAnglePriorExtreme(series, dataIndex, prev, oppPrice);
        const fftA = dialAngleFromFft(dataIndex, fft);
        angle = blendArcPathPrior(
          arcAngle,
          pathAngle,
          extA,
          fftA,
          series,
          dataIndex,
          prev.index,
          fft?.strength
        );
      } else {
        angle = angleBetweenTurns(series, dataIndex, prev, next, state, false);
        if (angle == null) return unknownStage(labels);
      }
    } else if (prev && !next) {
      const opp = priorOppositeTurn(turns, prev);
      const oppPrice = opp ? seriesAvgAt(series, opp.index) : null;
      if (state === 'WA' && waWeeklyAfterLastEnabled()) {
        angle = waDialAfterLastMarker(series, dataIndex, prev);
      } else if (mode === 'arc') {
        angle = dialAngleArcAfterLast(series, dataIndex, prev, oppPrice);
      } else if (mode === 'path') {
        angle = dialAnglePathAfterLast(series, dataIndex, prev, oppPrice);
      } else if (mode === 'arcpath') {
        angle = dialAngleArcPathAfterLast(series, dataIndex, prev, oppPrice, fft);
      } else {
        angle = dialAngleCurrentAfterLast(series, dataIndex, prev, oppPrice);
      }
      if (angle == null) return unknownStage(labels);
    } else if (!prev && next) {
      const { lo, hi } = priceRangeInSpan(series, 0, next.index);
      if (lo == null || hi == null || hi - lo < 0.05) {
        angle = next.type === 'peak' ? 270 : 90;
      } else if (next.type === 'peak') {
        const u = clamp01((price - lo) / (hi - lo));
        angle =
          mode === 'arcpath'
            ? 180 + expandExtremeProgress(u) * 180
            : 180 + u * 180;
      } else {
        const u = clamp01((hi - price) / (hi - lo));
        angle = mode === 'arcpath' ? expandExtremeProgress(u) * 180 : u * 180;
      }
      if (mode === 'arcpath' && fft && arcpathTune.fftDial > 0) {
        const fftA = dialAngleFromFft(dataIndex, fft);
        if (fftA != null) {
          const wFft = arcpathTune.fftDial * clamp01((fft.strength ?? 1) * 1.6);
          angle = widenArcpathLegAngle(blendDialAngles(angle, fftA, wFft));
        }
      }
    } else {
      return unknownStage(labels);
    }

    return packStage(
      angle,
      labels,
      mode === 'arcpath'
        ? {
            modelHint: `prior ${Math.round(arcpathTune.priorExtreme * 100)}% · FFT ${Math.round(arcpathTune.fftDial * 100)}%`,
            source: 'hybrid2',
          }
        : undefined
    );
  }

  function phaseTurns(series, state) {
    const { period } = findPeriodAcf(series);
    if (!period) return zigzagTurns(series, state);

    const zz = zigzagTurns(series, state);
    let anchor = 0;
    for (let i = zz.length - 1; i >= 0; i--) {
      if (zz[i].type === 'trough') {
        anchor = zz[i].index;
        break;
      }
    }
    if (!zz.length) {
      for (let i = 0; i < series.length; i++) {
        if (seriesAvgAt(series, i) != null) {
          anchor = i;
          break;
        }
      }
    }

    const turns = [];
    const half = period / 2;
    for (let k = 0; k <= 40; k++) {
      const troughIdx = Math.round(anchor + k * period);
      const peakIdx = Math.round(anchor + half + k * period);
      if (troughIdx >= series.length - 1 && peakIdx >= series.length - 1) break;
      if (troughIdx > 0 && troughIdx < series.length - 1 && seriesAvgAt(series, troughIdx) != null) {
        turns.push({ index: troughIdx, type: 'trough' });
      }
      if (peakIdx > 0 && peakIdx < series.length - 1 && seriesAvgAt(series, peakIdx) != null) {
        turns.push({ index: peakIdx, type: 'peak' });
      }
    }
    for (let k = 1; k <= 40; k++) {
      const troughIdx = Math.round(anchor - k * period);
      const peakIdx = Math.round(anchor - half - k * period);
      if (troughIdx < 1 && peakIdx < 1) break;
      if (peakIdx > 0 && peakIdx < series.length - 1 && seriesAvgAt(series, peakIdx) != null) {
        turns.push({ index: peakIdx, type: 'peak' });
      }
      if (troughIdx > 0 && troughIdx < series.length - 1 && seriesAvgAt(series, troughIdx) != null) {
        turns.push({ index: troughIdx, type: 'trough' });
      }
    }
    turns.sort((a, b) => a.index - b.index);
    return dedupeNearbyTurns(series, turns, Math.max(2, Math.floor(period / 4)));
  }

  function stageBand(dataIndex, series, labels, asFallback) {
    const WIN = 21;
    const price = seriesAvgAt(series, dataIndex);
    if (price == null) return unknownStage(labels);
    const p10 = rollingPercentile(series, dataIndex, WIN, 0.1);
    const p90 = rollingPercentile(series, dataIndex, WIN, 0.9);
    if (p10 == null || p90 == null || p90 - p10 < 1) return unknownStage(labels);

    const pct = clamp01((price - p10) / (p90 - p10));
    const local = localDaySlope(series, dataIndex);
    const steep = steepDayForAmp(p90 - p10);
    const riseStr = local > 0.3 ? clamp01(local / steep) : 0;
    const fallStr = local < -0.3 ? clamp01((-local) / steep) : 0;

    let angle;
    if (riseStr > 0.15) {
      angle = 180 + pct * 180;
      if (pct >= 0.85) angle = 270 + (1 - riseStr) * 45;
      else angle = Math.min(angle, 315 - riseStr * 40);
    } else if (fallStr > 0.15) {
      angle = (1 - pct) * 180;
      if (pct <= 0.15) angle = 90 + (1 - fallStr) * 45;
      else angle = Math.min(angle, 135 + (1 - fallStr) * 45);
    } else if (pct >= 0.78) {
      angle = 0;
    } else if (pct <= 0.22) {
      angle = 180;
    } else if (pct > 0.5) {
      angle = 270;
    } else {
      angle = 90;
    }

    return packStage(angle, labels, {
      modelHint: asFallback ? 'band fallback' : 'percentile band',
      source: 'band',
    });
  }

  function stagePhase(dataIndex, turns, series, labels) {
    const { period, strength } = findPeriodAcf(series);
    const price = seriesAvgAt(series, dataIndex);
    if (price == null) return unknownStage(labels);

    let anchorTrough = null;
    for (const t of turns || []) {
      if (t.type === 'trough' && t.index <= dataIndex) anchorTrough = t;
    }
    if (!period || !anchorTrough) {
      return stageBand(dataIndex, series, labels, true);
    }

    const days = dataIndex - anchorTrough.index;
    const u = (days % period) / period;
    let angle;
    if (u <= 0.5) {
      angle = 180 + (u / 0.5) * 180;
    } else {
      angle = ((u - 0.5) / 0.5) * 180;
    }
    const hint =
      '~' + period + 'd phase' + (strength != null ? ' (r=' + strength.toFixed(2) + ')' : '');
    return packStage(angle, labels, { modelHint: hint, source: 'phase' });
  }

  function bandTurns(series) {
    const WIN = 21;
    const MIN_SEP = 4;
    const turns = [];
    let lastHigh = -999;
    let lastLow = -999;
    for (let i = WIN - 1; i < series.length - 1; i++) {
      const price = seriesAvgAt(series, i);
      const prev = seriesAvgAt(series, i - 1);
      if (price == null || prev == null) continue;
      const p90 = rollingPercentile(series, i, WIN, 0.9);
      const p10 = rollingPercentile(series, i, WIN, 0.1);
      if (p90 == null || p10 == null) continue;
      if (prev < p90 && price >= p90 && i - lastHigh >= MIN_SEP) {
        turns.push({ index: i, type: 'peak' });
        lastHigh = i;
      }
      if (prev > p10 && price <= p10 && i - lastLow >= MIN_SEP) {
        turns.push({ index: i, type: 'trough' });
        lastLow = i;
      }
    }
    return turns;
  }

  function stageHybrid(dataIndex, turns, series, labels) {
    const { period, strength } = findPeriodAcf(series);
    const price = seriesAvgAt(series, dataIndex);
    if (price == null) return unknownStage(labels);

    const hit = turns.find((t) => t.index === dataIndex);
    const hint =
      period != null ? 'Noel turns · ~' + period + 'd period' : 'Noel turns · no period';

    if (hit) {
      return packStage(hit.type === 'peak' ? 0 : 180, labels, { modelHint: hint });
    }

    let prev = null;
    let next = null;
    for (const t of turns) {
      if (t.index < dataIndex) prev = t;
      else if (t.index > dataIndex) {
        next = t;
        break;
      }
    }

    if (prev && next) {
      const span = next.index - prev.index;
      if (!period || span <= period * 1.15) {
        const angle = angleBetweenTurns(series, dataIndex, prev, next, null, true);
        if (angle == null) return unknownStage(labels);
        return packStage(angle, labels, { modelHint: hint, source: 'hybrid' });
      }
    }

    if (prev && period && strength != null && strength >= 0.35) {
      const days = dataIndex - prev.index;
      const local = localDaySlope(series, dataIndex);
      const steep = steepDayForAmp(8);
      const riseStr = local > 0.3 ? clamp01(local / steep) : 0;
      const fallStr = local < -0.3 ? clamp01((-local) / steep) : 0;

      let angle;
      if (prev.type === 'trough') {
        const u = clamp01(days / period);
        if (u <= 0.5) {
          angle = 180 + (u / 0.5) * 180;
          if (u >= 0.4 && riseStr > 0.2) angle = 270 + (1 - riseStr) * 45;
          else if (u >= 0.45 && riseStr <= 0.15) angle = Math.min(angle, 350);
        } else {
          angle = ((u - 0.5) / 0.5) * 180;
          if (fallStr > 0.2) angle = Math.min(angle, 135);
        }
      } else {
        const u = clamp01(days / period);
        if (u <= 0.5) {
          angle = (u / 0.5) * 180;
          if (u >= 0.4 && fallStr > 0.2) angle = 90 + (1 - fallStr) * 45;
        } else {
          angle = 180 + ((u - 0.5) / 0.5) * 180;
          if (riseStr > 0.2) angle = Math.min(angle, 300);
        }
      }
      return packStage(angle, labels, { modelHint: hint, source: 'hybrid' });
    }

    if (prev) {
      const opp = priorOppositeTurn(turns, prev);
      const oppPrice = opp ? seriesAvgAt(series, opp.index) : null;
      const angle = dialAngleArcAfterLast(series, dataIndex, prev, oppPrice);
      if (angle == null) return unknownStage(labels);
      return packStage(angle, labels, { modelHint: hint, source: 'hybrid' });
    }

    return unknownStage(labels);
  }

  const MODELS = [
    {
      id: 'current',
      label: 'Current (markers + slope)',
      hint: 'markers + slope blend',
      dialLabels: LABELS,
      findTurns: zigzagTurns,
      stageAt(dataIndex, ctx) {
        return stageFromTurnsCore(dataIndex, ctx.turns, ctx.series, ctx.state, LABELS, 'current');
      },
    },
    {
      id: 'arc',
      label: 'Arc (price between turns)',
      hint: 'price on arc between turns',
      dialLabels: LABELS,
      findTurns: zigzagTurns,
      stageAt(dataIndex, ctx) {
        return stageFromTurnsCore(dataIndex, ctx.turns, ctx.series, ctx.state, LABELS, 'arc');
      },
    },
    {
      id: 'path',
      label: 'Path (slope / trajectory)',
      hint: 'slope / trajectory first',
      dialLabels: LABELS,
      findTurns: zigzagTurns,
      stageAt(dataIndex, ctx) {
        return stageFromTurnsCore(dataIndex, ctx.turns, ctx.series, ctx.state, LABELS, 'path');
      },
    },
    {
      id: 'phase',
      label: 'Phase (period clock)',
      hint: 'period phase clock',
      dialLabels: LABELS,
      findTurns: phaseTurns,
      stageAt(dataIndex, ctx) {
        return stagePhase(dataIndex, ctx.turns, ctx.series, LABELS);
      },
    },
    {
      id: 'band',
      label: 'Band (percentile)',
      hint: 'percentile band',
      dialLabels: BAND_LABELS,
      findTurns: (series) => bandTurns(series),
      stageAt(dataIndex, ctx) {
        return stageBand(dataIndex, ctx.series, BAND_LABELS, false);
      },
    },
    {
      id: 'hybrid',
      label: 'Hybrid (Noel + period)',
      hint: 'Noel turns + period',
      dialLabels: LABELS,
      findTurns: zigzagTurns,
      stageAt(dataIndex, ctx) {
        return stageHybrid(dataIndex, ctx.turns, ctx.series, LABELS);
      },
    },
    {
      id: 'arcpath',
      label: 'Hybrid (arc + path)',
      hint: 'arc/path + prior + FFT',
      dialLabels: LABELS,
      findTurns: zigzagTurns,
      stageAt(dataIndex, ctx) {
        return stageFromTurnsCore(
          dataIndex,
          ctx.turns,
          ctx.series,
          ctx.state,
          LABELS,
          'arcpath'
        );
      },
    },
  ];

  const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));

  function get(id) {
    return byId[id] || byId[DEFAULT_ID];
  }

  // One-time apply of product default bumps (does not run again after rev is stored).
  const DEFAULTS_REV_KEY = 'afw.defaultsRev';
  const DEFAULTS_REV = 3;
  try {
    const rev = Number(global.localStorage?.getItem(DEFAULTS_REV_KEY) || 0);
    if (rev < DEFAULTS_REV) {
      setTurnTune({ ...DEFAULT_TURN_TUNE });
      setArcpathTune({ ...DEFAULT_ARCPATH_TUNE });
      setWaWeeklyAfterLast(false);
      global.localStorage?.setItem(DEFAULTS_REV_KEY, String(DEFAULTS_REV));
    }
  } catch (_) {
    /* ignore */
  }

  global.CycleModels = {
    STORAGE_KEY,
    DEFAULT_ID,
    ARCPATH_TUNE_KEY,
    DEFAULT_ARCPATH_TUNE: { ...DEFAULT_ARCPATH_TUNE },
    MODELS,
    get,
    getArcpathTune,
    setArcpathTune,
    resetArcpathTune,
    TURN_TUNE_KEY,
    DEFAULT_TURN_TUNE: { ...DEFAULT_TURN_TUNE },
    getTurnTune,
    setTurnTune,
    resetTurnTune,
    resolveTurnDetectParams,
    findDominantFftCycle,
    fftCycleCurve,
    buildFftChartOverlay,
    WA_WEEKLY_AFTER_LAST_KEY,
    waWeeklyAfterLastEnabled,
    setWaWeeklyAfterLast,
    findTurns(id, series, state) {
      return get(id).findTurns(series, state) || [];
    },
    stageAt(id, dataIndex, ctx) {
      return get(id).stageAt(dataIndex, ctx);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
