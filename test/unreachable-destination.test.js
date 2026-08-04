'use strict';
/**
 * What a dead disguise machine should sound like.
 *
 * A destination that is switched off does not fail cleanly: the odd datagram
 * slips through between ARP retries, so the sink sees a stream of errors with
 * occasional successes scattered through it. Treating any one of those as
 * recovery reset the warning backoff, which is how a disguise machine being off
 * for three hours produced **1,294 log lines and 440 "reachable again" claims**
 * where the backoff was designed to produce about fifteen.
 *
 * These drive the sink's own error and success callbacks rather than a real
 * socket, because the behaviour under test is the announcement policy, not the
 * networking.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');

const { EncoderLink } = require('../src/core/encoder-link');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A link with one destination, started against a silent encoder. */
async function linkWithSink(t) {
  const server = net.createServer(() => { /* accept and say nothing */ });
  const encPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => server.close());

  const sock = dgram.createSocket('udp4');
  const d3 = await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
  t.after(() => { try { sock.close(); } catch { /* closed */ } });

  const warnings = [];
  const l = new EncoderLink({
    id: 't', name: 'test',
    encoder: { host: '127.0.0.1', port: encPort },
    destinations: [{ host: '127.0.0.1', port: d3, devid: 1 }],
    reconnect: { enabled: false }
  });
  l.on('log', (e) => { if (/Cannot reach|reachable again/.test(e.text)) warnings.push(e.text); });
  t.after(() => l.stop());
  l.start();

  // Wait for the UDP sinks to exist.
  const end = Date.now() + 4000;
  while (!l._sinks.length && Date.now() < end) await sleep(20);
  assert.ok(l._sinks.length, 'the link should have opened a sink');
  return { link: l, sink: l._sinks[0], warnings };
}

const fail = (sink, n = 1) => {
  for (let i = 0; i < n; i++) sink.onError(new Error('send EHOSTUNREACH'));
};

test('a lone success between failures is not recovery', async (t) => {
  const { sink, warnings } = await linkWithSink(t);

  // The shape of a host that is off: mostly errors, the occasional one landing.
  for (let round = 0; round < 40; round++) {
    fail(sink, 25);
    sink.onSent();
  }

  const claims = warnings.filter((w) => /reachable again/.test(w));
  assert.equal(claims.length, 0, `no recovery should be claimed, got: ${claims.join(' | ')}`);
});

test('the warning backoff survives that flapping', async (t) => {
  const { sink, warnings } = await linkWithSink(t);

  for (let round = 0; round < 40; round++) {
    fail(sink, 25);
    sink.onSent();
  }

  // 0s then 15s: inside one test run only the first warning is due.
  const said = warnings.filter((w) => /Cannot reach/.test(w));
  assert.equal(said.length, 1,
    `one warning was due in this window, got ${said.length}: ${said.join(' | ')}`);
  assert.match(said[0], /packets lost so far/);
});

test('a destination that really comes back is announced', async (t) => {
  const { sink, warnings } = await linkWithSink(t);
  fail(sink, 10);

  // Sends land, and keep landing, for longer than the quiet period.
  await sleep(3200);
  sink.onSent();

  const claims = warnings.filter((w) => /reachable again/.test(w));
  assert.equal(claims.length, 1, 'a genuine recovery must still be reported');
  assert.match(claims[0], /after 10 lost packets/);
});
