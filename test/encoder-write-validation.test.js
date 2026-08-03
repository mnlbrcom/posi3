'use strict';
/**
 * What may be written to an encoder variable.
 *
 * `checkValue` alone only refuses a line break, which is the dangerous case —
 * a value containing CR or LF becomes a second command on the shared TCP
 * session. It is not the only one: without a per-variable check, a wrong type,
 * an out-of-range resolution or a malformed address all travelled to the
 * device to be rejected there.
 *
 * These run against the server-side validator, not the UI, because a hand-made
 * HTTP request meets the same code and the UI's own constraints are only a
 * convenience.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkVarWrite, checkValue } = require('../src/server/validate');

const rejects = (name, value, why) => assert.throws(
  () => checkVarWrite(name, value),
  (err) => err.code === 'EINVAL',
  `${why}: ${name}=${JSON.stringify(value)} should have been rejected`
);

test('a line break can never become a second command', () => {
  // The whole reason the guard exists: the command channel is the data channel.
  for (const evil of ['0\nset IP=1.2.3.4', '0\r\nRun!', 'Cyclic\rRun!']) {
    assert.throws(() => checkValue(evil), (err) => err.code === 'EINVALIDVALUE');
    assert.throws(() => checkVarWrite('CycleTime', evil));
  }
});

test('only known variables are addressable', () => {
  rejects('NotAVariable', '1', 'unknown name');
  rejects('IP; rm -rf /', '1.2.3.4', 'punctuation in a name');
  rejects('', '1', 'empty name');
});

test('integers must be integers, and within the range the manual gives', () => {
  assert.deepEqual(checkVarWrite('CycleTime', '8'), { variable: 'CycleTime', value: '8' });
  assert.deepEqual(checkVarWrite('CycleTime', 999999).value, '999999');
  rejects('CycleTime', 'abc', 'not a number');
  rejects('CycleTime', '8.5', 'not a whole number');
  rejects('CycleTime', '0', 'below the documented minimum of 1 ms');
  rejects('CycleTime', '1000000', 'above the documented maximum of 999,999 ms');
  rejects('CycleTime', '1e6', 'exponent notation is not a whole number');
  rejects('UsedScopeOfPhysRes', '-1', 'negative resolution');
  rejects('TotalScaledRes', '1073741825', 'beyond the 30-bit maximum');
});

test('enums accept what the device answers, not only the manual spelling', () => {
  // The encoder replies `CYCLIC`; POSITAL's own applet writes `COS`.
  assert.equal(checkVarWrite('TimeMode', 'CYCLIC').value, 'Cyclic');
  assert.equal(checkVarWrite('TimeMode', 'cyclic').value, 'Cyclic');
  assert.equal(checkVarWrite('TimeMode', 'COS').value, 'Change of state');
  assert.equal(checkVarWrite('CountingDir', 'ccw').value, 'CCW');
  rejects('TimeMode', 'Sometimes', 'not a mode');
  rejects('CountingDir', 'CW; Run!', 'command tacked onto a valid value');
  rejects('OutputType', 'ASCII_LONG', 'not an output type');
});

test('flag sets must be built from the declared tokens', () => {
  assert.equal(checkVarWrite('OutputMode', 'Position_Velocity_').value, 'Position_Velocity_');
  assert.equal(checkVarWrite('OutputMode', '').value, '', 'sending nothing is a legitimate choice');
  rejects('OutputMode', 'Position_Nonsense_', 'an undeclared token');
});

test('addresses must be four octets in range', () => {
  assert.equal(checkVarWrite('IP', '10.10.10.10').value, '10.10.10.10');
  assert.equal(checkVarWrite('Gateway', '010.001.001.001').value, '10.1.1.1', 'leading zeros normalised');
  rejects('IP', '10.10.10', 'three octets');
  rejects('IP', '10.10.10.256', 'octet out of range');
  rejects('NetMask', '255.255.255.0 ; Run!', 'command appended');
  rejects('IP', 'localhost', 'not dotted quad');
});

test('a value is capped in length', () => {
  assert.throws(() => checkValue('x'.repeat(257)), (err) => err.code === 'EINVAL');
});

test('a value the app cannot stream is refused, even though it is a real one', () => {
  // OutputType=BINARY is a legitimate encoder setting and a guaranteed outage
  // here: the app parses ASCII only. It stays in the table so a device already
  // in it reads back correctly and can be set to something usable — but it can
  // never be written, and both the break and the repair would be flash writes.
  assert.equal(checkVarWrite('OutputType', 'ASCII_SHORT').value, 'ASCII_SHORT');
  assert.equal(checkVarWrite('OutputType', 'ascii').value, 'ASCII');
  rejects('OutputType', 'BINARY', 'the app cannot stream it');
  rejects('OutputType', 'binary', 'case does not launder it');
});
