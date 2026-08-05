'use strict';
/**
 * Settings and mapping numbers are validated when typed, not discovered at
 * the next launch.
 *
 * `configSetSettings` merged arbitrary keys and types into the persisted
 * profile: `webPort: "abc"` was accepted, saved, and consumed at startup —
 * where an unbindable value kills the desktop app in fatal(). And the mapping
 * accepted `Infinity` (`Number(x) || 1` keeps it: Infinity is truthy) and
 * negative ratios, which end as NaN or garbage in the axis values disguise is
 * sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSettings, sanitiseConnection } = require('../src/server/validate');

test('a setting that would break the next launch is refused now', () => {
  assert.throws(() => checkSettings({ webPort: 'abc' }), (e) => e.code === 'EINVAL');
  assert.throws(() => checkSettings({ webPort: 70000 }), (e) => e.code === 'EINVAL');
  assert.throws(() => checkSettings({ webBindHost: 'not a host; Run!' }), (e) => e.code === 'EINVAL');
  assert.throws(() => checkSettings({ telemetryHz: 0 }), (e) => e.code === 'EINVAL');
  assert.throws(() => checkSettings({ nonsense: true }), (e) => e.code === 'EINVAL',
    'unknown keys used to be merged and saved forever');
});

test('the settings that are valid come through typed', () => {
  const s = checkSettings({
    webPort: '8710', telemetryHz: '30', webBindHost: '0.0.0.0', logToFile: 1
  });
  assert.equal(s.webPort, 8710);
  assert.equal(s.telemetryHz, 30);
  assert.equal(s.webBindHost, '0.0.0.0', 'the wildcard is a bind address, not a host to resolve');
  assert.equal(s.logToFile, true);
  assert.equal(checkSettings({ webBindHost: '::' }).webBindHost, '::');
});

test('mapping numbers are finite and ratios positive', () => {
  const conn = (mapping) => sanitiseConnection({
    name: 'M', encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ host: '127.0.0.1', port: 65533, devid: 1, mapping }]
  }).destinations[0].mapping;

  assert.equal(conn({ revolutions: '1e999' }).revolutions, 1,
    'Infinity is truthy, so `Number(x) || 1` kept it');
  assert.equal(conn({ gearRatio: -3 }).gearRatio, 1, 'a negative ratio is not a ratio');
  assert.equal(conn({ maxOutput: 'NaN' }).maxOutput, 1);
  assert.equal(conn({ revolutions: 2.5 }).revolutions, 2.5, 'real values pass untouched');
});
