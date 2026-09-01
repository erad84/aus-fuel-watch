'use strict';
// One-off probe — run with QLD_FUEL_TOKEN in env. Not used by the collector.
const BASE = 'https://fppdirectapi-prod.fuelpricesqld.com.au';
const token = process.env.QLD_FUEL_TOKEN;
if (!token) throw new Error('set QLD_FUEL_TOKEN');
const h = {
  Authorization: `FPDAPI SubscriberToken=${token}`,
  'Content-Type': 'application/json',
};

async function main() {
  const geo = await fetch(`${BASE}/Subscriber/GetCountryGeographicRegions?countryId=21`, { headers: h })
    .then((r) => r.json());
  const level3 = (geo.GeographicRegions || []).filter((x) => x.GeoRegionLevel === 3);
  console.log('level 3:');
  for (const x of level3) console.log(`  ${x.GeoRegionId} ${x.Name}`);

  const fuels = await fetch(`${BASE}/Subscriber/GetCountryFuelTypes?countryId=21`, { headers: h })
    .then((r) => r.json());
  console.log('fuels:', (fuels.Fuels || []).map((f) => `${f.FuelId}=${f.Name}`).join(', '));

  const qld = level3.find((x) => /queensland/i.test(x.Name));
  if (!qld) return;
  const id = qld.GeoRegionId;
  const sites = await fetch(
    `${BASE}/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=${id}`,
    { headers: h }
  ).then((r) => r.json());
  console.log(`QLD sites (geoId=${id}): ${(sites.S || []).length}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
