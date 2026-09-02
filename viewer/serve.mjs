#!/usr/bin/env node
// Serves the viewer and proxies Petrolmate (browser CORS blocks direct calls).
//   node viewer/serve.mjs  →  http://localhost:3456

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const DOCS = path.join(ROOT, '..', 'docs');
const PORT = Number(process.env.VIEWER_PORT || 3456);
const UA = 'AusFuelWatch/1.0 (local viewer)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept');
}

async function proxyPetrolmate(upstreamPath, query, res) {
  const qs = query ? `?${query}` : '';
  const url = `https://petrolmate.com.au${upstreamPath}${qs}`;
  const upstream = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  const body = await upstream.text();
  cors(res);
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/proxy/summary') {
      await proxyPetrolmate('/api/summary', '', res);
      return;
    }
    if (pathname === '/proxy/area') {
      await proxyPetrolmate('/api/v1/stations/area', url.searchParams.toString(), res);
      return;
    }

    if (pathname.startsWith('/docs/')) {
      sendFile(res, path.join(DOCS, pathname.slice('/docs/'.length)));
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    sendFile(res, path.join(ROOT, rel));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Viewer  http://localhost:${PORT}`);
  console.log(`Docs    http://localhost:${PORT}/docs/v1/index.json`);
  console.log(`Proxy   http://localhost:${PORT}/proxy/summary`);
});
