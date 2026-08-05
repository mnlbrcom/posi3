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

  // Already failing for longer than the give-up window, so the first error in
  // the loop takes it offline and says so once. The successes scattered through
  // are what a host that is off actually looks like — the odd datagram slipping
  // between ARP retries — and they must not reopen the announcement.
  sink.failingSince = Date.now() - 5000;
  for (let round = 0; round < 40; round++) {
    fail(sink, 25);
    sink.onSent();
  }

  // One message for the outage, and no more inside this window: the backoff
  // starts at 15s. `fail()` raises errors with no `code`, so the cause falls
  // back to "not answering".
  const said = warnings.filter((w) => /Sends paused/.test(w));
  assert.equal(said.length, 1,
    `one warning was due in this window, got ${said.length}: ${said.join(' | ')}`);
  assert.match(said[0], /not answering/);
});

test('a destination that really comes back is announced', async (t) => {
  const { sink, warnings } = await linkWithSink(t);
  fail(sink, 10);

  // Sends land, and keep landing, for longer than the quiet period. Wound back
  // rather than waited out: the window is thirty seconds, because that is how
  // long a switched-off host can stay silent while sending at the full rate.
  sink.lastErrorAt = Date.now() - 31000;
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

test('a trial that stays quiet resumes sending without claiming a recovery', async (t) => {
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

  assert.equal(sink.offline, false, 'sending resumes');
  assert.deepEqual(warnings.filter((w) => /reachable again/.test(w)), [],
    'but nothing is claimed: three seconds of quiet is not proof a host is back, ' +
    'and this exact trial passed three times in ninety seconds against a machine that was off');

  // The claim belongs to ordinary traffic staying clean, which is onSent's job.
  sink.lastErrorAt = Date.now() - 30000;
  sink.onSent();
  assert.equal(warnings.filter((w) => /reachable again/.test(w)).length, 1,
    'a real recovery is still announced, by the path that can see real traffic');
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
  assert.equal(sink.offline, false, 'the trial ran its course quietly, so sending resumes');
  assert.deepEqual(warnings.filter((w) => /reachable again/.test(w)), [],
    'without announcing anything on the strength of silence alone');
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
  // Past the give-up window: nothing is said about a failure that might still
  // clear, so the diagnosis arrives with the decision to pause sends.
  sink.failingSince = Date.now() - 5000;
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
  sink.failingSince = Date.now() - 5000;
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
  assert.equal(sink.offline, false, 'every packet went unremarked, so sending resumes');

  // And only then, once ordinary traffic has stayed clean, is it announced.
  sink.onSent();
  assert.equal(warnings.filter((w) => /reachable again/.test(w)).length, 1);
  assert.match(warnings.find((w) => /reachable again/.test(w)), /after 42 lost packets/);
});

test('going offline is said once, with its cause', async (t) => {
  // "no answer from 10.10.10.5 at all" and "is not answering — pausing sends"
  // are the same fact two seconds apart: going offline *is* the diagnosis. One
  // sentence carries the cause and what follows from it.
  const { sink, warnings } = await linkWithSink(t);

  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';
  sink.onError(down);
  sink.failingSince = Date.now() - 5000;   // long enough to give up
  sink.onError(down);

  const offlineLines = warnings.filter((w) => /Sends paused/.test(w));
  assert.equal(offlineLines.length, 1, 'once, not twice');
  assert.match(offlineLines[0], /no answer from [\d.]+ at all/, 'with the cause in it');
  assert.match(offlineLines[0], /retrying every 5s/, 'and what happens next');
  assert.deepEqual(warnings.filter((w) => /is not answering —/.test(w)), [],
    'and not also as a separate line saying the same thing');
});

test('going offline says one thing, and the banner and the log say the same thing', async (t) => {
  // The banner and the log line were built in different places with different
  // words. The banner claimed "is offline — sends paused, retrying every 5s"
  // and no log line ever carried those words, so the one message an operator
  // was interrupted by left no trace in the record — against the rule that
  // anything worth a banner is worth a log line.
  const { link, sink } = await linkWithSink(t);
  const logged = [];
  const bannered = [];
  link.on('log', (e) => { if (e.level === 'warn') logged.push(e.text); });
  link.on('encoderEvent', (e) => { if (e.kind === 'destinationDown') bannered.push(e.text); });

  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';
  sink.onError(down);
  // Inside the give-up window nothing is said: a failure that clears in two
  // seconds is a blip, and a banner for something already over is noise.
  assert.deepEqual(bannered, [], 'no banner before we have given up');
  assert.deepEqual(logged, [], 'and nothing logged either');

  sink.failingSince = Date.now() - 5000;
  sink.onError(down);

  assert.equal(bannered.length, 1, 'one banner for the outage');
  assert.equal(logged.length, 1, 'and one log line');
  assert.equal(bannered[0], logged[0], 'and they are the same sentence');
  assert.match(bannered[0], /no answer from [\d.]+ at all/);
  assert.match(bannered[0], /retrying every 5s/);
});

test('a continuing outage says how long, not how often it retries', async (t) => {
  // "retrying every 5s" was repeated on a backoff that fires at 15s, 60s, 240s —
  // so the message described a cadence that did not match when it appeared. The
  // retry interval is in the first message and has not changed; what is new is
  // how long this has been going on.
  const { link, sink } = await linkWithSink(t);
  const warns = [];
  link.on('log', (e) => { if (e.level === 'warn') warns.push(e.text); });

  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';
  sink.failingSince = Date.now() - 40000;
  sink.onError(down);              // goes offline, one message
  warns.length = 0;

  sink.nextWarnAt = 0;             // the backoff comes due
  sink.onError(down);

  assert.equal(warns.length, 1);
  assert.match(warns[0], /still not answering after \d+s/);
  assert.doesNotMatch(warns[0], /retrying every/,
    'the cadence is not restated on a schedule that does not match it');
});

test('an outage is announced once, however many times sending is retried', async (t) => {
  // Sending resumes every few seconds to test whether the host is back, so the
  // sink goes offline again each time it fails — the *same* outage continuing.
  // It was announced identically each time, twelve seconds apart, for a machine
  // that had never come back.
  const { link, sink } = await linkWithSink(t);
  const said = [];
  link.on('log', (e) => { if (/Sends paused/.test(e.text)) said.push(e.text); });

  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';

  for (let cycle = 0; cycle < 4; cycle++) {
    sink.failingSince = Date.now() - 5000;
    sink.onError(down);                 // fails, goes offline
    assert.equal(sink.offline, true);
    sink.offline = false;               // a trial resumes sending, as it does
  }

  assert.equal(said.length, 1, `one announcement for one outage, got ${said.length}`);

  // A genuine recovery makes the next outage news again.
  sink.lastErrorAt = Date.now() - 31000;
  sink.onSent();
  sink.failingSince = Date.now() - 5000;
  sink.onError(down);
  assert.equal(said.length, 2, 'a new outage is announced');
});

test('an outage does not get younger, and its cause is not restated', async (t) => {
  // "still not answering after 17s", then a minute later "after 7s" — the
  // elapsed time was measured from `failingSince`, which restarts every time a
  // trial resumes sending and fails again. And the cause was repeated in full
  // each time, which is the first message over again.
  const { link, sink } = await linkWithSink(t);
  const warns = [];
  link.on('log', (e) => { if (e.level === 'warn') warns.push(e.text); });

  const down = new Error('send EHOSTUNREACH');
  down.code = 'EHOSTUNREACH';
  sink.failingSince = Date.now() - 5000;
  sink.onError(down);                       // outage begins, announced once
  sink.outageSince = Date.now() - 90000;    // an outage an hour into a show
  warns.length = 0;

  // A trial resumed and failed again, so the current run is seconds old.
  sink.offline = false;
  sink.failingSince = Date.now() - 3000;
  sink.nextWarnAt = 0;
  sink.onError(down);

  const followUp = warns.find((w) => /still not answering/.test(w));
  assert.ok(followUp, 'the outage is restated on the backoff');
  assert.match(followUp, /after 90s/, 'measured from when the outage began');
  assert.doesNotMatch(followUp, /switched off, unplugged/,
    'without repeating a cause that has not changed');

  // A cause that does change is worth saying.
  warns.length = 0;
  const refused = new Error('recvmsg ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  sink.offline = true;
  sink.nextWarnAt = 0;
  sink.onError(refused);
  assert.match(warns.join(' '), /Now: .*nothing is listening/,
    'a host that starts refusing the port instead is news');
});
