'use strict';
/**
 * The encoder's indicator tells the truth about the device, not about posi3.
 *
 * `idle` described this app — "you have not pressed Start" — so an unplugged
 * encoder and a healthy one looked identical until somebody started them.
 * While a link is idle the bridge now shakes hands with the encoder once a
 * second: a plain TCP connect and an immediate close, no command sent and
 * nothing read, so the device's flash and configuration are untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EncoderLink } = require('../src/core/encoder-link');
const { LinkManager } = require('../src/core/link-manager');
const { ConfigStore } = require('../src/core/config-store');
const { createApi } = require('../src/server/api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}


/**
 * The liveness tests assert the probe state machine, not the operating
 * system's ping — which is unusable as a fixture: this machine's stealth
 * firewall drops even loopback self-pings. Hosts on TEST-NET-1 read dead,
 * everything else alive, and each answer lands on the next tick.
 */
function installFakePing(t) {
  const prev = EncoderLink.pingRunner;
  EncoderLink.pingRunner = (host, onDone) => {
    const timer = setTimeout(() => onDone(!host.startsWith('192.0.2.')), 15);
    return { kill: () => clearTimeout(timer) };
  };
  t.after(() => { EncoderLink.pingRunner = prev; });
}

function link(port, host = '127.0.0.1') {
  return new EncoderLink({
    id: 'probe', name: 'probe',
    encoder: { host, port },
    destinations: [{ id: 'd', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
}

test('a ping answered proves the device, an unanswered one its absence', async (t) => {
  // Ping, not a TCP handshake: the first probe shook hands with the
  // destination's own port and a live Designer popped "Error 0x2740" at the
  // operator mid-session. ICMP is answered by the kernel — nothing on the
  // machine ever sees it.
  installFakePing(t);
  const alive = link(65534);
  t.after(() => { alive.stop(); alive.stopIdleProbe(); });
  const events = [];
  alive.on('encoderEvent', (e) => { if (e.kind === 'encoderReachability') events.push(e); });

  alive.startIdleProbe();
  await until(() => alive.encoderAlive === true, 4000, 'loopback to answer the ping');
  assert.equal(events[events.length - 1].alive, true);

  // TEST-NET-1 answers nothing, ever.
  const dead = link(6000, '192.0.2.1');
  t.after(() => { dead.stop(); dead.stopIdleProbe(); });
  dead.startIdleProbe();
  await until(() => dead.encoderAlive === false, 5000, 'the silence to be read as absence');
});

test('the probe never runs beside a live connection', async (t) => {
  installFakePing(t);
  const l = link(65534);
  t.after(() => { l.stop(); l.stopIdleProbe(); });

  l.startIdleProbe();
  await until(() => l.encoderAlive === true, 3000, 'idle handshake');

  l.start();
  assert.equal(l._idleProbeTimer, null, 'starting suspends the handshake — the stream is its own proof');
  l.stop();
  assert.ok(l._idleProbeTimer, 'and stopping resumes it, immediately');
});

test('a read that fails against a known-offline encoder is not logged as news', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-reach-'));
  const store = new ConfigStore(dir);
  store.load();
  const manager = new LinkManager({});
  const api = createApi({
    manager, store,
    syncLink: (conn) => manager.upsert(conn),
    onConfigChanged: () => {}, onSettings: () => {}, env: () => ({})
  });
  t.after(() => manager.dispose());

  api.configSaveConnection({
    id: 'c1', name: 'Revolve',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd1', host: '127.0.0.1', port: 65533, devid: 1 }]
  });

  const lines = () => manager.logger.tail({ limit: 100 }).map((l) => l.text);

  // The indicator already says offline: the failure is the pill's job, and an
  // error line repeating it buries the failures that are new.
  manager.get('c1').stopIdleProbe();
  manager.get('c1').encoderAlive = false;
  await assert.rejects(() => api.encoderReadMany({ id: 'c1', variables: ['CycleTime'] }));
  assert.equal(lines().filter((l) => /read failed — no answer/.test(l)).length, 0,
    'not news: the indicator said offline before the read was asked for');

  // The same failure against a supposedly-connected encoder IS news.
  manager.get('c1').encoderAlive = true;
  await assert.rejects(() => api.encoderReadMany({ id: 'c1', variables: ['CycleTime'] }));
  assert.equal(lines().filter((l) => /read failed — no answer/.test(l)).length, 1,
    'a device the indicator calls connected failing to answer is worth keeping');

  // And appInfo carries the answers, so a browser's first render can agree.
  assert.deepEqual(api.appInfo().encoderAlive, { c1: true });
});

test('a retry loop wears one name, not two in alternation', async (t) => {
  // Each attempt re-entered `connecting` and each failure `reconnecting`, so
  // against an unreachable encoder the pill ping-ponged every few seconds.
  // The first attempt is `connecting`; from then on the condition is "a retry
  // loop is running", and it keeps the one name until it ends.
  const l = link(65533); // nothing listens: every attempt fails fast
  t.after(() => { l.stop(); l.stopIdleProbe(); });
  const states = [];
  l.on('state', (e) => states.push(e.state));

  l.start();
  await until(() => states.filter((x) => x === 'reconnecting').length >= 3,
    8000, 'a few retry cycles');
  const afterFirstFailure = states.slice(states.indexOf('reconnecting'));
  assert.equal(afterFirstFailure.includes('connecting'), false,
    'once retrying, no attempt announces itself as a fresh connect');
  assert.equal(states[0], 'connecting', 'while the very first attempt still does');
});

test('a disconnect must not orphan the watches or wipe their answers', async (t) => {
  // The constructor's probe fields were pasted into _handleDisconnect too —
  // the patch anchored on a code trio that exists in both places — so every
  // reconnect cycle nulled the timer handles. The intervals kept ticking,
  // orphaned and unstoppable, and on the rig a replugged disguise machine
  // stayed `offline` because the watch's own field lied about its existence.
  installFakePing(t);
  const l = new EncoderLink({
    id: 'dc', name: 'dc',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
  t.after(() => { l.stop(); l.stopIdleProbe(); });

  l.start();
  await until(() => l._sinks[0] && l._sinks[0].destAlive === true, 4000, 'the first answer');
  // The encoder port is closed, so the TCP connect has already failed at
  // least once by now — _handleDisconnect has run.
  assert.ok(l._destWatch, 'the destination watch is still tracked after a disconnect');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'encoder-link.js'), 'utf8');
  const dc = src.slice(src.indexOf('_handleDisconnect(err) {'));
  const body = dc.slice(0, dc.indexOf('\n  }'));
  for (const field of ['encoderAlive', '_idleProbeTimer', '_idleProbe', '_destWatch']) {
    assert.equal(body.includes(field), false,
      `_handleDisconnect must not touch ${field} — a reconnect is not a teardown`);
  }
});
