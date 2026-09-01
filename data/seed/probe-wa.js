'use strict';

// WA FuelWatch RSS. No credentials.
//
// Two things to establish: which Product codes map to our fuel canon, and
// whether Day=tomorrow really returns next-day prices. WA is the one state
// where the seed fit gives a confident 7-day cycle, so a known next-day price
// would let the watch say "fill up today" with certainty rather than inference.
//
// Usage: node data/seed/probe-wa.js

const BASE = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS';
const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(qs) {
  const res = await fetch(`${BASE}${qs}`, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  const text = await res.text();
  return { status: res.status, ctype: res.headers.get('content-type'), text };
}

function tagAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function tagOne(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

async function main() {
  console.log('--- raw shape, Product=1 (expected ULP) ---');
  const first = await get('?Product=1');
  console.log(`HTTP ${first.status}  ${first.ctype}  ${first.text.length} bytes`);
  const items = tagAll(first.text, 'item');
  console.log(`items: ${items.length}`);
  if (items[0]) {
    console.log('\nfirst item verbatim:');
    console.log(items[0].trim().split('\n').slice(0, 40).join('\n'));
  }
  console.log(`\nchannel title: ${tagOne(first.text, 'title')}`);

  // Which tags are available on an item? Drives the adapter's field mapping.
  if (items[0]) {
    const tags = [...items[0].matchAll(/<([a-zA-Z0-9-]+)>/g)].map((m) => m[1]);
    console.log(`item tags: ${[...new Set(tags)].join(', ')}`);
  }

  console.log('\n--- product codes ---');
  for (const p of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]) {
    await sleep(700);
    const r = await get(`?Product=${p}`);
    const its = tagAll(r.text, 'item');
    let sample = null;
    if (its[0]) {
      sample = {
        title: tagOne(its[0], 'title'),
        brand: tagOne(its[0], 'brand'),
      };
    }
    console.log(
      `  Product=${String(p).padStart(2)}  HTTP ${r.status}  items ${String(its.length).padStart(
        4
      )}  ${sample ? `${sample.brand || '?'} | ${sample.title || '?'}` : '(none)'}`
    );
  }

  console.log('\n--- tomorrow ---');
  for (const day of ['today', 'tomorrow', 'yesterday']) {
    await sleep(700);
    const r = await get(`?Product=1&Day=${day}`);
    const its = tagAll(r.text, 'item');
    const dates = new Set(its.slice(0, 200).map((i) => tagOne(i, 'date')));
    console.log(
      `  Day=${day.padEnd(9)} HTTP ${r.status}  items ${String(its.length).padStart(4)}  dates ${[
        ...dates,
      ]
        .slice(0, 3)
        .join(', ')}`
    );
  }

  console.log('\n--- region filter (for metro) ---');
  for (const region of ['', '&Region=1', '&Region=25']) {
    await sleep(700);
    const r = await get(`?Product=1${region}`);
    const its = tagAll(r.text, 'item');
    console.log(`  ${(region || '(all)').padEnd(12)} items ${its.length}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
