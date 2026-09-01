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

WA FuelWatch and NT MyFuel need no credentials. VIC falls back to Petrolmate until
`VIC_FUEL_API_KEY` exists.

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
