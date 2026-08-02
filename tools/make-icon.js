#!/usr/bin/env node
'use strict';
/**
 * Renders build/icon.png (1024x1024) using Electron itself as the rasteriser —
 * no image tooling to install.
 *
 * electron-builder derives the .icns and .ico from this single PNG.
 *
 *   npx electron tools/make-icon.js
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 1024;

// The dial is the app: an encoder angle rendered as a ring. Brand magenta on
// Designed to survive 16 px, where this icon is seen most (Finder list,
// Spotlight, the Dock's smaller sizes). Three rules follow from that:
//
//  1. The tile is INSET, not full-bleed. macOS icons occupy roughly 824 of a
//     1024 canvas; a full-bleed tile renders visibly larger and blunter than
//     every neighbouring app.
//  2. Brand magenta is the tile, not a detail on it. A dark plate with a
//     magenta ring turns into a grey smudge against a dark sidebar; a solid
//     magenta tile is identifiable at a glance at any size.
//  3. Few, heavy shapes. Fine tick marks and hairlines average away to mud
//     when downsampled, so there are none.
const BRAND = '#e6007e';
const BRAND_LIGHT = '#ff2f9a';
const BRAND_DARK = '#b8006a';
const INK = '#2b0018';   // needle and hub: dark enough to read on both magenta and white
const PAPER = '#ffffff';

/**
 * @param {boolean} simple drop fine detail for the 16/32 px entries, the way
 *   Apple ships different artwork per size. A needle one pixel wide is noise,
 *   not information.
 */
function svg(simple = false) {
  const C = 512;

  // Apple's macOS tile: ~824/1024 wide, corner radius ~22.4% of the tile.
  const TILE = 824;
  const T0 = (1024 - TILE) / 2;
  const RADIUS = Math.round(TILE * 0.224);

  const rRing = simple ? 226 : 236;
  const ringWidth = simple ? 108 : 78;
  const circumference = 2 * Math.PI * rRing;
  const sweep = 0.72; // a partial arc reads as "in motion"

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${BRAND_LIGHT}"/>
        <stop offset="1" stop-color="${BRAND_DARK}"/>
      </linearGradient>
    </defs>

    <rect x="${T0}" y="${T0}" width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="url(#tile)"/>

    <!-- Unfilled part of the sweep: white held back so the tile still shows. -->
    <circle cx="${C}" cy="${C}" r="${rRing}" fill="none"
            stroke="${PAPER}" stroke-opacity="0.28" stroke-width="${ringWidth}"/>

    <!-- Travelled part of the sweep. -->
    <circle cx="${C}" cy="${C}" r="${rRing}" fill="none"
            stroke="${PAPER}" stroke-width="${ringWidth}" stroke-linecap="round"
            stroke-dasharray="${circumference.toFixed(1)}"
            stroke-dashoffset="${(circumference * (1 - sweep)).toFixed(1)}"
            transform="rotate(-90 ${C} ${C})"/>

    ${simple ? '' : `
    <!-- Needle in ink, so it separates from both the white ring and the tile. -->
    <g transform="rotate(128 ${C} ${C})">
      <path d="M${C - 34} ${C} L${C} ${C - 196} L${C + 34} ${C} Z" fill="${INK}"/>
    </g>
    <circle cx="${C}" cy="${C}" r="46" fill="${INK}"/>`}
  </svg>`;
}

/** Contact sheet so the icon can be judged at the sizes it is actually used. */
function previewPage(iconDataUrl) {
  const sizes = [16, 24, 32, 48, 64, 128];
  const cells = sizes.map((s) => `
    <div class="cell">
      <div class="shade light"><img src="${iconDataUrl}" width="${s}" height="${s}"></div>
      <div class="shade dark"><img src="${iconDataUrl}" width="${s}" height="${s}"></div>
      <span>${s}px</span>
    </div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#5b5b5b;font:12px -apple-system,sans-serif;color:#fff;
         display:flex;align-items:flex-end;gap:22px;padding:26px}
    .cell{display:flex;flex-direction:column;align-items:center;gap:8px}
    .shade{display:flex;align-items:center;justify-content:center;padding:10px;border-radius:6px}
    .light{background:#ececec}.dark{background:#1e1e1e}
    span{opacity:.75}
  </style><body>${cells}</body>`;
}

module.exports = { svg, previewPage };

let sharedWin = null;

/**
 * Render the icon at an exact pixel size.
 *
 * One full-size window is reused and the artwork is drawn into its top-left
 * corner, then captured as a sub-rect. A window actually sized 16x16 fails to
 * load its document at all (ERR_FAILED), so the size cannot come from the
 * window itself.
 */
async function render(px) {
  if (!sharedWin) {
    sharedWin = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true, zoomFactor: 1 }
    });
    await sharedWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
       #host{position:absolute;top:0;left:0}svg{display:block}</style>
       <div id="host"></div>`));
  }

  const markup = svg(px <= 32)
    .replace(`width="${SIZE}" height="${SIZE}"`, `width="${px}" height="${px}"`);

  await sharedWin.webContents.executeJavaScript(
    `document.getElementById('host').innerHTML = ${JSON.stringify(markup)}; true`);
  await new Promise((r) => setTimeout(r, 140));

  const image = await sharedWin.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
  const got = image.getSize();
  if (got.width !== px || got.height !== px) {
    throw new Error(`expected ${px}x${px}, captured ${got.width}x${got.height}`);
  }
  return image.toPNG();
}

/**
 * Entries an .icns needs. Each is rendered from the vector at its true size —
 * not downsampled from 1024 — so hairlines land on whole pixels.
 */
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
];

app.whenReady().then(async () => {
  const buildDir = path.dirname(OUT);
  fs.mkdirSync(buildDir, { recursive: true });

  // 1024 PNG — electron-builder derives the Windows .ico from this.
  const big = await render(SIZE);
  fs.writeFileSync(OUT, big);
  console.log(`[icon] wrote ${OUT} (${SIZE}x${SIZE})`);

  // The .icns must be built by Apple's own tool.
  //
  // electron-builder generates it itself, and its 16 px and 32 px entries come
  // out corrupt — verified by extracting the produced .icns: those two sizes
  // contained neither the magenta tile nor any transparency, just noise, while
  // 128 px and above were correct. Those small entries are exactly what Finder,
  // Spotlight and the menu bar display, which is why the icon looked wrong
  // everywhere except large previews. `iconutil` gets them right.
  if (process.platform === 'darwin') {
    const iconset = path.join(buildDir, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });

    for (const [name, px] of ICONSET) {
      fs.writeFileSync(path.join(iconset, name), px === SIZE ? big : await render(px));
    }

    const icns = path.join(buildDir, 'icon.icns');
    const res = require('node:child_process').spawnSync(
      '/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns], { encoding: 'utf8' });

    if (res.status !== 0) {
      console.error(`[icon] iconutil failed: ${res.stderr || res.error}`);
      process.exitCode = 1;
    } else {
      fs.rmSync(iconset, { recursive: true, force: true });
      console.log(`[icon] wrote ${icns} (${ICONSET.length} entries via iconutil)`);
    }
  } else {
    console.log('[icon] not on macOS — skipped icon.icns');
  }

  const image = { toPNG: () => big, getSize: () => ({ width: SIZE, height: SIZE }) };

  // Contact sheet, so the small sizes get judged rather than assumed.
  if (process.env.ICON_PREVIEW) {
    const dataUrl = 'data:image/png;base64,' + image.toPNG().toString('base64');
    const pv = new BrowserWindow({
      width: 820, height: 300, show: false, webPreferences: { offscreen: true }
    });
    await pv.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(previewPage(dataUrl)));
    await new Promise((r) => setTimeout(r, 400));
    const sheet = await pv.webContents.capturePage();
    fs.writeFileSync(process.env.ICON_PREVIEW, sheet.toPNG());
    console.log(`[icon] wrote preview ${process.env.ICON_PREVIEW}`);
  }

  app.quit();
});
