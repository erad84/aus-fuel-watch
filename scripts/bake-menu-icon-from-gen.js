#!/usr/bin/env node
/** Downscale AI dial with majority-vote sampling for crisp 25x25. */
const fs = require('fs');
const { PNG } = require('/mnt/e/Mark/webdev/Pebble watch/Aus Fuel Watch/node_modules/pngjs');

const SRC =
  '/mnt/c/Users/mnwil/.cursor/projects/e-Mark-webdev-Pebble-watch-Aus-Fuel-Watch/assets/menu_icon_grey_dial.png';
const DST =
  '/mnt/e/Mark/webdev/Pebble watch/Aus Fuel Watch/resources/images/menu_icon.png';
const OUT = 25;

const src = PNG.sync.read(fs.readFileSync(SRC));
const dst = new PNG({ width: OUT, height: OUT });

function lum(r, g, b) {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

function quantize(r, g, b, a) {
  if (a < 40) return [0, 0, 0];
  const L = lum(r, g, b);
  // Map to palette matching dial greys + pip
  if (L > 235) return [255, 255, 255]; // pip center
  if (L < 25) return [0, 0, 0];
  if (L < 55) return [30, 30, 30]; // pip ring / separators
  if (L < 95) return [70, 70, 70]; // bottom
  if (L < 145) return [150, 150, 150]; // falling
  if (L < 190) return [185, 185, 185]; // rising
  return [220, 220, 220]; // peak
}

for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    const x0 = Math.floor((x * src.width) / OUT);
    const x1 = Math.floor(((x + 1) * src.width) / OUT);
    const y0 = Math.floor((y * src.height) / OUT);
    const y1 = Math.floor(((y + 1) * src.height) / OUT);
    const counts = new Map();
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (src.width * sy + sx) << 2;
        const q = quantize(src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]);
        const key = q.join(',');
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    let best = '0,0,0';
    let bestN = -1;
    for (const [k, n] of counts) {
      if (n > bestN) {
        bestN = n;
        best = k;
      }
    }
    const [r, g, b] = best.split(',').map(Number);
    const di = (OUT * y + x) << 2;
    dst.data[di] = r;
    dst.data[di + 1] = g;
    dst.data[di + 2] = b;
    dst.data[di + 3] = 255;
  }
}

fs.writeFileSync(DST, PNG.sync.write(dst));
console.log('wrote quantized', DST);
