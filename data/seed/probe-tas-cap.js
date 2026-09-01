'use strict';

// Can the 20-result cap on the nearby endpoint be escaped?
//
// Tries, in order: a state filter on the bulk feed, pagination-style parameters
// on the nearby POST, the named-location endpoint, and the "new prices" feed.
// If none of these beat 20, sampling is the honest answer.
//
// Usage: node --env-file=.env data/seed/probe-tas-cap.js

const AUTH_URL =
  'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials';
const BASE = 'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2';

const KEY = process.env.FUELCHECK_API_KEY;
const SECRET = process.env.FUELCHECK_API_SECRET;

function requestTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())} ${ampm}`;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: KEY,
    transactionid: `ausfuelwatch_${Date.now()}`,
    requesttimestamp: requestTimestamp(new Date()),
    'Content-Type': 'application/json',
  };
}

function tasCount(body) {
  const stations = body.stations || [];
  let tas = 0;
  for (const s of stations) {
    const m = /(\d{4})\s*$/.exec((s.address || '').trim());
    const pc = m ? Number(m[1]) : null;
    if (pc !== null && pc >= 7000 && pc <= 7999) tas++;
  }
  return { total: stations.length, tas };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryGet(token, label, url) {
  try {
    const res = await fetch(url, { headers: headers(token) });
    if (!res.ok) {
      console.log(`${label.padEnd(44)} HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    const c = tasCount(body);
    console.log(`${label.padEnd(44)} HTTP 200  stations ${c.total}, TAS ${c.tas}`);
    return body;
  } catch (e) {
    console.log(`${label.padEnd(44)} ERROR ${e.message}`);
    return null;
  }
}

async function tryPost(token, label, path, payload) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      console.log(`${label.padEnd(44)} HTTP ${res.status}  ${t}`);
      return null;
    }
    const body = await res.json();
    const c = tasCount(body);
    console.log(`${label.padEnd(44)} HTTP 200  stations ${c.total}, TAS ${c.tas}`);
    return body;
  } catch (e) {
    console.log(`${label.padEnd(44)} ERROR ${e.message}`);
    return null;
  }
}

async function main() {
  if (!KEY || !SECRET) {
    console.error('FUELCHECK_API_KEY and FUELCHECK_API_SECRET are not set.');
    process.exit(1);
  }
  const basic = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const authRes = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${basic}` } });
  if (!authRes.ok) throw new Error(`auth HTTP ${authRes.status}`);
  const token = (await authRes.json()).access_token;
  console.log('credentials loaded: true\n');

  console.log('--- 1. state filter on the bulk feed ---');
  for (const qs of ['?states=TAS', '?state=TAS', '?jurisdiction=TAS']) {
    await tryGet(token, `GET /fuel/prices${qs}`, `${BASE}/fuel/prices${qs}`);
    await sleep(1200);
  }

  console.log('\n--- 2. pagination-style params on nearby (Hobart, r=50) ---');
  const base = {
    fueltype: 'U91',
    latitude: '-42.8821',
    longitude: '147.3272',
    radius: '50',
    sortby: 'price',
    sortascending: 'true',
  };
  for (const extra of [
    { limit: '200' },
    { pageSize: '200' },
    { maxResults: '200' },
    { count: '200' },
    { size: '200' },
    { limit: '200', offset: '20' },
    { pageNumber: '2', pageSize: '20' },
  ]) {
    await tryPost(token, `POST nearby + ${JSON.stringify(extra)}`, '/fuel/prices/nearby', {
      ...base,
      ...extra,
    });
    await sleep(1200);
  }

  console.log('\n--- 3. named-location endpoint ---');
  for (const loc of ['7000', 'HOBART', 'TAS']) {
    await tryPost(token, `POST location namedlocation=${loc}`, '/fuel/prices/location', {
      fueltype: 'U91',
      namedlocation: loc,
      sortby: 'price',
      sortascending: 'true',
    });
    await sleep(1200);
  }

  console.log('\n--- 4. new-prices feed ---');
  await tryGet(token, 'GET /fuel/prices/new', `${BASE}/fuel/prices/new`);

  console.log('\n--- 5. brand partitioning (does brand filter change the 20?) ---');
  // If a brand filter is honoured, many cheap per-brand queries could enumerate
  // far more than 20 stations across the state.
  for (const brand of ['United', 'BP']) {
    await tryPost(token, `POST nearby brand=${brand}`, '/fuel/prices/nearby', {
      ...base,
      brand: [brand],
    });
    await sleep(1200);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
