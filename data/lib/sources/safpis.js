'use strict';

// South Australia Fuel Pricing Information Scheme (SAFPIS) via FPPDirect.
//
// Verified against the live API on 2026-09-02:
//
//   GET /Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=4
//   GET /Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=4
//
// countryId 21 is Australia, geoRegionLevel 3 is state/territory, geoRegionId 4 is
// South Australia. Same FPPDirect shape as Queensland but a different host.
//
// Prices are tenths of a cent per litre (1579 = 157.9 c/L). 9999 means the fuel
// is not stocked at that site. The API asks that prices are not polled more than
// once per minute; our daily job is well inside that.

const { stateFromPostcode } = require('../regions');

const BASE = 'https://fppdirectapi-prod.safuelpricinginformation.com.au';

const NAME = 'safpis';
const ATTRIBUTION = 'SA Fuel Pricing Information Scheme (SAFPIS)';
const LICENCE = 'SA Government mandated retail price reporting';
const STATES = ['SA'];

const COUNTRY_ID = 21;
const GEO_LEVEL = 3;
const GEO_ID = 4;

const PRICE_UNAVAILABLE = 9999;

// FuelId values confirmed via homeassistant sa_fuel_pricing/const.py and live Fuels list.
const FUEL_MAP = {
  2: 'U91',
  3: 'DSL',
  5: 'P95',
  8: 'P98',
  12: 'E10',
  14: 'PDSL',
};

function requireToken() {
  const token = process.env.SA_FUEL_TOKEN;
  if (!token) {
    throw new Error(
      'SA_FUEL_TOKEN is not set. ' +
        'Locally: copy .env.example to .env and run with `node --env-file=.env`. ' +
        'In CI: add SA_FUEL_TOKEN as a repository secret. ' +
        'Register as a Data Publisher at https://www.safuelpricinginformation.com.au/publishers.html'
    );
  }
  return token;
}

function authHeaders(token) {
  return {
    Authorization: `FPDAPI SubscriberToken=${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function get(path) {
  const token = requireToken();
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(token) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`SAFPIS auth failed with HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`SAFPIS ${path} HTTP ${res.status}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {{source, attribution, licence, fetchedAt, stations: Array, notes: Array}}
 */
async function fetchStations() {
  const token = requireToken();

  const brandsBody = await get(`/Subscriber/GetCountryBrands?countryId=${COUNTRY_ID}`);
  const brands = {};
  for (const b of brandsBody.Brands || []) brands[b.BrandId] = b.Name;

  const sitesBody = await get(
    `/Subscriber/GetFullSiteDetails?countryId=${COUNTRY_ID}&geoRegionLevel=${GEO_LEVEL}&geoRegionId=${GEO_ID}`
  );
  const pricesBody = await get(
    `/Price/GetSitesPrices?countryId=${COUNTRY_ID}&geoRegionLevel=${GEO_LEVEL}&geoRegionId=${GEO_ID}`
  );

  const sites = new Map();
  for (const s of sitesBody.S || []) {
    const siteId = s.S;
    const postcode = num(s.P);
    const state = postcode !== null ? stateFromPostcode(postcode) : 'SA';
    // A few border stations carry Victorian postcodes. SA has its own source; drop them.
    if (state !== 'SA') continue;

    sites.set(siteId, {
      id: `${NAME}:SA:${siteId}`,
      code: String(siteId),
      name: s.N || '',
      brand: brands[s.B] || '',
      address: s.A || '',
      suburb: '',
      postcode,
      state: 'SA',
      lat: num(s.Lat),
      lng: num(s.Lng),
      prices: {},
      updated: s.M || null,
    });
  }

  let priceRows = 0;
  for (const p of pricesBody.SitePrices || []) {
    const fuel = FUEL_MAP[p.FuelId];
    if (!fuel) continue;
    const raw = num(p.Price);
    if (raw === null || raw >= PRICE_UNAVAILABLE) continue;
    const site = sites.get(p.SiteId);
    if (!site) continue;
    site.prices[fuel] = Math.round(raw);
    priceRows++;
    if (p.TransactionDateUtc) site.updated = p.TransactionDateUtc;
  }

  const stations = [...sites.values()].filter((s) => Object.keys(s.prices).length > 0);

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    fetchedAt: new Date().toISOString(),
    states: STATES,
    sampled: [],
    stations,
    notes: [
      `sites: ${(sitesBody.S || []).length}, prices joined: ${priceRows}, with fuel: ${stations.length}`,
    ],
  };
}

module.exports = {
  NAME,
  ATTRIBUTION,
  LICENCE,
  STATES,
  BASE,
  COUNTRY_ID,
  GEO_LEVEL,
  GEO_ID,
  FUEL_MAP,
  fetchStations,
};
