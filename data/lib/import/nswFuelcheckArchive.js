'use strict';

// NSW FuelCheck monthly archives (Data.NSW). Covers NSW, ACT (postcode), and
// Tasmanian stations present in the feed. Station-level event log: we take the
// last price per station per fuel per local calendar day.
//
// Prefer local files in cache/nsw/ (CSV or XLSX). Falls back to CKAN downloads.

const fs = require('fs');
const path = require('path');
const xlsx = require('../xlsx');
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
  const m = /(?:price history|fuelcheck|price_history|fuelcheck_pricehistory)[^\d]*(\w+)\s*(\d{4})/i.exec(
    name
  );
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

/** Parse FuelCheck PriceUpdatedDate: ISO string, DD/MM/YYYY, or Excel serial. */
function parseUpdated(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    const iso = xlsx.serialToISO(val);
    // Preserve time ordering within a day via fractional part.
    const frac = val - Math.floor(val);
    return { iso, ts: iso + 'T' + String(frac).slice(0, 10) };
  }
  const s = String(val).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, ts: s };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) {
    const iso = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return { iso, ts: s };
  }
  return null;
}

function addPriceEvent(latest, row, startIso, endIso) {
  const fuelCode = row.FuelCode || row.FuelType || row.fuelcode;
  const fuel = FUEL_MAP[String(fuelCode || '').trim()];
  if (!fuel) return;

  const pc = Number(row.Postcode || row.PostCode || row.postcode);
  const state = stateFromPostcode(pc);
  if (!state || (state !== 'NSW' && state !== 'ACT' && state !== 'TAS')) return;

  const parsed = parseUpdated(row.PriceUpdatedDate || row.PriceUpdated || row.Date);
  if (!parsed || !inRange(parsed.iso, startIso, endIso)) return;

  const price = Number(row.Price);
  if (!Number.isFinite(price)) return;
  // Archives publish cents with one decimal (194.9); live API uses the same.
  const tenths = Math.round(price * 10);

  const name = row.ServiceStationName || row.StationName || row.Name || '';
  const stationKey = `${state}:${pc}:${String(name).toLowerCase()}`;
  const slotKey = `${parsed.iso}|${stationKey}|${fuel}`;
  const prev = latest.get(slotKey);
  if (!prev || parsed.ts >= prev.ts) {
    latest.set(slotKey, {
      ts: parsed.ts,
      station: {
        state,
        postcode: pc,
        name,
        brand: row.Brand || '',
        address: row.Address || '',
        lat: null,
        lng: null,
        prices: { [fuel]: tenths },
      },
      fuel,
      iso: parsed.iso,
    });
  }
}

function flushLatest(latest, stationsByDay) {
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

function ingestCsvFile(filePath, startIso, endIso, stationsByDay) {
  const latest = new Map();
  parseCsvFile(filePath, (row) => addPriceEvent(latest, row, startIso, endIso));
  flushLatest(latest, stationsByDay);
}

function ingestXlsxFile(filePath, startIso, endIso, stationsByDay) {
  const wb = xlsx.open(filePath);
  const sheetName = wb.sheetNames()[0];
  const rows = wb.rows(sheetName);
  if (!rows.length) return;

  const headerRow = rows[0];
  const colToField = {};
  for (const [col, val] of Object.entries(headerRow)) {
    if (val === null || val === undefined) continue;
    const h = String(val).trim().replace(/\s+/g, '');
    // Normalise common header variants to our field names.
    if (/^servicestationname$/i.test(h) || /^stationname$/i.test(h)) colToField[col] = 'ServiceStationName';
    else if (/^address$/i.test(h)) colToField[col] = 'Address';
    else if (/^suburb$/i.test(h)) colToField[col] = 'Suburb';
    else if (/^postcode$/i.test(h)) colToField[col] = 'Postcode';
    else if (/^brand$/i.test(h)) colToField[col] = 'Brand';
    else if (/^fuelcode$/i.test(h) || /^fueltype$/i.test(h)) colToField[col] = 'FuelCode';
    else if (/^priceupdateddate$/i.test(h) || /^priceupdated$/i.test(h)) {
      colToField[col] = 'PriceUpdatedDate';
    } else if (/^price$/i.test(h)) colToField[col] = 'Price';
  }

  const latest = new Map();
  for (const cells of rows.slice(1)) {
    const row = {};
    for (const [col, field] of Object.entries(colToField)) {
      row[field] = cells[col];
    }
    addPriceEvent(latest, row, startIso, endIso);
  }
  flushLatest(latest, stationsByDay);
}

function ingestLocalNswDir(cacheDir, startIso, endIso, stationsByDay) {
  const dir = path.join(cacheDir, 'nsw');
  if (!fs.existsSync(dir)) return { files: 0, skippedXls: [] };

  let files = 0;
  const skippedXls = [];
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    if (!fs.statSync(filePath).isFile()) continue;

    if (/\.csv$/i.test(name)) {
      files++;
      ingestCsvFile(filePath, startIso, endIso, stationsByDay);
      continue;
    }
    if (/\.xlsx$/i.test(name)) {
      files++;
      ingestXlsxFile(filePath, startIso, endIso, stationsByDay);
      continue;
    }
    if (/\.xls$/i.test(name) && !/\.xlsx$/i.test(name)) {
      skippedXls.push(name);
    }
  }
  return { files, skippedXls };
}

async function listResources() {
  const pkg = await packageShow(CKAN, PACKAGE);
  const out = [];
  for (const r of pkg.resources || []) {
    const fmt = (r.format || '').toUpperCase();
    if (fmt !== 'CSV' && fmt !== 'XLSX' && fmt !== 'XLS') continue;
    if (!/price history|fuelcheck/i.test(r.name || '')) continue;
    const when = parseResourceMonth(r.name || '');
    if (!when) continue;
    out.push({ name: r.name, url: r.url, format: fmt, ...when });
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

/**
 * @returns {Promise<{byState: Map, localFiles: number, skippedXls: string[]}>}
 */
async function importNswActTas(cacheDir, days) {
  const { startIso, endIso } = dayRange(days);
  const stationsByDay = new Map();

  const local = ingestLocalNswDir(cacheDir, startIso, endIso, stationsByDay);

  // Also pull overlapping months from CKAN when the portal is up.
  try {
    const resources = await listResources();
    const needed = resources.filter((r) => monthOverlapsRange(r.year, r.month, startIso, endIso));
    for (const r of needed) {
      const ext = r.format === 'XLSX' || r.format === 'XLS' ? 'xlsx' : 'csv';
      if (r.format === 'XLS') continue; // legacy BIFF not supported by our reader
      const fname = `nsw-${r.year}-${String(r.month).padStart(2, '0')}.${ext}`;
      const file = await downloadCached(r.url, cacheDir, fname);
      if (ext === 'xlsx') ingestXlsxFile(file, startIso, endIso, stationsByDay);
      else ingestCsvFile(file, startIso, endIso, stationsByDay);
    }
  } catch (err) {
    if (!local.files) throw err;
    console.log(`  CKAN download skipped (${err.message}); using local files only`);
  }

  return {
    byState: readingsByStateAndDay(stationsByDay, { preferMetro: false }),
    localFiles: local.files,
    skippedXls: local.skippedXls,
  };
}

module.exports = {
  ATTRIBUTION,
  importNswActTas,
  listResources,
  dayRange,
};
