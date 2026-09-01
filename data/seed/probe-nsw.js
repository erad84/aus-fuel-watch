'use strict';

// Verification probe for the NSW FuelCheck v2 API.
//
// The question: does one endpoint with one set of credentials return NSW, ACT
// and TAS stations, or is TAS a sibling deployment on its own base URL? That
// decides whether three of our eight jurisdictions collapse into one
// integration.
//
// Credentials come from the gitignored .env.
//
// Usage: node --env-file=.env data/seed/probe-nsw.js
//        node --env-file=.env data/seed/probe-nsw.js --cached
//
// Never log the key, secret or bearer token: terminal output ends up in
// transcripts and logs.

const fs = require('fs');

const AUTH_URL =
  'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials';
const PRICES_URL = 'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices';

const KEY = process.env.FUELCHECK_API_KEY;
const SECRET = process.env.FUELCHECK_API_SECRET;

// NSW wants dd/MM/yyyy hh:mm:ss AM/PM, with no comma between date and time.
function requestTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())} ${ampm}`;
}

// ACT postcode ranges. The API's own `state` field cannot be used: it reports
// "NSW" even for stations whose address is plainly in the ACT.
const ACT_RANGES = [
  [200, 299],
  [2600, 2618],
  [2900, 2920],
];

function postcodeOf(station) {
  if (typeof station.address !== 'string') return null;
  const m = /(\d{4})\s*$/.exec(station.address.trim());
  return m ? Number(m[1]) : null;
}

function isACT(pc) {
  return pc !== null && ACT_RANGES.some(function (r) {
    return pc >= r[0] && pc <= r[1];
  });
}

// Re-analyse the cached response so repeat checks do not spend the trial key's
// 5-calls-per-minute budget.
function analyseCached(path) {
  const body = JSON.parse(fs.readFileSync(path, 'utf8'));
  const stations = body.stations || [];
  let act = 0;
  let nsw = 0;
  let tas = 0;
  let other = 0;
  const actExamples = [];
  for (const s of stations) {
    const pc = postcodeOf(s);
    if (isACT(pc)) {
      act++;
      if (actExamples.length < 3) actExamples.push(`${s.name} (${pc})`);
    } else if (pc !== null && pc >= 7000 && pc <= 7999) tas++;
    else if (pc !== null && pc >= 2000 && pc <= 2999) nsw++;
    else other++;
  }
  console.log(`cached ${path}: ${stations.length} stations`);
  console.log(`  ACT (by postcode): ${act}`);
  console.log(`  NSW (by postcode): ${nsw}`);
  console.log(`  TAS (7xxx):        ${tas}`);
  console.log(`  other:             ${other}`);
  console.log(`  distinct values of the API 'state' field: ${
    [...new Set(stations.map((s) => s.state))].join(', ')
  }`);
  console.log(`  ACT examples: ${actExamples.join(' | ')}`);
}

// The bulk "all prices" endpoint came back NSW-only. The docs and the TAS Home
// Assistant integration both claim v2 covers Tasmania on the same credentials,
// so test the radius query instead: if TAS lives behind location-scoped calls
// rather than the bulk feed, this is where it shows up.
async function nearby(token, lat, lng, radius, fuel) {
  const res = await fetch('https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/nearby', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: KEY,
      transactionid: `ausfuelwatch_${Date.now()}`,
      requesttimestamp: requestTimestamp(new Date()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fueltype: fuel,
      latitude: String(lat),
      longitude: String(lng),
      radius: String(radius),
      sortby: 'price',
      sortascending: 'true',
    }),
  });
  console.log(`nearby(${lat},${lng},r=${radius},${fuel}) HTTP ${res.status}`);
  if (!res.ok) {
    console.log('  ' + (await res.text()).slice(0, 300).replace(/\s+/g, ' '));
    return;
  }
  const body = await res.json();
  const stations = body.stations || [];
  console.log(`  stations: ${stations.length}, prices: ${(body.prices || []).length}`);

  const byState = {};
  for (const s of stations) {
    const pc = postcodeOf(s);
    let st = 'other';
    if (pc !== null) {
      if (pc >= 7000 && pc <= 7999) st = 'TAS';
      else if (isACT(pc)) st = 'ACT';
      else if (pc >= 2000 && pc <= 2999) st = 'NSW';
    }
    byState[st] = (byState[st] || 0) + 1;
  }
  console.log(`  by jurisdiction: ${JSON.stringify(byState)}`);
  if (stations[0]) {
    console.log(
      `  nearest: ${stations[0].name} | ${stations[0].address} | state field=${stations[0].state}`
    );
  }
}

// Reference data ("list of values"). If the platform knows about Tasmania at
// all, its brands or fuel types should show it.
async function lovs(token) {
  const res = await fetch('https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/lovs', {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: KEY,
      transactionid: `ausfuelwatch_${Date.now()}`,
      requesttimestamp: requestTimestamp(new Date()),
      'Content-Type': 'application/json',
    },
  });
  console.log(`lovs HTTP ${res.status}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 400));
    return;
  }
  const body = await res.json();
  console.log(`lovs keys: ${Object.keys(body).join(', ')}`);
  console.log(JSON.stringify(body).slice(0, 1200));
}

async function main() {
  if (process.argv.includes('--cached')) return analyseCached('/tmp/nsw.json');

  if (!KEY || !SECRET) {
    console.error('FUELCHECK_API_KEY and FUELCHECK_API_SECRET are not set.');
    console.error('Copy .env.example to .env, fill it in, and run with --env-file=.env');
    process.exit(1);
  }
  console.log(`credentials loaded: ${Boolean(KEY && SECRET)}`);

  const basic = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const authRes = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${basic}` } });
  if (!authRes.ok) throw new Error(`auth HTTP ${authRes.status}: ${await authRes.text()}`);
  const auth = await authRes.json();
  const token = auth.access_token;
  // Token lifetime decides whether the collector must cache it between runs.
  console.log(
    `auth ok, token length ${token.length}, expires_in ${auth.expires_in}s, issued_at ${auth.issued_at}\n`
  );

  if (process.argv.includes('--lovs')) return lovs(token);

  if (process.argv.includes('--tas')) {
    // Three radii around Hobart. If the count stops growing, the endpoint caps
    // the result set and enumerating a whole state needs tiled queries.
    for (const r of [5, 15, 50]) {
      await nearby(token, -42.8821, 147.3272, r, 'U91');
      await new Promise((res) => setTimeout(res, 1500));
    }
    return;
  }

  const res = await fetch(PRICES_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: KEY,
      transactionid: `ausfuelwatch_${Date.now()}`,
      requesttimestamp: requestTimestamp(new Date()),
      'Content-Type': 'application/json',
    },
  });
  console.log(`prices HTTP ${res.status}`);
  if (!res.ok) throw new Error(await res.text());

  const body = await res.json();
  fs.writeFileSync('/tmp/nsw.json', JSON.stringify(body));
  console.log(`top-level keys: ${Object.keys(body).join(', ')}`);

  const stations = body.stations || [];
  const prices = body.prices || [];
  console.log(`stations: ${stations.length}, prices: ${prices.length}\n`);

  console.log('--- sample station ---');
  console.log(JSON.stringify(stations[0], null, 2));
  console.log('\n--- sample price ---');
  console.log(JSON.stringify(prices[0], null, 2));

  // How is jurisdiction identified? Try an explicit field first, then fall back
  // to parsing the address, which is where NSW historically put it.
  const stateField = stations[0] && ('state' in stations[0] ? 'state' : null);
  console.log(`\nexplicit state field present: ${stateField ? 'yes' : 'no'}`);

  const byState = {};
  const byPostcode = {};
  for (const s of stations) {
    let st = s.state || null;
    if (!st && typeof s.address === 'string') {
      const m = /\b(NSW|ACT|TAS|VIC|QLD|SA|WA|NT)\b\s*\d{4}\s*$/.exec(s.address.trim());
      if (m) st = m[1];
    }
    st = st || 'unknown';
    byState[st] = (byState[st] || 0) + 1;

    const pc = typeof s.address === 'string' ? (/(\d{4})\s*$/.exec(s.address.trim()) || [])[1] : null;
    if (pc) {
      const band = pc[0] === '0' ? '0xxx (ACT/NT)' : pc[0] + 'xxx';
      byPostcode[band] = (byPostcode[band] || 0) + 1;
    }
  }
  console.log('\n--- stations by jurisdiction ---');
  for (const [k, v] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${v}`);
  }
  console.log('\n--- stations by postcode band ---');
  for (const [k, v] of Object.entries(byPostcode).sort()) console.log(`  ${k} ${v}`);

  const fuels = {};
  for (const p of prices) fuels[p.fueltype] = (fuels[p.fueltype] || 0) + 1;
  console.log('\n--- fuel codes ---');
  for (const [k, v] of Object.entries(fuels).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${v}`);
  }

  // Show a couple of non-NSW examples as direct evidence.
  for (const want of ['ACT', 'TAS']) {
    const hit = stations.find((s) => {
      const a = typeof s.address === 'string' ? s.address : '';
      return s.state === want || new RegExp(`\\b${want}\\b\\s*\\d{4}\\s*$`).test(a.trim());
    });
    console.log(`\n--- example ${want} station ---`);
    console.log(hit ? JSON.stringify(hit, null, 2) : `none found`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
