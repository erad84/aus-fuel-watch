const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'resources', 'images');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'menu_icon.png');

async function main() {
  const src80 = path.join(root, 'viewer', 'icons', 'icon-cycle-dial-80.png');
  const src144 = path.join(root, 'viewer', 'icons', 'icon-cycle-dial.png');
  const src = fs.existsSync(src80) ? src80 : src144;
  console.log('src', src, 'exists', fs.existsSync(src));
  console.log('out', out);
  try {
    const sharp = require('sharp');
    await sharp(src).resize(25, 25).png().toFile(out);
    console.log('menu icon from', src);
    return;
  } catch (e) {
    console.warn('sharp failed', e.message);
  }
  // Minimal opaque placeholder (Pebble menuIcon max 25x25)
  const w = 25;
  const h = 25;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 59;
    rgba[i * 4 + 1] = 130;
    rgba[i * 4 + 2] = 246;
    rgba[i * 4 + 3] = 255;
  }
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    let c = 0xffffffff;
    const buf = Buffer.concat([t, data]);
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    out,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
  console.log('placeholder menu icon');
}

main();
