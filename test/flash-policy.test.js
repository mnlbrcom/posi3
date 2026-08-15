'use strict';
/**
 * The encoder's flash is rated ~100,000 writes and the device can be bricked by
 * losing power mid-commit, so the rules around spending a cycle are safety
 * behaviour, not UI polish. They live on EncoderLink precisely so that every
 * transport — the desktop window, a browser, a script — shares one budget.
 *
 * These tests drive a fake socket rather than a real encoder: the whole point
 * is to exercise paths (the duplicate-Preset refusal above all) that must never
 * be tested against hardware.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { EncoderLink } = require('../src/core/encoder-link');
const flashBudget = require('../src/core/flash-budget');
const { TIMEOUTS } = require('../src/shared/constants');

/**
 * A link with its socket replaced by a scripted responder.
 *
 * `replies` maps a command line to the line the encoder would send back. The
 * responder answers asynchronously, as the real device does.
 */
function fakeLink(vars = {}, dialect = 'both', { broadcast = true } = {}) {
  // The flash budget is shared per connection id and outlives any one link
  // object — which is what makes it correct in production, where a link is
  // rebuilt on every reconfigure and must not get a fresh allowance for it.
  // Here it means each test has to start from a clean one.
  flashBudget.forget('test');

  const link = new EncoderLink({
    id: 'test',
    name: 'test',
    encoder: { host: '127.0.0.1', port: 6000 },
    d3: { host: '127.0.0.1', port: 6001, devid: 1 }
  });

  const sent = [];
  const state = Object.assign({ Preset: '0' }, vars);

  // Stand in for a connected socket. The command queue only needs `write`.
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = (line) => {
    const cmd = line.trim();
    sent.push(cmd);
    const m = /^read (\w+)$/.exec(cmd);
    // POSITAL document two syntaxes; `dialect` picks which one this fake
    // firmware understands. 'both' accepts either.
    const isSet = /^set (\w+)=(.*)$/.exec(cmd);
    const isBare = /^(\w+)=(.*)$/.exec(cmd);
    setImmediate(() => {
      if (m) return link._onLine(`${m[1]}=${state[m[1]] ?? ''}`);

      const accepted =
        (isSet && (dialect === 'both' || dialect === 'set')) ||
        (isBare && !isSet && (dialect === 'both' || dialect === 'bare'));

      if (!accepted && (isSet || isBare)) {
        return link._onLine('ERROR: unknown command');
      }
      const w = isSet || isBare;
      if (w) {
        state[w[1]] = w[2];
        link._onLine(`${w[1]}=${w[2]}`);
        // The real encoder broadcasts this a few seconds later; fire it soon so
        // the two-cycle Preset path can complete without a long test. Some
        // firmware/variables never announce it (IP, CycleTime) — `broadcast:
        // false` models that, so the read-back confirmation path can be tested.
        if (broadcast) setTimeout(() => link._onLine('Parameters successfully written!'), 5);
      }
    });
    return true;
  };
  link._socket = socket;

  return { link, sent, state };
}

test('a write batch claims the shared flash budget', async () => {
  const { link } = fakeLink();
  await link.writeMany([{ variable: 'CycleTime', value: '20' }]);
  assert.throws(() => link.beginWriteBatch(), (err) => err.code === 'ERATELIMIT');
});

test('the budget is shared between writeMany and setPreset', async () => {
  const { link } = fakeLink({ Preset: '0' });
  // A Preset change and a variable write are different UI actions but the same
  // finite resource; the old build rate-limited only one of them.
  await link.setPreset(500);
  await assert.rejects(
    link.writeMany([{ variable: 'CycleTime', value: '20' }]),
    (err) => err.code === 'ERATELIMIT'
  );
});

test('the rate limit reports how long to wait', async () => {
  const { link } = fakeLink();
  await link.writeMany([{ variable: 'CycleTime', value: '20' }]);
  try {
    link.beginWriteBatch();
    assert.fail('should have been rate limited');
  } catch (err) {
    assert.equal(err.code, 'ERATELIMIT');
    assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= TIMEOUTS.WRITE_RATE_LIMIT_MS);
  }
});

test('setting Preset to a new value costs one flash cycle', async () => {
  const { link, sent } = fakeLink({ Preset: '0' });
  const r = await link.setPreset(12345);
  assert.deepEqual(r, { written: 12345, cycles: 1, previous: 0 });
  assert.deepEqual(sent.filter((s) => s.startsWith('set')), ['set Preset=12345']);
});

test('re-setting the value the encoder already holds is refused, not silently dropped', async () => {
  // The firmware will not store the same Preset twice in a row. Writing it
  // again looks like it worked and does nothing, which is the worst outcome on
  // a show floor — so it is an explicit error.
  const { link, sent } = fakeLink({ Preset: '7' });
  await assert.rejects(link.setPreset(7), (err) => {
    assert.equal(err.code, 'EPRESET_DUPLICATE');
    assert.equal(err.current, 7);
    return true;
  });
  assert.deepEqual(sent.filter((s) => s.startsWith('set')), [], 'no flash cycle spent');
});

test('a refused duplicate does not consume the rate limit', async () => {
  const { link } = fakeLink({ Preset: '7' });
  await assert.rejects(link.setPreset(7), (err) => err.code === 'EPRESET_DUPLICATE');
  // Nothing was written, so the next genuine write must not be blocked.
  assert.doesNotThrow(() => link.beginWriteBatch());
});

test('forcing a duplicate goes the long way round: value+1, then value', async () => {
  const { link, sent, state } = fakeLink({ Preset: '7' });
  const r = await link.setPreset(7, { force: true });
  assert.deepEqual(r, { written: 7, cycles: 2, previous: 7 });
  assert.deepEqual(sent.filter((s) => s.startsWith('set')), ['set Preset=8', 'set Preset=7']);
  assert.equal(state.Preset, '7');
});

test('Preset rejects values the encoder cannot hold', async () => {
  const { link } = fakeLink();
  await assert.rejects(link.setPreset(-1), (err) => err.code === 'EINVAL');
  await assert.rejects(link.setPreset(1.5), (err) => err.code === 'EINVAL');
});

test('replies are cached even when no command was waiting for them', () => {
  // The encoder broadcasts every reply to every connected client, so this is
  // how a change made in another browser tab, or by a leftover Java tool,
  // becomes visible to us.
  const { link } = fakeLink();
  link._onLine('CountingDir=CCW');
  assert.equal(link.cachedVar('CountingDir').value, 'CCW');
  assert.equal(link.cachedVar('Nonexistent'), null);
});

// -- confirmation on the echo ------------------------------------------------
//
// The encoder echoes a `set` by name AND value, and write() only resolves when
// the echoed value matches — a refusal carries the old value back and throws.
// So the echo, in under a second, is the confirmation. There is no separate
// broadcast to wait for: this firmware does not reliably send one (an IP or
// CycleTime write is accepted and never announced). Waiting for it and then
// warning "flash commit not confirmed within 30s" cried wolf over a write that
// had plainly worked, and left the "do not power off" banner hanging.

test('a write is confirmed on its echo, and the risk window is logged either side', async () => {
  const { link, sent } = fakeLink({}, 'both', { broadcast: false });
  const seen = [];
  const logs = [];
  link.on('encoderEvent', (e) => seen.push(e.kind));
  link.on('log', (l) => logs.push(l));

  await link.writeMany([{ variable: 'CycleTime', value: '1' }]);

  assert.ok(!sent.some((s) => /^read /.test(s)), 'the echo confirms — no read-back is sent');
  assert.ok(seen.includes('flashConfirmed'), 'confirmation is emitted so the banner clears');
  // banner = log entry, both ends: the do-not-power-off warning and the confirm.
  assert.ok(logs.some((l) => l.level === 'warn' && /flash write started — do not power off/.test(l.text)),
    'the risk window is on the record');
  assert.ok(logs.some((l) => l.level === 'info' && /flash write confirmed — CycleTime=1/.test(l.text)),
    'and so is the confirmation');
});

test('a refused write is recorded as refused, and not confirmed', async () => {
  const { link } = fakeLink();
  const logs = [];
  const seen = [];
  link.on('log', (l) => logs.push(l));
  link.on('encoderEvent', (e) => seen.push(e.kind));

  // The encoder answers a refusal by echoing the *old* value; write() rejects
  // that, so writeMany records it failed. Make the fake echo a wrong value.
  link._socket.write = (line) => {
    const cmd = line.trim();
    const m = /^set (\w+)=(.*)$/.exec(cmd) || /^(\w+)=(.*)$/.exec(cmd);
    if (m) setImmediate(() => link._onLine(`${m[1]}=999`)); // never the requested value
    return true;
  };

  const results = await link.writeMany([{ variable: 'CycleTime', value: '1' }]);
  assert.ok(results.every((r) => !r.ok), 'the write is marked failed');
  assert.ok(!seen.includes('flashConfirmed'), 'nothing is confirmed');
  assert.ok(logs.some((l) => l.level === 'warn' && /flash write refused/.test(l.text)));
});

test('a Preset write confirms on its echo, no window left hanging', async () => {
  const { link } = fakeLink({ Preset: '0' }, 'both', { broadcast: false });
  const seen = [];
  const logs = [];
  link.on('encoderEvent', (e) => seen.push(e.kind));
  link.on('log', (l) => logs.push(l));

  await link.setPreset(12345);

  assert.ok(seen.includes('flashConfirmed'), 'the popup banner clears on confirmation');
  assert.ok(logs.some((l) => /flash write started — do not power off/.test(l.text)));
  assert.ok(logs.some((l) => /flash write confirmed — Preset=12345/.test(l.text)));
});

// -- command dialect ---------------------------------------------------------
//
// POSITAL document the same operation two ways: the manual (UME-OCD-EM §5.6.1)
// gives `set <Variable>=<Value>`, their later command-line note gives the bare
// `Variable=Value`. Which one a firmware accepts cannot be known from here, and
// guessing wrong means every write silently fails on site.

test('the documented `set` form is tried first', async () => {
  const { link, sent } = fakeLink({}, 'set');
  await link.write('CycleTime', '20');
  assert.deepEqual(sent.filter((s) => /CycleTime/.test(s)), ['set CycleTime=20']);
});

test('a firmware that refuses `set` is retried with the bare form', async () => {
  const { link, sent, state } = fakeLink({}, 'bare');
  await link.write('CountingDir', 'CCW');
  assert.deepEqual(
    sent.filter((s) => /CountingDir/.test(s)),
    ['set CountingDir=CCW', 'CountingDir=CCW'],
    'the refusal must be followed by the other dialect'
  );
  assert.equal(state.CountingDir, 'CCW', 'the value must actually land');
});

test('the working dialect is remembered, so the refusal is paid once', async () => {
  const { link, sent } = fakeLink({}, 'bare');
  await link.write('CountingDir', 'CCW');
  sent.length = 0;
  await link.write('Verbose', '1');
  assert.deepEqual(sent, ['Verbose=1'], 'the second write should not re-try the dead form');
});

test('a timeout is never retried — the write may already have reached flash', async () => {
  // Only an explicit refusal proves nothing was written. Anything else and a
  // retry risks spending a second of the encoder's ~100,000 cycles.
  const { link, sent } = fakeLink();
  link._socket.write = (line) => { sent.push(line.trim()); return true; }; // never answers
  await assert.rejects(link.write('CycleTime', '20'));
  assert.equal(sent.length, 1, 'exactly one attempt');
});

test('the duplicate question is askable before anything in a batch spends flash', async () => {
  // The server writes a batch as "every other variable, then Preset". The
  // duplicate refusal used to live only inside setPreset — thrown *after* the
  // rest of the batch had burned its cycles, discarding their results, and
  // the retry-with-force wrote them all again.
  const { link, sent } = fakeLink({ Preset: '7' });
  await assert.rejects(link.assertPresetWritable(7), (err) => err.code === 'EPRESET_DUPLICATE');
  assert.deepEqual(sent.filter((s) => s.startsWith('set')), [],
    'the check is read-only — a refusal costs nothing');
  const ok = await link.assertPresetWritable(8);
  assert.equal(ok.current, 7, 'a non-duplicate answers instead of throwing');

  // And the server actually asks first: the batch path refuses before writeMany.
  const fs = require('node:fs');
  const path = require('node:path');
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'api.js'), 'utf8');
  const batch = api.slice(api.indexOf('presets.length && link && link.running'));
  const block = batch.slice(0, batch.indexOf('recordPendingAddress'));
  assert.ok(block.indexOf('assertPresetWritable') !== -1 &&
    block.indexOf('assertPresetWritable') < block.indexOf('writeMany'),
    'the refusal comes before the first flash write of the batch');
});
