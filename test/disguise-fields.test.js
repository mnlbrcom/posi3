'use strict';
/**
 * The numbers an operator types into disguise, per receiver.
 *
 * `d3Fields` read `conn.d3.port` and `conn.d3.devid` — the legacy mirror of the
 * *first* destination. So a fan-out to a director and an understudy produced one
 * set of values describing the director, and the second machine was never
 * described at all. On a redundant rig that is exactly the machine nobody is
 * looking at until it has to take over, and it would have been configured from
 * the wrong device ID and the wrong port.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { d3Fields, computeMapping } = require('../src/shared/mapping');

const rowsOf = (fields, section) =>
  Object.fromEntries(fields.find((f) => f.section === section).rows.map((r) => [r.key, r.value]));

const mapped = (over = {}) => computeMapping(Object.assign({
  mode: 'full', countsPerRev: 8192, totalCounts: 300000,
  minOutput: 0, maxOutput: 1, wrapInput: true, property: 'offset.x', object: ''
}, over));

test('each receiver is described by its own device id and port', () => {
  const conn = { name: 'Revolve', velocityPolicy: 'zero' };
  const director = { name: 'director', host: '10.10.10.5', port: 6000, devid: 10 };
  const understudy = { name: 'US', host: '10.10.10.2', port: 7401, devid: 11 };
  const m = mapped();

  const a = d3Fields(conn, director, m);
  const b = d3Fields(conn, understudy, m);

  assert.equal(rowsOf(a, 'ScreenPositionAxis').id, '10');
  assert.equal(rowsOf(b, 'ScreenPositionAxis').id, '11',
    'the second machine gets its own id, not the first one’s');
  assert.equal(rowsOf(a, 'NavigatorDriver').port, '6000');
  assert.equal(rowsOf(b, 'NavigatorDriver').port, '7401',
    'and its own port');
});

test('velocitycalcmode follows what the bridge actually sends', () => {
  // Getting this wrong is silent and wrong in both directions: deriving from
  // position while a real velocity arrives double-counts, and not deriving
  // while zeroes arrive leaves the axis with no velocity at all.
  const dest = { name: 'd', host: '10.0.0.1', port: 6000, devid: 1 };

  const zero = rowsOf(d3Fields({ velocityPolicy: 'zero' }, dest, mapped()), 'ScreenPositionAxis');
  assert.equal(zero.velocitycalcmode, 'from position');

  const pass = rowsOf(d3Fields({ velocityPolicy: 'passthrough' }, dest, mapped()), 'ScreenPositionAxis');
  assert.equal(pass.velocitycalcmode, 'from device',
    'a connection forwarding the encoder’s velocity must not have disguise derive one too');
});

test('the axis range comes from the receiver’s own mapping', () => {
  // Two machines fed by one encoder need not be showing the same thing.
  const conn = { velocityPolicy: 'zero' };
  const dest = { host: '10.0.0.1', port: 6000, devid: 1 };

  const whole = rowsOf(d3Fields(conn, dest, mapped()), 'ScreenPositionAxis');
  assert.equal(whole.min_input, '0');
  assert.equal(whole.max_input, '299999', 'the device’s travel, not the nameplate');

  const oneTurn = rowsOf(
    d3Fields(conn, dest, mapped({ mode: 'revolutions', revolutions: 1, property: 'rotation.y', maxOutput: 360 })),
    'ScreenPositionAxis');
  assert.equal(oneTurn.max_input, '8191');
  assert.equal(oneTurn.property, 'rotation.y');
  assert.equal(oneTurn.max_output, '360');
});
