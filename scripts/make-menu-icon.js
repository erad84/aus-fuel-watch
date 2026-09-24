#!/usr/bin/env node
/**
 * 25x25 greyscale cycle-dial menu icon (Pebble).
 * Transparent corners (no black square behind the dial).
 * Segments: peak(top) / falling(right) / bottom / rising(left)
 * Pip on falling arc: dark ring + white center.
 */
const fs = require('fs');
const zlib = require('zlib');

const DST =
  '/mnt/e/Mark/webdev/Pebble watch/Aus Fuel Watch/resources/images/menu_icon.png';
const W = 25;
const H = 25;
/* RGBA */
const px = Buffer.alloc(W * H * 4);

const C = {
  peak: [245, 245, 245, 255],
  falling: [120, 120, 120, 255],
  bottom: [40, 40, 40, 255],
  rising: [185, 185, 185, 255],
  hub: [175, 175, 175, 255],
  sep: [0, 0, 0, 255],
  pipRing: [15, 15, 15, 255],
  pipFill: [255, 255, 255, 255],
  clear: [0, 0, 0, 0],
};

function put(x, y, rgba) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = rgba[0];
  px[i + 1] = rgba[1];
  px[i + 2] = rgba[2];
  px[i + 3] = rgba[3];
}

function colourFor(deg) {
  const a = ((deg % 360) + 360) % 360;
  for (const s of [45, 135, 225, 315]) {
    let d = Math.abs(a - s);
    if (d > 180) d = 360 - d;
    if (d <= 2.8) return C.sep;
  }
  if (a < 45 || a >= 315) return C.peak;
  if (a < 135) return C.falling;
  if (a < 225) return C.bottom;
  return C.rising;
}

const cx = 12;
const cy = 12;
const rOut = 11.6;
const rIn = 6.5;
const hubR = 2.6;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    put(x, y, C.clear);
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;

    if (d <= rOut && d >= rIn) {
      put(x, y, colourFor(deg));
    } else if (d >= hubR - 0.7 && d <= hubR + 0.7) {
      put(x, y, C.hub);
    }
  }
}

/* Thin black outline around the full outer ring so the dial reads on white
 * app-list backgrounds (especially the peak/white segment). */
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > rOut && d <= rOut + 1.35) put(x, y, C.sep);
  }
}

const pipX = 20;
const pipY = 12;
const ring = [
  [-2, -1], [-2, 0], [-2, 1],
  [-1, -2], [0, -2], [1, -2],
  [2, -1], [2, 0], [2, 1],
  [-1, 2], [0, 2], [1, 2],
  [-2, -2], [2, -2], [-2, 2], [2, 2],
];
for (const [ox, oy] of ring) put(pipX + ox, pipY + oy, C.pipRing);
for (let oy = -1; oy <= 1; oy++) {
  for (let ox = -1; ox <= 1; ox++) {
    put(pipX + ox, pipY + oy, C.pipFill);
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const stride = W * 4 + 1;
const raw = Buffer.alloc(stride * H);
for (let y = 0; y < H; y++) {
  raw[y * stride] = 0;
  px.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; /* bit depth */
ihdr[9] = 6; /* RGBA */
fs.writeFileSync(
  DST,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
);
console.log('wrote', DST);
