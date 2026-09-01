'use strict';

// Queensland Fuel Prices (Fuel Prices QLD Direct / FPPDirect).
//
// Verified against the live API on 2026-09-02:
//
//   GET /Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1
//   GET /Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1
//
// countryId 21 is Australia, geoRegionLevel 3 is state/territory, geoRegionId 1 is
// Queensland. API docs: FuelPricesQLDDirectAPI(OUT) v1.5 on fuelpricesqld.com.au.
//
// Same FPPDirect contract as SAFPIS but a different host and Data Consumer token.

const { stateFromPostcode } = require('../regions');

const BASE = 'https://fppdirectapi-prod.fuelpricesqld.com.au';

const NAME = 'fuelpricesqld';
const ATTRIBUTION = 'Fuel Prices Queensland (Queensland Government)';
const LICENCE = 'Queensland Government fuel price reporting scheme';
const STATES = ['QLD'];

const COUNTRY_ID = 21;
const GEO_LEVEL = 3;
const GEO_ID = 1;

const PRICE_UNAVAILABLE = 9999;

const FUEL_MAP = {
  2: 'U91',
  3: 'DSL',
  5: 'P95',
  8: 'P98',
  12: 'E10',
  14: 'PDSL',
};

function requireToken() {
  const token = process.env.QLD_FUEL_TOKEN;
  if (!token) {
    throw new Error(
      'QLD_FUEL_TOKEN is not set. ' +
        'Locally: copy .env.example to .env and run with `node --env-file=.env`. ' +
        'In CI: add QLD_FUEL_TOKEN as a repository secret. ' +
        'Register at https://www.fuelpricesqld.com.au/'
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
    throw new Error(`Fuel Prices QLD auth failed with HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`Fuel Prices QLD ${path} HTTP ${res.status}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchStations() {
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
    const state = postcode !== null ? stateFromPostcode(postcode) : 'QLD';
    if (state !== 'QLD') continue;

    sites.set(siteId, {
      id: `${NAME}:QLD:${siteId}`,
      code: String(siteId),
      name: s.N || '',
      brand: brands[s.B] || '',
      address: s.A || '',
      suburb: '',
      postcode,
      state: 'QLD',
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
