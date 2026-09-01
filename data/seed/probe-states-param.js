'use strict';

// The `states` query parameter on the bulk feed escapes the nearby endpoint's
// 20-result cap entirely. Work out its exact semantics: which values it
// accepts, whether several can be combined in one call, and whether the
// Tasmanian payload carries the prices and coordinates we need.
//
// Usage: node --env-file=.env data/seed/probe-states-param.js

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function breakdown(body) {
  const out = { total: 0, byState: {}, noCoords: 0, stateField: {} };
  for (const s of body.stations || []) {
    out.total++;
    const m = /(\d{4})\s*$/.exec((s.address || '').trim());
    const pc = m ? Number(m[1]) : null;
    let st = 'unknown';
    if (pc !== null) {
      if (pc >= 7000 && pc <= 7999) st = 'TAS';
      else if ((pc >= 2600 && pc <= 2618) || (pc >= 2900 && pc <= 2920) || (pc >= 200 && pc <= 299))
        st = 'ACT';
      else if (pc >= 1000 && pc <= 2999) st = 'NSW';
      else st = `pc${String(pc)[0]}xxx`;
    }
    out.byState[st] = (out.byState[st] || 0) + 1;
    out.stateField[s.state] = (out.stateField[s.state] || 0) + 1;
    if (!s.location || typeof s.location.latitude !== 'number') out.noCoords++;
  }
  return out;
}

async function probe(token, qs) {
  const res = await fetch(`${BASE}/fuel/prices${qs}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: KEY,
      transactionid: `ausfuelwatch_${Date.now()}`,
      requesttimestamp: requestTimestamp(new Date()),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    console.log(`  ${qs.padEnd(30)} HTTP ${res.status}`);
    return null;
  }
  const body = await res.json();
  const b = breakdown(body);
  console.log(
    `  ${(qs || '(none)').padEnd(30)} stations ${String(b.total).padStart(4)}  prices ${String(
      (body.prices || []).length
    ).padStart(5)}  postcode split ${JSON.stringify(b.byState)}  state field ${JSON.stringify(
      b.stateField
    )}  missing coords ${b.noCoords}`
  );
  return body;
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

  console.log('--- single values ---');
  for (const qs of ['', '?states=NSW', '?states=TAS', '?states=ACT']) {
    await probe(token, qs);
    await sleep(1200);
  }

  console.log('\n--- can one call cover everything? ---');
  for (const qs of ['?states=NSW,TAS', '?states=NSW&states=TAS', '?states=NSW%2CTAS']) {
    await probe(token, qs);
    await sleep(1200);
  }

  console.log('\n--- TAS payload sample (fields we depend on) ---');
  const tas = await probe(token, '?states=TAS');
  if (tas && tas.stations && tas.stations[0]) {
    const s = tas.stations[0];
    console.log(
      JSON.stringify(
        { brand: s.brand, code: s.code, name: s.name, address: s.address, location: s.location, state: s.state },
        null,
        2
      )
    );
    const fuels = {};
    for (const p of tas.prices || []) fuels[p.fueltype] = (fuels[p.fueltype] || 0) + 1;
    console.log(`  TAS fuel codes: ${JSON.stringify(fuels)}`);
    console.log(`  sample price: ${JSON.stringify((tas.prices || [])[0])}`);

    // Do TAS and NSW station codes actually collide? That was the bug class.
    const nsw = await probe(token, '?states=NSW');
    if (nsw) {
      const nswCodes = new Set((nsw.stations || []).map((x) => String(x.code)));
      let collisions = 0;
      for (const t of tas.stations) if (nswCodes.has(String(t.code))) collisions++;
      console.log(
        `\n  station codes shared between NSW and TAS payloads: ${collisions} of ${tas.stations.length}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
