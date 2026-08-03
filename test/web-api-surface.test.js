'use strict';
/**
 * The browser shim (`src/web/js/api.js`) names server operations as strings, so
 * a typo is invisible until someone clicks the button in a browser. These tests
 * read the shim's source and check every name it calls actually exists.
 *
 * There used to be a second test here comparing the shim against the Electron
 * preload, to stop the two transports drifting. The preload is gone — the
 * desktop window now loads the same web UI over HTTP — so there is only one
 * transport left to be wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApi } = require('../src/server/api');

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'api.js'), 'utf8');

/** A stub context — we only need the shape of what createApi returns. */
function apiNames() {
  const api = createApi({
    manager: { logger: { tail: () => [] }, get: () => null, ids: () => [], setTelemetryHz() {} },
    store: { profile: {}, connections: [], settings: {} },
    syncLink: () => {},
    env: () => ({})
  });
  return new Set(Object.keys(api));
}

/** Every `call('name'` in the shim. */
function calledNames() {
  return [...SHIM.matchAll(/\bcall\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
}

test('every operation the browser shim calls exists on the server', () => {
  const available = apiNames();
  const called = calledNames();
  assert.ok(called.length > 15, `expected the shim to call many operations, found ${called.length}`);
  const missing = [...new Set(called)].filter((n) => !available.has(n));
  assert.deepEqual(missing, [], `shim calls operations the server does not expose: ${missing.join(', ')}`);
});

test('the shim never sends the token in a URL it leaves behind', () => {
  // A token in the address bar gets pasted into tickets and chat messages, so
  // the shim moves it to sessionStorage and rewrites the URL. Guard the intent.
  assert.match(SHIM, /sessionStorage\.setItem\('posi3\.token'/);
  assert.match(SHIM, /searchParams\.delete\('token'\)/);
  assert.match(SHIM, /history\.replaceState/);
});

test('the served page allows the UI to reach its own API', () => {
  // connect-src 'none' shipped in the packaged app: correct for a file://
  // renderer on IPC, fatal for one that must fetch.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.html'), 'utf8');
  assert.ok(!/connect-src 'none'/.test(html), "index.html still blocks fetch with connect-src 'none'");
  assert.match(html, /connect-src 'self'/);
});

test('the CSP served over HTTP also forbids framing', () => {
  const { SECURITY_HEADERS } = require('../src/server/security');
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /connect-src 'self'/);
});

test('the desktop window has no second transport to drift from', () => {
  // The preload and IPC layer were removed when the window moved onto HTTP.
  // If either comes back, the single-codebase guarantee is gone and the
  // surface-comparison test that used to live here has to come back with it.
  for (const gone of ['preload.js', 'ipc.js']) {
    assert.ok(
      !fs.existsSync(path.join(__dirname, '..', 'src', 'desktop', gone)),
      `src/desktop/${gone} is back — restore the preload/shim surface comparison`
    );
  }
});
