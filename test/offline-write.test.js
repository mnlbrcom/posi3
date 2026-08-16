'use strict';
/**
 * Writing to an encoder whose connection is stopped.
 *
 * One fact about the device shapes this: it acknowledges a `set` by echoing
 * `<Variable>=<Value>` — the new value on success, the *old* one on a refusal —
 * so the echo, matched by value rather than by name, is the confirmation. It
 * commits to flash a moment later and sometimes announces `Parameters
 * successfully written!`, but that broadcast is unreliable (an IP or CycleTime
 * write is accepted and never announced), so nothing waits for it. Same stance
 * as the running-connection path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeVariablesOnce } = require('../src/core/discover');
const { createApi } = require('../src/server/api');
const { ConfigStore } = require('../src/core/config-store');
const { LinkManager } = require('../src/core/link-manager');
const { Logger } = require('../src/core/logger');
const flashBudget = require('../src/core/flash-budget');

/**
 * A scripted encoder. `behaviour` decides what a `set` gets back.
 */
async function fakeEncoder(t, behaviour) {
  const state = { IP: '192.0.2.20', CycleTime: '18' };
  const reads = []; // any `read X` the writer sends — must stay empty
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (/^read\s+/i.test(line)) { reads.push(line); continue; }
        const m = /^(?:set\s+)?(\w+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, name, value] = m;
        behaviour(sock, name, value, state);
      }
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => server.close());
  return { port, state, reads };
}

const accepts = (sock, name, value, state) => {
  state[name] = value;
  sock.write(`${name}=${value}\r\n`);
  setTimeout(() => { try { sock.write('Parameters successfully written!\r\n'); } catch { /* closed */ } }, 150);
};

test('a write to a stopped connection is confirmed on its echo', async (t) => {
  const enc = await fakeEncoder(t, accepts);
  const { results } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'IP', value: '192.0.2.30' }], { port: enc.port });

  assert.equal(results[0].ok, true);
  assert.equal(enc.state.IP, '192.0.2.30');
  assert.deepEqual(enc.reads, [], 'the echo confirms — no read-back is sent');
});

test('a write that is never announced is still confirmed — the echo is enough', async (t) => {
  // The real case: an IP or CycleTime write is accepted, stored, and never
  // announced. Nothing waits for a broadcast; the echo confirms it.
  const enc = await fakeEncoder(t, (sock, name, value, state) => {
    state[name] = value;
    sock.write(`${name}=${value}\r\n`);   // acknowledged, never announced
  });
  const { results } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'IP', value: '192.0.2.30' }], { port: enc.port });

  assert.equal(results[0].ok, true);
  assert.equal(enc.state.IP, '192.0.2.30');
});

test('a refusal that echoes the old value is not a success', async (t) => {
  // The failure mode that hid the OutputMode problem for an entire session: a
  // refusal is acknowledged the same way a success is, carrying the old value.
  const enc = await fakeEncoder(t, (sock, name, value, state) => {
    sock.write(`${name}=${state[name]}\r\n`);  // "using previous value"
  });
  const { results } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'IP', value: '192.0.2.30' }], { port: enc.port });

  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /still reports 192\.0\.2\.20/);
});

test('the bare dialect is tried once when set is refused', async (t) => {
  const seen = [];
  const enc = await fakeEncoder(t, (sock, name, value, state) => {
    seen.push(value);
    if (seen.length === 1) { sock.write('ERROR: unknown command\r\n'); return; }
    accepts(sock, name, value, state);
  });
  const { results } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'CycleTime', value: '12' }], { port: enc.port });

  assert.equal(seen.length, 2, 'exactly one retry, in the other dialect');
  assert.equal(results[0].ok, true);
});

test('an encoder that is gone reports unreachable', async () => {
  await assert.rejects(
    () => writeVariablesOnce('127.0.0.1', [{ variable: 'IP', value: '192.0.2.1' }],
      { port: 1, connectTimeoutMs: 1500 }),
    (err) => err.code === 'EUNREACHABLE' || err.code === 'ECONNREFUSED'
  );
});

test('a stopped-connection write surfaces a confirmation on screen, not only in the log', async (t) => {
  // Regression: the offline path has no link to raise flashConfirmed, so a
  // stopped-connection write once confirmed in the log while nothing appeared
  // on screen. The api must emit the event itself — three times this gap bit.
  const enc = await fakeEncoder(t, accepts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-offline-api-'));
  const store = new ConfigStore(dir);
  store.load();
  const manager = new LinkManager({ logger: new Logger() });
  const api = createApi({ manager, store, syncLink: () => {}, env: () => ({}) });

  const conn = store.upsertConnection({ name: 'Test', encoder: { host: '127.0.0.1', port: enc.port } });
  manager.upsert(conn);       // an idle link — not running, so the write goes offline
  flashBudget.forget(conn.id);

  const events = [];
  manager.on('encoderEvent', (e) => events.push(e));

  await api.encoderWriteMany({ id: conn.id, entries: [{ variable: 'Offset', value: '0' }] });

  const confirmed = events.find((e) => e.kind === 'flashConfirmed' && e.id === conn.id);
  assert.ok(confirmed, 'the offline path emits flashConfirmed, so the toast fires on a stopped connection');
  assert.match(confirmed.text, /Offset=0/);
});
