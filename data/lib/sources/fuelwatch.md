# WA FuelWatch

Probed live on 2026-08-31. No credentials of any kind.

## Endpoint

```
GET https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=<n>[&Region=<n>][&Day=<day>]
```

Returns RSS, `text/xml; charset=utf-8`. Product 1 is 700KB across 940 items.

## The channel title is a red herring

The feed calls itself **"FuelWatch Prices For All Metro Regions"**, which reads as Perth-only. It
is not. Enumerating every Region code from 1 to 60 finds 54 populated regions holding 731
stations in total, and **all 731 already appear in the default feed**, which carries 940. The
default response is the whole state plus 209 stations that belong to no region.

So one call per product covers Western Australia. `Region` only ever narrows.

For the record, the region codes are: 1 Boulder, 2 Broome, 4 Carnarvon, 5 Collie, 6 Dampier,
7 Esperance, 8 Kalgoorlie, 9 Karratha, 10 Kununurra, 11 Narrogin, 13 Port Hedland, 15 Albany,
16 Bunbury, 17 Geraldton, 18 Mandurah, 19 Capel, 20 Dardanup, 22 Harvey, 23 Murray, 24 Waroona,
25 North of River, 26 South of River, 27 East/Hills, 28 Augusta-M River, 29 Busselton-Shire,
30 B-Town/G-Bushes, 31 D-Brook/Bal-Up, 32 Manjimup, and 33-58 assorted country towns. Codes 3,
12, 14, 21, 59 and 60 return nothing. Regions 25, 26 and 27 are the Perth metropolitan trio,
totalling 449 stations.

## Product codes

Confirmed by item count and by relative price at the same station:

| Product | Items | Canon |
| --- | --- | --- |
| 1 | 940 | `U91` |
| 2 | 524 | `P95` |
| 4 | 677 | `DSL` |
| 6 | 727 | `P98` |
| 11 | 458 | `PDSL` |
| 5 | 36 | LPG, out of scope |
| 10 | 13 | truck-stop product, out of scope |

3, 7, 8 and 12 return zero items. **WA has no E10**, matching Petrolmate.

Product 2 against 6 was worth confirming rather than assuming, since there are more 98 stations
than 95 ones, which is the opposite of the eastern states. Perth metro averages settle it:
P95 215.5c against P98 224.6c, so 2 is the 95 and 6 is the 98.

## Item shape

```xml
<item>
  <title>186.7: Costco Perth Airport</title>
  <description>Address: 142 Dunreath Dr, PERTH AIRPORT, Phone: ...</description>
  <brand>Costco</brand>
  <date>2026-08-31</date>
  <price>186.7</price>
  <trading-name>Costco Perth Airport</trading-name>
  <location>PERTH AIRPORT</location>
  <address>142 Dunreath Dr</address>
  <phone>(08) 9311 4700</phone>
  <latitude>-31.94037700</latitude>
  <longitude>115.95186900</longitude>
  <site-features>EFTPOS, Open Mon: 06:00-21:30, ...</site-features>
  <restrictions>Membership Required; </restrictions>
</item>
```

Coordinates on every item. **No postcode** — only a suburb in `location`. That is not a problem:
every station here is in WA by construction, and metro membership comes from distance to the
Perth GPO.

**No station id.** Identity is trading name plus suburb, namespaced by source.

`restrictions` is worth keeping. Costco at 186.7c is the cheapest ULP in the state but reads
"Membership Required", so a watch that sends someone there without warning them is unhelpful.

The feed is sorted by price ascending, not by station.

## Tomorrow's prices

`Day=tomorrow` is the reason WA is special. WA is also the one state where the seed fit gives a
confident 7-day cycle, so a known next-day price turns the watch's advice from an inference into
a fact.

**But the timing does not currently work.** WA releases tomorrow's prices at **14:30 WST**, and
our sampling window is 07:00-13:00 local. Probed at 07:38 WST, `Day=tomorrow` returned 0 items
while `Day=today` returned 940 and `Day=yesterday` returned 940 dated 2026-08-30.

The three scheduled runs are 23:07, 02:37 and 06:07 UTC, which in WST are 07:07, 10:37 and
14:07 — the last of them 23 minutes short. **Capturing WA's next-day price needs a fourth cron
at roughly 07:07 UTC (15:07 WST).** The adapter already asks for tomorrow on every run and
records it when present, so only the schedule needs changing.

## Coverage measured

994 distinct stations, 461 of them in Perth.

| Scope | U91 avg | median | min | max |
| --- | --- | --- | --- | --- |
| WA state-wide | 212.2c | 202.9c | 186.7c | 450.0c |
| Perth metro | 199.3c | 199.9c | 186.7c | 216.9c |

A **12.9c gap** between the capital and the state, the largest of any jurisdiction so far. Remote
WA reaches 450c/L, and the state-wide mean sits 9c above its own median because of it. For a
Perth user the state-wide number is not merely less precise, it is misleading — which is the
clearest justification for the metro pivot in the whole dataset.

Note that state-wide `PDSL` (254.4c) comes out *below* state-wide `DSL` (260.3c). This is not a
data error: premium diesel is not sold at the remote outlets that drag ordinary diesel upward, so
the two grades are averaged over different station populations. Within Perth the ordering is
correct, 246.1c against 253.8c. The collector's premium-inversion sanity gate has to account for
this.

## Licence

WA Government open data, CC BY 4.0. Attribution: "FuelWatch WA (Department of Energy, Mines,
Industry Regulation and Safety)".
