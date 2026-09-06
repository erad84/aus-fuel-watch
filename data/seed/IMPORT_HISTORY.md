# Historical import (one-off backfill)

Official open-data archives are **event logs** or **daily snapshots**, not the same
as the live APIs. This tool aggregates them into the same `{avg, min, max, n}` daily
shape as `collect.js` and fills **empty** slots in `docs/v1/*.json`. It also writes
per-station day shards under `docs/v1/stations/{STATE}/days/` (plus a catalog).

```bash
node data/seed/import-history.js
node data/seed/import-history.js --days 90 --sources nsw,qld,nt,wa
DOCS_DIR=./docs node data/seed/import-history.js
```

Downloads cache to `data/seed/.import-cache/` (gitignored).

## Sources

| Flag | States | Archive | Metro? | Stations? |
| --- | --- | --- | --- | --- |
| `nsw` | NSW, ACT, TAS | [Data.NSW FuelCheck](https://data.nsw.gov.au/data/dataset/fuel-check) monthly CSV/XLSX + local cache | state-wide (no coords) | yes (weak id: postcode+name) |
| `qld` | QLD | [QLD open data](https://www.data.qld.gov.au/dataset/fuel-price-reporting-2026) monthly CSV | yes (lat/lng) | yes (SiteId) |
| `nt` | NT | [NTG MyFuel](https://data.nt.gov.au/dataset/?groups=driving) monthly XLSX + Trends JSON | yes | XLSX yes; Trends **no** |
| `wa` | WA | FuelWatch RSS (`today`, `yesterday`) + optional zip/CSV cache | yes | yes |

**NT notes:**
- CKAN monthly XLSX archives currently stop at **November 2024**, so they do not
  cover the live 90-day window.
- `--sources nt` also calls MyFuel’s Trends API for ~28 Greater Darwin daily
  averages (avg-only; **no station rows**).
- Remaining older days still only accumulate via daily `collect.js`.

### NSW / ACT / TAS local backfill

Drop monthly FuelCheck price-history files into:

`data/seed/.import-cache/nsw/`

Supported: **`.csv`** and **`.xlsx`**. Legacy **`.xls`** is not supported.

### WA full backfill

For more than ~2 days, download monthly `FuelWatchRetail-*.csv` (or `.csv.zip`)
into `data/seed/.import-cache/wa/` and re-run.

## Station history layout

```
docs/v1/stations/index.json
docs/v1/stations/{STATE}/catalog.json
docs/v1/stations/{STATE}/days/YYYY-MM-DD.json
docs/v1/stations/archive/YYYY-MM.json
```

Prices are tenths of a cent. Day shards roll with the same 90-day window as state files.
SA is live-only (no archive importer yet). VIC has no station source.

## Window

Published files use a **90-day** rolling window (`history.WINDOW_DAYS`). The importer
trim/archives after merge, same as the daily collector.

## After import

Commit on the `data` branch and push. Re-run `data/seed/fit-params.js` once you have
enough observed days for cycle re-anchor.
