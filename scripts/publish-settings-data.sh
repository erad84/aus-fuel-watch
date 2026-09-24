#!/usr/bin/env bash
# Copy settings + suburb assets into the local `data` branch worktree (.data-publish)
# and push. Canonical published files live on the `data` branch / GitHub Pages
# (`{dataBase}/v1/…`); .data-publish is a checkout helper only — never treat it
# as source of truth, and never commit it onto main.
set -euo pipefail
ROOT="/mnt/e/Mark/webdev/Pebble watch/Aus Fuel Watch"
cd "$ROOT"
if [[ ! -d .data-publish/.git && ! -f .data-publish/.git ]]; then
  echo "error: .data-publish worktree missing; create with: git worktree add .data-publish data" >&2
  exit 1
fi
cp -f viewer/settings.html viewer/settings.js viewer/settings.css viewer/userPrefs.js viewer/brands.js .data-publish/viewer/
cp -rf viewer/brands .data-publish/viewer/
cp -f viewer/au-suburbs.json .data-publish/viewer/au-suburbs.json
cp -f docs/v1/au-suburbs.json .data-publish/v1/au-suburbs.json
cp -f viewer/au-suburbs-data.js .data-publish/viewer/au-suburbs-data.js
cd .data-publish
git checkout -B data
git add viewer/settings.html viewer/settings.js viewer/settings.css viewer/au-suburbs.json viewer/au-suburbs-data.js v1/au-suburbs.json
git status --short | head -30
git -c user.name="Mark" -c user.email="mark@local" commit -m "Fix settings suburb typeahead and publish au-suburbs.json."
git push origin HEAD:data
echo "published ok"
