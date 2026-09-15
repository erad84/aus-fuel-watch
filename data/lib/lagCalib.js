'use strict';

/**
 * Singapore lead → AU retail lag calibration (Spearman on smoothed biz-day changes,
 * optional turn assist). Pure helpers for cron + shared constants with the viewer.
 */

const STRONG_R = 0.3;
const MIN_R = 0.15;
const TURN_ASSIST_R = 0.5;
const TURN_MIN_N = 8;
const TURN_AGREE_DAYS = 3;
const SMOOTH_GRID = [5, 7];
const RET_GRID = [5, 7];
const TURN_WINDOW = 7;
const TURN_THRESH = 0.4;

const DEFAULT_LAG = {
  default: 10,
  min: 5,
  max: 21,
  byState: {
    NSW: 10,
    VIC: 11,
    QLD: 9,
    WA: 7,
    SA: 10,
    TAS: 12,
    NT: 10,
    ACT: 10,
  },
};

function isoWeekday(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function movingAverage(values, window) {
  const out = new Array(values.length).fill(null);
  if (!(window >= 1)) return values.slice();
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rankArray(values) {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  for (let i = 0; i < indexed.length; ) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j += 1;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

function pearsonCorr(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 12) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx < 1e-9 || dy < 1e-9) return null;
  return num / Math.sqrt(dx * dy);
}

function spearmanCorr(xs, ys) {
  return pearsonCorr(rankArray(xs), rankArray(ys));
}

function spearmanCorrLoose(xs, ys, minN = 8) {
  const n = Math.min(xs.length, ys.length);
  if (n < minN) return null;
  return pearsonCorr(rankArray(xs.slice(0, n)), rankArray(ys.slice(0, n)));
}

function bestLagFromChanges(leadCh, avgCh, minL, maxL) {
  let bestL = null;
  let bestCorr = -Infinity;
  let bestN = 0;
  for (let L = minL; L <= maxL; L++) {
    const xs = [];
    const ys = [];
    for (let i = 0; i + L < leadCh.length; i++) {
      xs.push(leadCh[i]);
      ys.push(avgCh[i + L]);
    }
    const corr = spearmanCorr(xs, ys);
    if (corr == null) continue;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestL = L;
      bestN = xs.length;
    }
  }
  if (bestL == null || !Number.isFinite(bestCorr)) return null;
  return { lag: bestL, corr: bestCorr, n: bestN };
}

function lagChangeSeries(pairs, smooth, retDays) {
  const biz = pairs.filter((p) => {
    const wd = isoWeekday(p.date);
    return wd >= 1 && wd <= 5;
  });
  const lead = biz.map((p) => p.lead);
  const avg = biz.map((p) => p.avg);
  const leadSmooth = movingAverage(lead, smooth);
  const avgSmooth = movingAverage(avg, smooth);
  const leadCh = [];
  const avgCh = [];
  for (let i = retDays; i < biz.length; i++) {
    if (leadSmooth[i] == null || leadSmooth[i - retDays] == null) continue;
    if (avgSmooth[i] == null || avgSmooth[i - retDays] == null) continue;
    leadCh.push(leadSmooth[i] - leadSmooth[i - retDays]);
    avgCh.push(avgSmooth[i] - avgSmooth[i - retDays]);
  }
  return { leadCh, avgCh };
}

function leadTurnIndices(levels, thresh) {
  const turns = [];
  if (levels.length < 3) return turns;
  const deltas = [];
  for (let i = 1; i < levels.length; i++) deltas.push(levels[i] - levels[i - 1]);
  for (let i = 1; i < deltas.length; i++) {
    if (deltas[i - 1] === 0) continue;
    if (Math.sign(deltas[i]) !== 0 && Math.sign(deltas[i - 1]) !== Math.sign(deltas[i])) {
      if (Math.abs(deltas[i]) < thresh && Math.abs(deltas[i - 1]) < thresh) continue;
      turns.push(i);
    }
  }
  return turns;
}

function calibrateTurnLag(pairs, minL, maxL) {
  const lead = pairs.map((p) => p.lead);
  const avg = pairs.map((p) => p.avg);
  const leadSmooth = movingAverage(lead, 5);
  const avgSmooth = movingAverage(avg, 5);
  const turns = leadTurnIndices(lead, TURN_THRESH);
  if (turns.length < 6) return null;

  let bestL = null;
  let bestCorr = -Infinity;
  let bestN = 0;
  const w = TURN_WINDOW;
  for (let L = minL; L <= maxL; L++) {
    const xs = [];
    const ys = [];
    for (const j of turns) {
      if (j + L >= pairs.length || j < 1) continue;
      const i0 = Math.max(0, j - w);
      const i1 = j;
      const j0 = Math.max(0, j + L - w);
      const j1 = j + L;
      if (
        leadSmooth[i0] == null ||
        leadSmooth[i1] == null ||
        avgSmooth[j0] == null ||
        avgSmooth[j1] == null
      ) {
        continue;
      }
      xs.push(leadSmooth[i1] - leadSmooth[i0]);
      ys.push(avgSmooth[j1] - avgSmooth[j0]);
    }
    const corr = spearmanCorrLoose(xs, ys, 8);
    if (corr == null) continue;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestL = L;
      bestN = xs.length;
    }
  }
  if (bestL == null || !Number.isFinite(bestCorr) || bestCorr < MIN_R) return null;
  return {
    lag: bestL,
    corr: Math.round(bestCorr * 1000) / 1000,
    n: bestN,
  };
}

/**
 * @param {Array<{ date: string, lead: number, avg: number }>} pairs
 * @param {{ min?: number, max?: number }} [cfg]
 * @returns {{
 *   lag: number,
 *   corr: number,
 *   n: number,
 *   soft: boolean,
 *   source: string,
 *   turns: { lag: number, corr: number, n: number } | null
 * } | null}
 */
function calibrateFromPairs(pairs, cfg = {}) {
  const minL = Math.max(1, Math.round(Number(cfg.min) || DEFAULT_LAG.min));
  const maxL = Math.max(minL, Math.round(Number(cfg.max) || DEFAULT_LAG.max));
  if (!pairs?.length || pairs.length < maxL + 40) return null;

  let dailyBest = null;
  for (const smooth of SMOOTH_GRID) {
    for (const retDays of RET_GRID) {
      const { leadCh, avgCh } = lagChangeSeries(pairs, smooth, retDays);
      if (leadCh.length < maxL + 12) continue;
      const hit = bestLagFromChanges(leadCh, avgCh, minL, maxL);
      if (!hit) continue;
      if (!dailyBest || hit.corr > dailyBest.corr) {
        dailyBest = { ...hit, smooth, retDays };
      }
    }
  }

  const turnBest = calibrateTurnLag(pairs, minL, maxL);

  if (
    (!dailyBest || dailyBest.corr < MIN_R) &&
    !(turnBest && turnBest.corr >= TURN_ASSIST_R && turnBest.n >= TURN_MIN_N)
  ) {
    return null;
  }

  let lag = dailyBest?.lag ?? turnBest.lag;
  let corr = dailyBest?.corr ?? turnBest.corr;
  let n = dailyBest?.n ?? turnBest.n;
  let soft = true;
  let source = 'soft';

  const dailyStrong = dailyBest && dailyBest.corr >= STRONG_R;
  const dailySoft =
    dailyBest && dailyBest.corr >= MIN_R && dailyBest.corr < STRONG_R;
  const turnStrong =
    turnBest && turnBest.corr >= TURN_ASSIST_R && turnBest.n >= TURN_MIN_N;

  if (dailyStrong && turnStrong && Math.abs(dailyBest.lag - turnBest.lag) <= TURN_AGREE_DAYS) {
    const wDaily = dailyBest.n * dailyBest.corr;
    const wTurn = turnBest.n * turnBest.corr;
    lag = Math.round((dailyBest.lag * wDaily + turnBest.lag * wTurn) / (wDaily + wTurn));
    corr = dailyBest.corr;
    n = dailyBest.n;
    soft = false;
    source = 'merged';
  } else if (dailyStrong) {
    lag = dailyBest.lag;
    corr = dailyBest.corr;
    n = dailyBest.n;
    soft = false;
    source = 'daily';
  } else if (dailySoft && turnStrong) {
    lag = turnBest.lag;
    corr = turnBest.corr;
    n = turnBest.n;
    soft = false;
    source = 'turns';
  } else if (dailySoft) {
    lag = dailyBest.lag;
    corr = dailyBest.corr;
    n = dailyBest.n;
    soft = true;
    source = 'soft';
  } else if (turnStrong) {
    lag = turnBest.lag;
    corr = turnBest.corr;
    n = turnBest.n;
    soft = false;
    source = 'turns';
  } else {
    return null;
  }

  return {
    lag,
    corr: Math.round(corr * 1000) / 1000,
    n,
    soft,
    source,
    turns: turnBest,
  };
}

module.exports = {
  DEFAULT_LAG,
  STRONG_R,
  MIN_R,
  calibrateFromPairs,
};
