'use strict';

// MyFuel NT adapter. No credentials.
//
// The Territory publishes no API and its open data portal only offers monthly
// XLSX archives, so this reads the public site. That sounds fragile, but the
// site is far friendlier than scraping usually is: `GET /Home/Results` returns
// the entire territory in one response with a complete JSON model embedded in
// the HTML, HTML-escaped. We pull that model out and parse it, rather than
// picking apart rendered markup.
//
// Verified against the live site on 2026-08-31: one 372KB response, no POST, no
// anti-forgery token, no cookie needed. Query parameters such as FuelCode and
// RegionId do not filter the payload, so a single call is both necessary and
// sufficient.
//
// The model gives us more than the other sources do:
//
//   Postcode, Latitude, Longitude   metro grouping, three independent ways
//   RegionId                        the site's own regions, so Greater Darwin
//                                   is an authoritative grouping rather than
//                                   our radius guess
//   Price / PriceScheduled          the NT runs a 24-hour price lock, and
//                                   PriceScheduled is the next window's price
//
// There is no robots.txt on the host (it 404s), so nothing is disallowed. We
// still make exactly one request per run.

const { CAPITALS } = require('../regions');

const BASE = 'https://myfuelnt.nt.gov.au';
const RESULTS_PATH = '/Home/Results';
const USER_AGENT = 'AusFuelWatch/1.0 (Pebble watchapp)';

const NAME = 'myfuelnt';
const ATTRIBUTION = 'MyFuel NT (NT Consumer Affairs)';
const LICENCE = 'NT Government, CC BY 4.0';
const STATES = ['NT'];

const FUEL_MAP = {
  U91: 'U91',
  E10: 'E10',
  P95: 'P95',
  P98: 'P98',
  DL: 'DSL',
  PD: 'PDSL',
};

// The site's own regions. Greater Darwin is Darwin, Palmerston and Litchfield,
// which matches the ABS Greater Darwin statistical area far better than a
// radius from the GPO would.
const REGIONS = {
  1: 'Top End Rural',
  2: 'Litchfield',
  3: 'Darwin',
  4: 'Central Australia',
  5: 'Barkly',
  6: 'Katherine',
  7: 'East Arnhem',
  8: 'Tiwi Island',
  9: 'Palmerston',
};
const GREATER_DARWIN = new Set([2, 3, 9]);

// The NT price lock runs on a 24-hour window that turns over at 14:30 ACST.
// Our 07:00-13:00 local sampling window sits inside a single window, so a run
// always sees one settled price rather than catching a change midway.
const PRICE_LOCK_CHANGEOVER_HOUR = 14.5;

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Pulls a balanced JSON array out of a larger string starting at `[`. The model
// is embedded in an HTML attribute whose name we deliberately do not depend on,
// since anchoring to the data key survives template changes better.
function extractArray(text, startIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function parseOutlets(html) {
  const decoded = unescapeHtml(html);
  const key = '"FuelOutlet":';
  const at = decoded.indexOf(key);
  if (at === -1) {
    throw new Error(
      'MyFuel NT: could not find the FuelOutlet model in the page. The site template may have changed.'
    );
  }
  const bracket = decoded.indexOf('[', at + key.length);
  if (bracket === -1) throw new Error('MyFuel NT: FuelOutlet key present but no array follows');
  const json = extractArray(decoded, bracket);
  if (!json) throw new Error('MyFuel NT: FuelOutlet array is unbalanced');
  return JSON.parse(json);
}

function toTenths(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents * 10);
}

/**
 * @returns {{source, attribution, licence, fetchedAt, stations: Array, notes: Array}}
 */
async function fetchStations() {
  const res = await fetch(`${BASE}${RESULTS_PATH}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
  });
  if (!res.ok) throw new Error(`MyFuel NT HTTP ${res.status}`);
  const html = await res.text();
  const outlets = parseOutlets(html);

  const notes = [`model carried ${outlets.length} outlets`];
  const stations = [];
  let scheduledCount = 0;

  for (const o of outlets) {
    if (o.IsActive === false) continue;
    // Every outlet is in the Territory by construction, but the field is there,
    // so check it rather than assume, given what NSW's state field did.
    if (o.OutletState && o.OutletState !== 'NT') continue;

    const prices = {};
    const scheduled = {};
    for (const f of o.AvailableFuels || []) {
      const fuel = FUEL_MAP[f.FuelCode];
      if (!fuel) continue;
      if (f.isAvailable !== false) {
        const t = toTenths(f.Price);
        if (t !== null) prices[fuel] = t;
      }
      const s = toTenths(f.PriceScheduled);
      if (s !== null && f.isAvailableScheduled !== false) scheduled[fuel] = s;
    }
    if (!Object.keys(prices).length) continue;
    if (Object.keys(scheduled).length) scheduledCount++;

    const postcode = Number(o.Postcode);
    stations.push({
      id: `${NAME}:NT:${o.FuelOutletIdentifier || o.FuelOutletId}`,
      code: String(o.FuelOutletIdentifier || o.FuelOutletId),
      name: (o.OutletName || '').trim(),
      brand: o.FuelBrandIdentifier || o.OutletBrandIdentifier || '',
      address: [o.Address, o.Suburb, o.Postcode].filter(Boolean).join(', ').trim(),
      suburb: (o.Suburb || '').trim(),
      postcode: Number.isFinite(postcode) ? postcode : null,
      state: 'NT',
      lat: typeof o.Latitude === 'number' && o.Latitude !== 0 ? o.Latitude : null,
      lng: typeof o.Longitude === 'number' && o.Longitude !== 0 ? o.Longitude : null,
      regionId: o.RegionId,
      region: REGIONS[o.RegionId] || null,
      // The site's own Greater Darwin grouping, kept alongside the coordinate
      // test so aggregation can prefer the authoritative one.
      metro: GREATER_DARWIN.has(o.RegionId),
      prices,
      scheduled: Object.keys(scheduled).length ? scheduled : undefined,
      updated: null,
    });
  }

  notes.push(`${stations.length} active outlets with a current price`);
  notes.push(`${scheduledCount} carry a next-window scheduled price`);

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    fetchedAt: new Date().toISOString(),
    states: STATES,
    sampled: [],
    hasScheduled: scheduledCount > 0,
    stations,
    notes,
  };
}

module.exports = {
  NAME,
  ATTRIBUTION,
  LICENCE,
  STATES,
  FUEL_MAP,
  REGIONS,
  GREATER_DARWIN,
  PRICE_LOCK_CHANGEOVER_HOUR,
  CAPITALS,
  fetchStations,
};
