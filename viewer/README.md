# Aus Fuel Watch — Data Viewer

Browser dashboard for collected JSON and published station prices. Also prototypes
watch-shaped settings (favourites, default scope/fuel/state) before the Pebble app.

## Run (recommended)

```bash
node viewer/serve.mjs
```

Open **http://localhost:3456**

This serves the viewer and local `docs/` at `/docs/`. No third-party proxy is required.

You can also open `viewer/index.html` directly in the browser. Suburb search, Outlook,
and CME lead all prefer published JSON (Data base URL / Pages) when available;
[`au-suburbs-data.js`](au-suburbs-data.js), [`outlook-data.js`](outlook-data.js), and
[`lead-data.js`](lead-data.js) are offline fallbacks only. Price history / stations
always use the Data base URL.

### Data loading (source of truth)

Published watch/viewer series live under `{dataBase}/v1/` on the **data** branch
(GitHub Pages). The viewer fetches those first on **Load data**; local `*-data.js`
embeds are fallbacks for offline / `file://` only. New data feeds should follow the
same pattern: write `docs/v1/….json` in the cron/pipeline, then load via `baseUrl()`.

| Dataset | Pages path | Embed fallback |
| --- | --- | --- |
| State / station history | `v1/index.json`, `v1/{STATE}.json`, … | — |
| AIP weekly Mogas/Gasoil | `v1/outlook.json` | `outlook-data.js` |
| CME daily lead | `v1/lead.json` | `lead-data.js` |
| Lag calib (cron, ~180d) | `v1/lag-calib.json` (+ `lead.json` `lagDays`) | — |
| AU suburbs (optional on Pages) | `v1/au-suburbs.json`, else viewer `au-suburbs.json` | `au-suburbs-data.js` |

### Data URLs

| Source | Base URL in the UI |
| --- | --- |
| GitHub Pages | `https://erad84.github.io/aus-fuel-watch` |
| Local `docs/` | `http://localhost:3456/docs` |

Click **Load data**, then **Go to capital** (or zoom the map) to load stations from published history.

**Map tiles:** Esri World Dark Gray (no API key).

## Features

- Time-series charts from `v1/{STATE}.json` + archives
- Leaflet map + station list from published day files
- Scope + favourites cycle dials and turn markers
- Outlook bar (last AIP weekly Mogas/Gasoil move on ±8 c/L Falling↔Rising scale; hover-scrub)
- Singapore Mogas/Gasoil weekly overlay + CME/ICE daily settle lead on the fuel graph
- Per-state lag from cron `lag-calib.json` (~180d); viewer falls back to local calib if missing
- Chart periods: 30 / 60 / 90 / 120 / 180 days (archives fill beyond the live 90d window)
- Favourites list (default station, mean/low/high series, summary bars)
- Suburb / postcode search for favourite-area centre (AU-wide) + radius stats

## Outlook data (`docs/v1/outlook.json`)

Curated weekly Argus Mogas 95 / Gasoil in AUD c/L. Prefer AIP weekly PDFs; ACCC weeks
fill gaps. Refresh:

```bash
node data/seed/fetch-aip-outlook.js
```

Discovers PDFs via the AIP WordPress media API, parses Last/Previous week averages, and
merges into `docs/v1/outlook.json` plus `viewer/outlook-data.js` (AIP overwrites ACCC for
the same `weekEnding`).

## CME daily lead (`docs/v1/lead.json`)

Daily Singapore Mogas 95 / Gasoil lead in AUD c/L for turn timing. Live pins from NYMEX
Platts settles (TradingView delayed); history reshaped from AIP weekly anchors + Brent
moves; FX from Yahoo AUDUSD. Refresh:

```bash
node data/seed/fetch-cme-lead.js
```

Writes `docs/v1/lead.json` plus `viewer/lead-data.js`. The outlook GitHub Action
(`.github/workflows/outlook.yml`) refreshes AIP weekly and pins CME settles on weekdays,
then updates Pages + embeds on `main`.

## User prefs (`afw.userPrefs`)

Stored in `localStorage` via [`userPrefs.js`](userPrefs.js). Intended as the Clay / PebbleKit
field mirror:

| Field | Role |
| --- | --- |
| `preferredFuel` | Watch fuel |
| `homeState` | Home state file to download |
| `defaultScope` | `metro` / `regional` / `state` for the graph |
| `favourites[]` | `{ id, state, name, brand, suburb }` |
| `defaultFavouriteId` | Primary favourite inside the list |

Dashboard-only keys (`afw.cycleModel`, turn/arcpath tunes) stay separate.

**Payload budget (watch):** face uses `index.json` + one `{STATE}.json`. Favourites prices come
from day shards (or later pkjs area refresh), not full station history. Last successful compact
snapshot is cached as `afw.lastGoodPayload` for offline preview.

## Data limits

Per-station daily prices are recorded under `docs/v1/stations/` by `collect.js` and
`import-history.js` (separate from the watch’s compact state aggregates). The viewer matches
map pins to the published catalog by coordinates (~80&nbsp;m) when history exists.
