'use strict';
/**
 * Asking disguise what it is listening on.
 *
 * ICMP says a machine is there and nothing is bound to the port we send to. It
 * cannot say which port *is* bound — and that is the whole answer, so it is
 * worth one question to Designer.
 *
 * These run against a stub HTTP server, never a real machine: the endpoint's own
 * documentation says it must not be polled and is not for use during a show.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { inspectReceivers, SCRIPT } = require('../src/core/disguise-api');

/** A stand-in Designer whose Python endpoint answers however the test wants. */
async function fakeDesigner(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: JSON.parse(body || '{}') });
      handler(req, res);
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => new Promise((r) => server.close(r)));
  return { host: '127.0.0.1', apiPort: port, seen };
}

const ok = (payload) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

test('it asks the documented endpoint, with a script that returns a list', async (t) => {
  const d = await fakeDesigner(t, ok([]));
  await inspectReceivers(d.host, { apiPort: d.apiPort });

  assert.equal(d.seen[0].method, 'POST');
  assert.equal(d.seen[0].url, '/api/session/python/execute');
  assert.ok(d.seen[0].body.script, 'the payload key is `script`');
  assert.match(SCRIPT, /UdpReceiverDriver/, 'it filters on the documented base class');
  assert.match(SCRIPT, /d\.Port/, 'and reads the documented property');
  assert.match(SCRIPT, /^return out$/m, 'the endpoint returns what the script returns');
});

test('the ports it finds are reported', async (t) => {
  const d = await fakeDesigner(t, ok([
    { kind: 'NavigatorDriver', name: 'nav 1', port: 8000, multicastAddress: '', ipFromFilter: '' },
    { kind: 'PosiStageNetDriver', name: 'psn', port: 56565, multicastAddress: '236.10.10.10', ipFromFilter: '' }
  ]));
  const found = await inspectReceivers(d.host, { apiPort: d.apiPort });
  assert.equal(found.length, 2);
  assert.equal(found[0].port, 8000);
});

test('a wrapped return value is unwrapped', async (t) => {
  // The endpoint wraps the script's value and the key has varied by version, so
  // insisting on one shape would break at a venue.
  const d = await fakeDesigner(t, ok({ result: [{ kind: 'NavigatorDriver', name: '', port: 8000 }] }));
  const found = await inspectReceivers(d.host, { apiPort: d.apiPort });
  assert.equal(found[0].port, 8000);
});

test('a machine with no Designer session is named as such', async (t) => {
  // Not "cannot reach disguise": the machine may be perfectly reachable and
  // simply not running Designer, which is a different thing to go and fix.
  await assert.rejects(
    () => inspectReceivers('127.0.0.1', { apiPort: 9, timeoutMs: 800 }),
    (err) => err.code === 'EDISGUISE_UNREACHABLE' && /Designer must be running/.test(err.message));
});

test('an error from Designer is surfaced, not swallowed', async (t) => {
  const d = await fakeDesigner(t, (req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('NameError: state is not defined');
  });
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_API' && /NameError/.test(err.message));
});

test('a session with no receiver at all is not mistaken for a list', async (t) => {
  const d = await fakeDesigner(t, ok({ logging: 'ran fine', result: undefined }));
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_API' && /no receiver list/.test(err.message));
});

test('an older Designer is named as such, not left as a bare 404', async (t) => {
  // Measured on the rig: 10.10.10.4 serves a web page on port 80 and answers
  // JSON 404 for every /api path. "404" on its own invites the reading that the
  // address is wrong, when the address is fine and the software is old.
  const d = await fakeDesigner(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
  });
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_NO_API' &&
      /older than the Python API/.test(err.message) &&
      /not Designer at all/.test(err.message));
});
