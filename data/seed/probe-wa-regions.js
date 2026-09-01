'use strict';

// The default FuelWatch RSS feed is titled "FuelWatch Prices For All Metro
// Regions" — it is Perth only, not the whole state. To get a WA state-wide
// average we need to know which Region codes exist and which are country.
//
// Also inspects the NT site, which is server-rendered ASP.NET with no API, to
// find where prices actually live in the HTML.
//
// Usage: node data/seed/probe-wa-regions.js

const WA = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS';
const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waRegion(region) {
  const qs = region === null ? '?Product=1' : `?Product=1&Region=${region}`;
  const res = await fetch(`${WA}${qs}`, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  const items = tagAll(text, 'item');
  // The channel title names the region, which saves hardcoding a lookup.
  const title = (tagOne(text, 'title') || '').replace(/^FuelWatch Prices For\s*/i, '');
  return { region, count: items.length, title, text };
}

async function main() {
  console.log('=== WA: region enumeration (Product=1) ===');
  const base = await waRegion(null);
  console.log(`  (default)  ${String(base.count).padStart(4)} items  "${base.title}"`);

  const found = [];
  for (let r = 1; r <= 60; r++) {
    await sleep(450);
    try {
      const info = await waRegion(r);
      if (info.count > 0) {
        found.push(info);
        console.log(`  Region=${String(r).padStart(2)}  ${String(info.count).padStart(4)} items  "${info.title}"`);
      }
    } catch (e) {
      console.log(`  Region=${r} ERROR ${e.message}`);
    }
  }

  const total = found.reduce((a, b) => a + b.count, 0);
  console.log(`\n  regions with data: ${found.length}, summed items: ${total}, default feed: ${base.count}`);

  // Are the metro stations a subset of the regions, or disjoint? Determines
  // whether we sum regions or fetch default plus country regions.
  const baseNames = new Set(
    tagAll(base.text, 'item').map((i) => `${tagOne(i, 'trading-name')}|${tagOne(i, 'location')}`)
  );
  let overlap = 0;
  const allNames = new Set();
  for (const f of found) {
    for (const i of tagAll(f.text, 'item')) {
      const k = `${tagOne(i, 'trading-name')}|${tagOne(i, 'location')}`;
      allNames.add(k);
      if (baseNames.has(k)) overlap++;
    }
  }
  console.log(
    `  distinct stations across all regions: ${allNames.size}; of the ${total} region rows, ${overlap} are also in the default metro feed`
  );

  console.log('\n=== NT: locate the price page ===');
  const res = await fetch('https://myfuelnt.nt.gov.au/', { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const links = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/g)) links.add(m[1]);
  console.log(`  links: ${links.size}`);
  for (const l of [...links].slice(0, 30)) console.log(`    ${l}`);
  const forms = [...html.matchAll(/<form[^>]*action=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
  console.log(`  forms: ${JSON.stringify(forms)}`);
  // Does the landing page already carry prices, or is a search required?
  const priceish = html.match(/\b\d{3}\.\d\b/g);
  console.log(`  price-shaped numbers on landing page: ${priceish ? priceish.length : 0}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
