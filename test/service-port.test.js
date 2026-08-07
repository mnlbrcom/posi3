'use strict';
/**
 * Binding the web UI's port.
 *
 * The desktop app is meant to survive its configured port being taken — by a
 * headless posi3 someone left running, or anything else — by falling back to an
 * ephemeral one. It never did: `const port = opts.port || 8710` turns the 0
 * that means "any free port" into the default, so the fallback retried the very
 * port it had just found busy and the window never opened. The failure was
 * silent because the fatal handler only tried a dialog.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startService } = require('../src/server/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-port-'));

test('port 0 means any free port, not the default', async (t) => {
  const a = await startService({ dataDir: tmp(), port: 0 });
  t.after(() => a.stop());
  const port = a.http.server.address().port;
  assert.ok(port > 0, 'a port must have been assigned');
  assert.notEqual(port, 8710, 'the falsy 0 must not have been replaced by the default');
});

test('the reported URL is the port actually bound', async (t) => {
  const a = await startService({ dataDir: tmp(), port: 0 });
  t.after(() => a.stop());
  const port = a.http.server.address().port;
  assert.equal(a.url, `http://127.0.0.1:${port}`);
  assert.ok(!a.url.endsWith(':0'), 'reporting the request rather than the binding');
  assert.equal(a.api.appInfo().port, port, 'appInfo must agree');
});

test('a taken port rejects with EADDRINUSE so the caller can fall back', async (t) => {
  const first = await startService({ dataDir: tmp(), port: 0 });
  t.after(() => first.stop());
  const taken = first.http.server.address().port;

  await assert.rejects(
    startService({ dataDir: tmp(), port: taken }),
    (err) => {
      assert.equal(err.code, 'EADDRINUSE', 'the desktop fallback keys off this exact code');
      return true;
    }
  );
});

test('the fallback the desktop app performs actually lands elsewhere', async (t) => {
  // The whole sequence: take a port, fail on it, retry with 0, get a different
  // one. This is what did not work.
  const first = await startService({ dataDir: tmp(), port: 0 });
  t.after(() => first.stop());
  const taken = first.http.server.address().port;

  let fallback = null;
  try {
    await startService({ dataDir: tmp(), port: taken });
    assert.fail('the second bind should have been refused');
  } catch (err) {
    assert.equal(err.code, 'EADDRINUSE');
    fallback = await startService({ dataDir: tmp(), port: 0 });
  }
  t.after(() => fallback.stop());

  assert.notEqual(fallback.http.server.address().port, taken);
  assert.notEqual(fallback.url, first.url);
});

test('an explicit port is still honoured', async (t) => {
  const probe = await startService({ dataDir: tmp(), port: 0 });
  const free = probe.http.server.address().port;
  await probe.stop();

  const a = await startService({ dataDir: tmp(), port: free });
  t.after(() => a.stop());
  assert.equal(a.http.server.address().port, free);
});

test('with a token, every shared URL carries it — window, lock, and guard agree', async (t) => {
  // Bound beyond loopback the service always generates a token and the guard
  // checks it on static files too. The desktop window loaded the bare URL and
  // rendered its own 401; the "already running — open it" dialog launched the
  // lock's bare URL into a browser with the same result.
  const dir = tmp();
  const svc = await startService({ dataDir: dir, port: 0, token: 'secret-t' });
  t.after(() => svc.stop());

  const bare = await fetch(svc.url);
  assert.equal(bare.status, 401, 'the bare URL is exactly what a window must not load');
  const tokened = await fetch(`${svc.url}/?token=secret-t`);
  assert.equal(tokened.status, 200, 'the tokened form is the one that opens');

  const lock = JSON.parse(
    fs.readFileSync(path.join(dir, require('../src/core/instance-lock').LOCK_FILE), 'utf8'));
  assert.match(lock.url, /token=secret-t/,
    'the lock exists to be opened by a second instance, so it carries the token');

  const desktop = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'desktop', 'main.js'), 'utf8');
  // The window loads loopback — with a wide bind, svc.url is a LAN address
  // the password guards, and the app would have locked itself out — but it
  // still presents an explicit token, which outranks loopback by design.
  assert.match(desktop, /mainWindow\.loadURL\(windowUrl\(\)\)/);
  const fn = desktop.slice(desktop.indexOf('function windowUrl'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /127\.0\.0\.1/, 'the window is always local');
  assert.match(body, /svc\.token/, 'and carries a token when one was demanded');
});
