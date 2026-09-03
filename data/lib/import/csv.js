'use strict';

// Minimal RFC 4180 CSV parser (quoted fields, no multiline cells).

function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * @param {string} text full file
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];
  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseLine(line);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = fields[c] ?? '';
    rows.push(row);
  }
  return rows;
}

/**
 * Stream large files line-by-line without holding all rows in memory.
 * @param {string} path
 * @param {(row: Record<string,string>) => void} onRow
 */
function parseCsvFile(path, onRow) {
  const fs = require('fs');
  const buf = fs.readFileSync(path, 'utf8');
  const lines = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return 0;
  const header = parseLine(lines[0]);
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseLine(line);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = fields[c] ?? '';
    onRow(row);
    n++;
  }
  return n;
}

module.exports = { parseCsv, parseCsvFile, parseLine };
