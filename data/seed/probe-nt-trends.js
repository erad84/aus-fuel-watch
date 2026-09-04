'use strict';

// Probe MyFuel NT Trends page / AJAX for backfill-worthy series.
// Usage: node data/seed/probe-nt-trends.js

const fs = require('fs');
const path = require('path');

const BASE = 'https://myfuelnt.nt.gov.au';
const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';

async function get(urlPath, opts = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    headers: {
      'User-Agent': UA,
      Accept: opts.accept || '*/*',
      ...(opts.headers || {}),
    },
    method: opts.method || 'GET',
    body: opts.body,
  });
  const text = await res.text();
  return { status: res.status, ctype: res.headers.get('content-type'), text };
}

function dumpMatches(label, text, re) {
  const hits = [...text.matchAll(re)].map((m) => m[0]);
  console.log(`\n=== ${label} (${hits.length}) ===`);
  for (const h of [...new Set(hits)].slice(0, 40)) console.log(' ', h.slice(0, 200));
}

async function main() {
  const cacheDir = path.join(__dirname, '.import-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const page = await get('/Trends/GetTrends?fueltypeId=DL&period=Weekly&regionId=0');
  console.log(`GetTrends HTML: HTTP ${page.status} ${page.ctype} ${page.text.length} bytes`);
  fs.writeFileSync(path.join(cacheDir, 'nt-trends-sample.html'), page.text);

  dumpMatches('script src', page.text, /src=["']([^"']+)["']/gi);
  dumpMatches('Trend URLs', page.text, /["']([^"']*[Tt]rend[^"']*)["']/g);
  dumpMatches('ajax/getJSON', page.text, /\.(?:getJSON|ajax|post|get)\([^)]{0,120}/gi);
  dumpMatches('fuel/period selects', page.text, /<(?:select|option)[^>]{0,80}(?:fuel|period|region|Fuel|Period|Region)[^>]{0,80}>/gi);

  const chartIdx = page.text.search(/highcharts|Chart\.|series\s*:|categories\s*:/i);
  console.log('\n=== chart-ish snippet ===');
  if (chartIdx >= 0) console.log(page.text.slice(Math.max(0, chartIdx - 100), chartIdx + 900));
  else console.log('(none)');

  // Inline scripts
  console.log('\n=== inline scripts ===');
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  let n = 0;
  while ((sm = scriptRe.exec(page.text)) !== null) {
    const body = sm[1].trim();
    if (body.length < 40) continue;
    n++;
    console.log(`\n--- inline #${n} (${body.length} chars) ---`);
    console.log(body.slice(0, 1500));
  }

  // Try common AJAX shapes against the same route
  const candidates = [
    '/Trends/GetTrendsData?fueltypeId=DL&period=Weekly&regionId=0',
    '/Trends/GetChartData?fueltypeId=DL&period=Weekly&regionId=0',
    '/Trends/GetAveragePrices?fueltypeId=DL&period=Weekly&regionId=0',
    '/Trends/GetTrendsJson?fueltypeId=DL&period=Weekly&regionId=0',
    '/api/Trends?fueltypeId=DL&period=Weekly&regionId=0',
    '/Trends/GetTrends?fueltypeId=DL&period=Weekly&regionId=0',
  ];

  console.log('\n=== candidate endpoints ===');
  for (const p of candidates) {
    const r = await get(p, { accept: 'application/json, text/plain, */*' });
    const start = r.text.trim().slice(0, 120).replace(/\s+/g, ' ');
    console.log(`  ${p}`);
    console.log(`    HTTP ${r.status} ${r.ctype} len=${r.text.length} start=${start}`);
  }

  // POST form-style (ASP.NET MVC often wants this)
  const formBody = new URLSearchParams({
    fueltypeId: 'DL',
    period: 'Weekly',
    regionId: '0',
  }).toString();
  const post = await get('/Trends/GetTrends', {
    method: 'POST',
    accept: 'application/json, text/html, */*',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  console.log(`\nPOST /Trends/GetTrends: HTTP ${post.status} ${post.ctype} len=${post.text.length}`);
  console.log(post.text.trim().slice(0, 300).replace(/\s+/g, ' '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
