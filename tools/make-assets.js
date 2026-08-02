#!/usr/bin/env node
'use strict';
/**
 * Build-time asset preparation. Dependency-free PNG read/write.
 *
 * The source logos are 1920x1080 with the artwork floating in a large
 * transparent field, which is unusable as a UI element. This crops to the
 * actual ink and writes the trimmed version into the renderer's assets folder.
 *
 *   node tools/make-assets.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const BRANDING = path.join(ROOT, '..', '..', '8 - Branding');
const ASSETS = path.join(ROOT, 'src', 'renderer', 'assets');

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width; let height; let bitDepth; let colorType;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      bitDepth = buf[off + 16];
      colorType = buf[off + 17];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`only 8-bit PNGs are supported (got ${bitDepth})`);

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Write RGBA8 as a PNG with no row filtering. */
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ---------------------------------------------------------------------------

/** Convert any decoded image to RGBA and report the ink bounding box. */
function toRGBA(img) {
  const { width, height, channels, data } = img;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels >= 3) {
      rgba[d] = data[s]; rgba[d + 1] = data[s + 1]; rgba[d + 2] = data[s + 2];
      rgba[d + 3] = channels === 4 ? data[s + 3] : 255;
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = data[s];
      rgba[d + 3] = channels === 2 ? data[s + 1] : 255;
    }
  }
  return rgba;
}

function inkBounds(width, height, rgba, alphaThreshold = 24) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('image is fully transparent');
  return { minX, minY, maxX, maxY };
}

function crop(width, height, rgba, box, pad = 0) {
  const minX = Math.max(0, box.minX - pad);
  const minY = Math.max(0, box.minY - pad);
  const maxX = Math.min(width - 1, box.maxX + pad);
  const maxY = Math.min(height - 1, box.maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    rgba.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return { width: w, height: h, rgba: out };
}

/**
 * Row where the strapline begins: the first sustained run of rows with no
 * light ink after the wordmark's light ink has been seen.
 */
function findStraplineTop(width, height, rgba, gapRows = 5) {
  const lightPerRow = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] < 40) continue;
      if (rgba[o] > 150 && rgba[o + 1] > 150 && rgba[o + 2] > 150) n++;
    }
    lightPerRow[y] = n;
  }

  let seenWordmark = false;
  let run = 0;
  for (let y = 0; y < height; y++) {
    if (lightPerRow[y] > 20) { seenWordmark = true; run = 0; continue; }
    if (!seenWordmark) continue;
    run++;
    if (run >= gapRows) return y - run + 1;
  }
  return height; // no strapline found: leave the image untouched
}

// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  const src = path.join(BRANDING, 'Pixway_Logo_trans_dark.png');
  if (!fs.existsSync(src)) {
    console.error(`[assets] not found: ${src}`);
    process.exit(1);
  }

  const img = decodePNG(src);
  const rgba = toRGBA(img);
  const box = inkBounds(img.width, img.height, rgba);
  console.log(`[assets] source ${img.width}x${img.height}, ink at ` +
    `${box.minX},${box.minY} → ${box.maxX},${box.maxY}`);

  const full = crop(img.width, img.height, rgba, box, 4);
  fs.writeFileSync(path.join(ASSETS, 'pixway-logo.png'),
    encodePNG(full.width, full.height, full.rgba));
  console.log(`[assets] wrote pixway-logo.png (${full.width}x${full.height})`);

  // The wordmark alone, without the strapline: at sidebar width the strapline
  // is only a few pixels tall and reads as grey mush.
  //
  // Colour is not a usable discriminator here — the strapline is #fcfdf9 and
  // the "Pix" is #ffffff, three values apart. But they are vertically
  // separated: the wordmark's light ink stops, there is a clear gap, then the
  // strapline starts. The descender of the "y" runs down past both, and it is
  // magenta, so removing only LIGHT pixels below the gap keeps it intact.
  const cutY = findStraplineTop(full.width, full.height, full.rgba);
  console.log(`[assets] strapline starts below y=${cutY} of ${full.height}`);

  const wordmark = Buffer.from(full.rgba);
  for (let y = cutY; y < full.height; y++) {
    for (let x = 0; x < full.width; x++) {
      const o = (y * full.width + x) * 4;
      const r = wordmark[o]; const g = wordmark[o + 1]; const b = wordmark[o + 2];
      if (r > 150 && g > 150 && b > 150) wordmark[o + 3] = 0;
    }
  }
  const wmBox = inkBounds(full.width, full.height, wordmark, 40);
  const wm = crop(full.width, full.height, wordmark, wmBox, 2);
  fs.writeFileSync(path.join(ASSETS, 'pixway-wordmark.png'),
    encodePNG(wm.width, wm.height, wm.rgba));
  console.log(`[assets] wrote pixway-wordmark.png (${wm.width}x${wm.height})`);
}

main();
