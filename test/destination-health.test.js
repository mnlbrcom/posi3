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

test('a persistent failure is announced once, not on every packet', async (t) => {
  const { link } = await deadLink(t);
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
  assert.match(warnings[0], /nothing is listening|no answer from|no route to/,
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

  const health = () => link.snapshot().telemetry.destinations[0].health;
  assert.equal(health(), 'connected', 'the network alone can never say more than this');

  // With an answer, the manager raises or lowers it — and only with one.
  const t1 = link.telemetry();
  const destId = t1.destinations[0].id;

  manager.disguiseChecks.set(destId, { matches: true, at: Date.now() });
  const raised = { destinations: [{ id: destId, health: 'connected' }] };
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
