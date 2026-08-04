'use strict';
/**
 * Reacting to somebody else reconfiguring the encoder.
 *
 * The device broadcasts to *every* connected TCP client — not just the reply
 * but the command itself. So when an operator changes something from POSITAL's
 * applet, another posi3, or a raw socket, we are told.
 *
 * Until this was handled we cached the new value and carried on parsing with
 * the old layout. Found on real hardware: `OutputMode` went
 * POSITION_VELOCITY -> POSITION and `CycleTime` 18 -> 8 mid-session, our cache
 * updated, and the parser kept assuming two fields. Benign that time, because
 * the field that vanished was the last one. Not benign in general — losing
 * Position from the front promotes the next field into its place and disguise
 * ends up driven by a timestamp.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { EncoderLink } = require('../src/core/encoder-link');

function link() {
  const l = new EncoderLink({
    id: 'test', name: 'test',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations: [{ host: '127.0.0.1', port: 6001, devid: 1 }],
    encoderMeta: { countsPerRev: 8192, totalCounts: 33554432, cycleTimeMs: 10 }
  });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => true;
  l._socket = socket;
  return l;
}

/** The exact strings the reference encoder broadcast. */
test('a field-layout change is applied, not just cached', () => {
  const l = link();
  const layouts = [];
  l.on('fieldLayout', (e) => layouts.push(e.fields));

  l._onLine('OutputMode=POSITION_VELOCITY');
  assert.deepEqual(l._parser.fieldMap, [0, 1]);

  // Somebody drops velocity from the applet.
  l._onLine('OutputMode=POSITION');
  assert.deepEqual(l._parser.fieldMap, [0], 'the parser must follow the device');
  assert.deepEqual(layouts[layouts.length - 1], [0]);
});

test('the dangerous direction: Position leaving the front', () => {
  const l = link();
  l._onLine('OutputMode=POSITION_VELOCITY');
  // With a stale [0,1] map, "12345 678" would be read as position 12345.
  // The device is now sending velocity first, and only the layout says so.
  l._onLine('OutputMode=VELOCITY_TIMESTAMP');
  assert.deepEqual(l._parser.fieldMap, [1, 2],
    'a two-number line must now be read as velocity and timestamp, not position');
});

test('an unchanged layout does not churn', () => {
  const l = link();
  l._onLine('OutputMode=POSITION_VELOCITY');
  let events = 0;
  l.on('fieldLayout', () => { events++; });
  l._onLine('OutputMode=POSITION_VELOCITY');
  l._onLine('OutputMode=Position_Velocity_'); // the manual's spelling, same thing
  assert.equal(events, 0, 'only a real change should be announced');
});

test('a cycle-time change moves the stall watchdog with it', () => {
  // At CycleTime=8 a gap that is unremarkable at 18 would look like a stall,
  // and at 18 a real stall would go unnoticed for too long.
  const l = link();
  l._onLine('CycleTime=8');
  assert.equal(l.config.encoderMeta.cycleTimeMs, 8);
  l._onLine('CycleTime=18');
  assert.equal(l.config.encoderMeta.cycleTimeMs, 18);
});

test('a scaling change re-derives counts per revolution', () => {
  const l = link();
  l._onLine('UsedScopeOfPhysRes=300000');
  l._onLine('TotalScaledRes=300000');
  assert.equal(l.config.encoderMeta.totalCounts, 300000);
  assert.equal(l.config.encoderMeta.countsPerRev, 8192, 'scaled 1:1, so unchanged per revolution');

  // Halve the scaled resolution over the same physical scope.
  l._onLine('TotalScaledRes=150000');
  assert.equal(l.config.encoderMeta.totalCounts, 150000);
  assert.equal(l.config.encoderMeta.countsPerRev, 4096, 'half the counts over the same travel');
});

test('switching the encoder to BINARY is reported, not silently mis-parsed', () => {
  const l = link();
  const events = [];
  l.on('encoderEvent', (e) => events.push(e.kind));
  l._onLine('OutputType=BINARY');
  assert.ok(events.includes('binaryMode'));
});

test('garbage in a broadcast does not disturb the current layout', () => {
  const l = link();
  l._onLine('OutputMode=POSITION_VELOCITY');
  l._onLine('OutputMode=');
  l._onLine('OutputMode=NONSENSE');
  assert.deepEqual(l._parser.fieldMap, [0, 1], 'an unreadable value must be ignored, not applied');
});

// ---------------------------------------------------------------------------
// What counts as a change
// ---------------------------------------------------------------------------

/** A link that has never spoken to an encoder knows nothing about one. */
function freshLink() {
  const l = new EncoderLink({
    id: 'test', name: 'test',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations: [{ host: '127.0.0.1', port: 6001, devid: 1 }]
  });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => true;
  l._socket = socket;
  const logs = [];
  l.on('log', (e) => logs.push(e.text));
  return { l, logs };
}

test('the first value an encoder reports is state, not a change', () => {
  // The profile used to be seeded with nameplate figures -- 8192/rev,
  // 33,554,432 counts, 10 ms -- so the first read of a commissioned encoder
  // differed from them and was announced as a change on every single connect.
  // Nothing had changed: we simply had not asked before.
  const { l, logs } = freshLink();

  l._onLine('OutputMode=POSITION_VELOCITY');
  l._onLine('CycleTime=18');
  l._onLine('UsedScopeOfPhysRes=300000');
  l._onLine('TotalScaledRes=300000');

  assert.deepEqual(logs.filter((t) => /changed on the encoder/.test(t)), [],
    'a first observation must not be reported as a change');

  // Observed, kept, and usable -- the point of asking.
  assert.equal(l.config.encoderMeta.cycleTimeMs, 18);
  assert.equal(l.config.encoderMeta.totalCounts, 300000);
  assert.deepEqual(l._parser.fieldMap, [0, 1]);
});

test('a value that really changes is reported as one', () => {
  const { l, logs } = freshLink();

  l._onLine('CycleTime=18');
  l._onLine('OutputMode=POSITION_VELOCITY');
  l._onLine('UsedScopeOfPhysRes=300000');
  l._onLine('TotalScaledRes=300000');
  logs.length = 0;

  // Somebody reconfigures the device from another client.
  l._onLine('CycleTime=8');
  l._onLine('OutputMode=POSITION');
  l._onLine('TotalScaledRes=150000');

  const changes = logs.filter((t) => /changed on the encoder/.test(t));
  assert.equal(changes.length, 3, `expected three changes, got: ${JSON.stringify(changes)}`);
  assert.ok(changes.some((t) => /cycle time changed on the encoder: 8 ms/.test(t)));
  assert.ok(changes.some((t) => /field layout changed on the encoder: POSITION/.test(t)));
  assert.ok(changes.some((t) => /scaling changed on the encoder: 150000/.test(t)));
});

test('the same value reported twice is not a change', () => {
  const { l, logs } = freshLink();
  l._onLine('CycleTime=18');
  logs.length = 0;

  // Every reconnect re-reads the same variables; a reread is not an event.
  l._onLine('CycleTime=18');
  l._onLine('CycleTime=18');
  assert.deepEqual(logs.filter((t) => /changed on the encoder/.test(t)), []);
});
