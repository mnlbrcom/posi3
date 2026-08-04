'use strict';
/**
 * The encoder's two ASCII forms, end to end.
 *
 * `ASCII_SHORT` sends `<position> <velocity> <time>`; `ASCII` sends
 * `POSITION=… VELOCITY=… TIMESTAMP=…`. The parser had a rule for each and a
 * unit test for each line, but nothing had ever run the verbose form through
 * the link to a datagram — and the simulator could produce it while having no
 * way to be asked for it, so the path was unreachable from a test.
 *
 * What matters is that the choice is invisible downstream: disguise must
 * receive the same packet either way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { EncoderLink } = require('../src/core/encoder-link');

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function rig(t, outputType) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'tools', 'mock-encoder.js'),
    '--port', String(port), '--cycle', '5', '--motion', 'constant', '--rpm', '60',
    '--output-type', outputType, '--quiet'
  ], { stdio: 'ignore' });
  t.after(() => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }));

  const deadline = Date.now() + 5000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('simulator did not start');
    const up = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (b) => seen.push(b.toString('latin1')));
  const d3 = await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
  t.after(() => { try { sock.close(); } catch { /* closed */ } });

  const l = new EncoderLink({
    id: 't', name: 'test',
    encoder: { host: '127.0.0.1', port },
    destinations: [{ host: '127.0.0.1', port: d3, devid: 1 }],
    velocityPolicy: 'passthrough',
    reconnect: { enabled: false }
  });
  t.after(() => l.stop());
  l.start();

  const end = Date.now() + 8000;
  while (seen.length < 30) {
    if (Date.now() > end) throw new Error(`no datagrams in ${outputType}`);
    await new Promise((r) => setTimeout(r, 40));
  }
  return { link: l, seen };
}

const parse = (d) => {
  const m = /^(\d+):(-?\d+),(-?\d+);\n$/.exec(d);
  assert.ok(m, `malformed packet: ${JSON.stringify(d)}`);
  return { devid: Number(m[1]), pos: Number(m[2]), vel: Number(m[3]) };
};

test('verbose ASCII produces the same packets as ASCII_SHORT', async (t) => {
  const verbose = await rig(t, 'ASCII');
  const packets = verbose.seen.slice(0, 30).map(parse);

  for (const p of packets) {
    assert.equal(p.devid, 1);
    assert.equal(p.vel, 8192, 'the velocity survives the verbose form');
    assert.ok(p.pos >= 0 && p.pos < 33554432);
  }
  const tel = verbose.link.snapshot().telemetry;
  assert.equal(tel.unknownLines, 0, 'every verbose line parsed');
  assert.equal(tel.errors, 0);
  assert.ok(tel.ts > 0, 'the timestamp is read out of the verbose form too');
});

test('the choice of ASCII form is invisible to disguise', async (t) => {
  // The point of the setting: an encoder may be in either form because another
  // client on the same socket needs it, and the bridge must not care.
  const short = await rig(t, 'ASCII_SHORT');
  const verbose = await rig(t, 'ASCII');

  const velsOf = (r) => new Set(r.seen.slice(0, 30).map((d) => parse(d).vel));
  assert.deepEqual([...velsOf(short)], [...velsOf(verbose)],
    'the same shaft speed reaches disguise from either form');

  for (const r of [short, verbose]) {
    assert.equal(r.link.snapshot().telemetry.unknownLines, 0);
  }
});
