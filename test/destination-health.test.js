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

  // Far more than the old rule's 500-error threshold.
  for (let i = 0; i < 1500; i++) link._forward(i, 0);
  await until(() => link._sinks[0].txErrors > 400, 4000, 'failures to accumulate');
  await sleep(300);

  assert.ok(link._sinks[0].txErrors > 400, 'the failures must still be counted');
  assert.equal(warnings.length, 1,
    `a steady failure should be said once, not ${warnings.length} times`);
});

test('the warning names the destination and what is wrong', async (t) => {
  const { link } = await deadLink(t);
  const warnings = [];
  link.on('log', (e) => { if (e.level === 'warn') warnings.push(e.text); });

  for (let i = 0; i < 50; i++) link._forward(i, 0);
  await until(() => warnings.length > 0, 4000, 'a warning');

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
