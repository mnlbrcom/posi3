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
  // Every warning the link raises about its destination. Filtered per test —
  // a narrower filter here silently hid the reworded messages when the raw
  // errno was replaced by a diagnosis.
  l.on('log', (e) => { if (e.level === 'warn' || /reachable again/.test(e.text)) warnings.push(e.text); });
  t.after(() => l.stop());
  l.start();

  // Wait for the sink to be *connected*, not merely to exist: _forward skips a
  // sink that is not ready, so a test that runs before then measures nothing.
  const end = Date.now() + 4000;
  while ((!l._sinks.length || !l._sinks[0].ready) && Date.now() < end) await sleep(20);
  assert.ok(l._sinks.length && l._sinks[0].ready, 'the link should have a connected sink');
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
  // `fail()` raises errors with no `code`, so these take the fallback wording.
  const said = warnings.filter((w) => /Cannot reach/.test(w));
  assert.equal(said.length, 1,
    `one warning was due in this window, got ${said.length}: ${said.join(' | ')}`);
  assert.match(said[0], /send EHOSTUNREACH/,
    'an error the app cannot explain keeps its raw message, which is the only place it can be seen');
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

test('sending stops when the destination will not answer, and the link stays up', async (t) => {
  // The question this answers: should we keep firing at a machine that has told
  // us by ICMP that it is not there? No — but the encoder connection must
  // survive it. Its TCP socket accepts only a handful of clients, and with
  // fan-out one dead disguise must not stop the others.
  const { link, sink } = await linkWithSink(t);

  fail(sink, 5);
  assert.equal(sink.offline, false, 'a blip is not an outage');

  // Two seconds of unbroken failure.
  sink.failingSince = Date.now() - 2100;
  fail(sink, 1);
  assert.equal(sink.offline, true, 'sustained failure pauses the destination');

  const before = sink.suppressed;
  for (let i = 0; i < 500; i++) link._forward(i, 0);
  assert.ok(sink.suppressed - before >= 490,
    `packets should be suppressed, not sent: ${sink.suppressed - before} of 500`);

  // This fixture's encoder accepts and says nothing, so the link is connected
  // rather than streaming. What matters is that it is still up.
  assert.ok(link.running, 'the encoder connection must survive a dead destination');
  assert.notEqual(link.snapshot().state, 'idle');
});

test('one probe still goes out while a destination is offline', async (t) => {
  const { link, sink } = await linkWithSink(t);
  sink.failingSince = Date.now() - 2100;
  fail(sink, 1);
  assert.equal(sink.offline, true);

  // Due now rather than in five seconds.
  sink.nextProbeAt = 0;
  const suppressedBefore = sink.suppressed;
  link._forward(1, 0);
  assert.equal(sink.suppressed, suppressedBefore, 'the probe is sent, not suppressed');

  link._forward(2, 0);
  assert.equal(sink.suppressed, suppressedBefore + 1, 'and the next one is suppressed again');
});

test('a destination recovering through the probe path does not crash the process', async (t) => {
  // Reported from the rig after installing a VPN, which changed the routes
  // under a running link:
  //
  //   ReferenceError: dest is not defined
  //     at EncoderLink._forward (encoder-link.js:618)
  //
  // `_forward` announced recovery with `dest`, a name that exists only in the
  // `_openUdp` loop where the *other* call site lives. It is a ReferenceError,
  // not a wrong value, so the branch had plainly never run: every test above
  // drives the sink's callbacks, which is the other path. Uncaught in the main
  // process, it takes the whole bridge down — with the encoder streaming.
  const { link, sink, warnings } = await linkWithSink(t);

  // The state _forward tests for: offline, a probe sent long enough ago, and
  // nothing having objected since it went out.
  sink.offline = true;
  sink.txErrors = 12;
  sink.recovered = false;
  // Straight to the end of a trial that stayed quiet: this test is about the
  // announcement, which is where the ReferenceError was.
  sink.trialUntil = Date.now() - 1;
  sink.lastErrorAt = Date.now() - 30000;

  link._forward(12345, 0);

  assert.equal(sink.offline, false, 'a trial that drew no objection ends the outage');
  const claims = warnings.filter((w) => /reachable again/.test(w));
  assert.equal(claims.length, 1, `expected one recovery claim, got: ${claims.join(' | ')}`);
  assert.match(claims[0], /127\.0\.0\.1:\d+ is reachable again/,
    'and it must name the destination, which is what `dest` was for');
});

test('a probe does not count as recovery while errors keep arriving', async (t) => {
  // From the rig, with the disguise machine's cable pulled: 404 send errors and
  // 4,148 suppressed packets, and the dashboard reading `receiving` throughout.
  //
  // The probe test asked only "did an error arrive in the second after this
  // probe". A pulled cable's ICMP can take longer than that, so the probe looked
  // clean, the sink was declared recovered, the next samples failed, and two
  // seconds later it was offline again — flapping, while the pill claimed the
  // data was arriving.
  const { link, sink, warnings } = await linkWithSink(t);

  sink.offline = true;
  sink.txErrors = 400;
  sink.recovered = false;
  // A probe sent long enough ago, with no error *since* it went out — but an
  // error only a moment before, which is what a failing destination looks like.
  sink.probeSentAt = Date.now() - 1500;
  sink.lastErrorAt = sink.probeSentAt - 10;

  link._forward(1000, 0);

  assert.equal(sink.offline, true,
    'errors were arriving right up to the probe, so this is not recovery');
  assert.deepEqual(warnings.filter((w) => /reachable again/.test(w)), []);

  // Genuinely quiet, and only after a trial that stayed quiet throughout.
  sink.lastErrorAt = Date.now() - 6000;
  sink.probeSentAt = Date.now() - 1500;
  link._forward(1001, 0);
  assert.ok(sink.trialUntil > 0, 'a quiet probe earns a trial, not a verdict');
  assert.equal(sink.offline, true, 'and the outage is not over yet');

  sink.trialUntil = Date.now() - 1;
  link._forward(1002, 0);
  assert.equal(sink.offline, false, 'the trial ran its course quietly — it is back');
  assert.equal(warnings.filter((w) => /reachable again/.test(w)).length, 1);
});

test('a refused port is diagnosed, not just reported', async (t) => {
  // From the rig: "Cannot reach disguise 1 (10.10.10.4:6000): recvmsg
  // ECONNREFUSED. 215 packets lost so far." — with disguise's Navigator driver
  // set to port 8000 while the connection sent to 6000.
  //
  // The message was wrong as well as unhelpful: the machine *was* reached. It
  // answered, saying nothing is listening on that port. That is the one failure
  // here with an exact cause and an exact fix, and "Cannot reach" said the
  // opposite of what had happened.
  const { sink, warnings } = await linkWithSink(t);

  const refused = new Error('recvmsg ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  sink.onError(refused);

  const said = warnings.join(' ');
  assert.match(said, /answered, but nothing is listening on UDP \d+/,
    'it must say the machine answered, and on which port');
  assert.match(said, /Navigator driver/, 'and name what is usually not running');
  assert.match(said, /defaults to 8000/, 'and that the port field defaults elsewhere');
  assert.doesNotMatch(said, /Cannot reach/, 'because it was reached');
  // Neither the running total nor the errno: one is obvious from the fact that
  // a destination is not receiving, the other is the app's own vocabulary and
  // has already been spent on the sentence in front of it.
  assert.doesNotMatch(said, /packets lost/);
  assert.doesNotMatch(said, /\(ECONNREFUSED\)/);
});

test('a machine that is really absent still says so', async (t) => {
  const { sink, warnings } = await linkWithSink(t);
  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';
  sink.onError(down);

  assert.match(warnings.join(' '), /no answer from [\d.]+ at all — switched off, unplugged/,
    'the opposite case must stay distinguishable from a refused port');
});

test('one unobjected probe is not recovery', async (t) => {
  // From the rig, with the disguise machine switched off — every 27 seconds:
  //
  //   15:27:59  no answer from 10.10.10.5 at all
  //   15:28:05  is reachable again after 3,102 lost packets
  //   15:28:09  no answer from 10.10.10.5 at all
  //
  // While offline we send one packet every five seconds, and a host that is off
  // does not refuse every one — once the ARP entry has failed the kernel drops
  // some silently. So "no error since the last probe" was guaranteed by our own
  // silence, not by the machine being back.
  const { link, sink, warnings } = await linkWithSink(t);

  sink.offline = true;
  sink.txErrors = 3000;
  sink.recovered = false;
  sink.probeSentAt = Date.now() - 2000;   // sent, and nothing objected
  sink.lastErrorAt = sink.probeSentAt - 100;

  link._forward(1, 0);
  assert.equal(sink.offline, true, 'one quiet probe must not end the outage');
  assert.ok(sink.trialUntil > 0, 'it starts a trial instead');
  assert.deepEqual(warnings.filter((w) => /reachable again/.test(w)), []);

  // The host is still dead: the next packet of the trial draws an error.
  const dead = new Error('send EHOSTUNREACH');
  dead.code = 'EHOSTUNREACH';
  sink.onError(dead);

  assert.equal(sink.trialUntil, 0, 'the trial is cancelled');
  assert.equal(sink.offline, true, 'and it stays offline');
  assert.deepEqual(warnings.filter((w) => /reachable again/.test(w)), [],
    'with nothing announced — the outage never ended');
});

test('a trial that stays quiet all the way through is recovery', async (t) => {
  const { link, sink, warnings } = await linkWithSink(t);

  sink.offline = true;
  sink.txErrors = 42;
  sink.recovered = false;
  sink.trialUntil = Date.now() - 1;      // the trial has run its course
  sink.lastErrorAt = Date.now() - 30000;

  link._forward(1, 0);

  assert.equal(sink.offline, false, 'every packet went unremarked, so it is back');
  assert.equal(warnings.filter((w) => /reachable again/.test(w)).length, 1);
  assert.match(warnings.find((w) => /reachable again/.test(w)), /after 42 lost packets/);
});
