# SAFPIS (South Australia) probe findings

Probed 2026-09-02 with a Data Publisher token from
https://www.safuelpricinginformation.com.au/publishers.html

## Base URL

Production: `https://fppdirectapi-prod.safuelpricinginformation.com.au`

## Authentication

```
Authorization: FPDAPI SubscriberToken=<token>
Content-Type: application/json
```

Register as a **Data Publisher** (not a fuel retailer) to receive the subscriber token.
Environment variable: `SA_FUEL_TOKEN`.

## Geographic scope

FPPDirect uses a hierarchy:

| Parameter | SA value | Meaning |
| --- | --- | --- |
| `countryId` | 21 | Australia |
| `geoRegionLevel` | 3 | State/territory |
| `geoRegionId` | 4 | South Australia |

Queensland uses the same `countryId=21` on a different host (`fuelpricesqld.com.au`).

## Endpoints used by the collector

| Endpoint | Cache cadence (API guidance) |
| --- | --- |
| `GET /Subscriber/GetCountryBrands?countryId=21` | daily |
| `GET /Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=4` | daily |
| `GET /Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=4` | ≤ once per minute |

`GetFullSiteDetails` returns `S[]` with:

- `S` site id
- `N` name, `A` address, `P` postcode
- `B` brand id, `Lat` / `Lng`
- `G1` suburb region, `G2` city region (names need `GetCountryGeographicRegions`)

`GetSitesPrices` returns `SitePrices[]` with:

- `SiteId`, `FuelId`, `Price` (tenths of c/L), `TransactionDateUtc`

`Price` of **9999** means unavailable at that site.

## FuelId mapping

| FuelId | Canon | Name |
| --- | --- | --- |
| 2 | U91 | Unleaded |
| 3 | DSL | Diesel |
| 5 | P95 | Premium 95 |
| 8 | P98 | Premium 98 |
| 12 | E10 | E10 |
| 14 | PDSL | Premium Diesel |

LPG (4) and E85 (19) exist but are outside v1 canon.

## Station counts (2026-09-02)

Roughly **700+** stations statewide with coordinates and postcodes, enough for both
state-wide and Greater Adelaide metro averages. Metro membership is computed from
distance to the Adelaide GPO in `regions.js`.

## Licensing

Retailers are required by law to report prices. Data Publishers receive access under
the scheme's terms of service. This is an official government-mandated feed rather
than a third-party aggregate.
