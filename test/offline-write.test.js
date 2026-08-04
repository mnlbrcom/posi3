'use strict';
/**
 * Writing to an encoder whose connection is stopped.
 *
 * Two facts about the device shape this. It acknowledges a `set` immediately
 * with `<Variable>=<Value>` and only commits to flash seconds later, announcing
 * `Parameters successfully written!` — so a session that closed on the
 * acknowledgement would report "status unknown" for a write that worked. And a
 * refusal is acknowledged the same way, carrying the *old* value back, so the
 * acknowledgement has to be matched by value rather than by name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { writeVariablesOnce } = require('../src/core/discover');

/**
 * A scripted encoder. `behaviour` decides what a `set` gets back.
 */
async function fakeEncoder(t, behaviour) {
  const state = { IP: '10.10.10.20', CycleTime: '18' };
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

test('a write to a stopped connection is acknowledged and committed', async (t) => {
  const enc = await fakeEncoder(t, accepts);
  const { results, committed } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'IP', value: '10.10.10.30' }], { port: enc.port, commitMs: 3000 });

  assert.deepEqual(results, [{ variable: 'IP', value: '10.10.10.30', ok: true }]);
  assert.equal(committed, true, 'the session must be held open for the flash commit');
  assert.equal(enc.state.IP, '10.10.10.30');
});

test('a refusal that echoes the old value is not a success', async (t) => {
  // The failure mode that hid the OutputMode problem for an entire session.
  const enc = await fakeEncoder(t, (sock, name, value, state) => {
    sock.write(`${name}=${state[name]}\r\n`);  // "using previous value"
  });
  const { results, committed } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'IP', value: '10.10.10.30' }], { port: enc.port, commitMs: 500 });

  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /still reports 10\.10\.10\.20/);
  assert.equal(committed, false);
});

test('the bare dialect is tried once when set is refused', async (t) => {
  const seen = [];
  const enc = await fakeEncoder(t, (sock, name, value, state) => {
    seen.push(value);
    if (seen.length === 1) { sock.write('ERROR: unknown command\r\n'); return; }
    accepts(sock, name, value, state);
  });
  const { results } = await writeVariablesOnce('127.0.0.1',
    [{ variable: 'CycleTime', value: '12' }], { port: enc.port, commitMs: 2000 });

  assert.equal(seen.length, 2, 'exactly one retry, in the other dialect');
  assert.equal(results[0].ok, true);
});

test('an encoder that is gone reports unreachable', async () => {
  await assert.rejects(
    () => writeVariablesOnce('127.0.0.1', [{ variable: 'IP', value: '10.0.0.1' }],
      { port: 1, connectTimeoutMs: 1500 }),
    (err) => err.code === 'EUNREACHABLE' || err.code === 'ECONNREFUSED'
  );
});
