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

const { writeVariablesOnce } = require('../src/core/discover');

/**
 * A scripted encoder. `behaviour` decides what a `set` gets back.
 */
async function fakeEncoder(t, behaviour) {
  const state = { IP: '192.0.2.20', CycleTime: '18' };
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        const m = /^(?:set\s+)?(\w+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, name, value] = m;
        behaviour(sock, name, value, state);
      }
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => server.close());
  return { port, state };
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
