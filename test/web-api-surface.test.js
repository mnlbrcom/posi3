'use strict';
/**
 * The browser shim (`src/web/js/api.js`) names server operations as strings, so
 * a typo is invisible until someone clicks the button in a browser. These tests
 * read the shim's source and check every name it calls actually exists.
 *
 * They also check it against the Electron preload: while both transports exist,
 * a method added to one and not the other produces a screen that works in the
 * desktop window and throws in a browser, or the reverse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApi } = require('../src/server/api');

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'api.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', 'preload.js'), 'utf8');

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

test('the shim exposes the same namespaced surface as the Electron preload', () => {
  // Both files describe the same object literal, so comparing `name:` keys
  // inside each namespace block is enough to catch one drifting from the other.
  const surfaceOf = (src) => {
    const out = {};
    for (const ns of ['config', 'link', 'encoder', 'mapping', 'log', 'events']) {
      const block = new RegExp(`\\b${ns}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(src);
      if (!block) continue;
      out[ns] = new Set([...block[1].matchAll(/^\s{4,}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
    }
    return out;
  };

  const shim = surfaceOf(SHIM);
  const preload = surfaceOf(PRELOAD);

  for (const ns of Object.keys(preload)) {
    const onlyInPreload = [...preload[ns]].filter((k) => !shim[ns] || !shim[ns].has(k));
    assert.deepEqual(
      onlyInPreload, [],
      `window.d3d.${ns} has ${onlyInPreload.join(', ')} in the preload but not in the browser shim`
    );
  }
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
