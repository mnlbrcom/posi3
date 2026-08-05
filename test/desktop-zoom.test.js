'use strict';
/**
 * The desktop window's zoom is bounded: three steps either side of Cmd+0.
 *
 * Each Electron zoom level is ×1.2, so the range is 58%–173%. Past that the
 * UI stops being usable long before it stops being zoomable. The stock menu
 * roles are unbounded, so they are replaced by clamped items on the same
 * accelerators — and because Electron persists the zoom level per origin, an
 * out-of-range level from an earlier run is clamped once at launch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', 'main.js'), 'utf8');

test('the zoom menu items are clamped, not the stock roles', () => {
  assert.doesNotMatch(src, /role: 'zoomIn'/, 'the stock role is unbounded');
  assert.doesNotMatch(src, /role: 'zoomOut'/);
  assert.match(src, /accelerator: 'CmdOrCtrl\+Plus', click: \(\) => stepZoom\(1\)/,
    'zoom in keeps its key and gains the bound');
  assert.match(src, /accelerator: 'CmdOrCtrl\+-', click: \(\) => stepZoom\(-1\)/);
  assert.match(src, /role: 'resetZoom'/, 'Cmd+0 stays stock — zero is inside any bound');
});

test('the bound is three steps each way, and survives a restart', () => {
  assert.match(src, /ZOOM_LEVEL_MIN = -3/);
  assert.match(src, /ZOOM_LEVEL_MAX = 3/);
  const step = src.slice(src.indexOf('function stepZoom'));
  assert.match(step.slice(0, step.indexOf('\n}')),
    /Math\.max\(ZOOM_LEVEL_MIN, Math\.min\(ZOOM_LEVEL_MAX, next\)\)/,
    'every step lands inside the range');
  assert.match(src, /stepZoom\(0\)/,
    'a persisted out-of-range level is clamped at launch — stepZoom(0) is the clamp');
});
