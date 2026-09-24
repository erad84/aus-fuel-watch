#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'viewer/au-suburbs-data.js'), 'utf8');
const i = src.indexOf('{');
const j = src.lastIndexOf('}');
const data = JSON.parse(src.slice(i, j + 1));
const json = JSON.stringify(data);
fs.mkdirSync(path.join(root, 'docs/v1'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/v1/au-suburbs.json'), json);
fs.writeFileSync(path.join(root, 'viewer/au-suburbs.json'), json);
console.log('suburbs', data.suburbs && data.suburbs.length, (Buffer.byteLength(json) / 1e6).toFixed(2) + 'MB');
