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
const net = require('node:net');
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

/** A listener standing in for a powered encoder: accepts, says nothing. */
async function fakeDevice(t) {
  const server = net.createServer((sock) => sock.on('error', () => {}));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => new Promise((r) => server.close(r)));
  return port;
}

function link(port) {
  return new EncoderLink({
    id: 'probe', name: 'probe',
    encoder: { host: '127.0.0.1', port },
    destinations: [{ id: 'd', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
}

test('a handshake proves the device, and a dead port proves its absence', async (t) => {
  const port = await fakeDevice(t);
  const alive = link(port);
  t.after(() => { alive.stop(); alive.stopIdleProbe(); });
  const events = [];
  alive.on('encoderEvent', (e) => { if (e.kind === 'encoderReachability') events.push(e); });

  alive.startIdleProbe();
  await until(() => alive.encoderAlive === true, 3000, 'the handshake to land');
  assert.equal(events[events.length - 1].alive, true);

  // A closed port: for an encoder this is absence — the device always
  // listens on its data port, so a refusal is not a device ready to talk.
  const dead = link(65533);
  t.after(() => { dead.stop(); dead.stopIdleProbe(); });
  dead.startIdleProbe();
  await until(() => dead.encoderAlive === false, 3000, 'the refusal to land');
});

test('the probe never runs beside a live connection', async (t) => {
  const port = await fakeDevice(t);
  const l = link(port);
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
