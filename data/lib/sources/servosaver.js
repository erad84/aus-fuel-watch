'use strict';

// Victoria Servo Saver / Fair Fuel Open Data API (Service Victoria).
//
// Production base: https://api.fuel.service.vic.gov.au/open-data/v1
// Auth: x-consumer-id (VIC_FUEL_API_KEY) + unique x-transactionid (UUID v4)
//       and a User-Agent on every request.
//
// Prices are ~24 hours delayed by design. Fuel type codes already match our
// canon (U91, E10, P95, P98, DSL, PDSL). Price is cents per litre with one
// decimal place; we store tenths of a cent like every other adapter.
//
// Rate limit: max 10 requests / 60s. One prices call (plus optional brands)
// is enough per collector run.

const crypto = require('crypto');
const { postcodeFromAddress, stateFromPostcode } = require('../regions');

const BASE = 'https://api.fuel.service.vic.gov.au/open-data/v1';
const USER_AGENT = 'AusFuelWatch/1.0 (Pebble watchapp)';

const NAME = 'servosaver';
const ATTRIBUTION = 'Servo Saver / Fair Fuel Open Data (Service Victoria)';
const LICENCE = 'Victorian Government open data, CC BY 4.0';
const STATES = ['VIC'];

const FUEL_MAP = {
  U91: 'U91',
  E10: 'E10',
  P95: 'P95',
  P98: 'P98',
  DSL: 'DSL',
  PDSL: 'PDSL',
};

function requireKey() {
  const key = process.env.VIC_FUEL_API_KEY;
  if (!key) {
    throw new Error(
      'VIC_FUEL_API_KEY is not set. ' +
        'Locally: copy .env.example to .env and run with `node --env-file=.env`. ' +
        'In CI: add VIC_FUEL_API_KEY as a repository secret. ' +
        'Apply at https://service.vic.gov.au/find-services/transport-and-driving/servo-saver/help-centre/servo-saver-public-api'
    );
  }
  return key;
}

function headers(key) {
  return {
    'x-consumer-id': key,
    'x-transactionid': crypto.randomUUID(),
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
}

async function get(path) {
  const key = requireKey();
  const res = await fetch(`${BASE}${path}`, { headers: headers(key) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Servo Saver auth failed with HTTP ${res.status}`);
  }
  if (res.status === 429) {
    throw new Error('Servo Saver rate limited (HTTP 429); retry after 60s');
  }
  if (!res.ok) throw new Error(`Servo Saver ${path} HTTP ${res.status}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseAddress(address) {
  const postcode = postcodeFromAddress(address || '');
  let suburb = '';
  // Typical: "123 Main St, Footscray VIC 3011" or "…, Footscray 3011 VIC"
  const m = String(address || '').match(
    /,\s*([^,]+?)\s+(?:VIC\s+)?(\d{4})(?:\s+VIC)?\s*$/i
  );
  if (m) suburb = m[1].trim();
  return { postcode, suburb };
}

/**
 * @returns {{source, attribution, licence, fetchedAt, stations: Array, notes: Array}}
 */
async function fetchStations() {
  requireKey();

  let brands = {};
  try {
    const brandsBody = await get('/fuel/reference-data/brands');
    const list = brandsBody.brands || brandsBody.fuelBrands || [];
    for (const b of list) {
      const id = b.id || b.brandId;
      const name = b.name || b.brandName;
      if (id && name) brands[id] = name;
    }
  } catch (err) {
    // Brands are cosmetic; prices alone are enough for aggregation.
    brands = {};
  }

  const body = await get('/fuel/prices');
  const rows = body.fuelPriceDetails || [];
  const stations = [];
  let priceRows = 0;

  for (const row of rows) {
    const fs = row.fuelStation || {};
    const id = fs.id;
    if (!id) continue;

    const address = fs.address || '';
    const { postcode, suburb } = parseAddress(address);
    const state = postcode !== null ? stateFromPostcode(postcode) : 'VIC';
    // Drop rare border mislabels; VIC is the only jurisdiction this adapter owns.
    if (state && state !== 'VIC') continue;

    const loc = fs.location || {};
    const prices = {};
    let updated = row.updatedAt || null;
    for (const p of row.fuelPrices || []) {
      const fuel = FUEL_MAP[p.fuelType];
      if (!fuel) continue;
      if (p.isAvailable === false) continue;
      const cents = num(p.price);
      if (cents === null || cents <= 0 || cents >= 9999) continue;
      prices[fuel] = Math.round(cents * 10);
      priceRows++;
      if (p.updatedAt) updated = p.updatedAt;
    }
    if (!Object.keys(prices).length) continue;

    stations.push({
      id: `${NAME}:VIC:${id}`,
      code: String(id),
      name: fs.name || '',
      brand: brands[fs.brandId] || fs.brandId || '',
      address,
      suburb,
      postcode,
      state: 'VIC',
      lat: num(loc.latitude),
      lng: num(loc.longitude),
      prices,
      updated,
    });
  }

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    fetchedAt: new Date().toISOString(),
    states: STATES,
    sampled: [],
    stations,
    notes: [
      `price rows: ${rows.length}, fuels joined: ${priceRows}, with fuel: ${stations.length}`,
    ],
  };
}

module.exports = {
  NAME,
  ATTRIBUTION,
  LICENCE,
  STATES,
  BASE,
  FUEL_MAP,
  fetchStations,
};
