'use strict';
/**
 * What the log says, and who it says said it.
 *
 * Two defects this pins down, both of which made the log quietly untrue rather
 * than visibly broken:
 *
 * 1. `rx` and `tx` were used for anything encoder-related, so the app's own
 *    conclusions were logged as though the device had said them — and worse,
 *    logged *instead of* the reply they were derived from.
 * 2. The per-tick forwarding cap was 25, sized for a raw-sample firehose that
 *    is never logged. A config read of two encoders is ~56 lines inside one
 *    tick, so a third of them vanished with only a note beside the toolbar to
 *    show for it, and nothing at all in the exported log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Logger } = require('../src/core/logger');
const { LinkManager } = require('../src/core/link-manager');
const { LOG_SOURCES } = require('../src/shared/constants');

/** Lines the manager actually forwarded to clients. */
function collect(manager) {
  const seen = [];
  manager.on('log', (batch) => seen.push(...batch.lines));
  return seen;
}

test('a full config read of two encoders reaches the log intact', () => {
  // 14 variables each, sent and answered, inside a few milliseconds. This is
  // the ordinary case that used to lose a third of itself.
  const logger = new Logger();
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  for (let i = 0; i < 14; i++) {
    for (const id of ['a', 'b']) {
      logger.push({ id, dir: 'tx', text: `read Var${i}` });
      logger.push({ id, dir: 'rx', text: `Var${i}=${i}` });
    }
  }
  manager._tick();

  assert.equal(forwarded.length, 56, 'every line of the sweep must be forwarded');
  assert.equal(forwarded.filter((l) => l.dir === 'tx').length, 28);
  assert.equal(forwarded.filter((l) => l.dir === 'rx').length, 28);
});

test('lines that cannot be forwarded are reported in the log itself', () => {
  // Not beside the Export button, where a reader of the log will not look, and
  // where the exported log carried no trace of the gap at all.
  const logger = new Logger({ maxPerFlush: 5 });
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  for (let i = 0; i < 12; i++) logger.push({ id: 'a', dir: 'rx', text: `line ${i}` });
  manager._tick();
  assert.equal(forwarded.length, 5, 'the cap still applies');

  // The notice lands on the following tick, so it cannot enlarge the batch
  // that just overflowed.
  forwarded.length = 0;
  manager._tick();

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].dir, 'app', 'the app is saying this, not the encoder');
  assert.equal(forwarded[0].level, 'warn');
  assert.match(forwarded[0].text, /7 lines arrived faster/);

  // And it does not talk about itself for ever.
  forwarded.length = 0;
  manager._tick();
  assert.deepEqual(forwarded, []);
});

test('nothing is lost from the record, only from the live view', () => {
  // Export reads the ring buffer, which is why the notice can promise it.
  const logger = new Logger({ maxPerFlush: 5 });
  for (let i = 0; i < 12; i++) logger.push({ id: 'a', dir: 'rx', text: `line ${i}` });

  const kept = logger.tail({ limit: 100 });
  assert.equal(kept.length, 12, 'every line stays in the buffer Export reads');
  assert.equal(kept[11].text, 'line 11');
});

test('a link state change is the app talking, not the encoder', () => {
  const logger = new Logger();
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  manager.upsert({
    id: 'a', name: 'test',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations: [{ host: '127.0.0.1', port: 6001, devid: 1 }]
  });
  // Reconfiguring emits no state; stopping an idle link does. Either way the
  // line must not claim to come off the wire.
  manager.stop('a');
  manager._tick();

  const states = forwarded.filter((l) => /^\[/.test(l.text));
  assert.ok(states.length > 0, 'expected at least one state line');
  for (const l of states) {
    assert.equal(l.dir, 'app', `"${l.text}" must be marked as the app, not rx/tx`);
  }
});

test('every source a log line can carry is a known one', () => {
  // The UI colours and filters by these; a fifth invented in passing would be
  // unstyled and unfilterable, which is how `null` behaved before.
  assert.deepEqual(LOG_SOURCES, ['rx', 'tx', 'app', 'user']);
});
