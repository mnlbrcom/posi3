'use strict';
/**
 * What reaches disguise when the encoder also sends a timestamp.
 *
 * The parsing side of this was already covered: an explicit field map resolves
 * the two-number ambiguity, and `encoder-link.test.js` proves the layout is
 * read from the device rather than guessed. Neither went the last step and
 * looked at the datagram — so the thing those tests exist to prevent, a
 * timestamp arriving in disguise as a velocity, was never actually asserted
 * against.
 *
 * It is worth asserting because the two are trivially distinguishable in the
 * output but not in the wire format. A timestamp is microseconds since the
 * encoder powered up, so within a second it is past 1,000,000 and climbing
 * monotonically. A velocity at 60 rpm on an 8,192-step encoder is about 8,192
 * and wanders. Anything above VELOCITY_CEILING in the velocity slot is a clock,
 * not a shaft.
 *
 * Neither encoder on the reference rig is in a timestamp mode — both are
 * POSITION_VELOCITY — and changing that writes flash, so this runs against the
 * simulator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { EncoderLink } = require('../src/core/encoder-link');

/** Above this, a value in the velocity slot cannot be a shaft speed. */
const VELOCITY_CEILING = 100000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startMockEncoder(t, flags = {}) {
  const port = await freePort();
  const args = [path.join(__dirname, '..', 'tools', 'mock-encoder.js'), '--port', String(port), '--quiet'];
  for (const [k, v] of Object.entries(flags)) {
    const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (v === true) args.push(flag);
    else if (v !== false && v !== undefined) args.push(flag, String(v));
  }
  const child = spawn(process.execPath, args, { stdio: 'ignore' });

  const deadline = Date.now() + 5000;
  for (;;) {
    if (Date.now() > deadline) { child.kill(); throw new Error('mock encoder did not start'); }
    const up = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  t.after(() => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }));
  return { port };
}

async function sink(t) {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (b) => seen.push(b.toString('latin1')));
  const port = await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
  t.after(() => { try { sock.close(); } catch { /* already closed */ } });
  return { port, seen };
}

function link(t, encPort, d3Port, extra = {}) {
  const l = new EncoderLink(Object.assign({
    id: 't', name: 'test',
    encoder: { host: '127.0.0.1', port: encPort },
    destinations: [{ host: '127.0.0.1', port: d3Port, devid: 1 }],
    reconnect: { enabled: true, minDelayMs: 60, maxDelayMs: 200 }
  }, extra));
  t.after(() => l.stop());
  return l;
}

async function until(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Every datagram, split into its parts. Also proves the shape never changed. */
function parse(datagrams) {
  return datagrams.map((d) => {
    const m = /^(\d+):(-?\d+),(-?\d+);\n$/.exec(d);
    assert.ok(m, `malformed packet for disguise: ${JSON.stringify(d)}`);
    return { devid: Number(m[1]), pos: Number(m[2]), vel: Number(m[3]) };
  });
}

// ---------------------------------------------------------------------------

test('adding a timestamp does not change the packet disguise receives', async (t) => {
  // Three fields on the wire, two in the packet. The extra one must be dropped,
  // not shifted into the velocity slot.
  const mock = await startMockEncoder(t, {
    cycle: 5, motion: 'constant', rpm: 60, outputMode: 'Position_Velocity_Timestamp_'
  });
  const out = await sink(t);
  const l = link(t, mock.port, out.port, { velocityPolicy: 'passthrough' });
  l.start();

  await until(() => out.seen.length >= 25, 8000, 'datagrams');
  const packets = parse(out.seen.slice(0, 25));

  for (const p of packets) {
    assert.equal(p.devid, 1);
    assert.ok(Math.abs(p.vel) < VELOCITY_CEILING,
      `velocity ${p.vel} is timestamp-sized — the third field reached disguise as a speed`);
  }
  // A clock only ever climbs; a velocity does not have to. If the timestamp had
  // been forwarded, these would be strictly increasing across the whole run.
  const strictlyClimbing = packets.every((p, i) => i === 0 || p.vel > packets[i - 1].vel);
  assert.ok(!strictlyClimbing, 'the velocity slot is counting like a clock');
});

test('a position+timestamp encoder sends zero velocity, never the timestamp', async (t) => {
  // The genuinely dangerous layout: two numbers, and the second is microseconds.
  // Inferring from the line alone would put ~1e6 into disguise as a speed.
  const mock = await startMockEncoder(t, {
    cycle: 5, motion: 'constant', rpm: 60, outputMode: 'Position_Timestamp_'
  });
  const out = await sink(t);
  const l = link(t, mock.port, out.port, { velocityPolicy: 'passthrough' });
  l.start();

  await until(() => out.seen.length >= 20, 8000, 'datagrams');
  const packets = parse(out.seen.slice(0, 20));

  for (const p of packets) {
    assert.equal(p.vel, 0,
      `there is no velocity in this layout, so 0 is the only correct value — got ${p.vel}`);
  }
});

test('position still advances with a timestamp in the stream', async (t) => {
  // The parser reads three fields where it used to read two; the position must
  // still come from the first one.
  const mock = await startMockEncoder(t, {
    cycle: 5, motion: 'constant', rpm: 60, outputMode: 'Position_Velocity_Timestamp_'
  });
  const out = await sink(t);
  const l = link(t, mock.port, out.port);
  l.start();

  await until(() => out.seen.length >= 30, 8000, 'datagrams');
  const packets = parse(out.seen.slice(0, 30));
  const distinct = new Set(packets.map((p) => p.pos));
  assert.ok(distinct.size > 3, `position is not moving: ${[...distinct].slice(0, 5).join(', ')}`);
  for (const p of packets) {
    assert.ok(p.pos >= 0 && p.pos < 33554432, `position ${p.pos} is out of range`);
  }
});

test('the timestamp is surfaced to the operator rather than silently dropped', async (t) => {
  // It is not sent to disguise, but the readouts show it — so it has to be
  // parsed into its own field rather than discarded at the line.
  const mock = await startMockEncoder(t, {
    cycle: 5, motion: 'constant', rpm: 60, outputMode: 'Position_Velocity_Timestamp_'
  });
  const out = await sink(t);
  const l = link(t, mock.port, out.port);
  l.start();

  await until(() => {
    const s = l.snapshot();
    return s.telemetry && s.telemetry.ts !== null && s.telemetry.ts !== undefined;
  }, 8000, 'a timestamp in telemetry');

  const first = l.snapshot().telemetry.ts;
  await new Promise((r) => setTimeout(r, 400));
  const later = l.snapshot().telemetry.ts;
  assert.ok(later > first, `the timestamp should advance: ${first} then ${later}`);
});
