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

test('a link state change repaints, but never rebuilds', () => {
  // The staged values on an encoder card, a half-edited mapping and the "Ask
  // disguise" answer all live in card closures. Rebuilding the view for a
  // state change threw them away — an encoder quietly reconnecting erased what
  // the operator was typing on a different card. Every view seeds its pill at
  // build time and keeps it live in refreshLive, so state needs no structure.
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf('function onStoreChange'));
  const body = handler.slice(0, handler.indexOf('\n}'));
  assert.match(body, /'linkState'/, 'linkState is handled by the animation loop');
  assert.ok(body.indexOf("'linkState'") < body.indexOf('renderView'),
    'and returns before any rebuild');
});

test('a remembered disguise answer is restored when the card is rebuilt', () => {
  // `lastAsked` existed to survive navigation and was write-only — stored on
  // every ask, read by nothing, so the answer vanished with the closure that
  // held it.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'mapping.js'), 'utf8');
  assert.match(view, /if \(lastAsked\.has\(dest\.id\)\) showAnswer\(lastAsked\.get\(dest\.id\)\)/,
    'the stored answer is rendered at build time');
});

test('a stream reconnect closes its own gap', () => {
  // The event stream only carries lines produced while it is connected, so a
  // reconnect means a hole: lines and config edits from the outage were never
  // sent and never will be. Telemetry heals on the next frame; log and config
  // need re-fetching, and the log is merged by sequence so nothing doubles.
  const shim = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'api.js'), 'utf8');
  assert.match(shim, /everOpened/, 'the first open is not a reconnect');
  assert.match(shim, /onReconnected/, 'later opens are, and are subscribable');

  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'app.js'), 'utf8');
  const hook = app.slice(app.indexOf('onReconnected'));
  const body = hook.slice(0, hook.indexOf('});'));
  assert.match(body, /config\.get\(\)/, 'config is re-fetched');
  assert.match(body, /mergeLog\(/, 'and the log tail is merged, not re-ingested');

  const merge = src.slice(src.indexOf('export function mergeLog'));
  const mbody = merge.slice(0, merge.indexOf('\n}'));
  assert.match(mbody, /line\.seq > newest/, 'only lines newer than the newest held are appended');
  assert.match(mbody, /pausedAtSeq = null/,
    'a restarted bridge resets the freeze point — the frozen stream no longer exists');
});

test('what is keyed by a connection or destination dies with it', () => {
  // Module-scope maps survive rebuilds on purpose; they must not survive the
  // thing they describe. A deleted connection kept its last telemetry frame
  // forever, and a pending flash timer for a deleted encoder would still fire.
  const storeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'store.js'), 'utf8');
  const adopt = storeSrc.slice(storeSrc.indexOf('setProfile('));
  assert.match(adopt.slice(0, adopt.indexOf('\n  }')), /map\.delete\(id\)/,
    'states, telemetry and field layouts follow the profile');

  const cfg = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'encoder-config.js'), 'utf8');
  assert.match(cfg, /clearTimeout\(pendingFlash\.get\(id\)\)/,
    'a deleted encoder\'s flash timer is stopped, not just dropped');

  const map = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'mapping.js'), 'utf8');
  assert.match(map, /lastAsked\.delete\(id\)/, 'stored verdicts follow the destinations');
});
