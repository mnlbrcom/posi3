'use strict';
/**
 * The log console's live-update signal.
 *
 * The view keeps a bounded buffer: `ingestLog` caps it at MAX_RENDERED. That
 * cap means the buffer's *length* stops changing the moment it fills — so a
 * repaint guard comparing lengths goes permanently quiet after 2000 lines,
 * and the console silently freezes for the rest of the session. During an
 * incident that reads as "nothing is being logged", which is the worst
 * possible lie for a log to tell.
 *
 * The only signal that keeps moving is the newest line's sequence number.
 * These tests pin the mechanism at source level, because the view needs a
 * browser to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'log.js'), 'utf8');

test('the buffer is capped, so length cannot be the change signal', () => {
  assert.match(src, /buffer = buffer\.slice\(-MAX_RENDERED\)/,
    'the cap is what makes a length comparison freeze');
  assert.doesNotMatch(src, /buffer\.length === last/,
    'no repaint guard may compare the buffer length to a remembered length');
});

test('the repaint signal is the newest sequence number', () => {
  assert.match(src, /buffer\[buffer\.length - 1\]\.seq/,
    'the guard reads the newest seq, which advances even when the length is pinned');
});

test('no shortcut sits on a browser-owned key, and stop is matched physically', () => {
  // Cmd/Ctrl+Shift+R is the hard reload in Blink and Gecko: bound to Start
  // All, refreshing a misbehaving page engaged every encoder. And a stop
  // shortcut matched by `ev.key === '.'` while requiring Shift is unreachable
  // — Shift turns that key into '>' (US) or ':' (German) before it arrives.
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf('function wireShortcuts'),
    app.indexOf('\n}', app.indexOf('function wireShortcuts')));
  assert.doesNotMatch(handler, /=== 'r'/, 'nothing may bind near the reload key');
  assert.match(handler, /ev\.code === 'Comma'/);
  assert.match(handler, /ev\.code === 'Period'/,
    'physical-key match, so the shortcut works on every layout');
  assert.doesNotMatch(handler, /ev\.key/,
    'ev.key is layout- and Shift-dependent; ev.code is not');

  const desktop = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'desktop', 'main.js'), 'utf8');
  assert.doesNotMatch(desktop, /CmdOrCtrl\+Shift\+R/,
    'the desktop menu answers to the same keys as the web UI');
});
