'use strict';
/**
 * Generates the application icon as a PNG, then the macOS .icns from it.
 *
 *   node tools/make-app-icon.js
 *
 * Writes build/icon.png (1024px, for the Windows .ico and Linux) and, on
 * macOS, build/icon.icns assembled by Apple's own `iconutil` from a full
 * iconset. That indirection matters: given only a PNG, electron-builder
 * generates the .icns itself and its 16px and 32px entries come out corrupt —
 * precisely the sizes Finder, Spotlight and the Dock display.
 *
 * Each size is rendered at its true size rather than downsampled, and the two
 * smallest drop the needle: one pixel of needle is noise, not information.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const SS = 4;

/** macOS icons need roughly a 10% inset or they read larger than their neighbours. */
const INSET = 0.10;

const BG = [0x1a, 0x1a, 0x19];   // matches the app's panel surface
const FG = [0xec, 0xec, 0xea];   // ring and hub
const ACCENT = [0x39, 0x87, 0xe5]; // the needle: the one saturated element

function render(size, { needle = true } = {}) {
  const n = size * SS;
  const px = new Uint8Array(n * n * 4);

  const pad = n * INSET;
  const box = n - pad * 2;
  const cx = n / 2 - 0.5;
  const cy = n / 2 - 0.5;
  const plateR = box / 2;
  const corner = box * 0.22;

  const ringR = box * 0.31;
  const ringW = box * 0.075;
  const hubR = box * 0.075;
  const needleLen = box * 0.27;
  const needleW = box * 0.068;
  const angle = -Math.PI / 4;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);

  const put = (i, rgb, a) => {
    // Painter's algorithm over what is already there.
    const inv = 1 - a;
    px[i] = Math.round(rgb[0] * a + px[i] * inv);
    px[i + 1] = Math.round(rgb[1] * a + px[i + 1] * inv);
    px[i + 2] = Math.round(rgb[2] * a + px[i + 2] * inv);
    px[i + 3] = Math.round(255 * a + px[i + 3] * inv);
  };

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const dx = x - cx;
      const dy = y - cy;

      // Rounded-square plate (squircle-ish: superellipse via a corner radius).
      const ax = Math.abs(dx) - (plateR - corner);
      const ay = Math.abs(dy) - (plateR - corner);
      const inPlate = (ax <= 0 || ay <= 0)
        ? (Math.abs(dx) <= plateR && Math.abs(dy) <= plateR)
        : Math.hypot(ax, ay) <= corner;
      if (inPlate) put(i, BG, 1);

      if (!inPlate) continue;

      const r = Math.hypot(dx, dy);
      if (Math.abs(r - ringR) <= ringW / 2) put(i, FG, 1);
      if (r <= hubR) put(i, FG, 1);

      if (needle) {
        const t = Math.max(0, Math.min(needleLen, dx * nx + dy * ny));
        if (Math.hypot(dx - nx * t, dy - ny * t) <= needleW / 2) put(i, ACCENT, 1);
      }
    }
  }

  // Downsample with a box filter.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const cnt = SS * SS;
      const o = (y * size + x) * 4;
      // Un-premultiply so edges do not darken toward black.
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / cnt) * 255);
    }
  }
  return out;
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
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePng(1024, render(1024)));
process.stdout.write('wrote build/icon.png (1024px)\n');

if (process.platform === 'darwin') {
  const iconset = path.join(os.tmpdir(), `posi3-${process.pid}.iconset`);
  fs.mkdirSync(iconset, { recursive: true });
  const entries = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png']
  ];
  for (const [size, name] of entries) {
    fs.writeFileSync(path.join(iconset, name), encodePng(size, render(size, { needle: size > 32 })));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  process.stdout.write('wrote build/icon.icns (10 entries, each rendered at true size)\n');
} else {
  process.stdout.write('skipped icon.icns — needs macOS iconutil\n');
}
