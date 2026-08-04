'use strict';
/**
 * The encoder's microsecond counter, shown as a clock.
 *
 * Boundary arithmetic is where this kind of formatter goes wrong, and the
 * counter is a 32-bit value that wraps roughly every 1.2 hours — so the hour
 * field carries real information and the wrap point is worth pinning down.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'web', 'js', 'ui.js')).href);

test('microseconds read as hours, minutes, seconds and milliseconds', async () => {
  const { microsToClock } = await load();
  assert.equal(microsToClock(2655553000), '00:44:15.553', "the operator's own example");
  assert.equal(microsToClock(0), '00:00:00.000');
  assert.equal(microsToClock(999), '00:00:00.000', 'under a millisecond is not yet a millisecond');
  assert.equal(microsToClock(1000), '00:00:00.001');
  assert.equal(microsToClock(59999000), '00:00:59.999');
  assert.equal(microsToClock(60000000), '00:01:00.000', 'the minute boundary');
  assert.equal(microsToClock(3600000000), '01:00:00.000', 'the hour boundary');
});

test('the wrap point of the 32-bit counter', async () => {
  const { microsToClock } = await load();
  // 2^32 - 1 microseconds is the last value before it returns to zero.
  assert.equal(microsToClock(4294967295), '01:11:34.967');
});

test('an absent timestamp is not a zero one', async () => {
  const { microsToClock } = await load();
  // OutputMode without Timestamp means there is no reading, which is different
  // from a reading of zero — showing 00:00:00.000 would invent one.
  for (const v of [null, undefined, NaN]) assert.equal(microsToClock(v), '—');
});
