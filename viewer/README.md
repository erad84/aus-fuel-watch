# Aus Fuel Watch — Data Viewer

Browser dashboard for collected JSON and published station prices. Also prototypes
watch-shaped settings (favourites, default scope/fuel/state) before the Pebble app.

## Run (recommended)

```bash
node viewer/serve.mjs
```

Open **http://localhost:3456**

This serves the viewer and local `docs/` at `/docs/`. No third-party proxy is required.

You can also open `viewer/index.html` directly in the browser: suburb search uses
[`au-suburbs-data.js`](au-suburbs-data.js) and Outlook uses [`outlook-data.js`](outlook-data.js)
(no local server). Price history / stations still need a Data base URL (GitHub Pages or a
local `docs/` server).

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
- Outlook bar (Singapore Mogas 95 / Gasoil rising–falling + lag ETA) under the state dial
- Singapore Mogas/Gasoil overlay on the fuel graph (Graph view checkbox)
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
the same `weekEnding`). A weekly GitHub Action (`.github/workflows/outlook.yml`) refreshes
Pages `v1/outlook.json` and commits the embed on `main`.

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
