// scripts/make-icons.mjs — generate the plugin/action PNG icons.
//
// Written by hand rather than pulled from an image library: the plugin has no
// native dependencies and no build step, and a placeholder icon is not worth
// breaking either. zlib is built in; PNG needs only a CRC32 beyond that.
//
//   node scripts/make-icons.mjs

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixel data as a PNG buffer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with its filter type byte (0 = none).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: three stacked bars in the three profile-ish colours, on a dark
 * rounded field — a legible stand-in for "named profiles" at any size.
 */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bars = [
    [0x22, 0x55, 0xcc],
    [0x22, 0xaa, 0x44],
    [0xee, 0x66, 0x22],
  ];
  const radius = size * 0.18;
  const inset = size * 0.14;
  const barH = (size - inset * 2) / 5;
  const gap = barH / 2;

  const inRounded = (x, y) => {
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) continue; // leave transparent

      px[i] = 0x1a;
      px[i + 1] = 0x1a;
      px[i + 2] = 0x1e;
      px[i + 3] = 0xff;

      for (let b = 0; b < bars.length; b++) {
        const top = inset + b * (barH + gap);
        if (y >= top && y < top + barH && x >= inset && x < size - inset) {
          [px[i], px[i + 1], px[i + 2]] = bars[b];
        }
      }
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(ASSETS, { recursive: true });

for (const [name, size] of [
  ['plugin-icon', 144],
  ['plugin-icon@2x', 288],
  ['action-icon', 72],
  ['action-icon@2x', 144],
  ['category-icon', 28],
  ['category-icon@2x', 56],
]) {
  const file = resolve(ASSETS, `${name}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${name}.png (${size}x${size})`);
}
