'use strict';

// Jurisdiction and metro classification for station-level data.
//
// Two problems this solves:
//
// 1. Source `state` fields cannot be trusted. NSW FuelCheck's bulk feed labels
//    every station "NSW", including the 68 ACT ones whose addresses plainly say
//    ACT. Postcode is authoritative, so we parse it out of the address.
//
// 2. Metro averages are the entire point of collecting station-level data,
//    because state-wide averaging smears the price cycle away. Metro membership
//    is decided by distance from the capital's GPO rather than by postcode
//    lists, since every source gives us coordinates but only some give a clean
//    postcode.

const DEG = Math.PI / 180;
const EARTH_KM = 6371;

// Australian postcode allocations. Ranges are inclusive.
const STATE_POSTCODES = [
  ['NT', 800, 999],
  ['ACT', 200, 299],
  ['NSW', 1000, 2599],
  ['ACT', 2600, 2618],
  ['NSW', 2619, 2898],
  ['ACT', 2900, 2920],
  ['NSW', 2921, 2999],
  ['VIC', 3000, 3999],
  ['QLD', 4000, 4999],
  ['SA', 5000, 5999],
  ['WA', 6000, 6999],
  ['TAS', 7000, 7999],
  ['VIC', 8000, 8999],
  ['QLD', 9000, 9999],
];

// Capital GPO coordinates, with a radius chosen to approximate each Greater
// Capital City Statistical Area. These are deliberately generous enough to
// include the outer suburbs that participate in the metro price cycle, and
// tight enough to exclude regional towns that do not.
const CAPITALS = {
  NSW: { name: 'Sydney', lat: -33.8688, lng: 151.2093, radiusKm: 60 },
  VIC: { name: 'Melbourne', lat: -37.8136, lng: 144.9631, radiusKm: 60 },
  QLD: { name: 'Brisbane', lat: -27.4698, lng: 153.0251, radiusKm: 70 },
  SA: { name: 'Adelaide', lat: -34.9285, lng: 138.6007, radiusKm: 45 },
  WA: { name: 'Perth', lat: -31.9523, lng: 115.8613, radiusKm: 60 },
  TAS: { name: 'Hobart', lat: -42.8821, lng: 147.3272, radiusKm: 30 },
  NT: { name: 'Darwin', lat: -12.4634, lng: 130.8456, radiusKm: 30 },
  ACT: { name: 'Canberra', lat: -35.2809, lng: 149.13, radiusKm: 30 },
};

function stateFromPostcode(pc) {
  if (typeof pc !== 'number' || Number.isNaN(pc)) return null;
  for (const [state, lo, hi] of STATE_POSTCODES) {
    if (pc >= lo && pc <= hi) return state;
  }
  return null;
}

// Australian addresses end with "SUBURB STATE 1234". Take the trailing 4-digit
// group rather than the first one found, since street numbers can be 4 digits.
function postcodeFromAddress(address) {
  if (typeof address !== 'string') return null;
  const m = /(\d{4})\s*$/.exec(address.trim());
  return m ? Number(m[1]) : null;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns the state code whose capital this point sits inside, or null if the
// station is regional. Checks only the expected state's capital when known, so
// a border town cannot be misfiled into a neighbouring capital.
function metroOf(lat, lng, state) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const candidates = state && CAPITALS[state] ? [state] : Object.keys(CAPITALS);
  for (const code of candidates) {
    const c = CAPITALS[code];
    if (distanceKm(lat, lng, c.lat, c.lng) <= c.radiusKm) return code;
  }
  return null;
}

// Best-effort jurisdiction for a station: postcode first, then an explicit
// state field, then coordinates.
function resolveState(station) {
  const pc =
    typeof station.postcode === 'number'
      ? station.postcode
      : postcodeFromAddress(station.address || '');
  const byPostcode = stateFromPostcode(pc);
  if (byPostcode) return byPostcode;
  if (station.state && CAPITALS[station.state]) return station.state;
  return null;
}

module.exports = {
  CAPITALS,
  stateFromPostcode,
  postcodeFromAddress,
  distanceKm,
  metroOf,
  resolveState,
};
