'use strict';

// Minimal read-only xlsx reader. Deliberately dependency-free: it parses the zip
// central directory by hand and inflates with Node's built-in zlib, so neither the
// seed fitting step nor CI needs an npm install.
//
// Scope is only what the FuelRadar seed workbook needs: shared strings, numeric
// cells and date serials. It is not a general purpose spreadsheet library.

const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;

// Excel's 1900 date system, offset so that serial 2 is 1900-01-01. This lands
// 46174 on 2026-06-01, which is the first date in the seed workbook.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function findEocd(buf) {
  // The EOCD sits at the end, but a trailing comment can push it back up to 64KB.
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

function openZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDIR) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`zip entry not found: ${name}`);
    // Local header field widths are fixed; the name and extra lengths there can
    // differ from the central directory, so re-read them rather than reusing.
    const lh = e.localOffset;
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  }

  return { names: () => [...entries.keys()], read, readText: (n) => read(n).toString('utf8') };
}

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(zip) {
  if (!zip.names().includes('xl/sharedStrings.xml')) return [];
  const xml = zip.readText('xl/sharedStrings.xml');
  const out = [];
  const siRe = /<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] || '';
    // Rich text splits a single string across multiple <r><t> runs, so join them.
    let text = '';
    const tRe = /<t\b[^>]*(?:\/>|>([\s\S]*?)<\/t>)/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) text += t[1] || '';
    out.push(decodeEntities(text));
  }
  return out;
}

// Sheet order in the workbook does not match the sheetN.xml filenames, and sheetId
// is not the file number either. In the seed workbook "VIC PULP95" carries
// sheetId="5" but lives in sheet2.xml. The only correct route is r:id -> rels target.
function parseSheetIndex(zip) {
  const wb = zip.readText('xl/workbook.xml');
  const rels = zip.readText('xl/_rels/workbook.xml.rels');

  const target = new Map();
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let r;
  while ((r = relRe.exec(rels)) !== null) {
    const attrs = r[1];
    const id = /\bId="([^"]+)"/.exec(attrs);
    const tgt = /\bTarget="([^"]+)"/.exec(attrs);
    if (id && tgt) target.set(id[1], tgt[1]);
  }

  const sheets = [];
  const shRe = /<sheet\b([^>]*)\/>/g;
  let s;
  while ((s = shRe.exec(wb)) !== null) {
    const attrs = s[1];
    const name = /\bname="([^"]*)"/.exec(attrs);
    const rid = /\br:id="([^"]+)"/.exec(attrs);
    if (!name || !rid) continue;
    let path = target.get(rid[1]);
    if (!path) continue;
    if (!path.startsWith('xl/')) path = 'xl/' + path.replace(/^\/+/, '');
    sheets.push({ name: decodeEntities(name[1]), path });
  }
  return sheets;
}

function colOf(ref) {
  let i = 0;
  while (i < ref.length && ref.charCodeAt(i) >= 65) i++;
  return ref.slice(0, i);
}

// Returns rows as objects keyed by column letter, values either string or number.
function parseSheet(zip, path, sst) {
  const xml = zip.readText(path);
  const rows = [];
  const rowRe = /<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const inner = rm[1] || '';
    const cells = {};
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(inner)) !== null) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!refM) continue;
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);

      let value = null;
      if (type === 's') {
        if (vM) value = sst[Number(vM[1])];
      } else if (type === 'inlineStr') {
        const isM = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        if (isM) value = decodeEntities(isM[1]);
      } else if (vM) {
        const n = Number(vM[1]);
        value = Number.isNaN(n) ? decodeEntities(vM[1]) : n;
      }
      if (value !== null) cells[colOf(refM[1])] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function serialToISO(serial) {
  const ms = EXCEL_EPOCH_MS + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Seed cells hold text like "180.0 c/L" or "+23.2 c/L" rather than numbers.
function parseCents(text) {
  if (typeof text === 'number') return text;
  if (typeof text !== 'string') return null;
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*c\/L\s*$/i.exec(text);
  if (!m) return null;
  return Number(m[1]);
}

function open(path) {
  const zip = openZip(fs.readFileSync(path));
  const sst = parseSharedStrings(zip);
  const sheets = parseSheetIndex(zip);
  return {
    sheetNames: () => sheets.map((s) => s.name),
    rows(name) {
      const s = sheets.find((x) => x.name === name);
      if (!s) throw new Error(`sheet not found: ${name}`);
      return parseSheet(zip, s.path, sst);
    },
  };
}

module.exports = { open, serialToISO, parseCents };
