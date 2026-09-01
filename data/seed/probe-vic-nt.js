'use strict';

// VIC and NT reconnaissance.
//
// VIC: the documented Open Data API is 24-hour delayed and needs an issued
// x-consumer-id. Petrolmate's llms.txt names a real-time `/public/v1/`
// endpoint instead, which is presumably what the Servo Saver app itself calls.
// Establish which of the two actually answers, and whether the real-time one is
// open.
//
// NT: MyFuel NT publishes in real time through a web app but documents no API.
// Find whatever the app calls.
//
// Usage: node data/seed/probe-vic-nt.js

const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function probe(label, url, extraHeaders) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...(extraHeaders || {}) },
      redirect: 'follow',
    });
    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    console.log(
      `  ${label.padEnd(52)} HTTP ${res.status}  ${ctype.split(';')[0].padEnd(24)} ${
        text.length
      } bytes`
    );
    if (text.length && text.length < 700) {
      console.log(`      ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    return { status: res.status, ctype, text };
  } catch (e) {
    console.log(`  ${label.padEnd(52)} ERROR ${e.message}`);
    return null;
  }
}

async function main() {
  const vicHeaders = { 'x-transactionid': uuid() };

  console.log('=== VIC: is there an open real-time endpoint? ===');
  const vicUrls = [
    ['public/v1 prices', 'https://api.fuel.service.vic.gov.au/public/v1/fuel/prices'],
    ['public/v1 stations', 'https://api.fuel.service.vic.gov.au/public/v1/fuel/stations'],
    ['open-data/v1 prices (no key)', 'https://api.fuel.service.vic.gov.au/open-data/v1/fuel/prices'],
    ['open-data/v1 types (no key)', 'https://api.fuel.service.vic.gov.au/open-data/v1/fuel/reference-data/types'],
    ['fuel.service.vic.gov.au root', 'https://api.fuel.service.vic.gov.au/'],
  ];
  for (const [label, url] of vicUrls) {
    await probe(label, url, vicHeaders);
    await sleep(1200);
  }

  console.log('\n=== VIC: what does the Servo Saver web app call? ===');
  const app = await probe('servo saver page', 'https://servosaver.vic.gov.au/');
  if (app && app.text) {
    const hits = new Set();
    for (const m of app.text.matchAll(/https?:\/\/[a-z0-9.-]*fuel[a-z0-9.-]*\/[^"'\s<>]{0,80}/gi)) {
      hits.add(m[0]);
    }
    for (const m of app.text.matchAll(/["'](\/(?:api|public|open-data)\/[^"']{0,80})["']/g)) {
      hits.add(m[1]);
    }
    console.log(`  candidate endpoints found: ${hits.size}`);
    for (const h of [...hits].slice(0, 25)) console.log(`    ${h}`);
    const scripts = [...app.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    console.log(`  scripts: ${scripts.length}`);
    for (const s of scripts.slice(0, 12)) console.log(`    ${s}`);
  }

  console.log('\n=== NT: what backs MyFuel NT? ===');
  const nt = await probe('myfuelnt home', 'https://myfuelnt.nt.gov.au/');
  if (nt && nt.text) {
    console.log(`  page ${nt.text.length} bytes`);
    const hits = new Set();
    for (const m of nt.text.matchAll(/["'](\/?[A-Za-z0-9_\-/]*(?:api|Api|API)[A-Za-z0-9_\-/]*)["']/g)) {
      hits.add(m[1]);
    }
    for (const m of nt.text.matchAll(/https?:\/\/[a-z0-9.-]+\/[^"'\s<>]{0,80}/gi)) {
      if (/api|json|data|price/i.test(m[0])) hits.add(m[0]);
    }
    console.log(`  candidate endpoints: ${hits.size}`);
    for (const h of [...hits].slice(0, 30)) console.log(`    ${h}`);

    const scripts = [...nt.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    console.log(`  scripts: ${scripts.length}`);
    for (const s of scripts.slice(0, 15)) console.log(`    ${s}`);

    // Framework fingerprints tell us whether prices are server-rendered into
    // the HTML or fetched by the client from an endpoint we could call.
    for (const marker of ['__NEXT_DATA__', 'ng-version', 'window.__', 'Blazor', 'vue', 'React']) {
      if (nt.text.includes(marker)) console.log(`  marker present: ${marker}`);
    }
  }

  console.log('\n=== NT: guess the obvious API paths ===');
  for (const p of [
    '/api/prices',
    '/api/fuel/prices',
    '/api/sites',
    '/api/outlets',
    '/api/FuelPrice',
    '/api/v1/prices',
    '/robots.txt',
  ]) {
    await probe(`myfuelnt ${p}`, `https://myfuelnt.nt.gov.au${p}`);
    await sleep(900);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
