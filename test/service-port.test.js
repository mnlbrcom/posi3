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
