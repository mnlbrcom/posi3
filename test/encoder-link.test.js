'use strict';
/**
 * The link's behaviour against a real encoder simulator.
 *
 * `encoder-link.js` is the largest file in the project and had no unit tests —
 * the wire format was covered, but not the things that decide whether a show
 * survives a bad cable: reconnecting, noticing a socket that has gone quiet
 * without closing, and refusing to guess at a field layout it could not read.
 *
 * These drive the actual simulator over a real socket rather than a stub, so
 * the framing, the command channel and the data path are all exercised
 * together — the same combination that breaks in a venue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { EncoderLink } = require('../src/core/encoder-link');
const { STATE } = require('../src/shared/constants');

/** An unused TCP port. Racy in principle, fine for a test run. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The simulator, run as its own process.
 *
 * It is a CLI rather than a library, and spawning it keeps that boundary
 * honest: these tests exercise the same program a person runs with
 * `npm run mock`, over a real socket, rather than an in-process stub that
 * could quietly diverge from it.
 */
async function startMockEncoder(flags = {}) {
  const port = await freePort();
  const args = [path.join(__dirname, '..', 'tools', 'mock-encoder.js'), '--port', String(port), '--quiet'];
  for (const [k, v] of Object.entries(flags)) {
    const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (v === true) args.push(flag);
    else if (v !== false && v !== undefined) args.push(flag, String(v));
  }
  const child = spawn(process.execPath, args, { stdio: 'ignore' });

  // Wait for it to accept connections.
  const deadline = Date.now() + 5000;
  for (;;) {
    if (Date.now() > deadline) { child.kill(); throw new Error('mock encoder did not start'); }
    const up = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  return {
    port,
    close: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); })
  };
}

/** A UDP listener that records what disguise would have received. */
async function sink() {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (b) => seen.push(b.toString('latin1')));
  const port = await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
  return { port, seen, close: () => sock.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, so tests do not depend on fixed sleeps. */
async function until(fn, ms = 4000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function link(encPort, d3Port, extra = {}) {
  return new EncoderLink(Object.assign({
    id: 't', name: 'test',
    encoder: { host: '127.0.0.1', port: encPort },
    destinations: [{ host: '127.0.0.1', port: d3Port, devid: 1 }],
    reconnect: { enabled: true, minDelayMs: 60, maxDelayMs: 200 }
  }, extra));
}

test('streams position through to disguise', async () => {
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant' });
  const out = await sink();
  const l = link(mock.port, out.port);
  l.start();

  await until(() => l.state === STATE.STREAMING, 4000, 'streaming');
  await until(() => out.seen.length >= 10, 4000, 'datagrams');

  for (const d of out.seen) assert.match(d, /^1:\d+,0;\n$/);
  l.stop(); out.close(); await mock.close();
});

test('coalesced and split records survive intact', async () => {
  // The 2016 driver treated one recv() as exactly one sample and lost roughly
  // three quarters of the data at a short cycle time.
  const mock = await startMockEncoder({ cycle: 3, motion: 'constant', coalesce: 4, split: true });
  const out = await sink();
  const l = link(mock.port, out.port);
  l.start();

  await until(() => out.seen.length >= 60, 6000, 'datagrams');
  const malformed = out.seen.filter((d) => !/^1:\d+,0;\n$/.test(d));
  assert.deepEqual(malformed, [], 'every datagram must be well formed');
  assert.equal(l.counters.unknownLines, 0, 'no line should have failed to parse');
  assert.equal(l.counters.rx, l.counters.tx, 'every sample read must be forwarded');

  l.stop(); out.close(); await mock.close();
});

test('reconnects after the encoder drops the connection', async () => {
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant', dropAfter: 20 });
  const out = await sink();
  const l = link(mock.port, out.port);
  l.start();

  await until(() => l.state === STATE.STREAMING, 4000, 'first connect');
  await until(() => l.counters.reconnects >= 1, 6000, 'a reconnect');
  await until(() => l.state === STATE.STREAMING, 6000, 'recovery');

  l.stop(); out.close(); await mock.close();
});

test('a socket that goes quiet without closing is detected and reconnected', async () => {
  // The nastiest failure on site: the TCP session stays open, so nothing looks
  // wrong, but disguise sees a frozen position. Only a watchdog catches it.
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant', stallAfter: 15 });
  const out = await sink();
  const l = link(mock.port, out.port);
  l.start();

  await until(() => l.state === STATE.STREAMING, 4000, 'streaming');
  const stalled = await until(
    () => l.state === STATE.STALLED || l.counters.reconnects >= 1,
    10000, 'the stall to be noticed'
  );
  assert.ok(stalled);

  l.stop(); out.close(); await mock.close();
});

test('a failed connection retries and reports why', async () => {
  const out = await sink();
  // Port 1 is reserved and nothing will be listening on it.
  const l = link(1, out.port);
  const states = [];
  l.on('state', (s) => states.push(s.state));
  l.start();

  await until(() => l._attempt >= 2, 5000, 'a second attempt');
  assert.ok(states.includes(STATE.CONNECTING));
  assert.ok(l._lastError, 'the failure reason must be kept for the UI');

  l.stop(); out.close();
});

test('the field layout is read from the encoder, not guessed', async () => {
  // A two-number ASCII_SHORT line is genuinely ambiguous between "pos vel" and
  // "pos timestamp". Guessing wrong feeds a timestamp to disguise as velocity.
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant', outputmode: 'Position_Timestamp_' });
  const out = await sink();
  const l = link(mock.port, out.port);
  const layouts = [];
  l.on('fieldLayout', (p) => layouts.push(p));
  l.start();

  await until(() => layouts.length > 0, 5000, 'a field layout');
  assert.equal(layouts[0].inferred, false, 'it must be read, not inferred');

  l.stop(); out.close(); await mock.close();
});

test('velocity passthrough forwards the encoder value instead of zero', async () => {
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant', rpm: 60 });
  const out = await sink();
  const l = link(mock.port, out.port, { velocityPolicy: 'passthrough' });
  l.start();

  await until(() => out.seen.length >= 12, 5000, 'datagrams');
  const nonZero = out.seen.filter((d) => !/,0;/.test(d));
  assert.ok(nonZero.length > 0, 'a moving shaft must report a non-zero velocity');

  l.stop(); out.close(); await mock.close();
});

test('stopping leaves no socket and no timer behind', async () => {
  const mock = await startMockEncoder({ cycle: 5, motion: 'constant' });
  const out = await sink();
  const l = link(mock.port, out.port);
  l.start();
  await until(() => l.state === STATE.STREAMING, 4000, 'streaming');

  l.stop();
  assert.equal(l._socket, null);
  assert.equal(l._sinks.length, 0);
  assert.equal(l.state, STATE.IDLE);

  const before = out.seen.length;
  await sleep(150);
  assert.equal(out.seen.length, before, 'nothing may be sent after stop');

  out.close(); await mock.close();
});
