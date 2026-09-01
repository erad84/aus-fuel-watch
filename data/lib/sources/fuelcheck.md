# NSW FuelCheck (NSW + ACT + TAS)

Probed live on 2026-08-31. Credentials are held in a gitignored `.env` and are deliberately
absent from this file and from every sample below.

## Authentication

Client-credentials OAuth, as expected:

```
GET https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials
Authorization: Basic base64(key:secret)
```

Returns `access_token`, `expires_in`, `issued_at`. Measured `expires_in` was **43199 seconds**,
just under 12 hours, matching the portal's "approximately 12 hours" claim.

A collector run lasts seconds, so the token only needs an in-process cache — there is nothing
worth persisting between runs, and a stale cached token across runs would be a liability. One
auth call per run.

Data calls need all of:

```
Authorization: Bearer <token>
apikey: <key>
transactionid: <any unique string>
requesttimestamp: dd/MM/yyyy hh:mm:ss AM/PM
Content-Type: application/json
```

## Endpoints

### `GET /FuelPriceCheck/v2/fuel/prices` — bulk, NSW + ACT

Returned **3273 stations and 10573 prices** in one call. This is the endpoint the collector
needs: everything current, no pagination, no per-station fan-out.

Response is two parallel arrays joined on station code:

```json
{
  "stations": [{
    "brand": "United", "code": "972", "name": "United Petroleum Umina",
    "address": "307-313 Ocean Beach Road, UMINA BEACH NSW 2257",
    "location": { "latitude": -33.511231, "longitude": 151.318092 },
    "state": "NSW"
  }],
  "prices": [{
    "stationcode": 1, "state": "NSW", "fueltype": "DL",
    "price": 258.9, "lastupdated": "26/08/2026 09:05:17"
  }]
}
```

Coordinates are present on every station, and the postcode is recoverable from the tail of
`address`. Both of the things metro averaging needs are therefore available.

**The `state` field is unusable.** Every one of the 3273 stations reports `"NSW"`, including
the 68 whose addresses say ACT — for example `6 GOLD CREEK RD, NICHOLLS ACT 2913` comes back
as `"state": "NSW"`. Jurisdiction must be derived from the postcode. `lib/regions.js` does
this.

Fuel codes seen, by frequency: `U91` 2038, `P98` 1941, `E10` 1488, `PDL` 1455, `P95` 1330,
`DL` 1209, `EV` 903, `LPG` 176, `E85` 32, `B20` 1. Note `DL`/`PDL` where our canon uses
`DSL`/`PDSL`.

### `POST /FuelPriceCheck/v2/fuel/prices/nearby` — Tasmania

The portal claims the v2 endpoints cover "NSW & Tasmania combined", but **the bulk feed
contains zero Tasmanian stations** — no 7xxx postcode appears in all 3273. Tasmania is
reachable on the same credentials through the radius query instead:

```json
{ "fueltype": "U91", "latitude": "-42.8821", "longitude": "147.3272",
  "radius": "50", "sortby": "price", "sortascending": "true" }
```

Around Hobart this returns Tasmanian stations, correctly labelled `"state": "TAS"` — so the
state field is reliable here even though it is not in the bulk feed.

**It caps at 20 results regardless of radius.** Radii of 5 km, 15 km and 50 km around Hobart
each returned exactly 20 stations. A 300 km radius centred inland returned 1, so large radii
are not a workaround.

Enumerating all ~220 Tasmanian stations would need tiled queries per fuel type, which against
a 2500 calls/month free tier and three runs a day does not fit. The adapter instead samples
Hobart and Launceston for two grades, yielding ~41 stations for 4 calls. Anything derived from
Tasmania is therefore a *cheapest-20 tracker*, not a true average, and is flagged `sampled` in
the snapshot. Hobart does not run a price cycle, so this costs little.

### `GET /FuelPriceCheck/v2/fuel/lovs`

404. Reference data is not at this path under v2.

## Coverage measured

| Jurisdiction | Stations with prices | In capital |
| --- | --- | --- |
| NSW | 2319 | 867 (Sydney) |
| ACT | 62 | 62 (Canberra) |
| TAS | 41 (sampled) | 21 (Hobart) |

A handful of stations in the NSW feed carry Victorian or Queensland postcodes — genuine border
sites. They are dropped, since one station is not a state average and those states have their
own sources.

Station codes are only unique within a jurisdiction. Keying the accumulator on the bare code
let Tasmanian stations overwrite NSW ones that shared a code; the adapter keys on state and
code together.

## Rate limits and budget

Free tier is 2500 calls/month. Per run: 1 auth + 1 bulk + 4 Tasmanian samples = 6. At three
runs a day that is ~540/month, comfortably inside the tier.

The portal also advertises 5 calls/minute for unregistered trial credentials.

## Licence

NSW Government open data, CC BY 4.0. Attribution: "NSW FuelCheck and FuelCheck TAS (NSW
Government)". Redistribution of derived aggregates is permitted with attribution.
