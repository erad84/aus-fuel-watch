'use strict';

// Adapter registry. The collector talks to this rather than to any one source,
// so adding a jurisdiction does not mean rewriting collect.js.
//
// Two kinds of adapter live here and they are not interchangeable:
//
//   fetchStations()  station-level sources, which is what we want everywhere.
//                    They return individual stations with coordinates, so both
//                    state-wide and capital-city averages can be computed.
//   fetchSnapshot()  Petrolmate, which only ever returns pre-aggregated
//                    state-wide numbers. Kept as a fallback for jurisdictions
//                    we have no official station-level access to.
//
// Station identity must be unique across the whole dataset, not just within one
// adapter: NSW and Tasmania share 228 station codes, so every adapter namespaces
// its ids by source and jurisdiction.

const petrolmate = require('./petrolmate');
const fuelcheck = require('./fuelcheck');
const fuelwatch = require('./fuelwatch');
const myfuelnt = require('./myfuelnt');
const safpis = require('./safpis');
const fuelpricesqld = require('./fuelpricesqld');

// Keyed by the jurisdictions each one authoritatively covers.
const STATION_SOURCES = {
  [fuelcheck.NAME]: fuelcheck,
  [fuelwatch.NAME]: fuelwatch,
  [myfuelnt.NAME]: myfuelnt,
  [safpis.NAME]: safpis,
  [fuelpricesqld.NAME]: fuelpricesqld,
};

const SNAPSHOT_SOURCES = { [petrolmate.NAME]: petrolmate };

const SOURCES = { ...STATION_SOURCES, ...SNAPSHOT_SOURCES };
const DEFAULT_SOURCE = petrolmate.NAME;

// Which adapter owns which jurisdiction. VIC still needs Servo Saver credentials.
const BY_STATE = {
  NSW: fuelcheck.NAME,
  ACT: fuelcheck.NAME,
  TAS: fuelcheck.NAME,
  WA: fuelwatch.NAME,
  NT: myfuelnt.NAME,
  SA: safpis.NAME,
  QLD: fuelpricesqld.NAME,
};

function get(name) {
  const s = SOURCES[name || DEFAULT_SOURCE];
  if (!s) throw new Error(`unknown source: ${name}. Known: ${Object.keys(SOURCES).join(', ')}`);
  return s;
}

function stationSources() {
  return Object.values(STATION_SOURCES);
}

module.exports = {
  SOURCES,
  STATION_SOURCES,
  SNAPSHOT_SOURCES,
  DEFAULT_SOURCE,
  BY_STATE,
  get,
  stationSources,
};
