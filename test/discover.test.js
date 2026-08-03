'use strict';
/**
 * Encoder discovery.
 *
 * POSITAL documents no discovery mechanism, so this probes TCP 6000 across a
 * subnet. The tests that matter most are not "does it find one" but the
 * constraints around it: the subnet is derived from the machine's own
 * interfaces rather than the caller, wide masks are refused instead of
 * silently clipped, and a hit is disconnected as soon as it is identified —
 * the encoder accepts only a handful of clients.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  probe, hostsInSubnet, subnetSize, maskBits, ipToInt, intToIp, scanSubnet, MAX_HOSTS
} = require('../src/core/discover');

// -- address maths ----------------------------------------------------------

test('masks convert to prefix lengths', () => {
  assert.equal(maskBits('255.255.255.0'), 24);
  assert.equal(maskBits('255.255.0.0'), 16);
  assert.equal(maskBits('255.255.255.252'), 30);
});

test('a subnet excludes its network and broadcast addresses', () => {
  const hosts = hostsInSubnet('10.10.10.2', '255.255.255.0');
  assert.equal(hosts.length, 253, '254 usable, minus this machine');
  assert.ok(!hosts.includes('10.10.10.0'), 'network address');
  assert.ok(!hosts.includes('10.10.10.255'), 'broadcast address');
  assert.ok(!hosts.includes('10.10.10.2'), 'the scanning machine itself');
  assert.ok(hosts.includes('10.10.10.10'), 'the factory default address');
});

test('a /24 is scannable and a /16 is not', () => {
  assert.equal(subnetSize('255.255.255.0'), 254);
  assert.ok(subnetSize('255.255.255.0') <= MAX_HOSTS);
  assert.ok(subnetSize('255.255.0.0') > MAX_HOSTS, '65,534 addresses must be refused, not clipped');
});

test('addresses round-trip', () => {
  for (const ip of ['0.0.0.0', '10.10.10.10', '192.168.1.255', '255.255.255.255']) {
    assert.equal(intToIp(ipToInt(ip)), ip);
  }
  assert.equal(ipToInt('10.10.10.256'), null, 'octet out of range');
  assert.equal(ipToInt('10.10.10'), null, 'three octets');
});

// -- probing ----------------------------------------------------------------

/** A server that answers a `read` the way the encoder does. */
function fakeEncoder(mode) {
  const sockets = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    if (mode === 'cyclic') {
      sock.write('12345 0 \n');
      sock.streamer = setInterval(() => { try { sock.write('12346 0 \n'); } catch { /* closed */ } }, 20);
      sock.on('close', () => clearInterval(sock.streamer));
    }
    sock.on('data', (d) => {
      if (mode === 'polled' && /read TotalScaledRes/i.test(d.toString())) {
        sock.write('TotalScaledRes=300000\r\n');
      }
    });
  });
  return { server, sockets };
}

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

test('a streaming encoder is identified from its samples alone', async (t) => {
  const { server } = fakeEncoder('cyclic');
  const port = await listen(server);
  t.after(() => server.close());

  const hit = await probe('127.0.0.1', { port, timeoutMs: 2000 });
  assert.ok(hit, 'should have been found');
  assert.equal(hit.evidence, 'streaming position data');
});

test('a polled encoder is identified from its reply', async (t) => {
  const { server } = fakeEncoder('polled');
  const port = await listen(server);
  t.after(() => server.close());

  const hit = await probe('127.0.0.1', { port, timeoutMs: 2000 });
  assert.ok(hit, 'should have been found');
  assert.equal(hit.totalScaledRes, 300000, 'the scaling comes back with it');
});

test('the socket is closed as soon as the encoder is identified', async (t) => {
  // The encoder accepts only a handful of clients; a scan that lingers on one
  // is a scan that can stop a desk connecting during a show.
  const { server, sockets } = fakeEncoder('polled');
  const port = await listen(server);
  t.after(() => server.close());

  await probe('127.0.0.1', { port, timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(sockets.length, 1);
  assert.ok(sockets[0].destroyed || !sockets[0].writable, 'the probe must not hold the slot open');
});

test('something else listening on the port is not an encoder', async (t) => {
  const server = net.createServer((sock) => sock.write('HTTP/1.1 200 OK\r\n\r\n<html>'));
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal(await probe('127.0.0.1', { port, timeoutMs: 600 }), null,
    'an open port is not evidence; the device has to behave like an encoder');
});

test('a closed port answers quickly and negatively', async () => {
  // Port 1 on loopback: nothing listens, so this is the refused-connection path.
  assert.equal(await probe('127.0.0.1', { port: 1, timeoutMs: 2000 }), null);
});

// -- the safety property ----------------------------------------------------

test('the scan target must be an address this machine owns', async () => {
  // Otherwise the endpoint is a port scanner with an HTTP front end.
  await assert.rejects(
    () => scanSubnet({ localAddress: '203.0.113.7' }),
    (err) => err.code === 'EINVAL'
  );
});

test('a BSD mac is padded so prefixes can be compared', () => {
  const { normaliseMac } = require('../src/core/discover');
  // macOS prints 0:e:cf:14:10:67 for what is really 00:0e:cf:14:10:67, and an
  // unpadded prefix test would miss every encoder on the segment.
  assert.equal(normaliseMac('0:e:cf:14:10:67'), '00:0e:cf:14:10:67');
  assert.equal(normaliseMac('00:0E:CF:14:10:67'), '00:0e:cf:14:10:67');
});

test('reading the neighbour table never throws, whatever the platform prints', async () => {
  const { arpNeighbours } = require('../src/core/discover');
  const list = await arpNeighbours();
  assert.ok(Array.isArray(list), 'a missing or unparsable arp must yield a list, not an error');
  for (const n of list) {
    assert.match(n.host, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(n.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  }
});
