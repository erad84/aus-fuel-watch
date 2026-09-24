# GitHub Actions setup

The collector runs on a schedule and commits published JSON to the `data` branch.
GitHub Pages serves that branch at the repository site URL.

## 1. Repository secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Source |
| --- | --- |
| `FUELCHECK_API_KEY` | [NSW API portal](https://api.nsw.gov.au/Product/Index/22) |
| `FUELCHECK_API_SECRET` | same registration |
| `SA_FUEL_TOKEN` | [SAFPIS publishers](https://www.safuelpricinginformation.com.au/publishers.html) |
| `QLD_FUEL_TOKEN` | [Fuel Prices QLD](https://www.fuelpricesqld.com.au/) |
| `VIC_FUEL_API_KEY` | [Servo Saver Public API](https://service.vic.gov.au/find-services/transport-and-driving/servo-saver/help-centre/servo-saver-public-api) (`x-consumer-id`) |
| `PEBBLE_FIREBASE_REFRESH_TOKEN` | Local `pebble login` → `refresh_token` in `~/.local/share/pebble-sdk/oauth_firebase/firebase_oauth_storage.json` (CloudPebble CI install) |
| `PEBBLE_FIREBASE_API_KEY` | Optional. Firebase Web API key; omit to use pebble-tool’s public default |

WA FuelWatch and NT MyFuel need no credentials. Without `VIC_FUEL_API_KEY`, VIC
falls back to Petrolmate state averages.

`GITHUB_TOKEN` is provided automatically and is used to push the `data` branch.

## 2. Workflow permissions

Settings → Actions → General → Workflow permissions → **Read and write permissions**.

## 3. GitHub Pages

Settings → Pages → Build and deployment:

- Source: **Deploy from a branch**
- Branch: `data` / `/ (root)`

Published files are at `https://<user>.github.io/<repo>/v1/NSW.json` etc.

## 4. First run

Actions → **collect** → Run workflow (catch-up defaults to on).

Scheduled times (UTC): 23:07, 02:37, 06:07 daily.

## 5. Heartbeat

The `heartbeat` workflow pushes a trivial commit monthly so scheduled workflows
stay enabled past GitHub's 60-day inactivity cutoff.

## 6. Pebble watchapp build

`pebble-build.yml` builds the watchapp on pull requests and pushes to `main`
via the shared reusable workflow in [erad84/pebble-ci](https://github.com/erad84/pebble-ci)
(`…/pebble-build-reusable.yml@v1`). The `.pbw` is uploaded as a workflow artifact.

Optional CloudPebble install is enabled (`install-cloudpebble: true` +
`secrets: inherit`). Until `PEBBLE_FIREBASE_REFRESH_TOKEN` is set, the install
job **skips** with a notice and the build still succeeds. After the secret is
set, keep the phone’s Pebble/Rebble app online so CI can reach the watch.

Mint the refresh token locally (`pebble login`), copy **only** `refresh_token`
from `~/.local/share/pebble-sdk/oauth_firebase/firebase_oauth_storage.json`,
and paste it into the Actions secret. Never commit tokens.

Pin `@v1`. Breaking changes ship as `v2`. Report issues / request updates on
https://github.com/erad84/pebble-ci/issues. Other Cursor Projects and Pebble
repos can use the same caller pattern — see project-store `docs/pebble-ci.md`.
