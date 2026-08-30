# Petrolmate API probe findings

Probed 2026-08-31. Re-probe if the collector starts failing.

## robots.txt

`https://petrolmate.com.au/robots.txt` contains:

```
Disallow: /admin/
Allow: /api/summary
Disallow: /api/
...
Crawl-delay: 1
```

So the whole API is disallowed to automated agents **except** `/api/summary`, which is explicitly
allowed. The collector therefore uses `/api/summary` exclusively. Do not add calls to
`/api/widget/prices`, `/api/v1/stations/area` or `/api/recommendation/{station}` in the scheduled
job, even though they work, because they fall under `Disallow: /api/`.

## GET /api/summary

One request returns every state and fuel. About 3.1KB. No auth, no key.

```json
{
  "coverage": "10,000+ stations across all Australian states and New Zealand",
  "description": "Live fuel prices from official Australian government APIs and community sources",
  "generated_at": "2026-08-30T21:41:58.863076Z",
  "source": "Petrolmate (petrolmate.com.au)",
  "states": {
    "VIC": {
      "ULP":     { "avg": 205.6, "max": 300.0, "min": 182.9, "stations": 1929 },
      "E10":     { "avg": 199.4, "max": 230.9, "min": 155.5, "stations": 443 },
      "PULP95":  { "avg": 221.0, "max": 269.9, "min": 196.3, "stations": 1174 },
      "PULP98":  { "avg": 230.0, "max": 289.9, "min": 202.9, "stations": 1711 },
      "DIESEL":  { "avg": 253.7, "max": 339.9, "min": 197.9, "stations": 1281 },
      "PDIESEL": { "avg": 255.8, "max": 290.9, "min": 230.3, "stations": 1101 }
    }
  }
}
```

Confirmed facts:

- All 8 states and territories present: ACT NSW NT QLD SA TAS VIC WA.
- Six fuel codes: `ULP E10 PULP95 PULP98 DIESEL PDIESEL`. Codes are per-state, so a state simply
  omits a fuel it has no data for. WA and NT have no `E10`.
- **No LPG.** LPG exists on `/api/widget/prices` but not on `/api/summary`, so LPG is out of scope
  for v1 rather than reaching for a disallowed endpoint.
- `generated_at` is UTC and regenerates per request, so this is live rather than cached.
- Response headers are bare: `Content-Type: application/json`, `cf-cache-status: DYNAMIC`. No ETag,
  no Cache-Control, no Content-Encoding. Behind Cloudflare.
- Prices are cents per litre as JSON numbers with one decimal. We store tenths of a cent as
  integers, so 205.6 becomes 2056.

## State-level only, no metro

`/api/summary` is state-wide. Getting capital-city averages would need `/api/widget/prices` with a
city filter, an area query, or parsing the `/city/` HTML pages, and the first two are
robots-disallowed. So v1 collects state-wide series only, which matches the granularity of the seed
workbook anyway. Metro cannot be backfilled later, which is a real cost, but not enough to justify
hitting a disallowed endpoint on a schedule.

## Data quality warnings

These are the reason `collect.js` needs sanity gates rather than trusting the feed.

**Tasmania is currently broken.** `/api/summary` reports TAS ULP at 277.2 c/L across 18 stations,
where FuelRadar reports 210.0 c/L across 217 stations. It also reports PULP95 at 297.9 above PULP98
at 262.4, which is internally impossible. Petrolmate's TAS sync is clearly degraded. TAS readings
must be gated and flagged, not published as-is.

**NT diverges a lot.** `/api/summary` reports NT ULP at 251.9 across 185 stations against
FuelRadar's 217.9 across 91. Petrolmate appears to include remote community outlets that FuelRadar
excludes. Not wrong as such, but it is a different population, so NT levels are not comparable to
the seed.

Measured on 2026-08-31 by `data/seed/offset-check.js`, comparing the seed's final day against our
first collected day across 33 series: median offset **+2.4 c/L**, and prices were generally rising
over that day so the true source bias is smaller still. Agreement is close for the populated states
(ACT +0.1 to +0.7, NSW/VIC/QLD +0.1 to +3.9, SA +1.5 to +8.9) and WA's larger gap (U91 +9.9) is a
real hike-day move rather than a source disagreement. The exception is NT: **U91 +39.8 and diesel
+36.3**, which confirms the different station population. Cycle timing is level-independent so this
does not affect period or phase, but NT's seeded `p10Offset`/`p90Offset` should not be trusted
against Petrolmate levels.

**`avg` is an unweighted mean including outliers.** NT diesel `max` is 420.0 and QLD PULP95 `min` is
140.0. The mean is therefore noisier than a median would be, but it is consistently computed day to
day, which is what cycle detection actually needs.

**`min` is a single cheapest station**, so it is outlier-prone and is not a usable substitute for a
tenth-percentile figure. We store it for context only.

**`stations` counts differ between endpoints.** For VIC ULP, `/api/summary` says 1929 while
`/api/widget/prices` says 4697, though both agree on `avg` at 205.6. The widget count appears to
count price records rather than stations. Trust the summary count.

## Sanity gates implemented in collect.js

A reading is rejected, and the day left empty for the catch-up run, when any of these hold:

1. `stations` is below 60 percent of the trailing 14-day median for that state and fuel, which
   catches coverage collapses like the TAS one.
2. `avg` is outside the trailing 14-day median by more than 45 c/L, which is wider than a real price
   hike of 20 to 40 c/L so genuine spikes survive.
3. `PULP95 > PULP98` for the same state, which is a reliable tell that the sample is broken.
4. `avg`, `min` or `max` is missing, non-numeric, or `avg` falls outside 50 to 400 c/L.

Rejections are counted per state in the published file so the watch can downgrade confidence rather
than silently showing a wrong verdict.
