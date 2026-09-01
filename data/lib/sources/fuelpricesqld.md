# Fuel Prices Queensland probe findings

Probed 2026-09-02 with a Data Consumer token from
https://www.fuelpricesqld.com.au/

API documentation: `FuelPricesQLDDirectAPI(OUT)v1.5.pdf` on the publishers site.

## Base URL

Production: `https://fppdirectapi-prod.fuelpricesqld.com.au`

## Authentication

```
Authorization: FPDAPI SubscriberToken=<token>
Content-Type: application/json
```

Register as a **Data Consumer** to receive the subscriber token.
Environment variable: `QLD_FUEL_TOKEN`.

## Geographic scope

| Parameter | QLD value | Meaning |
| --- | --- | --- |
| `countryId` | 21 | Australia |
| `geoRegionLevel` | 3 | State/territory |
| `geoRegionId` | 1 | Queensland |

`GetCountryGeographicRegions?countryId=21` lists all Australian states at level 3
(Queensland=1, NSW=2, Victoria=3, SA=4, WA=5, ACT=6, TAS=7, NT=8). The QLD host
returns metadata for the whole country even though prices are QLD-only.

## Endpoints used by the collector

Same FPPDirect paths as SAFPIS:

| Endpoint | Notes |
| --- | --- |
| `GET /Subscriber/GetCountryBrands?countryId=21` | daily cache OK |
| `GET /Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1` | daily cache OK |
| `GET /Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1` | ≤ once per minute |

Response shape matches SAFPIS (`S[]` sites, `SitePrices[]` prices). Prices are
tenths of c/L; **9999** means unavailable.

## FuelId mapping

| FuelId | Canon | Name |
| --- | --- | --- |
| 2 | U91 | Unleaded |
| 3 | DSL | Diesel |
| 5 | P95 | Premium Unleaded 95 |
| 8 | P98 | Premium Unleaded 98 |
| 12 | E10 | e10 |
| 14 | PDSL | Premium Diesel |

## Station counts (2026-09-02)

**1806** sites in the QLD bulk payload; after postcode filtering and joining prices,
roughly **1700+** stations with fuel data. Enough for state-wide and Greater Brisbane
metro averages.

## Licensing

Queensland Treasury operates the fuel price reporting scheme. Data Consumers receive
access under the scheme's terms of service.
