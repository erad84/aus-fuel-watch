'use strict';

// WA FuelWatch: RSS supports today and yesterday only. For longer history,
// place monthly FuelWatchRetail-*.csv or *.csv.zip files in cache/wa/.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fuelwatch = require('../sources/fuelwatch');
const { parseCsvFile } = require('./csv');
const { readingsByStateAndDay } = require('./aggregateDays');
const { isoToDayNum, dayNumToISO } = require('../cyclefit');
const { localParts } = require('../states');

const ATTRIBUTION = fuelwatch.ATTRIBUTION;

const PRODUCT_FUEL = {
  1: 'U91',
  2: 'P95',
  4: 'DSL',
  6: 'P98',
  11: 'PDSL',
};

function dayRange(days) {
  const endIso = localParts(new Date(), 'WA').day;
  const startNum = isoToDayNum(endIso) - (days - 1);
  return { startIso: dayNumToISO(startNum), endIso };
}

function inRange(iso, startIso, endIso) {
  return iso >= startIso && iso <= endIso;
}

async function importWaRss(stationsByDay, startIso, endIso) {
  const today = localParts(new Date(), 'WA').day;
  const yesterday = dayNumToISO(isoToDayNum(today) - 1);
  const labels = [];
  if (inRange(today, startIso, endIso)) labels.push({ label: 'today', iso: today });
  if (inRange(yesterday, startIso, endIso)) labels.push({ label: 'yesterday', iso: yesterday });

  for (const { label, iso } of labels) {
    const { stations } = await fuelwatch.fetchStationsForDay(label);
    for (const s of stations) {
      delete s.tomorrow;
      delete s.restrictions;
    }
    stationsByDay.set(iso, stations);
  }
}

function parseWaDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function fuelFromProduct(desc) {
  const lower = String(desc || '').trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes('premium') && lower.includes('diesel')) return 'PDSL';
  if (lower === 'brand diesel') return 'PDSL';
  if (lower === 'diesel') return 'DSL';
  if (lower.includes('98')) return 'P98';
  if (lower === 'pulp' || lower.includes('95')) return 'P95';
  if (lower === 'ulp' || lower.includes('unleaded')) return 'U91';
  return PRODUCT_FUEL[desc] || PRODUCT_FUEL[Number(desc)] || null;
}

function ingestWaCsv(filePath, startIso, endIso, stationsByDay) {
  parseCsvFile(filePath, (row) => {
    const dateCol =
      row.PUBLISH_DATE ||
      row.PUBLISHED_DAY ||
      row.PublishedDay ||
      row.DATE ||
      row.Date ||
      row.date ||
      row['Service Date'];
    const iso = parseWaDate(dateCol);
    if (!iso || !inRange(iso, startIso, endIso)) return;

    const priceRaw =
      row.PRODUCT_PRICE ||
      row.PRICE ||
      row.Price ||
      row.price ||
      row['Todays Price'] ||
      row["Today's Price"];
    const price = Number(String(priceRaw).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(price)) return;

    const product = row.PRODUCT_DESCRIPTION || row.PRODUCT || row.Product || row.FUEL_TYPE;
    const fuel = fuelFromProduct(product);
    if (!fuel) return;

    const name = row.TRADING_NAME || row.TradingName || row.trading_name || row.Station || '';
    const suburb = row.LOCATION || row.Location || row.SUBURB || row.Suburb || '';
    const lat = Number(row.LATITUDE || row.Latitude || row.latitude);
    const lng = Number(row.LONGITUDE || row.Longitude || row.longitude);
    const inMetro = (row.REGION_DESCRIPTION || '').trim() === 'Metro';

    if (!stationsByDay.has(iso)) stationsByDay.set(iso, []);
    const list = stationsByDay.get(iso);
    const key = `${name}|${suburb}`.toLowerCase();
    let st = list.find((x) => x._key === key);
    if (!st) {
      st = {
        state: 'WA',
        name,
        brand: row.BRAND_DESCRIPTION || row.BRAND || row.Brand || '',
        address: row.ADDRESS || row.Address || suburb,
        suburb,
        postcode: row.POSTCODE ? Number(row.POSTCODE) : null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        metro: inMetro,
        prices: {},
        _key: key,
      };
      list.push(st);
    }
    st.prices[fuel] = Math.round(price * 10);
  });
}

function ingestWaCacheDir(cacheDir, startIso, endIso, stationsByDay) {
  const dir = path.join(cacheDir, 'wa');
  if (!fs.existsSync(dir)) return { csv: 0, zips: 0 };
  let csv = 0;
  let zips = 0;
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    if (/\.csv$/i.test(name) && !name.startsWith('_tmp_')) {
      csv++;
      ingestWaCsv(filePath, startIso, endIso, stationsByDay);
      continue;
    }
    if (!/\.zip$/i.test(name)) continue;
    zips++;
    const buf = fs.readFileSync(filePath);
    const entries = readZipEntries(buf);
    for (const [entryName, data] of entries) {
      if (!/\.csv$/i.test(entryName)) continue;
      const tmp = path.join(dir, `_tmp_${entryName.replace(/\W+/g, '_')}`);
      fs.writeFileSync(tmp, data);
      ingestWaCsv(tmp, startIso, endIso, stationsByDay);
      fs.unlinkSync(tmp);
    }
  }
  return { csv, zips };
}

function readZipEntries(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length - 30) {
    const sig = buf.readUInt32LE(p);
    if (sig === 0x04034b50) {
      const compMethod = buf.readUInt16LE(p + 8);
      const compSize = buf.readUInt32LE(p + 18);
      const nameLen = buf.readUInt16LE(p + 26);
      const extraLen = buf.readUInt16LE(p + 28);
      const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
      const dataStart = p + 30 + nameLen + extraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let data = raw;
      if (compMethod === 8) data = zlib.inflateRawSync(raw);
      out.push([name, data]);
      p = dataStart + compSize;
    } else if (sig === 0x02014b50) {
      p += 46;
      const nameLen = buf.readUInt16LE(p - 16);
      const extraLen = buf.readUInt16LE(p - 14);
      const commentLen = buf.readUInt16LE(p - 12);
      p += nameLen + extraLen + commentLen;
    } else break;
  }
  return out;
}

async function importWa(cacheDir, days) {
  const { startIso, endIso } = dayRange(days);
  const stationsByDay = new Map();

  await importWaRss(stationsByDay, startIso, endIso);
  const { csv, zips } = ingestWaCacheDir(cacheDir, startIso, endIso, stationsByDay);

  const byState = readingsByStateAndDay(stationsByDay, { preferMetro: true });
  return { byState, waCsv: csv, waZips: zips };
}

module.exports = { ATTRIBUTION, importWa, dayRange };
