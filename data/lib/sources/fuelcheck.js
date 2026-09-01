'use strict';

// NSW FuelCheck adapter. One set of credentials covers three jurisdictions.
//
// Verified against the live API on 2026-08-31:
//
//   GET /v2/fuel/prices              3273 stations, 10571 prices. NSW *and* ACT
//                                    (68 ACT stations, e.g. BP Nicholls 2913).
//   GET /v2/fuel/prices?states=TAS    292 stations, 953 prices. Full census.
//
// The undocumented `states` parameter is what makes Tasmania workable. The
// default payload contains no Tasmanian stations at all despite the portal
// claiming v2 covers "NSW & Tasmania combined", and the nearby endpoint that
// does return Tasmania caps hard at 20 results regardless of radius. With
// `states=TAS` the whole state arrives in one uncapped call.
//
// Its semantics are narrow: `states=ACT` is a 400, and the value cannot be
// combined (`states=NSW,TAS` is a 400 too), so it is two calls, not one.
//
// Two things here must not be trusted:
//
//   - The default payload's `state` field says "NSW" for all 3273 stations,
//     including the ACT ones. Jurisdiction comes from the postcode instead.
//     (The TAS payload does label its stations correctly, but we treat both
//     the same way rather than special-casing.)
//   - Station codes are only unique within a jurisdiction. 228 of the 292
//     Tasmanian codes also appear in the NSW payload, so a bare-code key would
//     silently overwrite most of Tasmania onto NSW stations.

const { postcodeFromAddress, stateFromPostcode } = require('../regions');

const AUTH_URL =
  'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials';
const BASE = 'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2';

const NAME = 'fuelcheck';
const ATTRIBUTION = 'NSW FuelCheck and FuelCheck TAS (NSW Government)';
const LICENCE = 'NSW Government open data, CC BY 4.0';
const STATES = ['NSW', 'ACT', 'TAS'];

const USER_AGENT = 'AusFuelWatch/1.0 (Pebble watchapp)';

// NSW uses DL/PDL where our canon and Victoria use DSL/PDSL.
const FUEL_MAP = {
  U91: 'U91',
  E10: 'E10',
  P95: 'P95',
  P98: 'P98',
  DL: 'DSL',
  PDL: 'PDSL',
};

// The default payload carries NSW and ACT together; Tasmania needs its own
// call. `states=ACT` is rejected, so ACT is never requested directly.
const BULK_QUERIES = [
  { label: 'NSW+ACT', qs: '' },
  { label: 'TAS', qs: '?states=TAS' },
];

function requireCredentials() {
  const key = process.env.FUELCHECK_API_KEY;
  const secret = process.env.FUELCHECK_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      'FUELCHECK_API_KEY and FUELCHECK_API_SECRET are not set. ' +
        'Locally: copy .env.example to .env and run with `node --env-file=.env`. ' +
        'In CI: add them as repository secrets. ' +
        'Register free at https://api.nsw.gov.au/Product/Index/22'
    );
  }
  return { key, secret };
}

// dd/MM/yyyy hh:mm:ss AM/PM, no comma. The API rejects other shapes.
function requestTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())} ${ampm}`;
}

// Tokens last about 12 hours. A collector run is far shorter than that, so an
// in-process cache is enough and there is nothing to persist between runs.
let cachedToken = null;

async function getToken(key, secret) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;

  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(AUTH_URL, {
    headers: { Authorization: `Basic ${basic}`, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    // Never echo the response body: it can contain credential fragments.
    throw new Error(`FuelCheck auth failed with HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body.access_token) throw new Error('FuelCheck auth returned no access_token');

  const ttlMs = (Number(body.expires_in) || 43199) * 1000;
  cachedToken = { value: body.access_token, expiresAt: Date.now() + ttlMs };
  return cachedToken.value;
}

function headers(token, key) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: key,
    transactionid: `ausfuelwatch_${Date.now()}`,
    requesttimestamp: requestTimestamp(new Date()),
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

function toTenths(cents) {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return null;
  return Math.round(cents * 10);
}

// Joins the parallel stations and prices arrays into one record per station.
//
// Station codes are only unique within a jurisdiction, so the accumulator is
// keyed by state and code together. Keying on the bare code let Tasmanian
// stations returned by the nearby endpoint land on top of NSW stations that
// happened to share a code, which both lost TAS rows and corrupted NSW ones.
// The price join uses a per-response lookup, since codes are unambiguous
// within a single response.
function joinStations(stations, prices, out) {
  const local = new Map();

  for (const s of stations) {
    const address = typeof s.address === 'string' ? s.address : '';
    const postcode = postcodeFromAddress(address);
    const state = stateFromPostcode(postcode);
    // A handful of border stations report Victorian or Queensland postcodes.
    // They are real, but one station is not a state average, and those states
    // have their own authoritative sources.
    if (!state || STATES.indexOf(state) === -1) continue;

    const code = String(s.code);
    const key = `${state}:${code}`;
    let rec = out.get(key);
    if (!rec) {
      rec = {
        id: `fuelcheck:${key}`,
        code,
        name: s.name || '',
        brand: s.brand || '',
        address,
        postcode,
        state,
        lat: s.location ? s.location.latitude : null,
        lng: s.location ? s.location.longitude : null,
        prices: {},
        updated: null,
      };
      out.set(key, rec);
    }
    local.set(code, rec);
  }

  for (const p of prices) {
    const fuel = FUEL_MAP[p.fueltype];
    if (!fuel) continue;
    const rec = local.get(String(p.stationcode));
    if (!rec) continue;
    const tenths = toTenths(p.price);
    if (tenths === null) continue;
    rec.prices[fuel] = tenths;
    if (p.lastupdated) rec.updated = p.lastupdated;
  }
}

/**
 * @returns {{source, attribution, licence, fetchedAt, stations: Array, notes: Array}}
 */
async function fetchStations() {
  const { key, secret } = requireCredentials();
  const token = await getToken(key, secret);
  const notes = [];
  const out = new Map();

  for (const q of BULK_QUERIES) {
    const res = await fetch(`${BASE}/fuel/prices${q.qs}`, { headers: headers(token, key) });
    if (!res.ok) throw new Error(`FuelCheck bulk prices (${q.label}) HTTP ${res.status}`);
    const body = await res.json();
    joinStations(body.stations || [], body.prices || [], out);
    notes.push(`${q.label}: ${(body.stations || []).length} stations`);
    await new Promise((r) => setTimeout(r, 1100));
  }

  const stations = [...out.values()].filter((s) => Object.keys(s.prices).length > 0);

  return {
    source: NAME,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    fetchedAt: new Date().toISOString(),
    states: STATES,
    sampled: [],
    stations,
    notes,
  };
}

module.exports = { NAME, ATTRIBUTION, LICENCE, STATES, FUEL_MAP, fetchStations };
