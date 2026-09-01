'use strict';

// GET /Home/Results returns the whole territory in one 372KB page. Work out the
// row structure so a parser can be written, and whether query parameters filter
// it (which would give an authoritative Greater Darwin grouping via the site's
// own region codes rather than our radius heuristic).
//
// Usage: node data/seed/probe-nt-rows.js

const BASE = 'https://myfuelnt.nt.gov.au';
const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA } });
  return { status: res.status, text: await res.text() };
}

function priceCount(html) {
  return (html.match(/\b\d{2,3}\.\d\b/g) || []).length;
}

async function main() {
  const all = await get('/Home/Results');
  console.log(`GET /Home/Results -> HTTP ${all.status}, ${all.text.length} bytes, ${priceCount(all.text)} prices`);

  // What repeating container holds a station?
  for (const tag of ['tr', 'article', 'li', 'div class="row"', 'card']) {
    const re = new RegExp(`<${tag.split(' ')[0]}\\b`, 'g');
    console.log(`  <${tag.split(' ')[0]}> occurrences: ${(all.text.match(re) || []).length}`);
  }

  // Find the densest repeated class name, which is usually the row wrapper.
  const classes = {};
  for (const m of all.text.matchAll(/class=["']([^"']+)["']/g)) {
    for (const c of m[1].split(/\s+/)) classes[c] = (classes[c] || 0) + 1;
  }
  const top = Object.entries(classes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18);
  console.log('\n  most frequent classes:');
  for (const [c, n] of top) console.log(`    ${String(n).padStart(5)}  ${c}`);

  // Dump one plausible station block so the parser can be written against it.
  const idx = all.text.search(/\b\d{2,3}\.\d\b/);
  if (idx > 0) {
    console.log('\n--- context around first price ---');
    console.log(all.text.slice(Math.max(0, idx - 1800), idx + 900));
  }

  console.log('\n--- do query parameters filter? ---');
  for (const qs of [
    '?FuelCode=U91',
    '?FuelCode=DL',
    '?RegionId=3',
    '?FuelCode=U91&RegionId=3',
    '?FuelCode=ALL',
  ]) {
    await sleep(900);
    const r = await get(`/Home/Results${qs}`);
    console.log(`  ${qs.padEnd(26)} HTTP ${r.status}  ${r.text.length} bytes  prices ${priceCount(r.text)}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
