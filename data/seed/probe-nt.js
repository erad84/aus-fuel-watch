'use strict';

// MyFuel NT has no API: the site is server-rendered ASP.NET MVC and the landing
// page posts to /Home/Results. Work out what that form needs and whether the
// response carries prices for the whole territory in one go.
//
// Usage: node data/seed/probe-nt.js

const BASE = 'https://myfuelnt.nt.gov.au';
const UA = 'AusFuelWatch/1.0 (Pebble watchapp)';

function inputs(html) {
  const out = [];
  for (const m of html.matchAll(/<(input|select)\b[^>]*>/g)) {
    const tagText = m[0];
    const name = /name=["']([^"']+)["']/.exec(tagText);
    const value = /value=["']([^"']*)["']/.exec(tagText);
    const type = /type=["']([^"']+)["']/.exec(tagText);
    if (name) out.push({ tag: m[1], name: name[1], type: type ? type[1] : '', value: value ? value[1] : '' });
  }
  return out;
}

function options(html) {
  const sels = [];
  for (const m of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/g)) {
    const opts = [...m[2].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/g)].map(
      (o) => ({ value: o[1], label: o[2].replace(/\s+/g, ' ').trim() })
    );
    sels.push({ name: m[1], count: opts.length, sample: opts.slice(0, 12) });
  }
  return sels;
}

async function main() {
  const home = await fetch(`${BASE}/`, { headers: { 'User-Agent': UA } });
  const cookie = (home.headers.getSetCookie ? home.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const html = await home.text();

  console.log('--- form fields on landing page ---');
  for (const i of inputs(html)) {
    // Never echo token values; only their presence and length.
    const shown = /token/i.test(i.name) ? `<${i.value.length} chars>` : i.value.slice(0, 40);
    console.log(`  ${i.tag} ${i.name.padEnd(28)} type=${(i.type || '-').padEnd(10)} value=${shown}`);
  }

  console.log('\n--- select options ---');
  for (const s of options(html)) {
    console.log(`  ${s.name} (${s.count} options)`);
    for (const o of s.sample) console.log(`      ${o.value.padEnd(8)} ${o.label}`);
  }

  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);
  console.log(`\n  anti-forgery token present: ${Boolean(token)}`);

  console.log('\n--- POST /Home/Results ---');
  // Try a broad search: all fuels, all regions, largest radius.
  const bodies = [
    { label: 'empty', form: {} },
    { label: 'fuel=1', form: { FuelType: '1' } },
    { label: 'fuel+region', form: { FuelType: '1', Region: '' , Locality: ''} },
  ];
  for (const b of bodies) {
    const form = new URLSearchParams(b.form);
    if (token) form.set('__RequestVerificationToken', token[1]);
    const res = await fetch(`${BASE}/Home/Results`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        Referer: `${BASE}/`,
      },
      body: form.toString(),
      redirect: 'follow',
    });
    const text = await res.text();
    const prices = text.match(/\b\d{2,3}\.\d\b/g) || [];
    const rows = (text.match(/<tr\b/g) || []).length;
    console.log(
      `  ${b.label.padEnd(14)} HTTP ${res.status}  ${text.length} bytes  table rows ${rows}  price-shaped ${prices.length}`
    );
    if (prices.length) console.log(`      first prices: ${prices.slice(0, 10).join(', ')}`);
    await new Promise((r) => setTimeout(r, 900));
  }

  console.log('\n--- GET /Home/Results ---');
  const g = await fetch(`${BASE}/Home/Results`, { headers: { 'User-Agent': UA, Cookie: cookie } });
  const gt = await g.text();
  console.log(`  HTTP ${g.status}  ${gt.length} bytes  price-shaped ${(gt.match(/\b\d{2,3}\.\d\b/g) || []).length}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
