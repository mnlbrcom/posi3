'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KIND,
  FIELD,
  Parser,
  parseOutputMode,
  formatOutputMode,
  writePacket,
  formatPacket,
  MAX_PACKET_BYTES,
  wrapDelta,
  angleDeg,
  revolution,
  stepsPerSecToRpm
} = require('../src/core/protocol');
const { TOTAL_COUNTS, COUNTS_PER_REV } = require('../src/shared/constants');

// ---------------------------------------------------------------------------
// ASCII_SHORT samples
// ---------------------------------------------------------------------------

test('ASCII_SHORT: three fields', () => {
  const p = new Parser();
  const r = p.classify('12345678 -42 998877');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 12345678);
  assert.equal(r.vel, -42);
  assert.equal(r.ts, 998877);
});

test('ASCII_SHORT: two fields infer position + velocity', () => {
  const p = new Parser();
  const r = p.classify('500 12');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 500);
  assert.equal(r.vel, 12);
  assert.equal(r.ts, null);
});

test('ASCII_SHORT: one field is position only', () => {
  const p = new Parser();
  const r = p.classify('33554431');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 33554431);
  assert.equal(r.vel, null);
});

test('an explicit field map resolves the two-field ambiguity', () => {
  // OutputMode=Position_Timestamp_ : the second number is a MICROSECOND
  // TIMESTAMP, not a velocity. Inferring here would feed ~1e6 into disguise
  // as a velocity.
  const p = new Parser();
  p.setFieldMap([FIELD.POSITION, FIELD.TIMESTAMP]);
  const r = p.classify('500 1234567');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 500);
  assert.equal(r.vel, null);
  assert.equal(r.ts, 1234567);
});

test('velocity-first field maps are honoured', () => {
  const p = new Parser();
  p.setFieldMap([FIELD.VELOCITY, FIELD.POSITION]);
  const r = p.classify('-7 900');
  assert.equal(r.vel, -7);
  assert.equal(r.pos, 900);
});

test('extra whitespace and tabs are tolerated', () => {
  const p = new Parser();
  const r = p.classify('  10\t20   30  ');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 10);
  assert.equal(r.vel, 20);
  assert.equal(r.ts, 30);
});

test('more than three numbers is not a sample', () => {
  const p = new Parser();
  assert.equal(p.classify('1 2 3 4').kind, KIND.UNKNOWN);
});

test('absurdly long digit runs are rejected rather than silently rounded', () => {
  const p = new Parser();
  assert.equal(p.classify('1234567890123456789012').kind, KIND.UNKNOWN);
});

// ---------------------------------------------------------------------------
// ASCII (verbose) samples
// ---------------------------------------------------------------------------

test('ASCII verbose form parses', () => {
  const p = new Parser();
  const r = p.classify('POSITION=123 VELOCITY=-4 TIMESTAMP=999');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 123);
  assert.equal(r.vel, -4);
  assert.equal(r.ts, 999);
});

test('ASCII verbose with position only', () => {
  const p = new Parser();
  const r = p.classify('POSITION=8192');
  assert.equal(r.kind, KIND.SAMPLE);
  assert.equal(r.pos, 8192);
  assert.equal(r.vel, null);
});

// ---------------------------------------------------------------------------
// Command replies interleaved with the stream — the ordering trap
// ---------------------------------------------------------------------------

test('a variable reply is not mistaken for a sample', () => {
  const p = new Parser();
  const r = p.classify('CycleTime=10');
  assert.equal(r.kind, KIND.REPLY);
  assert.equal(r.variable, 'CycleTime');
  assert.equal(r.value, '10');
});

test('replies whose names start with P/V/T still classify as replies', () => {
  // These share a first letter with the verbose ASCII data keywords, which is
  // exactly where a naive check order goes wrong.
  const p = new Parser();
  for (const [line, name, value] of [
    ['Preset=0', 'Preset', '0'],
    ['TotalScaledRes=33554432', 'TotalScaledRes', '33554432'],
    ['TimeMode=Cyclic', 'TimeMode', 'Cyclic'],
    ['Verbose=1', 'Verbose', '1']
  ]) {
    const r = p.classify(line);
    assert.equal(r.kind, KIND.REPLY, `${line} should be a reply`);
    assert.equal(r.variable, name);
    assert.equal(r.value, value);
  }
});

test('non-numeric reply values survive intact', () => {
  const p = new Parser();
  const r = p.classify('OutputMode=Position_Velocity_Timestamp_');
  assert.equal(r.kind, KIND.REPLY);
  assert.equal(r.value, 'Position_Velocity_Timestamp_');
});

test('ERROR and WARNING become status lines', () => {
  const p = new Parser();
  let r = p.classify('ERROR: unknown variable Foo');
  assert.equal(r.kind, KIND.STATUS);
  assert.equal(r.severity, 'error');
  assert.equal(r.text, 'unknown variable Foo');

  r = p.classify('WARNING: value clamped');
  assert.equal(r.kind, KIND.STATUS);
  assert.equal(r.severity, 'warning');
});

test('the flash-commit broadcast is an event, never a reply', () => {
  const p = new Parser();
  for (const line of [
    'Parameters successfully written!',
    'Parameters successfully written',
    'parameters   successfully   written !'
  ]) {
    const r = p.classify(line);
    assert.equal(r.kind, KIND.EVENT, line);
    assert.equal(r.text, 'paramsWritten');
  }
});

test('garbage is reported as unknown rather than throwing', () => {
  const p = new Parser();
  const r = p.classify('\x01\x02 !! nonsense');
  assert.equal(r.kind, KIND.UNKNOWN);
});

test('a realistic interleaved burst classifies correctly line by line', () => {
  const p = new Parser();
  const lines = [
    '1000 0 10',
    '1008 8192 20',
    'CycleTime=10',
    '1016 8192 30',
    'Parameters successfully written!',
    'ERROR: syntax',
    '1024 8192 40'
  ];
  const kinds = lines.map((l) => p.classify(l).kind);
  assert.deepEqual(kinds, [
    KIND.SAMPLE, KIND.SAMPLE, KIND.REPLY,
    KIND.SAMPLE, KIND.EVENT, KIND.STATUS, KIND.SAMPLE
  ]);
});

// ---------------------------------------------------------------------------
// OutputMode round trip
// ---------------------------------------------------------------------------

test('parseOutputMode / formatOutputMode round trip', () => {
  assert.deepEqual(parseOutputMode('Position_Velocity_Timestamp_'),
    [FIELD.POSITION, FIELD.VELOCITY, FIELD.TIMESTAMP]);
  assert.deepEqual(parseOutputMode('Position_Timestamp_'),
    [FIELD.POSITION, FIELD.TIMESTAMP]);
  assert.deepEqual(parseOutputMode('position_velocity'),
    [FIELD.POSITION, FIELD.VELOCITY]);
  assert.equal(parseOutputMode('nonsense'), null);
  assert.equal(parseOutputMode(undefined), null);
  assert.equal(formatOutputMode([FIELD.POSITION, FIELD.VELOCITY]), 'Position_Velocity_');
});

// ---------------------------------------------------------------------------
// disguise packet — byte-for-byte legacy parity
// ---------------------------------------------------------------------------

test('writePacket reproduces the legacy C output exactly', () => {
  const buf = Buffer.alloc(MAX_PACKET_BYTES);
  const cases = [
    [1, 12345, 0],
    [1, 0, 0],
    [3, 33554431, -8192],
    [0, 8192, 137],
    [65535, 33554431, 2147483647]
  ];
  for (const [devid, pos, vel] of cases) {
    const n = writePacket(buf, devid, pos, vel);
    assert.equal(buf.toString('latin1', 0, n), formatPacket(devid, pos, vel));
  }
});

test('the canonical packet is exactly "1:12345,0;\\n"', () => {
  const buf = Buffer.alloc(MAX_PACKET_BYTES);
  const n = writePacket(buf, 1, 12345, 0);
  assert.deepEqual(
    Array.from(buf.subarray(0, n)),
    Array.from(Buffer.from('1:12345,0;\n', 'latin1'))
  );
});

test('the widest realistic packet fits the buffer', () => {
  const buf = Buffer.alloc(MAX_PACKET_BYTES);
  const n = writePacket(buf, 65535, 33554431, -2147483648);
  assert.ok(n <= MAX_PACKET_BYTES, `${n} <= ${MAX_PACKET_BYTES}`);
});

test('writePacket leaves no residue from a previous longer packet', () => {
  const buf = Buffer.alloc(MAX_PACKET_BYTES);
  writePacket(buf, 1, 33554431, -8192);
  const n = writePacket(buf, 1, 0, 0);
  assert.equal(buf.toString('latin1', 0, n), '1:0,0;\n');
});

// ---------------------------------------------------------------------------
// Position maths
// ---------------------------------------------------------------------------

test('wrapDelta takes the short way round the rollover', () => {
  assert.equal(wrapDelta(5, 0), 5);
  assert.equal(wrapDelta(0, 5), -5);
  // 33554431 -> 0 is +1 forward, not -33554431
  assert.equal(wrapDelta(0, TOTAL_COUNTS - 1), 1);
  // 0 -> 33554431 is -1 backward
  assert.equal(wrapDelta(TOTAL_COUNTS - 1, 0), -1);
  assert.equal(wrapDelta(10, TOTAL_COUNTS - 10), 20);
});

test('angleDeg and revolution decompose a position', () => {
  assert.equal(angleDeg(0, COUNTS_PER_REV), 0);
  assert.equal(angleDeg(COUNTS_PER_REV / 4, COUNTS_PER_REV), 90);
  assert.equal(angleDeg(COUNTS_PER_REV, COUNTS_PER_REV), 0);
  assert.equal(angleDeg(COUNTS_PER_REV * 3 + COUNTS_PER_REV / 2, COUNTS_PER_REV), 180);
  assert.equal(revolution(0, COUNTS_PER_REV), 0);
  assert.equal(revolution(COUNTS_PER_REV * 1507 + 5, COUNTS_PER_REV), 1507);
});

test('steps/s converts to rpm using the datasheet resolution', () => {
  // 8192 steps/s == 1 rev/s == 60 rpm
  assert.equal(stepsPerSecToRpm(COUNTS_PER_REV, COUNTS_PER_REV), 60);
  assert.equal(stepsPerSecToRpm(0, COUNTS_PER_REV), 0);
  assert.equal(stepsPerSecToRpm(-COUNTS_PER_REV, COUNTS_PER_REV), -60);
});
