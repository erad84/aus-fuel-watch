#!/usr/bin/env node
/**
 * Rebuild viewer/docs au-suburbs from G-NAF-derived locality centroids
 * (joelkoen/postcodes-au → localities-au.csv).
 *
 * Unlike schappim postcode points (one lat/lng shared by every locality in a
 * postcode), these are address-average centroids per locality+postcode+state.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const root = path.join(__dirname, '..');
const SOURCE_URL = 'https://pub.joel.net.au/datasets/postcodes-au/localities-au.csv';
const CACHE = path.join(root, '.cache/localities-au.csv');

function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return fetchToFile(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', reject);
  });
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const need = ['locality', 'state', 'postcode', 'latitude', 'longitude'];
  for (const k of need) {
    if (idx[k] == null) throw new Error('CSV missing column: ' + k);
  }
  const rows = [];
  for (const line of lines) {
    /* Simple CSV — fields have no commas/quotes in this dataset */
    const parts = line.split(',');
    if (parts.length < header.length) continue;
    const locality = String(parts[idx.locality] || '').trim();
    const state = String(parts[idx.state] || '').trim().toUpperCase();
    const postcode = String(parts[idx.postcode] || '').trim().padStart(4, '0');
    const lat = Number(parts[idx.latitude]);
    const lng = Number(parts[idx.longitude]);
    const count = Number(parts[idx.count]);
    if (!locality || !state || postcode === '0000') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -45 || lat > -8 || lng < 110 || lng > 155) continue;
    rows.push({
      s: locality.toUpperCase(),
      p: postcode,
      st: state,
      lat: Math.round(lat * 10000) / 10000,
      lng: Math.round(lng * 10000) / 10000,
      n: Number.isFinite(count) ? count : undefined,
    });
  }
  return rows;
}

async function main() {
  const force = process.argv.includes('--force');
  if (force || !fs.existsSync(CACHE)) {
    console.log('downloading', SOURCE_URL);
    await fetchToFile(SOURCE_URL, CACHE);
  } else {
    console.log('using cache', CACHE);
  }
  const text = fs.readFileSync(CACHE, 'utf8');
  const suburbs = parseCsv(text);
  suburbs.sort((a, b) => {
    if (a.s !== b.s) return a.s < b.s ? -1 : 1;
    if (a.st !== b.st) return a.st < b.st ? -1 : 1;
    return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
  });

  const data = {
    v: 3,
    source: 'joelkoen/postcodes-au localities-au.csv (G-NAF address averages)',
    license:
      'Incorporates or developed using G-NAF © Geoscape Australia under the Open G-NAF End User Licence Agreement',
    note: 's=suburb p=postcode st=state; lat/lng are locality centroids (not shared postcode points)',
    generatedAt: new Date().toISOString(),
    suburbs: suburbs.map(({ s, p, st, lat, lng }) => ({ s, p, st, lat, lng })),
  };

  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(root, 'viewer/au-suburbs-data.js'), 'window.AFW_SUBURBS=' + json + ';\n');
  fs.writeFileSync(path.join(root, 'viewer/au-suburbs.json'), json);
  fs.mkdirSync(path.join(root, 'docs/v1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/v1/au-suburbs.json'), json);

  const pen = suburbs.find((r) => r.s === 'PENRITH' && r.st === 'NSW' && r.p === '2750');
  const emu = suburbs.find((r) => r.s === 'EMU PLAINS' && r.st === 'NSW' && r.p === '2750');
  console.log('suburbs', suburbs.length, (Buffer.byteLength(json) / 1e6).toFixed(2) + 'MB');
  console.log('PENRITH', pen);
  console.log('EMU PLAINS', emu);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
