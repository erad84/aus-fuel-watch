# Aus Fuel Watch — Data Viewer

Browser dashboard for collected JSON and live station prices.

## Run (recommended)

```bash
node viewer/serve.mjs
```

Open **http://localhost:3456**

This serves the viewer, local `docs/` at `/docs/`, and a **Petrolmate proxy** at `/proxy/` (browsers cannot call Petrolmate directly — CORS / NetworkError).

### Data URLs

| Source | Base URL in the UI |
| --- | --- |
| GitHub Pages | `https://erad84.github.io/aus-fuel-watch` |
| Local `docs/` | `http://localhost:3456/docs` |

Click **Load data**, then **Load stations**.

**Map tiles:** Esri World Dark Gray (no API key).

## Features

- Time-series charts from `v1/{STATE}.json` + archives
- Optional Petrolmate state-wide overlay (checkbox)
- Leaflet map + station list (live prices, max 50 per request)
- Cycle stage badges, E10 vs U91 comparison

## Data limits

Per-station daily prices are recorded under `docs/v1/stations/` by `collect.js` and
`import-history.js` (separate from the watch’s compact state aggregates). VIC has no
station adapter yet (Petrolmate summary only). The viewer matches map pins to the
published catalog by coordinates (~80&nbsp;m) when history exists.

## Legacy

`station-proxy.mjs` is optional; `serve.mjs` includes the same proxy on port 3456.
