'use strict';

// NT MyFuel monthly XLSX archives (daily rows per station).

const path = require('path');
const xlsx = require('../xlsx');
const { fetchJson, downloadCached } = require('./ckan');
const { readingsByStateAndDay } = require('./aggregateDays');
const { isoToDayNum, dayNumToISO } = require('../cyclefit');
const { localParts } = require('../states');

const CKAN = 'https://data.nt.gov.au';
const ATTRIBUTION = 'MyFuel NT (NT Consumer Affairs)';

const GREATER_DARWIN = new Set(['Darwin', 'Palmerston', 'Litchfield']);

const COL_FUEL = {
  H: 'DSL',
  I: 'P98',
  J: 'P95',
  K: 'U91',
  L: 'PDSL',
  P: 'E10',
};

function dayRange(days) {
  const endIso = localParts(new Date(), 'NT').day;
  const startNum = isoToDayNum(endIso) - (days - 1);
  return { startIso: dayNumToISO(startNum), endIso };
}

function inRange(iso, startIso, endIso) {
  return iso >= startIso && iso <= endIso;
}

async function searchPackages() {
  const body = await fetchJson(`${CKAN}/api/3/action/package_search?q=MyFuel&rows=100`);
  return (body.result && body.result.results) || [];
}

function ingestXlsx(filePath, startIso, endIso, stationsByDay) {
  const wb = xlsx.open(filePath);
  const sheet = wb.sheetNames()[0];
  const rows = wb.rows(sheet);
  if (!rows.length) return;

  for (const row of rows.slice(1)) {
    const serial = row.A;
    if (typeof serial !== 'number') continue;
    const iso = xlsx.serialToISO(serial);
    if (!inRange(iso, startIso, endIso)) continue;

    const region = String(row.C || '');
    const inMetro = GREATER_DARWIN.has(region);
    const lat = typeof row.F === 'number' ? row.F : null;
    const lng = typeof row.G === 'number' ? row.G : null;
    const stationKey = `${row.B}|${row.D}|${row.E}`;

    const prices = {};
    for (const [col, fuel] of Object.entries(COL_FUEL)) {
      const v = row[col];
      if (typeof v !== 'number' || v <= 0) continue;
      prices[fuel] = Math.round(v * 10);
    }
    if (!Object.keys(prices).length) continue;

    if (!stationsByDay.has(iso)) stationsByDay.set(iso, []);
    const list = stationsByDay.get(iso);
    let st = list.find((s) => s._key === stationKey);
    if (!st) {
      st = {
        state: 'NT',
        name: String(row.B || ''),
        brand: String(row.B || ''),
        address: `${row.D || ''} ${row.E || ''}`.trim(),
        postcode: typeof row.E === 'number' ? row.E : Number(row.E) || null,
        lat,
        lng,
        metro: inMetro,
        prices: {},
        _key: stationKey,
      };
      list.push(st);
    }
    Object.assign(st.prices, prices);
  }
}

async function importNt(cacheDir, days) {
  const { startIso, endIso } = dayRange(days);
  const packages = await searchPackages();
  const stationsByDay = new Map();
  const startYear = Number(startIso.slice(0, 4)) - 1;

  for (const pkg of packages) {
    const title = pkg.title || '';
    const yearMatch = title.match(/\b(20\d{2})\b/);
    if (yearMatch && Number(yearMatch[1]) < startYear) continue;

    const show = await fetchJson(`${CKAN}/api/3/action/package_show?id=${pkg.id}`);
    const resources = show.result && show.result.resources;
    if (!resources) continue;
    for (const r of resources) {
      if ((r.format || '').toUpperCase() !== 'XLSX') continue;
      const fname = `nt-${pkg.id}-${r.id}.xlsx`;
      const file = await downloadCached(r.url, path.join(cacheDir, 'nt'), fname);
      ingestXlsx(file, startIso, endIso, stationsByDay);
    }
  }

  return readingsByStateAndDay(stationsByDay, { preferMetro: true });
}

module.exports = { ATTRIBUTION, importNt, dayRange };
