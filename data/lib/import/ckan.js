'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function fetchJson(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const lib = url.startsWith('https') ? https : http;
      lib
        .get(url, { headers: { 'User-Agent': 'AusFuelWatch/1.0 (history import)' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            fetchJson(res.headers.location, n).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            if (n > 0 && res.statusCode >= 500) {
              setTimeout(() => attempt(n - 1), 2000);
              return;
            }
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(d));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on('error', (err) => {
          if (n > 0) setTimeout(() => attempt(n - 1), 2000);
          else reject(err);
        });
    };
    attempt(retries);
  });
}

async function packageShow(apiBase, packageId) {
  const base = apiBase.replace(/\/$/, '');
  const body = await fetchJson(
    `${base}/api/3/action/package_show?id=${encodeURIComponent(packageId)}`
  );
  if (!body.success) throw new Error(`CKAN package_show failed: ${packageId}`);
  return body.result;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    lib
      .get(url, { headers: { 'User-Agent': 'AusFuelWatch/1.0 (history import)' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(dest, () => reject(err));
      });
  });
}

async function downloadCached(url, cacheDir, name) {
  const dest = path.join(cacheDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await downloadFile(url, dest);
  return dest;
}

module.exports = { fetchJson, packageShow, downloadFile, downloadCached };
