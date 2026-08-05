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
