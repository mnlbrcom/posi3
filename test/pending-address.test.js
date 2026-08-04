'use strict';
/**
 * An encoder's address after it has been reprogrammed but before it is
 * power-cycled.
 *
 * The device stores a new IP immediately and keeps answering on the old one
 * until power is cycled, so for that whole window there are two different
 * facts: where it answers, and what it will answer on. Holding one field for
 * both made the saved connection name a dead address the moment a write
 * succeeded — measured on the rig, where Read then failed with "unreachable at
 * 10.10.10.30" while the encoder sat happily on .20.
 *
 * `host` therefore always names where it answers, and `pendingHost` what is
 * coming. Promotion happens on evidence — the pending address answered — never
 * on assumption.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitiseConnection } = require('../src/server/validate');

const base = {
  name: 'Encoder 2',
  encoder: { host: '10.10.10.20', port: 6000 },
  destinations: [{ host: '10.10.10.5', port: 6000, devid: 1 }]
};

test('a pending address survives being saved', () => {
  const c = sanitiseConnection(Object.assign({}, base, {
    encoder: { host: '10.10.10.20', port: 6000, pendingHost: '10.10.10.30' }
  }));
  assert.equal(c.encoder.host, '10.10.10.20', 'host still names where it answers');
  assert.equal(c.encoder.pendingHost, '10.10.10.30');
});

test('a pending address is validated like any other', () => {
  assert.throws(() => sanitiseConnection(Object.assign({}, base, {
    encoder: { host: '10.10.10.20', port: 6000, pendingHost: 'not an address; Run!' }
  })), (err) => err.code === 'EINVAL');
});

test('no pending address is the normal case, and stays absent', () => {
  const c = sanitiseConnection(base);
  assert.equal(c.encoder.pendingHost, undefined,
    'an absent pending address must not become a null that looks like a value');
});

test('the address a write programs is never assumed to be live', () => {
  // The rule in one line: writing IP sets pendingHost, never host. Anything
  // else points the connection at a device that will not answer until somebody
  // walks to the rack.
  const written = sanitiseConnection(Object.assign({}, base, {
    encoder: { host: '10.10.10.20', port: 6000, pendingHost: '10.10.10.30' }
  }));
  assert.notEqual(written.encoder.host, written.encoder.pendingHost);
});
