'use strict';

// WA FuelWatch adapter. No credentials.
//
// Verified against the live feed on 2026-08-31:
//
//   GET fuelWatchRSS?Product=1   940 items, 700KB of RSS.
//
// The channel title says "FuelWatch Prices For All Metro Regions", which is
// misleading: the default feed is the whole state. Enumerating all 54 Region
// codes yields 731 stations, every one of which already appears in the default
// feed, plus 209 the regions do not cover. So one call per product covers WA
// and the Region parameter is only useful for narrowing, never for completing.
//
// There is no postcode in the feed, only a suburb and coordinates. That is
// fine: everything here is WA by construction, and metro membership comes from
// distance to the Perth GPO like every other source.
//
// WA is the one jurisdiction that publishes *tomorrow's* prices, and the one
// where our seed fit finds a confident 7-day cycle, so a known next-day price
// can drive the watch's advice directly rather than by inference. See
// TOMORROW_PUBLISH_HOUR below for the timing catch.

const { metroOf } = require('../regions');

const BASE = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS';
const USER_AGENT = 'AusFuelWatch/1.0 (Pebble watchapp)';

const NAME = 'fuelwatch';
const ATTRIBUTION = 'FuelWatch WA (Department of Energy, Mines, Industry Regulation and Safety)';
const LICENCE = 'WA Government open data, CC BY 4.0';
const STATES = ['WA'];

// FuelWatch Product codes, confirmed by item counts and relative price:
//   1 ULP (940)   2 PULP 95 (524)   4 Diesel (677)   6 98 RON (727)   11 Brand Diesel (458)
// 5 is LPG and 10 is a 13-station oddity priced like a truck-stop product;
// both are outside our canon. WA has no E10, which matches Petrolmate.
const PRODUCTS = [
  { code: 1, fuel: 'U91' },
  { code: 2, fuel: 'P95' },
  { code: 4, fuel: 'DSL' },
  { code: 6, fuel: 'P98' },
  { code: 11, fuel: 'PDSL' },
];

// WA publishes the next day's prices at 14:30 WST. Our sampling window is
// 07:00-13:00 local, so a normal run always asks too early and gets an empty
// feed. The adapter still asks, because a late or catch-up run can land after
// the cutoff and a next-day price is worth having.
const TOMORROW_PUBLISH_HOUR = 14.5;

// Minimal RSS reading. The feed is flat and predictable, so a real XML parser
// would be a dependency bought for nothing; this matches how xlsx.js hand-rolls
// its own reader to keep the pipeline dependency-free.
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function items(xml) {
  const out = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function tag(fragment, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(fragment);
  return m ? unescapeXml(m[1]).trim() : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchProduct(productCode, day) {
  const qs = `?Product=${productCode}${day ? `&Day=${day}` : ''}`;
  const res = await fetch(`${BASE}${qs}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`FuelWatch Product=${productCode} HTTP ${res.status}`);
  return res.text();
}

// Station identity: FuelWatch has no station id, so trading name plus suburb is
// the key. Namespaced by source, since codes and names are only unique within a
// source and the collector merges several.
function keyOf(name, suburb) {
  return `${NAME}:WA:${(name || '').toLowerCase()}|${(suburb || '').toLowerCase()}`;
}

function parseInto(xml, fuel, out, field) {
  let seen = 0;
  for (const frag of items(xml)) {
    const name = tag(frag, 'trading-name');
    const suburb = tag(frag, 'location');
    const price = num(tag(frag, 'price'));
    if (!name || price === null) continue;

    const key = keyOf(name, suburb);
    let rec = out.get(key);
    if (!rec) {
      rec = {
        id: key,
        code: null,
        name,
        brand: tag(frag, 'brand') || '',
        address: [tag(frag, 'address'), suburb].filter(Boolean).join(', '),
        suburb,
        postcode: null,
        state: 'WA',
        lat: num(tag(frag, 'latitude')),
        lng: num(tag(frag, 'longitude')),
        prices: {},
        tomorrow: {},
        updated: tag(frag, 'date'),
        restrictions: tag(frag, 'restrictions') || '',
      };
      out.set(key, rec);
    }
    // Prices are cents with one decimal; we store tenths of a cent as integers.
    rec[field][fuel] = Math.round(price * 10);
    seen++;
  }
  return seen;
}

/**
 * @returns {{source, attribution, licence, fetchedAt, stations: Array, notes: Array}}
 */
async function fetchStations(options) {
  const opts = options || {};
  const wantTomorrow = opts.tomorrow !== false;

  const out = new Map();
  const notes = [];

  for (const p of PRODUCTS) {
    const xml = await fetchProduct(p.code, null);
    const n = parseInto(xml, p.fuel, out, 'prices');
    notes.push(`${p.fuel}: ${n} stations`);
    await new Promise((r) => setTimeout(r, 600));
  }

  let tomorrowCount = 0;
  if (wantTomorrow) {
    for (const p of PRODUCTS) {
      try {
        const xml = await fetchProduct(p.code, 'tomorrow');
        tomorrowCount += parseInto(xml, p.fuel, out, 'tomorrow');
      } catch (err) {
        notes.push(`tomorrow ${p.fuel} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    notes.push(
      tomorrowCount
        ? `tomorrow: ${tomorrowCount} prices`
        : `tomorrow: not published yet (WA releases at ${TOMORROW_PUBLISH_HOUR}:00 WST)`
    );
  }

  const stations = [...out.values()].filter((s) => Object.keys(s.prices).length > 0);
  for (const s of stations) {
    if (!Object.keys(s.tomorrow).length) delete s.tomorrow;
  }

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    fetchedAt: new Date().toISOString(),
    states: STATES,
    sampled: [],
    hasTomorrow: tomorrowCount > 0,
    stations,
    notes,
  };
}

/** Fetch one calendar day (`today`, `yesterday`) for all products. */
async function fetchStationsForDay(dayLabel) {
  const out = new Map();
  const notes = [];
  for (const p of PRODUCTS) {
    const xml = await fetchProduct(p.code, dayLabel);
    const n = parseInto(xml, p.fuel, out, 'prices');
    notes.push(`${dayLabel} ${p.fuel}: ${n}`);
    await new Promise((r) => setTimeout(r, 600));
  }
  const stations = [...out.values()].filter((s) => Object.keys(s.prices).length > 0);
  return { stations, notes };
}

module.exports = {
  NAME,
  ATTRIBUTION,
  LICENCE,
  STATES,
  PRODUCTS,
  TOMORROW_PUBLISH_HOUR,
  fetchStations,
  fetchStationsForDay,
};
