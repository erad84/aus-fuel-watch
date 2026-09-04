# Historical import (one-off backfill)

Official open-data archives are **event logs** or **daily snapshots**, not the same
as the live APIs. This tool aggregates them into the same `{avg, min, max, n}` daily
shape as `collect.js` and fills **empty** slots in `docs/v1/*.json`.

```bash
node data/seed/import-history.js
node data/seed/import-history.js --days 90 --sources nsw,qld,nt,wa
DOCS_DIR=./docs node data/seed/import-history.js
```

Downloads cache to `data/seed/.import-cache/` (gitignored).

## Sources

| Flag | States | Archive | Metro? |
| --- | --- | --- | --- |
| `nsw` | NSW, ACT, TAS | [Data.NSW FuelCheck](https://data.nsw.gov.au/data/dataset/fuel-check) monthly CSV/XLSX + local cache | state-wide (no coords) |
| `qld` | QLD | [QLD open data](https://www.data.qld.gov.au/dataset/fuel-price-reporting-2026) monthly CSV | yes (lat/lng) |
| `nt` | NT | [NTG MyFuel](https://data.nt.gov.au/dataset/?groups=driving) monthly XLSX + [MyFuel Trends JSON](https://myfuelnt.nt.gov.au/Trends/GetTrends?fueltypeId=DL&period=Monthly&regionId=3) | yes (XLSX regions/coords; Trends = Greater Darwin avg) |

**NT notes:**
- CKAN monthly XLSX archives currently stop at **November 2024**, so they do not
  cover the live 90-day window.
- `--sources nt` therefore also calls MyFuel’s site Trends API
  (`/Trends/GetTrendsJson`, `period=Monthly`) and fills empty slots with the
  last **~28 daily averages** for Greater Darwin (Darwin + Palmerston +
  Litchfield, unweighted mean of regional avgs). Trends rows are **avg-only**
  (`min` / `max` / `n` / `med` stay null).
- Remaining older days still only accumulate via daily `collect.js`.
| `wa` | WA | FuelWatch RSS (`today`, `yesterday`) + optional zip/CSV cache | yes (coords / Metro region) |

### NSW / ACT / TAS local backfill

Drop monthly FuelCheck price-history files into:

`data/seed/.import-cache/nsw/`

Supported: **`.csv`** and **`.xlsx`**. Legacy **`.xls`** (Excel 97–2003) is not supported —
open in Excel/LibreOffice and Save As `.xlsx` or `.csv` first.

Expected columns (Data.NSW layout): `ServiceStationName`, `Address`, `Suburb`,
`Postcode`, `Brand`, `FuelCode`, `PriceUpdatedDate`, `Price`.

### WA full backfill

The RSS API does **not** expose arbitrary dates. For more than ~2 days, download monthly
`FuelWatchRetail-*.csv` (or `.csv.zip`) from the FuelWatch historic portal and place them in:

`data/seed/.import-cache/wa/`

Re-run the importer; it will parse any CSV/zip files found there.

## Window

Published files use a **90-day** rolling window (`history.WINDOW_DAYS`). The importer
trim/archives after merge, same as the daily collector.

## After import

Commit on the `data` branch and push. Re-run `data/seed/fit-params.js` once you have
enough observed days for cycle re-anchor.
