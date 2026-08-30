# Aus Fuel Watch

A Pebble watchapp for Australian fuel prices: today's state average for your chosen fuel, the best
price among your favourite stations, and whether today is a good day to fill up.

All eight states and territories are supported.

## Repository layout

```
data/                     price history pipeline (plain Node, zero dependencies)
  lib/xlsx.js             minimal read-only xlsx reader
  lib/cyclefit.js         cycle detection and parameter fitting
  lib/history.js          rolling window, monthly archive, published file format
  lib/sources/            source adapters + API probe notes
  seed/fit-params.js      one-time local fit from the seed workbook
  seed/offset-check.js    compares seed levels against collected levels
  seed/inspect.js         prints one series with daily deltas, for diagnosis
  collect.js              daily entry point for CI
  params.seed.json        committed output of fit-params.js
docs/                     published data (lives on the `data` branch, gitignored on main)
src/                      watchapp: C UI and PebbleKit JS
.github/workflows/        collect + heartbeat
```

The pipeline has **no npm dependencies**, so CI needs no install step. The xlsx reader parses the
zip container by hand and inflates with Node's built-in `zlib`.

## How the data pipeline works

`data/collect.js` runs on a schedule, makes **one** HTTP request to Petrolmate's `/api/summary`,
and appends one reading per state and fuel to a rolling 60-day window in `docs/v1/{STATE}.json`.
Days that roll out of the window are written to `docs/v1/archive/YYYY-MM.json` first.

Writes only ever fill an empty slot, so re-running is safe and a retry can never overwrite a good
reading. Three runs a day (23:07, 02:37 and 06:07 UTC) give two in-window attempts plus a catch-up.
None of this can be backfilled: a missed day is lost permanently.

Published data is committed to the `data` branch rather than `main`, so a year of daily commits
does not bury the watchapp's history. GitHub Pages serves that branch.

### Sanity gates

The feed is not trusted blindly. A reading is rejected, leaving the slot for a later run, when the
average is implausible, when the state-wide mean is built from fewer than 25 stations, when station
coverage collapses below 60% of its recent median, when the average jumps more than 45 c/L from its
trailing median, or when premium 95 is reported above premium 98.

These gates are not hypothetical. Petrolmate's Tasmanian feed is currently degraded, reporting ULP
at 277.2 c/L across 18 stations where the real figure is about 210 c/L across roughly 220 stations,
and reporting premium 95 above premium 98. On the first run all five TAS readings were correctly
rejected. See `data/lib/sources/petrolmate.md`.

## The fuel price cycle, and what state-wide data can actually tell us

City fuel prices are a sawtooth: a hike of 20 to 40 c/L overnight, then a slow drift down. That
shape is what makes "buy now or wait" answerable.

**State-wide averages do not have that shape.** Averaging across a whole state blends metro
stations that hike on a Tuesday with regional ones that follow days or weeks later, so the hike is
smeared out. In the seed data, VIC U91 spans 54.9 c/L across 88 days yet its largest single-day
move is only +4.5 c/L. There is no edge to detect.

So cycles are recovered from periodicity in the first differences (which removes the crude-oil
trend) plus turning points on a smoothed series, and amplitude is measured on the detrended
residual so it reflects the part of the movement a driver can actually time.

Fitting the 88-day seed window gives an honest and rather one-sided result:

| Series | Result |
| --- | --- |
| WA U91, P95, P98 | 7-day cycle, r=0.84, 13 cycles observed, 13-15 c/L amplitude, cheapest Tue/Wed |
| Everything else | no detectable cycle |

This is a limit of the data, not of the method. A 35 to 40 day eastern cycle cannot be established
from 88 days, because that is barely two cycles. It would need roughly six months at state level,
and the same applies to the data we collect ourselves.

Which is why the watch leads with **position in the recent range plus current direction** ("near the
bottom of the last few weeks and still falling") rather than cycle timing, and only quotes timing
where confidence is earned. Every fitted series carries a `confidence` of `good`, `fair` or `none`,
and the UI degrades with it. Seeded params are retired per state and fuel once 45 days of our own
data exist.

## Data sources and attribution

**Live and historical prices: [Petrolmate](https://petrolmate.com.au).** Petrolmate aggregates
official state government feeds and community reports. The collector uses only `/api/summary`,
which `robots.txt` explicitly allows via `Allow: /api/summary` ahead of its `Disallow: /api/`, and
sends an identifying User-Agent. One request per run.

**Cycle seeding: [FuelRadar](https://fuelradar.com.au).** A manually downloaded workbook of
state-wide daily averages was used once, locally, to fit the cycle parameters in
`data/params.seed.json`. FuelRadar's terms prohibit scraping and redistribution, so the workbook is
gitignored and never committed, and the underlying series is never republished. Only the derived
parameters are, which are aggregate statistics rather than a reproduction of the data.

Attribution for both appears in the app's settings page.

## Running it locally

```bash
# Fit cycle params from the seed workbook (one-off, needs the workbook)
node data/seed/fit-params.js "path/to/Fuel seed data.xlsx"

# Collect today's prices
node data/collect.js --catchup

# See what a run would change without writing
node data/collect.js --dry-run

# Diagnostics
node data/seed/inspect.js "VIC U91"
node data/seed/offset-check.js
```

## One-time repository setup

1. Create the GitHub repository and push `main`.
2. Create the published data branch:
   ```bash
   git switch --orphan data && git commit --allow-empty -m "init data branch" && git push -u origin data && git switch main
   ```
3. Settings → Pages → deploy from branch `data`, folder `/`.
4. Settings → Actions → allow workflows to write to the repository.
5. Run the `collect` workflow manually once to confirm it commits.

Scheduled workflows are disabled after 60 days without repository activity, which is why
`heartbeat.yml` pushes a trivial commit monthly.
