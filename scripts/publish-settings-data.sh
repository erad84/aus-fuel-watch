#!/usr/bin/env bash
set -euo pipefail
ROOT="/mnt/e/Mark/webdev/Pebble watch/Aus Fuel Watch"
cd "$ROOT"
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
