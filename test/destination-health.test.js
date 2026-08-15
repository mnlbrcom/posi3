'use strict';
/**
 * How an unreachable destination is reported.
 *
 * A dead destination fails once per sample. At 125 Hz a "warn every 500
 * errors" rule shouts every four seconds, for as long as it stays dead, about
 * a situation that has not changed — which buries anything that has. The user
 * saw exactly that: "LOTS of errors ... failed (3000x)".
 *
 * The rule is: say it once, then back off, and say when it comes back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { EncoderLink } = require('../src/core/encoder-link');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A link pointed at a port with nothing listening. */
async function deadLink(t) {
  // Bind and immediately release, so the port is almost certainly free and
  // sends to it draw ICMP port-unreachable.
  const probe = dgram.createSocket('udp4');
  const port = await new Promise((r) => probe.bind(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));

  const l = new EncoderLink({
    id: 't', name: 't',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations: [{ name: 'gone', host: '127.0.0.1', port, devid: 1 }]
  });
  t.after(() => l.stop());
  l._openUdp();
  await until(() => l._sinks.every((s) => s.ready), 3000, 'the socket to connect');
  return { link: l, port };
}

/**
 * Force a sink's sends to fail with a real error code, deterministically.
 *
 * A closed loopback port draws ICMP port-unreachable on Linux, but the macOS
 * and Windows runners deliver it slowly or not at all — so a test that waits
 * for send errors to pile up ('timed out waiting for failures to accumulate')
 * is flaky there. This drives the exact same error path the socket would,
 * without depending on the platform's ICMP behaviour.
 */
function forceSendFailure(link, code = 'ECONNREFUSED') {
  for (const sink of link._sinks) {
    sink.udp.send = (buf, off, len, cb) => {
      if (typeof cb === 'function') cb(Object.assign(new Error(`send ${code}`), { code }));
    };
  }
}

test('a persistent failure is announced once, not on every packet', async (t) => {
  const { link } = await deadLink(t);
  forceSendFailure(link); // platform-independent: see forceSendFailure
  const warnings = [];
  link.on('log', (e) => { if (e.level === 'warn') warnings.push(e.text); });

  // Kept going past SEND_GIVE_UP_MS: nothing is said before we have given up,
  // because a failure that clears inside two seconds is a blip.
  const end = Date.now() + 2600;
  while (Date.now() < end) { for (let i = 0; i < 60; i++) link._forward(i, 0); await sleep(20); }
  await until(() => link._sinks[0].txErrors > 400, 4000, 'failures to accumulate');

  assert.ok(link._sinks[0].txErrors > 400, 'the failures must still be counted');
  assert.equal(warnings.length, 1,
    `a steady failure should be said once, not ${warnings.length} times`);
});

test('the warning names the destination and what is wrong', async (t) => {
  const { link } = await deadLink(t);
  const warnings = [];
  link.on('log', (e) => { if (e.level === 'warn') warnings.push(e.text); });

  // Long enough to give up on it: before that, a failure is a blip and says
  // nothing.
  const stop = Date.now() + 3000;
  while (Date.now() < stop && !warnings.length) {
    for (let i = 0; i < 20; i++) link._forward(i, 0);
    await sleep(20);
  }
  await until(() => warnings.length > 0, 2000, 'a warning');

  // The name, not a particular sentence around it: the wording changed when the
  // raw errno was replaced by a diagnosis, and a test pinned to the phrasing
  // fails for the message getting better.
  assert.match(warnings[0], /\bgone\b/, 'the destination must be named');
  // What is wrong, not how many packets: the count is on the dashboard, and a
  // destination that is not receiving is losing them by definition.
  assert.match(warnings[0], /nothing is listening|no answer at all|no route to it/,
    'the cause must be stated');
});

test('coming back is news too', async (t) => {
  const { link, port } = await deadLink(t);
  const events = [];
  link.on('encoderEvent', (e) => events.push(e.kind));

  for (let i = 0; i < 50; i++) link._forward(i, 0);
  await until(() => link._sinks[0].txErrors > 0, 4000, 'a failure');

  // Something starts listening again.
  const back = dgram.createSocket('udp4');
  await new Promise((r) => back.bind(port, '127.0.0.1', r));
  t.after(() => { try { back.close(); } catch { /* already closed */ } });

  // Sends have to keep landing for a while before this counts as recovery. A
  // host that is off still passes the odd datagram between ARP retries, and
  // announcing on the first success reset the warning backoff every time —
  // 440 false recoveries from one disguise machine left off for three hours.
  for (let i = 0; i < 40; i++) { link._forward(i, 0); await sleep(10); }
  assert.ok(!events.includes('destinationUp'),
    'half a second of success is not yet recovery');

  // The window is thirty seconds — long enough to outlast the silence a
  // switched-off host can produce at the full send rate. Wound back rather than
  // waited out.
  link._sinks[0].lastErrorAt = Date.now() - 31000;
  for (let i = 0; i < 10; i++) { link._forward(i, 0); await sleep(10); }
  await until(() => events.includes('destinationUp'), 4000, 'the recovery notice');
  assert.ok(events.includes('destinationUp'));
});

test('a second outage is announced again', async (t) => {
  const { link } = await deadLink(t);
  const sink = link._sinks[0];
  // Simulate the first outage having been announced and recovered.
  sink.txErrors = 10;
  sink.recovered = true;
  sink.onError(new Error('ECONNREFUSED'));
  assert.equal(sink.recovered, false,
    'a fresh failure must re-arm the recovery notice, or the second recovery is silent');
});

test('a destination is not called connected until the silence has lasted', async (t) => {
  // The pill read straight off `sink.offline`, so it flipped green for the
  // second or two between a trial resuming sends and the next error arriving —
  // the same false claim the log had just stopped making, in the one place an
  // operator actually watches.
  const { link } = await deadLink(t);
  const sink = link._sinks[0];

  for (let i = 0; i < 50; i++) link._forward(i, 0);
  await until(() => sink.txErrors > 0, 4000, 'a failure');
  // A stopped link reports `idle` for every destination, which would pass this
  // test without testing anything.
  link._state = 'streaming';

  // Sends resumed — as a trial does — but the last error is seconds old.
  sink.offline = false;
  sink.lastErrorAt = Date.now() - 2000;
  let d = link.snapshot().telemetry.destinations[0];
  assert.notEqual(d.health, 'connected',
    'two seconds of quiet from a host that was just failing proves nothing');

  // Quiet for longer than the recovery window: now it counts.
  sink.lastErrorAt = Date.now() - 31000;
  d = link.snapshot().telemetry.destinations[0];
  assert.equal(d.health, 'connected',
    'and `connected` is as far as it goes — the network cannot say more');
});

test('connected is not receiving, and only disguise can say otherwise', async (t) => {
  // From the rig: the "US" destination is a laptop, not a disguise server. The
  // packets leave, nothing objects, and nothing whatsoever is receiving them.
  // `connected` is the truthful word for that; `receiving` is a claim only a
  // disguise session can support.
  const { link } = await deadLink(t);
  const manager = new (require('../src/core/link-manager').LinkManager)({ logger: { push() {} } });
  const sink = link._sinks[0];
  link._state = 'streaming';
  sink.txErrors = 0;
  // Data is actually flowing: with nothing sent, silence proves nothing and
  // the handshake answers instead — that case has its own tests below.
  sink.lastTxAt = Date.now();

  const health = () => link.snapshot().telemetry.destinations[0].health;
  assert.equal(health(), 'connected', 'the network alone can never say more than this');

  // With an answer, the manager raises or lowers it — and only with one.
  const t1 = link.telemetry();
  const destId = t1.destinations[0].id;

  manager.disguiseChecks.set(destId, { matches: true, at: Date.now() });
  const raised = { destinations: [{ id: destId, health: 'connected', sending: true }] };
  for (const d of raised.destinations) {
    const c = manager.disguiseChecks.get(d.id);
    if (c && d.health === 'connected') d.health = c.matches ? 'receiving' : 'mismatch';
  }
  assert.equal(raised.destinations[0].health, 'receiving');

  manager.disguiseChecks.set(destId, { matches: false, at: Date.now() });
  const lowered = { destinations: [{ id: destId, health: 'connected' }] };
  for (const d of lowered.destinations) {
    const c = manager.disguiseChecks.get(d.id);
    if (c && d.health === 'connected') d.health = c.matches ? 'receiving' : 'mismatch';
  }
  assert.equal(lowered.destinations[0].health, 'mismatch');
});

// ---------------------------------------------------------------------------
// Getting back
// ---------------------------------------------------------------------------

const { hostProvenBack } = require('../src/core/encoder-link');

/** A sink with only the fields the recovery rule reads. */
function sink(over) {
  return Object.assign({ txErrors: 0, lastErrorAt: 0, aliveAt: 0 }, over);
}

test('a host proven alive by TCP does not also have to wait out the silence', () => {
  // The reported delay: a cable was replugged, disguise was visibly receiving
  // for seconds, and the indicator stayed offline. Silence was the only
  // evidence UDP could offer, so thirty seconds of it was the bar — and every
  // recovery paid it, including the ones that were obviously over.
  const now = Date.now();

  assert.equal(hostProvenBack(sink()), true,
    'a destination that has never failed is not recovering from anything');

  assert.equal(hostProvenBack(sink({ txErrors: 5, lastErrorAt: now - 1000, aliveAt: now - 200 })), true,
    'the machine answered TCP after the last error — that settles it');

  assert.equal(hostProvenBack(sink({ txErrors: 5, lastErrorAt: now - 1000, aliveAt: now - 4000 })), false,
    'proof older than the error proves nothing about now');

  assert.equal(hostProvenBack(sink({ txErrors: 5, lastErrorAt: now - 1000 })), false,
    'and with no proof at all, one second of quiet is still just one second');

  assert.equal(hostProvenBack(sink({ txErrors: 5, lastErrorAt: now - 31000 })), true,
    'the silence rule still carries it when TCP cannot answer — a firewall that ' +
    'drops everything degrades to the old behaviour, not to a wrong answer');
});

test('an answered ping counts as proof of life, an unanswered one does not', async (t) => {
  // Ping, deliberately, and nothing closer: the TCP version of this probe
  // knocked on the destination's own port and a live Designer popped
  // "Error 0x2740" at the operator. ICMP touches no port.
  const prev = EncoderLink.pingRunner;
  EncoderLink.pingRunner = (host, onDone) => {
    const timer = setTimeout(() => onDone(!host.startsWith('192.0.2.')), 15);
    return { kill: () => clearTimeout(timer) };
  };
  t.after(() => { EncoderLink.pingRunner = prev; });
  const link = new EncoderLink({
    id: 'alive', name: 'alive',
    // Never a real encoder address: this link is never started, but a fixture
    // that could reach hardware has cost flash writes here before.
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd', host: '127.0.0.1', port: 65533 }]
  });
  t.after(() => link.stop());

  const here = sink({ dest: { host: '127.0.0.1', port: 65533 } });
  link._probeHostAlive(here);
  await until(() => here.aliveAt > 0, 4000, 'loopback to answer');

  // 192.0.2.0/24 is TEST-NET-1, reserved by RFC 5737 and routed nowhere.
  const gone = sink({ dest: { host: '192.0.2.1', port: 6000 } });
  link._probeHostAlive(gone);
  await sleep(2200);
  assert.equal(gone.aliveAt, 0, 'nothing answered, so nothing is claimed');
  assert.equal(gone.aliveProbe, null, 'and the attempt was cleaned up');
});

test('a sink that never opened reports the outage instead of clean silence', async (t) => {
  // A hostname that does not resolve, a local address that is not ours: the
  // socket never becomes ready, so nothing is ever sent — and the silence
  // rule read that as health. One setup error, no sends, no further errors,
  // and the pill said `connected` for a destination that could not physically
  // receive a packet.
  const link = new EncoderLink({
    id: 'setup', name: 'setup',
    encoder: { host: '127.0.0.1', port: 65534 },
    // TEST-NET-1: never a local interface, so the bind fails on this machine
    // without a packet leaving it.
    destinations: [{ id: 'd', name: 'dead', host: '127.0.0.1', port: 65533, localAddress: '192.0.2.1', devid: 1 }]
  });
  t.after(() => link.stop());

  const events = [];
  link.on('encoderEvent', (e) => events.push(e));
  link._openUdp();

  const sink = link._sinks[0];
  await until(() => sink.offline, 3000, 'the setup failure to mark the sink offline');
  assert.equal(sink.ready, false, 'the socket never opened');
  assert.equal(sink.downAnnounced, true, 'and the outage was announced');

  const down = events.find((e) => e.kind === 'destinationDown');
  assert.ok(down, 'the announcement reached the event stream');
  assert.match(down.text, /restart the connection/i,
    'and tells the operator the one action that retries a failed setup');
});

test('a recovery announcement counts this outage, not the whole run', async (t) => {
  // `txErrors` is cumulative for the run and the announcement used it raw, so
  // a second outage said "reachable again after 1265 lost packets" when it
  // had lost a fraction of them — seen verbatim on the rig.
  const link = new EncoderLink({
    id: 'count', name: 'count',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd', name: 'dest', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
  t.after(() => link.stop());
  const lines = [];
  link.on('log', (l) => lines.push(l.text));
  link._openUdp();
  await until(() => link._sinks[0] && link._sinks[0].ready, 3000, 'sink ready');
  const sink = link._sinks[0];
  const err = Object.assign(new Error('sendmsg EHOSTUNREACH'), { code: 'EHOSTUNREACH' });

  // First outage: four errors over more than the give-up window.
  for (let i = 0; i < 3; i++) sink.onError(err);
  sink.failingSince = Date.now() - 3000;
  sink.onError(err);
  assert.equal(sink.offline, true);
  link._announceRecovery(sink, sink.dest);
  assert.match(lines[lines.length - 1], /after 4 lost packets/);

  // Second outage: three more. The count restarts; the total does not.
  sink.offline = false;
  sink.failingSince = 0;
  for (let i = 0; i < 2; i++) sink.onError(err);
  sink.failingSince = Date.now() - 3000;
  sink.onError(err);
  link._announceRecovery(sink, sink.dest);
  assert.match(lines[lines.length - 1], /after 3 lost packets/,
    'this outage lost three, however many the run has lost');
  assert.equal(sink.txErrors, 7, 'while the cumulative counter keeps the run total');
});

test('with nothing sent, the ping decides — silence is not evidence', async (t) => {
  const prev = EncoderLink.pingRunner;
  EncoderLink.pingRunner = (host, onDone) => {
    const timer = setTimeout(() => onDone(!host.startsWith('192.0.2.')), 15);
    return { kill: () => clearTimeout(timer) };
  };
  t.after(() => { EncoderLink.pingRunner = prev; });
  // The reported case: encoder unplugged, so no samples and no datagrams —
  // and the unplugged destination wore `connected` on zero evidence, because
  // send errors only ever answer a packet nobody was sending.
  const link = new EncoderLink({
    id: 'quiet', name: 'quiet',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [
      // TEST-NET-1: unroutable, so the handshake fails without a packet
      // leaving the machine.
      { id: 'gone', name: 'gone', host: '192.0.2.1', port: 6000, devid: 1 },
      // Loopback: this machine is up and answers its own ping —
      // "US is connected but not receiving; it is this laptop".
      { id: 'here', name: 'here', host: '127.0.0.1', port: 65533, devid: 2 }
    ]
  });
  t.after(() => { link.stop(); link.stopIdleProbe(); });

  link._openUdp();
  link._startDestWatch();
  link._state = 'connecting'; // running, no samples — the reported situation

  const healthOf = (id) => link.snapshot().telemetry.destinations.find((d) => d.id === id).health;
  await until(() => healthOf('gone') === 'offline', 5000, 'the dead destination to be proven dead');
  await until(() => healthOf('here') === 'connected', 5000, 'the live machine to be proven alive');
});

test('a config match with nothing flowing is a match, not a delivery', () => {
  const { LinkManager } = require('../src/core/link-manager');
  const manager = new LinkManager({ logger: { push() {} } });
  manager.disguiseChecks.set('d', { matches: true, at: Date.now() });

  const still = { destinations: [{ id: 'd', health: 'connected', sending: false }] };
  manager.applyDisguiseChecks(still);
  assert.equal(still.destinations[0].health, 'connected',
    'receiving would claim data is arriving, and none is being sent');

  const flowing = { destinations: [{ id: 'd', health: 'connected', sending: true }] };
  manager.applyDisguiseChecks(flowing);
  assert.equal(flowing.destinations[0].health, 'receiving');

  manager.disguiseChecks.set('d', { matches: false, at: Date.now() });
  const wrong = { destinations: [{ id: 'd', health: 'connected', sending: false }] };
  manager.applyDisguiseChecks(wrong);
  assert.equal(wrong.destinations[0].health, 'mismatch',
    'but a mismatch is about configuration and stands without data');
});

test('a ping-speaker going silent reads offline in seconds, mid-stream', async (t) => {
  // Unplugging a destination while data flowed took ten seconds to show:
  // an unplugged LAN host draws no send error until ARP gives it up, and the
  // pings had stood down in favour of send evidence. They run through the
  // stream now, and two consecutive misses from a host that has answered
  // pings mean gone — no error needed, only the missing reply.
  let answer = true;
  const prev = EncoderLink.pingRunner;
  EncoderLink.pingRunner = (host, onDone) => {
    const timer = setTimeout(() => onDone(answer), 10);
    return { kill: () => clearTimeout(timer) };
  };
  t.after(() => { EncoderLink.pingRunner = prev; });

  const link = new EncoderLink({
    id: 'pull', name: 'pull',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd', name: 'd', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
  t.after(() => { link.stop(); link.stopIdleProbe(); });
  link._openUdp();
  link._startDestWatch();
  link._state = 'streaming';

  const sink = link._sinks[0];
  const health = () => link.snapshot().telemetry.destinations[0].health;

  await until(() => sink.pingEverAnswered, 3000, 'the first answered ping');
  // Data flowing, pings answering: healthy.
  sink.lastTxAt = Date.now();
  assert.equal(health(), 'connected');

  // The cable comes out. Sends keep "succeeding" — ARP has not given up, so
  // there are no errors to see — but the replies stop.
  answer = false;
  sink.lastTxAt = Date.now();
  await until(() => sink.pingFails >= 2, 5000, 'two missed replies');
  sink.lastTxAt = Date.now(); // still no send errors, and still:
  assert.equal(health(), 'offline', 'the missing replies say gone before any send error can');

  // And back: one answered ping clears the verdict.
  answer = true;
  await until(() => sink.pingFails === 0, 4000, 'the replug to be noticed');
  sink.lastTxAt = Date.now();
  assert.equal(health(), 'connected');
});

test('a host that never answered pings cannot be declared dead by them', () => {
  // The stealth-firewall laptop: receives perfectly, answers no ping ever.
  // Its silence carries no information, so its health stays with the send
  // evidence — connected while packets leave and nothing objects.
  const s = sink({
    dest: { host: '127.0.0.1', port: 65533 },
    pingEverAnswered: false, pingFails: 50, destAliveAt: Date.now(), destAlive: false,
    lastTxAt: Date.now()
  });
  const { hostProvenBack } = require('../src/core/encoder-link');
  assert.ok(hostProvenBack(s), 'never failed a send, so the send evidence stands');
});
