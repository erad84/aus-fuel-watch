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
| `nsw` | NSW, ACT, TAS | [Data.NSW FuelCheck](https://data.nsw.gov.au/data/dataset/fuel-check) monthly CSV | state-wide (no coords in CSV) |
| `qld` | QLD | [QLD open data](https://www.data.qld.gov.au/dataset/fuel-price-reporting-2026) monthly CSV | yes (lat/lng) |
| `nt` | NT | [NTG MyFuel](https://data.nt.gov.au/dataset/?groups=driving) monthly XLSX | yes (region + coords) |
| `wa` | WA | FuelWatch RSS (`today`, `yesterday`) + optional zip cache | yes (coords) |

### WA full backfill

The RSS API does **not** expose arbitrary dates. For more than ~2 days, download monthly `FuelWatchRetail-*.csv` (or `.csv.zip`)
files from the FuelWatch historic portal and place them in:

`data/seed/.import-cache/wa/`

Re-run the importer; it will parse any zip CSVs found there.

## Window

Published files use a **90-day** rolling window (`history.WINDOW_DAYS`). The importer
trim/archives after merge, same as the daily collector.

## After import

Commit on the `data` branch and push. Re-run `data/seed/fit-params.js` once you have
enough observed days for cycle re-anchor.
