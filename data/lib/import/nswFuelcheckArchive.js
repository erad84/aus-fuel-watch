'use strict';

// NSW FuelCheck monthly archives (Data.NSW). Covers NSW, ACT (postcode), and
// Tasmanian stations present in the feed. Station-level event log: we take the
// last price per station per fuel per local calendar day.

const path = require('path');
const { parseCsvFile } = require('./csv');
const { packageShow, downloadCached } = require('./ckan');
const { readingsByStateAndDay } = require('./aggregateDays');
const { stateFromPostcode } = require('../regions');
const { isoToDayNum, dayNumToISO } = require('../cyclefit');

const CKAN = 'https://data.nsw.gov.au/data';
const PACKAGE = 'fuel-check';
const ATTRIBUTION = 'NSW FuelCheck and FuelCheck TAS (NSW Government)';

const FUEL_MAP = {
  U91: 'U91',
  E10: 'E10',
  P95: 'P95',
  P98: 'P98',
  DL: 'DSL',
  PDL: 'PDSL',
};

const MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function parseResourceMonth(name) {
  const m = /(?:price history|fuelcheck)[^\d]*(\w+)\s+(\d{4})/i.exec(name);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return { year: Number(m[2]), month: mo };
}

function dayRange(days) {
  const end = new Date();
  const startNum = isoToDayNum(end.toISOString().slice(0, 10)) - (days - 1);
  return { startIso: dayNumToISO(startNum), endIso: end.toISOString().slice(0, 10) };
}

function inRange(iso, startIso, endIso) {
  return iso >= startIso && iso <= endIso;
}

function monthOverlapsRange(year, month, startIso, endIso) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return last >= startIso && first <= endIso;
}

async function listResources() {
  const pkg = await packageShow(CKAN, PACKAGE);
  const out = [];
  for (const r of pkg.resources || []) {
    const fmt = (r.format || '').toUpperCase();
    if (fmt !== 'CSV') continue;
    if (!/price history/i.test(r.name || '')) continue;
    const when = parseResourceMonth(r.name || '');
    if (!when) continue;
    out.push({ name: r.name, url: r.url, ...when });
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

function ingestCsvFile(filePath, startIso, endIso, stationsByDay) {
  // last price per station+fuel+day wins
  const latest = new Map();

  parseCsvFile(filePath, (row) => {
    const fuel = FUEL_MAP[row.FuelCode];
    if (!fuel) return;
    const pc = Number(row.Postcode);
    const state = stateFromPostcode(pc);
    if (!state || (state !== 'NSW' && state !== 'ACT' && state !== 'TAS')) return;

    const dateStr = (row.PriceUpdatedDate || '').trim();
    const iso = dateStr.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !inRange(iso, startIso, endIso)) return;

    const price = Number(row.Price);
    if (!Number.isFinite(price)) return;
    const tenths = Math.round(price * 10);

    const stationKey = `${state}:${row.Postcode}:${(row.ServiceStationName || '').toLowerCase()}`;
    const slotKey = `${iso}|${stationKey}|${fuel}`;
    const ts = dateStr;
    const prev = latest.get(slotKey);
    if (!prev || ts >= prev.ts) {
      latest.set(slotKey, {
        ts,
        station: {
          state,
          postcode: pc,
          name: row.ServiceStationName || '',
          brand: row.Brand || '',
          address: row.Address || '',
          lat: null,
          lng: null,
          prices: { [fuel]: tenths },
        },
        fuel,
        iso,
      });
    }
  });

  for (const rec of latest.values()) {
    if (!stationsByDay.has(rec.iso)) stationsByDay.set(rec.iso, []);
    const list = stationsByDay.get(rec.iso);
    const key = `${rec.station.state}:${rec.station.postcode}:${rec.station.name}`;
    let st = list.find((s) => s._key === key);
    if (!st) {
      st = { ...rec.station, prices: {}, _key: key };
      list.push(st);
    }
    st.prices[rec.fuel] = rec.station.prices[rec.fuel];
  }
}

/**
 * @returns {Promise<Map<string, Map<string, object>>>} state -> day -> readings
 */
async function importNswActTas(cacheDir, days) {
  const { startIso, endIso } = dayRange(days);
  const resources = await listResources();
  const needed = resources.filter((r) => monthOverlapsRange(r.year, r.month, startIso, endIso));
  if (!needed.length) {
    return new Map();
  }

  const stationsByDay = new Map();
  for (const r of needed) {
    const fname = `nsw-${r.year}-${String(r.month).padStart(2, '0')}.csv`;
    const file = await downloadCached(r.url, cacheDir, fname);
    ingestCsvFile(file, startIso, endIso, stationsByDay);
  }

  return readingsByStateAndDay(stationsByDay, { preferMetro: false });
}

module.exports = {
  ATTRIBUTION,
  importNswActTas,
  listResources,
  dayRange,
};
