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
const { TIMEOUTS } = require('../src/shared/constants');

/**
 * A link with its socket replaced by a scripted responder.
 *
 * `replies` maps a command line to the line the encoder would send back. The
 * responder answers asynchronously, as the real device does.
 */
function fakeLink(vars = {}, dialect = 'both') {
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
        // the two-cycle Preset path can complete without a long test.
        setTimeout(() => link._onLine('Parameters successfully written!'), 5);
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

test('the flash-commit window opens on write and closes on the broadcast', async () => {
  const { link } = fakeLink();
  const seen = [];
  link.on('encoderEvent', (e) => seen.push(e.kind));

  await link.writeMany([{ variable: 'CycleTime', value: '20' }]);
  assert.equal(link.flashPending, true, 'the "do not power off" window should be open');

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.flashPending, false, 'the broadcast should have closed it');
  assert.ok(seen.includes('flashPending'));
  assert.ok(seen.includes('paramsWritten'));
});

test('losing the link closes the flash window rather than leaving it hanging', async () => {
  const { link } = fakeLink();
  await link.writeMany([{ variable: 'CycleTime', value: '20' }]);
  assert.equal(link.flashPending, true);
  link._clearTimers();
  assert.equal(link.flashPending, false);
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
