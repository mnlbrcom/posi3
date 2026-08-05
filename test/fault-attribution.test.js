'use strict';
/**
 * Which errors are faults in the stream, and which are answers to a question.
 *
 * The encoder sends `ERROR:` for both. A refused `set`, or a read of a
 * write-only variable, says something went wrong with a command. A complaint
 * nobody asked for says something is wrong with the device or the data. They
 * were counted together, so a bad configuration write sat on the show dashboard
 * as a permanent fault next to figures that mean the position feed is in
 * trouble.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');

const { EncoderLink } = require('../src/core/encoder-link');

/** A minimal encoder: streams, and answers whatever the test tells it to. */
async function fakeEncoder(t, onCommand) {
  const clients = [];
  const server = net.createServer((sock) => {
    clients.push(sock);
    const tick = setInterval(() => { try { sock.write('1000 0 \n'); } catch { /* closed */ } }, 25);
    sock.on('close', () => clearInterval(tick));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const reply = onCommand(line);
        if (reply) sock.write(`${reply}\r\n`);
      }
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => { for (const c of clients) c.destroy(); server.close(); });
  return { port, push: (line) => { for (const c of clients) c.write(`${line}\r\n`); } };
}

async function sink(t) {
  const sock = dgram.createSocket('udp4');
  const port = await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
  t.after(() => { try { sock.close(); } catch { /* closed */ } });
  return { port };
}

const until = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

function link(t, encPort, d3Port) {
  const l = new EncoderLink({
    id: 't', name: 'test',
    encoder: { host: '127.0.0.1', port: encPort },
    destinations: [{ host: '127.0.0.1', port: d3Port, devid: 1 }],
    reconnect: { enabled: false }
  });
  t.after(() => l.stop());
  return l;
}

/**
 * Answers every read except one, so the link's own connect-time reads settle
 * and nothing is left in flight. That matters: the encoder broadcasts errors
 * to every client, so an error arriving while a command is outstanding is
 * attributed to it — the same assumption the command queue already makes to
 * resolve replies. A test that leaves reads hanging measures that assumption
 * rather than the counters.
 */
const answersExcept = (bad) => (line) => {
  // `Version` is a bare command, not a variable. The link asks on connect, so a
  // fake that ignores it leaves a request in flight for the whole read timeout
  // — and then swallows the next unsolicited error as its reply.
  if (/^Version$/i.test(line)) return 'Software Version 4.50';
  const m = /^read (\w+)/.exec(line);
  if (!m) return null;
  return m[1] === bad ? 'ERROR: unknown variable' : `${m[1]}=1`;
};

/** No command outstanding, so the next error cannot be mistaken for a reply. */
const settle = async (l) => {
  await until(() => l.snapshot().state === 'streaming', 5000, 'streaming');
  await new Promise((r) => setTimeout(r, 600));
};

test('an error answering our own command is not a fault in the stream', async (t) => {
  const enc = await fakeEncoder(t, answersExcept('Verbose'));
  const out = await sink(t);
  const l = link(t, enc.port, out.port);
  l.start();
  await settle(l);

  const before = l.snapshot().telemetry;
  await l.read('Verbose').then(() => null, () => null);
  await until(() => l.snapshot().telemetry.commandErrors > before.commandErrors, 5000, 'a counted rejection');

  const after = l.snapshot().telemetry;
  assert.equal(after.commandErrors - before.commandErrors, 1, 'the rejection is counted once, as a command error');
  assert.equal(after.errors, before.errors, 'and never as a fault in the data path');
});

test('an error nobody asked for is a fault', async (t) => {
  const enc = await fakeEncoder(t, answersExcept(null));
  const out = await sink(t);
  const l = link(t, enc.port, out.port);
  l.start();
  await settle(l);

  const before = l.snapshot().telemetry;
  enc.push('ERROR: something is wrong');
  await until(() => l.snapshot().telemetry.errors > before.errors, 5000, 'a counted fault');

  const after = l.snapshot().telemetry;
  assert.equal(after.errors - before.errors, 1);
  assert.equal(after.commandErrors, before.commandErrors, 'nothing was asked, so nothing was refused');
});

test('both counters describe the current run', async (t) => {
  // start() resets the rest of the counters; a rejection surviving a restart
  // would show a fault from a connection that no longer exists.
  const enc = await fakeEncoder(t, answersExcept('Verbose'));
  const out = await sink(t);
  const l = link(t, enc.port, out.port);
  l.start();
  await settle(l);
  await l.read('Verbose').then(() => null, () => null);
  await until(() => l.snapshot().telemetry.commandErrors > 0, 5000, 'a rejection');

  l.stop();
  l.start();
  assert.equal(l.snapshot().telemetry.commandErrors, 0, 'a new run starts clean');
});

test('an error settling the stall probe proves life, and is not a death', () => {
  // The encoder broadcasts every client's replies and errors down the shared
  // TCP socket, and the command queue settles the in-flight request on any
  // ERROR line. So another client fumbling a command while our Run! probe was
  // in flight rejected the probe — and the catch tore down a connection to an
  // encoder that had just audibly answered. Only silence means dead.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'encoder-link.js'), 'utf8');
  const probe = src.slice(src.indexOf("this._commands.submit('Run!'"));
  const katch = probe.slice(probe.indexOf('.catch'), probe.indexOf('});', probe.indexOf('.catch')));
  assert.match(katch, /EENCODER/, 'the encoder-spoke case is distinguished');
  assert.ok(katch.indexOf('EENCODER') < katch.indexOf('_handleDisconnect'),
    'and handled before the only-silence-means-dead teardown');
});
