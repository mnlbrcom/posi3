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

test('every operation a view calls exists on the shim', () => {
  // The other half of the seam, and the half that was missing. The shim was
  // checked against the server, so `disguiseInspect` was known to exist — but
  // nothing checked the *views* against the shim, and `inspect` had been added
  // under `mapping` while the Disguise Mapping card called
  // `window.d3d.disguise.inspect`. It threw "Cannot read properties of
  // undefined" the first time a current Designer was available to answer it,
  // which is to say: at a venue, after the thing it diagnoses had gone wrong.
  const views = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) views.push(full);
    }
  };
  walk(path.join(__dirname, '..', 'src', 'web', 'js'));

  const used = new Map(); // "namespace.method" -> the file that calls it
  for (const file of views) {
    if (path.basename(file) === 'api.js') continue;      // the shim itself
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/window\.d3d\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g)) {
      used.set(`${m[1]}.${m[2]}`, path.basename(file));
    }
  }
  assert.ok(used.size > 10, `expected the views to call many operations, found ${used.size}`);

  const missing = [];
  for (const [name, file] of used) {
    const [ns, method] = name.split('.');
    // The namespace, and the method inside it — a namespace that exists with
    // the method missing is the same failure.
    const block = new RegExp(`\\b${ns}:\\s*\\{([\\s\\S]*?)\\n    \\}`).exec(SHIM);
    if (!block || !new RegExp(`\\b${method}\\s*:`).test(block[1])) missing.push(`${name}  (${file})`);
  }
  assert.deepEqual(missing, [],
    `views call operations the shim does not define:\n  ${missing.join('\n  ')}`);
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
