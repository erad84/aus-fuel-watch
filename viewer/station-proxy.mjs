#!/usr/bin/env node
'use strict';

// Tiny CORS proxy for Petrolmate station search (browser viewer only).
// Petrolmate allows some localhost origins but not all ports / hosted Pages.
//
//   node viewer/station-proxy.mjs
//   # then set Station proxy in the viewer to http://localhost:3457

const http = require('http');
const PORT = Number(process.env.STATION_PROXY_PORT || 3457);
const UPSTREAM = 'https://petrolmate.com.au/api/v1/stations/area';
const UA = 'AusFuelWatch/1.0 (local viewer proxy)';

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.url.startsWith('/area')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Use /area?lat=&lng=&radius=&limit=');
    return;
  }

  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  try {
    const upstream = await fetch(`${UPSTREAM}${qs}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`proxy error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Station proxy http://localhost:${PORT}/area?lat=-33.87&lng=151.21&radius=5000&limit=10`);
});
