'use strict';

// Queensland open-data monthly CSVs (changes-only event log).

const { parseCsvFile } = require('./csv');
const { packageShow, downloadCached } = require('./ckan');
const { readingsByStateAndDay } = require('./aggregateDays');
const { isoToDayNum, dayNumToISO } = require('../cyclefit');
const { localParts } = require('../states');

const CKAN = 'https://www.data.qld.gov.au';
const PACKAGES = ['fuel-price-reporting-2026', 'fuel-price-reporting-2025'];
const ATTRIBUTION = 'Fuel Prices Queensland (Queensland Government)';

const FUEL_MAP = {
  Unleaded: 'U91',
  e10: 'E10',
  E10: 'E10',
  'PULP 95/96 RON': 'P95',
  'PULP 98 RON': 'P98',
  Diesel: 'DSL',
  'Premium Diesel': 'PDSL',
};

function parseQldUtc(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec((s || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])));
}

function dayRange(days) {
  const endIso = localParts(new Date(), 'QLD').day;
  const startNum = isoToDayNum(endIso) - (days - 1);
  return { startIso: dayNumToISO(startNum), endIso };
}

function inRange(iso, startIso, endIso) {
  return iso >= startIso && iso <= endIso;
}

async function listCsvResources() {
  const out = [];
  for (const pkgId of PACKAGES) {
    try {
      const pkg = await packageShow(CKAN, pkgId);
      for (const r of pkg.resources || []) {
        if ((r.format || '').toUpperCase() !== 'CSV') continue;
        if (!/fuel prices/i.test(r.name || '')) continue;
        const ym = /(\d{4})-(\d{2})/.exec(r.url || '') || /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i.exec(
          r.name || ''
        );
        out.push({
          name: r.name,
          url: r.url,
          packageId: pkgId,
        });
      }
    } catch (err) {
      // year package may not exist yet
    }
  }
  return out;
}

function ingestQldFile(filePath, startIso, endIso, stationsByDay) {
  const latest = new Map();

  parseCsvFile(filePath, (row) => {
    if ((row.Site_State || '').trim() !== 'QLD') return;
    const fuel = FUEL_MAP[row.Fuel_Type];
    if (!fuel) return;

    const dt = parseQldUtc(row.TransactionDateutc);
    if (!dt) return;
    const iso = localParts(dt, 'QLD').day;
    if (!inRange(iso, startIso, endIso)) return;

    let tenths = Number(row.Price);
    if (!Number.isFinite(tenths) || tenths === 9999) return;

    const lat = Number(row.Site_Latitude);
    const lng = Number(row.Site_Longitude);
    const siteId = row.SiteId || row.Site_Name;
    const slotKey = `${iso}|${siteId}|${fuel}`;
    const ts = dt.getTime();
    const prev = latest.get(slotKey);
    if (!prev || ts >= prev.ts) {
      latest.set(slotKey, {
        ts,
        iso,
        fuel,
        station: {
          state: 'QLD',
          code: siteId,
          name: row.Site_Name || '',
          brand: row.Site_Brand || '',
          address: row.Sites_Address_Line_1 || '',
          postcode: Number(row.Site_Post_Code) || null,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          prices: { [fuel]: tenths },
        },
      });
    }
  });

  for (const rec of latest.values()) {
    if (!stationsByDay.has(rec.iso)) stationsByDay.set(rec.iso, []);
    const list = stationsByDay.get(rec.iso);
    const key = String(rec.station.code);
    let st = list.find((s) => s._key === key);
    if (!st) {
      st = { ...rec.station, prices: {}, _key: key };
      list.push(st);
    }
    st.prices[rec.fuel] = rec.station.prices[rec.fuel];
  }
}

async function importQld(cacheDir, days) {
  const { startIso, endIso } = dayRange(days);
  const resources = await listCsvResources();
  const stationsByDay = new Map();

  for (const r of resources) {
    const fname = `qld-${r.packageId}-${(r.name || 'file').replace(/\W+/g, '_').slice(0, 40)}.csv`;
    const file = await downloadCached(r.url, cacheDir, fname);
    ingestQldFile(file, startIso, endIso, stationsByDay);
  }

  return readingsByStateAndDay(stationsByDay, { preferMetro: true });
}

module.exports = { ATTRIBUTION, importQld, dayRange };
