'use strict';

// MyFuel NT site Trends chart API — daily territory averages for the last
// 7 / 28 days (Weekly / Monthly). Used when CKAN monthly XLSX archives lag.
//
// Endpoint (same as Scripts/Trends/trends.js):
//   GET /Trends/GetTrendsJson?fuelTypesString=U91,DL&period=Monthly&region=3

const { isoToDayNum, dayNumToISO } = require('../cyclefit');
const { localParts } = require('../states');
const { FUELS } = require('../fuels');

const BASE = 'https://myfuelnt.nt.gov.au';
const ATTRIBUTION = 'MyFuel NT (NT Consumer Affairs)';
const USER_AGENT = 'AusFuelWatch/1.0 (history import)';

// Site fuel codes → our canon.
const FUEL_MAP = {
  U91: 'U91',
  E10: 'E10',
  P95: 'P95',
  P98: 'P98',
  DL: 'DSL',
  PD: 'PDSL',
};

// Greater Darwin regions on the Trends dropdown (matches live metro grouping).
const GREATER_DARWIN_REGIONS = [
  { id: 3, name: 'Darwin' },
  { id: 9, name: 'Palmerston' },
  { id: 2, name: 'Litchfield' },
];

function dayRange(days) {
  const endIso = localParts(new Date(), 'NT').day;
  const startNum = isoToDayNum(endIso) - (days - 1);
  return { startIso: dayNumToISO(startNum), endIso };
}

function aspNetDateToIso(value) {
  const m = String(value || '').match(/\/Date\((-?\d+)/);
  if (!m) return null;
  return localParts(new Date(Number(m[1])), 'NT').day;
}

function toTenths(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents * 10);
}

async function fetchTrendsJson(fuelTypesString, period, regionId) {
  const q = new URLSearchParams({
    fuelTypesString,
    period,
    region: String(regionId),
  });
  const url = `${BASE}/Trends/GetTrendsJson?${q}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MyFuel NT Trends HTTP ${res.status} for region ${regionId}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('MyFuel NT Trends: expected a JSON array');
  return body;
}

/**
 * Unweighted mean of regional daily averages → one metro series per fuel/day.
 * @returns {Map<string, Record<string,{avg,med,min,max,n}>>} iso -> readings
 */
function mergeRegionSeries(regionPayloads, startIso, endIso) {
  // fuel -> iso -> { sum, count }
  const acc = new Map();

  for (const payload of regionPayloads) {
    for (const row of payload) {
      const canon = FUEL_MAP[row.FuelCode];
      if (!canon) continue;
      const trends = row.WeeklyMonthlyTrends && row.WeeklyMonthlyTrends.PlottingData;
      if (!Array.isArray(trends)) continue;

      if (!acc.has(canon)) acc.set(canon, new Map());
      const byDay = acc.get(canon);

      for (const pt of trends) {
        const iso = aspNetDateToIso(pt.TrendDate);
        if (!iso || iso < startIso || iso > endIso) continue;
        const tenths = toTenths(pt.AveragePrice);
        if (tenths === null) continue;
        const cur = byDay.get(iso) || { sum: 0, count: 0 };
        cur.sum += tenths;
        cur.count += 1;
        byDay.set(iso, cur);
      }
    }
  }

  const byDay = new Map();
  for (const fuel of FUELS) {
    const days = acc.get(fuel);
    if (!days) continue;
    for (const [iso, { sum, count }] of days) {
      if (!byDay.has(iso)) {
        const readings = {};
        for (const f of FUELS) {
          readings[f] = { avg: null, med: null, min: null, max: null, n: null };
        }
        byDay.set(iso, readings);
      }
      byDay.get(iso)[fuel] = {
        avg: Math.round(sum / count),
        med: null,
        min: null,
        max: null,
        n: null,
      };
    }
  }

  // Drop days with no usable fuel.
  for (const [iso, readings] of byDay) {
    if (!FUELS.some((f) => readings[f] && readings[f].avg !== null)) byDay.delete(iso);
  }

  return byDay;
}

/**
 * @param {number} days window length (Trends Monthly only supplies ~28 daily points)
 * @returns {{ byState: Map, meta: object }}
 */
async function importNtTrends(days) {
  const { startIso, endIso } = dayRange(days);
  const fuelTypesString = Object.keys(FUEL_MAP).join(',');
  const regionPayloads = [];
  const regionErrors = [];

  for (const region of GREATER_DARWIN_REGIONS) {
    try {
      const payload = await fetchTrendsJson(fuelTypesString, 'Monthly', region.id);
      regionPayloads.push(payload);
    } catch (err) {
      regionErrors.push(`${region.name}: ${err.message}`);
    }
  }

  const byDay = mergeRegionSeries(regionPayloads, startIso, endIso);
  const byState = new Map();
  if (byDay.size) byState.set('NT', byDay);

  return {
    byState,
    meta: {
      window: { startIso, endIso },
      regionsOk: regionPayloads.length,
      regionErrors,
      daysFilled: byDay.size,
      period: 'Monthly',
      note: 'avg-only Greater Darwin mean (Darwin/Palmerston/Litchfield); no min/max/n',
    },
  };
}

module.exports = {
  ATTRIBUTION,
  importNtTrends,
  dayRange,
  FUEL_MAP,
  GREATER_DARWIN_REGIONS,
};
