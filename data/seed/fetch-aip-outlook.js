'use strict';

/**
 * Discover AIP weekly petrol/diesel PDFs, parse Argus Mogas 95 / Gasoil A cpl,
 * and merge into docs/v1/outlook.json (prefer AIP over ACCC for the same week).
 *
 * Usage:
 *   node data/seed/fetch-aip-outlook.js
 *   node data/seed/fetch-aip-outlook.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const OUT_PATH = process.env.OUTLOOK_PATH || path.join(ROOT, 'docs', 'v1', 'outlook.json');
const EMBED_PATH =
  process.env.OUTLOOK_EMBED_PATH || path.join(ROOT, 'viewer', 'outlook-data.js');
const DRY = process.argv.includes('--dry-run');
const SKIP_EMBED = process.argv.includes('--no-embed');

const LISTING_URLS = [
  'https://aip.com.au/pricing/weekly-prices-reports',
  'https://www.aip.com.au/pricing/weekly-prices-reports',
  'https://aip.com.au/pricing',
  'https://www.aip.com.au/pricing',
];

const MEDIA_SEARCH = [
  'https://aip.com.au/wp-json/wp/v2/media?search=Weekly%20Petrol%20Prices%20Report&per_page=40',
  'https://aip.com.au/wp-json/wp/v2/media?search=Weekly%20Diesel%20Prices%20Report&per_page=40',
  'https://www.aip.com.au/wp-json/wp/v2/media?search=Weekly%20Petrol%20Prices%20Report&per_page=40',
  'https://www.aip.com.au/wp-json/wp/v2/media?search=Weekly%20Diesel%20Prices%20Report&per_page=40',
];

const UA =
  'AusFuelWatch/1.0 (+local outlook curator; Mozilla/5.0)';

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: 60000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects < 8
        ) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchBuffer(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`${url} -> HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
  });
}

async function fetchText(url) {
  const buf = await fetchBuffer(url);
  return buf.toString('utf8');
}

function inflatePdfStreams(buf) {
  const outs = [];
  let i = 0;
  const data = buf;
  while (true) {
    const j = data.indexOf(Buffer.from('stream'), i);
    if (j < 0) break;
    const k = data.indexOf(Buffer.from('endstream'), j);
    if (k < 0) break;
    let chunk = data.subarray(j + 6, k);
    if (chunk[0] === 0x0d && chunk[1] === 0x0a) chunk = chunk.subarray(2);
    else if (chunk[0] === 0x0a) chunk = chunk.subarray(1);
    try {
      outs.push(zlib.inflateSync(chunk).toString('latin1'));
    } catch {
      /* not flate */
    }
    i = k + 9;
  }
  return outs.join('\n');
}

function unescapePdfLiteral(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/** Reconstruct visible text from PDF Tj / TJ operators. */
function pdfVisibleText(buf) {
  const raw = inflatePdfStreams(buf);
  const parts = [];
  const re = /\((?:\\.|[^\\)])*\)\s*Tj|\[(.*?)\]\s*TJ/gs;
  let m;
  while ((m = re.exec(raw))) {
    if (m[0].endsWith('Tj')) {
      const lit = m[0].match(/\((?:\\.|[^\\)])*\)/)[0];
      parts.push(unescapePdfLiteral(lit.slice(1, -1)));
    } else {
      const arr = m[1] || '';
      const litRe = /\((?:\\.|[^\\)])*\)/g;
      let lm;
      while ((lm = litRe.exec(arr))) {
        parts.push(unescapePdfLiteral(lm[0].slice(1, -1)));
      }
    }
  }
  // AIP PDFs often leave literal \( \) in the reconstructed string
  return parts.join('').replace(/\\([()])/g, '$1');
}

function dmyToIso(dmy) {
  const m = String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const yy = Number(m[3]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${m[2]}-${m[1]}`;
}

/**
 * Parse petrol PDF: Last/Previous week → Mogas 95 (3rd of Tapis/Brent/Mogas triple).
 * Also capture national TGP when present in the wholesale block.
 */
function parsePetrolPdf(text) {
  const weeks = [];
  // Prices are one-decimal and concatenated: 87.978.7102.0 → 87.9, 78.7, 102.0
  // Forms: "to Friday DD/MM/YY" or "(to Friday DD/MM/YY)"
  const re =
    /Average:\s*(?:Last|Previous)\s*Week\s*(?:\(to Friday\s*|\s*to Friday\s*)(\d{2}\/\d{2}\/\d{2})\)?(\d+\.\d)(\d+\.\d)(\d+\.\d)/gi;
  let m;
  while ((m = re.exec(text))) {
    const iso = dmyToIso(m[1]);
    const mogas = Number(m[4]);
    if (iso && Number.isFinite(mogas) && mogas > 30 && mogas < 300) {
      weeks.push({ weekEnding: iso, mogas95: mogas, source: 'aip' });
    }
  }
  const tm = text.match(
    /Average:\s*Last Week\s*\(to Friday\s*(\d{2}\/\d{2}\/\d{2})\)\s*(\d+\.\d)[\s\S]{0,80}?Average:\s*Last Week\s*\(to Friday\s*\1\)\s*(\d+\.\d)/i
  );
  if (tm) {
    const iso = dmyToIso(tm[1]);
    const a = Number(tm[2]);
    const b = Number(tm[3]);
    const tgp = b > 120 ? b : a > 120 ? a : null;
    if (iso && tgp != null) {
      const row = weeks.find((w) => w.weekEnding === iso);
      if (row) row.tgp = tgp;
    }
  }
  return weeks;
}

/** Diesel PDF: Gasoil is typically the 3rd number in the same Average: Last Week pattern. */
function parseDieselPdf(text) {
  const weeks = [];
  const re =
    /Average:\s*(?:Last|Previous)\s*Week\s*(?:\(to Friday\s*|\s*to Friday\s*)(\d{2}\/\d{2}\/\d{2})\)?(\d+\.\d)(\d+\.\d)(\d+\.\d)/gi;
  let m;
  while ((m = re.exec(text))) {
    const iso = dmyToIso(m[1]);
    const gasoil = Number(m[4]);
    if (iso && Number.isFinite(gasoil) && gasoil > 30 && gasoil < 400) {
      weeks.push({ weekEnding: iso, gasoil, source: 'aip' });
    }
  }
  return weeks;
}

function extractPdfLinks(html, baseUrl) {
  const links = new Set();
  const re = /href=["']([^"']+\.pdf[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const href = m[1].replace(/&amp;/g, '&');
      if (!/Weekly|Petrol|Diesel|Prices|Report|MOGAS|At-A-Glance|At-a-Glance/i.test(href)) {
        continue;
      }
      links.add(new URL(href, baseUrl).href);
    } catch {
      /* ignore */
    }
  }
  return [...links];
}

function mediaApiPdfUrls(jsonText) {
  const links = new Set();
  try {
    const arr = JSON.parse(jsonText);
    if (!Array.isArray(arr)) return [];
    for (const item of arr) {
      const url = item?.source_url;
      if (url && /\.pdf($|\?)/i.test(url)) links.add(url);
      const desc = item?.description?.rendered || '';
      for (const u of extractPdfLinks(desc, 'https://aip.com.au/')) links.add(u);
    }
  } catch {
    /* ignore */
  }
  return [...links];
}

/** Probe recent Sunday-dated upload paths when API/listing miss a file. */
function guessedRecentPdfUrls(count = 8) {
  const links = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i * 7);
    // Snap toward Sunday report dates (AIP week ending Sunday)
    const day = d.getUTCDay();
    const toSun = (7 - day) % 7;
    d.setUTCDate(d.getUTCDate() + toSun);
    const dayNum = d.getUTCDate();
    const monthName = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
    const year = d.getUTCFullYear();
    const monthNum = String(d.getUTCMonth() + 1).padStart(2, '0');
    const name = `Weekly-Petrol-Prices-Report-${dayNum}-${monthName}-${year}.pdf`;
    const diesel = `Weekly-Diesel-Prices-Report-${dayNum}-${monthName}-${year}.pdf`;
    for (const folder of [monthNum, String(Number(monthNum) - 1 || 12).padStart(2, '0')]) {
      links.push(`https://aip.com.au/wp-content/uploads/${year}/${folder}/${name}`);
      links.push(`https://aip.com.au/wp-content/uploads/${year}/${folder}/${diesel}`);
    }
  }
  return links;
}

async function discoverLinks() {
  const all = new Set();

  for (const url of MEDIA_SEARCH) {
    try {
      const json = await fetchText(url);
      const found = mediaApiPdfUrls(json);
      found.forEach((u) => all.add(u));
      console.log(`media api ${url}: ${found.length} pdfs`);
    } catch (e) {
      console.warn(`media api fail ${url}: ${e.message}`);
    }
  }

  for (const url of LISTING_URLS) {
    try {
      const html = await fetchText(url);
      const pageLinks = [...html.matchAll(/href=["']([^"']*weekly-(?:petrol|diesel)-prices-report[^"']*)["']/gi)].map(
        (m) => {
          try {
            return new URL(m[1].replace(/&amp;/g, '&'), url).href;
          } catch {
            return null;
          }
        }
      );
      for (const page of pageLinks.filter(Boolean)) {
        try {
          const body = await fetchText(page);
          extractPdfLinks(body, page).forEach((u) => all.add(u));
        } catch (e) {
          console.warn(`report page fail ${page}: ${e.message}`);
        }
      }
      extractPdfLinks(html, url).forEach((u) => all.add(u));
    } catch (e) {
      console.warn(`listing fail ${url}: ${e.message}`);
    }
  }

  // Always try a few guessed recent URLs (404s are fine)
  if (all.size < 4) {
    guessedRecentPdfUrls(6).forEach((u) => all.add(u));
  }

  return [...all];
}

function mergeWeeks(existing, incoming) {
  const by = new Map();
  for (const w of existing || []) {
    if (!w?.weekEnding) continue;
    by.set(w.weekEnding, { ...w });
  }
  for (const w of incoming) {
    if (!w?.weekEnding) continue;
    const prev = by.get(w.weekEnding) || { weekEnding: w.weekEnding };
    const next = { ...prev };
    if (w.mogas95 != null) {
      if (prev.source !== 'aip' || w.source === 'aip' || prev.mogas95 == null) {
        next.mogas95 = w.mogas95;
        if (w.source) next.source = w.source;
      }
    }
    if (w.gasoil != null) {
      if (prev.gasoilSource !== 'aip' || w.source === 'aip' || prev.gasoil == null) {
        next.gasoil = w.gasoil;
        if (w.source) next.gasoilSource = w.source;
      }
    }
    if (w.tgp != null) next.tgp = w.tgp;
    if (w.source && !next.source) next.source = w.source;
    by.set(w.weekEnding, next);
  }
  return [...by.values()].sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
}

function loadOutlook() {
  if (!fs.existsSync(OUT_PATH)) {
    return {
      source: 'AIP weekly (Argus) curated; ACCC fills gaps',
      updated: null,
      lagDays: { default: 10, min: 7, max: 14 },
      weeks: [],
    };
  }
  return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
}

async function main() {
  const outlook = loadOutlook();
  const links = await discoverLinks();
  if (!links.length) {
    console.warn('No PDF links discovered; leaving outlook.json unchanged.');
    process.exitCode = 1;
    return;
  }

  const found = [];
  let ok = 0;
  for (const url of links) {
    const isDiesel = /diesel/i.test(url);
    try {
      const buf = await fetchBuffer(url);
      const text = pdfVisibleText(buf);
      const rows = isDiesel ? parseDieselPdf(text) : parsePetrolPdf(text);
      if (rows.length) {
        ok += 1;
        console.log(`ok ${url} → ${rows.length} week(s)`);
        found.push(...rows);
      }
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) console.warn(`parse fail ${url}: ${e.message}`);
    }
  }

  const weeks = mergeWeeks(outlook.weeks, found);
  const next = {
    ...outlook,
    source: 'AIP weekly (Argus) curated; ACCC fills gaps',
    updated: new Date().toISOString().slice(0, 10),
    lagDays: outlook.lagDays || { default: 10, min: 7, max: 14 },
    weeks,
    lastFetch: {
      at: new Date().toISOString(),
      pdfCandidates: links.length,
      pdfsParsed: ok,
      parsedRows: found.length,
    },
  };

  console.log(`merged weeks: ${weeks.length} (parsed ${found.length} rows from ${ok} pdfs)`);
  if (DRY) {
    console.log(JSON.stringify(next, null, 2).slice(0, 2500));
    return;
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`wrote ${OUT_PATH}`);
  if (!SKIP_EMBED) {
    fs.mkdirSync(path.dirname(EMBED_PATH), { recursive: true });
    fs.writeFileSync(
      EMBED_PATH,
      `window.OUTLOOK_DATA=${JSON.stringify(next)};\n`
    );
    console.log(`wrote ${EMBED_PATH}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
