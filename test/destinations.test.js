'use strict';
/**
 * Fan-out to several disguise servers.
 *
 * A redundant disguise rig — director plus understudy plus actors — needs the
 * same tracking data on every machine that might take over. Doing that by
 * defining a second connection would open a second TCP socket to an encoder
 * that only accepts a handful of clients, so the fan-out happens on the UDP
 * side of one link.
 *
 * The load-bearing test here is the first one: with a single destination the
 * bytes on the wire must still be exactly what the 2016 driver produced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { EncoderLink } = require('../src/core/encoder-link');
const { sanitiseConnection } = require('../src/server/validate');

/** A UDP listener that resolves once it has collected `n` datagrams. */
function sink() {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  let want = 0;
  let resolve = null;

  sock.on('message', (buf) => {
    seen.push(buf.toString('latin1'));
    if (resolve && seen.length >= want) { resolve(seen); resolve = null; }
  });

  return {
    seen,
    listen: () => new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port))),
    take: (n, ms = 1500) => new Promise((res, rej) => {
      want = n;
      if (seen.length >= n) return res(seen);
      resolve = res;
      setTimeout(() => rej(new Error(`only ${seen.length}/${n} datagrams arrived`)), ms);
    }),
    close: () => sock.close()
  };
}

/** Drive _forward directly: this is about the send path, not the TCP parser. */
function linkTo(destinations) {
  return new EncoderLink({
    id: 't', name: 't',
    encoder: { host: '127.0.0.1', port: 6000 },
    destinations
  });
}

async function settle(link) {
  link._openUdp();
  // Give dgram.connect() a moment to mark each sink ready.
  for (let i = 0; i < 50 && link._sinks.some((s) => !s.ready); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('one destination still emits the exact legacy bytes', async () => {
  const s = sink();
  const port = await s.listen();
  const link = linkTo([{ host: '127.0.0.1', port, devid: 1 }]);
  await settle(link);

  link._forward(12345, 0);
  const [first] = await s.take(1);

  // The contract with every existing disguise project.
  assert.equal(first, '1:12345,0;\n');

  link.stop();
  s.close();
});

test('every enabled destination receives the same sample', async () => {
  const a = sink();
  const b = sink();
  const [pa, pb] = [await a.listen(), await b.listen()];
  const link = linkTo([
    { host: '127.0.0.1', port: pa, devid: 4 },
    { host: '127.0.0.1', port: pb, devid: 4 }
  ]);
  await settle(link);

  link._forward(777, 0);
  assert.deepEqual(await a.take(1), ['4:777,0;\n']);
  assert.deepEqual(await b.take(1), ['4:777,0;\n']);

  link.stop();
  a.close();
  b.close();
});

test('a destination can override the device id', async () => {
  // Two disguise rigs may have been commissioned with different axis numbers;
  // forcing them to agree would mean re-patching one of the shows.
  const a = sink();
  const b = sink();
  const [pa, pb] = [await a.listen(), await b.listen()];
  const link = linkTo([
    { host: '127.0.0.1', port: pa, devid: 1 },
    { host: '127.0.0.1', port: pb, devid: 9 }
  ]);
  await settle(link);

  link._forward(500, 0);
  assert.deepEqual(await a.take(1), ['1:500,0;\n']);
  assert.deepEqual(await b.take(1), ['9:500,0;\n']);

  link.stop();
  a.close();
  b.close();
});

test('a disabled destination receives nothing', async () => {
  const a = sink();
  const b = sink();
  const [pa, pb] = [await a.listen(), await b.listen()];
  const link = linkTo([
    { host: '127.0.0.1', port: pa, devid: 1 },
    { host: '127.0.0.1', port: pb, devid: 1, enabled: false }
  ]);
  await settle(link);

  link._forward(1, 0);
  await a.take(1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(b.seen.length, 0);
  assert.equal(link._sinks.length, 1, 'no socket should be opened for a disabled destination');

  link.stop();
  a.close();
  b.close();
});

test('telemetry counts sends per destination', async () => {
  const a = sink();
  const b = sink();
  const [pa, pb] = [await a.listen(), await b.listen()];
  const link = linkTo([
    { host: '127.0.0.1', port: pa, devid: 1, name: 'director' },
    { host: '127.0.0.1', port: pb, devid: 1, name: 'understudy' }
  ]);
  await settle(link);

  link._forward(1, 0);
  link._forward(2, 0);
  await a.take(2);

  const t = link.telemetry();
  assert.equal(t.destinations.length, 2);
  assert.deepEqual(t.destinations.map((d) => d.name), ['director', 'understudy']);
  for (const d of t.destinations) assert.equal(d.tx, 2);
  assert.equal(t.txTotal, 4, 'the link total counts every datagram sent');

  link.stop();
  a.close();
  b.close();
});

test('stopping closes every socket', async () => {
  const a = sink();
  const b = sink();
  const link = linkTo([
    { host: '127.0.0.1', port: await a.listen(), devid: 1 },
    { host: '127.0.0.1', port: await b.listen(), devid: 1 }
  ]);
  await settle(link);
  assert.equal(link._sinks.length, 2);
  link.stop();
  assert.equal(link._sinks.length, 0);
  a.close();
  b.close();
});

// -- schema ------------------------------------------------------------------

test('a schema-1 profile with a lone d3 is accepted and promoted', () => {
  const out = sanitiseConnection({
    name: 'legacy',
    encoder: { host: '192.0.2.20', port: 6000 },
    d3: { host: '192.0.2.47', port: 6000, devid: 3 }
  });
  assert.equal(out.destinations.length, 1);
  assert.equal(out.destinations[0].host, '192.0.2.47');
  assert.equal(out.destinations[0].devid, 3);
  // …and the mirror the mapping screen reads stays in step.
  assert.equal(out.d3.devid, 3);
});

test('duplicate destinations are rejected', () => {
  assert.throws(() => sanitiseConnection({
    name: 'x',
    encoder: { host: '192.0.2.20', port: 6000 },
    destinations: [
      { host: '192.0.2.1', port: 6000, devid: 1 },
      { host: '192.0.2.1', port: 6000, devid: 1 }
    ]
  }), (err) => err.code === 'EINVAL' && /Duplicate destination/.test(err.message));
});

test('the same host and port with different device ids is allowed', () => {
  // One disguise machine can legitimately receive two axes from one encoder.
  const out = sanitiseConnection({
    name: 'x',
    encoder: { host: '192.0.2.20', port: 6000 },
    destinations: [
      { host: '192.0.2.1', port: 6000, devid: 1 },
      { host: '192.0.2.1', port: 6000, devid: 2 }
    ]
  });
  assert.equal(out.destinations.length, 2);
});

test('fan-out is bounded', () => {
  const many = Array.from({ length: 17 }, (_, i) => ({ host: '192.0.2.1', port: 6000, devid: i }));
  assert.throws(
    () => sanitiseConnection({ name: 'x', encoder: { host: '192.0.2.20', port: 6000 }, destinations: many }),
    (err) => err.code === 'EINVAL' && /At most 16/.test(err.message)
  );
});
