'use strict';
/**
 * What occupies the velocity slot, and what never changes.
 *
 * The requirement, in the user's words: with velocity switched off at the
 * encoder the string to disguise must not change shape but must carry 0; with
 * velocity switched on it must carry the encoder's value.
 *
 * The first half is structural — `writePacket` always emits
 * `id:pos,vel;` — and the second is the `passthrough` policy. Both are pinned
 * here because a change to either would be invisible until a show.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { writePacket, MAX_PACKET_BYTES } = require('../src/core/protocol');
const { EncoderLink } = require('../src/core/encoder-link');

function packet(devid, pos, vel) {
  const b = Buffer.allocUnsafe(MAX_PACKET_BYTES);
  return b.slice(0, writePacket(b, devid, pos, vel)).toString('latin1');
}

/** A link whose samples we can drive directly, with no sockets. */
function link(velocityPolicy) {
  const l = new EncoderLink({
    id: 't', name: 't',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations: [{ host: '127.0.0.1', port: 6001, devid: 1 }],
    velocityPolicy,
    encoderMeta: { countsPerRev: 8192, totalCounts: 300000, cycleTimeMs: 8 }
  });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => true;
  l._socket = socket;
  return l;
}

/** What the policy decides for a sample. `vel: null` means the encoder sent none. */
function outVel(l, { pos, vel }) {
  return l._resolveVelocity({ pos, vel, ts: null }, pos, Date.now(), 300000);
}

// -- the shape never changes --------------------------------------------------

test('the packet always carries a velocity field, whatever its value', () => {
  assert.equal(packet(1, 12345, 0), '1:12345,0;\n');
  assert.equal(packet(1, 12345, -47809), '1:12345,-47809;\n');
  // The grammar disguise parses: id:pos,vel; — three parts, always.
  for (const v of [0, 1, -1, 2147483647, -2147483648]) {
    assert.match(packet(7, 300000, v), /^7:300000,-?\d+;\n$/);
  }
});

// -- velocity off at the encoder ----------------------------------------------

test('velocity off at the encoder: passthrough sends 0, not nothing', () => {
  // OutputMode=POSITION, so the parser reports vel as null.
  const l = link('passthrough');
  assert.equal(outVel(l, { pos: 31687, vel: null }), 0);
  assert.equal(packet(1, 31687, outVel(l, { pos: 31687, vel: null })), '1:31687,0;\n');
});

test('velocity off at the encoder: every policy still produces a valid packet', () => {
  for (const policy of ['zero', 'passthrough']) {
    const l = link(policy);
    const v = outVel(l, { pos: 100, vel: null });
    assert.equal(typeof v, 'number', `${policy} must yield a number`);
    assert.ok(Number.isFinite(v), `${policy} must not yield NaN or Infinity`);
    assert.match(packet(1, 100, v), /^1:100,-?\d+;\n$/, `${policy} must keep the packet shape`);
  }
});

// -- velocity on at the encoder -----------------------------------------------

test('velocity on at the encoder: passthrough forwards the encoder value', () => {
  const l = link('passthrough');
  assert.equal(outVel(l, { pos: 31687, vel: 125653 }), 125653);
  assert.equal(outVel(l, { pos: 31687, vel: -110463 }), -110463, 'the sign must survive');
  assert.equal(packet(1, 31687, 125653), '1:31687,125653;\n');
});

test('velocity on at the encoder: zero still sends 0, by design', () => {
  // The compatibility default. disguise derives velocity itself, and existing
  // shows depend on that.
  const l = link('zero');
  assert.equal(outVel(l, { pos: 31687, vel: 125653 }), 0);
});

test('switching the encoder on and off mid-run needs no reconfiguration here', () => {
  // The encoder can gain or lose its velocity field at any moment — somebody
  // changing OutputMode from the applet. passthrough must ride that out.
  const l = link('passthrough');
  assert.equal(outVel(l, { pos: 10, vel: 500 }), 500);   // velocity present
  assert.equal(outVel(l, { pos: 20, vel: null }), 0);    // switched off
  assert.equal(outVel(l, { pos: 30, vel: -250 }), -250); // switched back on
});

test('a profile still naming the removed policy sends zero', () => {
  // 'derived' computed a velocity here and sent it. It is gone — the encoder
  // reports one and disguise derives one — but a saved profile written before
  // the removal can still name it, and an unknown policy must not become an
  // undefined value in the packet.
  const l = link('derived');
  assert.equal(outVel(l, { pos: 100, vel: 4096 }), 0, 'falls back to the original driver behaviour');
  assert.equal(packet(1, 100, outVel(l, { pos: 100, vel: 4096 })), '1:100,0;\n');
});
