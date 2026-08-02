'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandQueue, matchVariable, matchSample } = require('../src/core/command-queue');
const { Parser } = require('../src/core/protocol');

/** Wire a queue to a capture array, and feed it lines through the real parser. */
function harness() {
  const sent = [];
  const parser = new Parser();
  const q = new CommandQueue({ send: (line) => sent.push(line) });
  return {
    q,
    sent,
    feed: (line) => q.handleParsed(parser.classify(line))
  };
}

test('read resolves on the echoed variable', async () => {
  const h = harness();
  const req = h.q.submit('read CycleTime', { match: matchVariable('CycleTime'), timeoutMs: 500 });
  assert.deepEqual(h.sent, ['read CycleTime']);
  assert.equal(h.feed('CycleTime=10'), true);
  const r = await req;
  assert.equal(r.variable, 'CycleTime');
  assert.equal(r.value, '10');
});

test('variable matching is case-insensitive', async () => {
  const h = harness();
  const req = h.q.submit('read cycletime', { match: matchVariable('cycletime'), timeoutMs: 500 });
  h.feed('CycleTime=42');
  assert.equal((await req).value, '42');
});

test('samples and unrelated lines pass through without consuming the request', async () => {
  const h = harness();
  const req = h.q.submit('read CycleTime', { match: matchVariable('CycleTime'), timeoutMs: 500 });
  // Data continues to flow on the same socket while the command is outstanding.
  assert.equal(h.feed('12345 0 999'), false);
  assert.equal(h.feed('OutputType=ASCII_SHORT'), false);
  assert.equal(h.feed('CycleTime=7'), true);
  assert.equal((await req).value, '7');
});

test('the flash-commit broadcast never satisfies a request', async () => {
  const h = harness();
  const req = h.q.submit('set CycleTime=5', { match: matchVariable('CycleTime'), timeoutMs: 500 });
  assert.equal(h.feed('Parameters successfully written!'), false);
  h.feed('CycleTime=5');
  assert.equal((await req).value, '5');
});

test('an ERROR line rejects the outstanding request', async () => {
  const h = harness();
  const req = h.q.submit('set Foo=1', { match: matchVariable('Foo'), timeoutMs: 500 });
  assert.equal(h.feed('ERROR: unknown variable Foo'), true);
  await assert.rejects(req, (e) => e.code === 'EENCODER' && /unknown variable/.test(e.message));
});

test('a request that is never answered times out and frees the queue', async () => {
  const h = harness();
  const first = h.q.submit('read Ghost', { match: matchVariable('Ghost'), timeoutMs: 60, label: 'read Ghost' });
  const second = h.q.submit('read CycleTime', { match: matchVariable('CycleTime'), timeoutMs: 500 });

  // Strictly serialised: the second command is not written until the first settles.
  assert.deepEqual(h.sent, ['read Ghost']);
  await assert.rejects(first, (e) => e.code === 'ETIMEDOUT');
  assert.deepEqual(h.sent, ['read Ghost', 'read CycleTime']);

  h.feed('CycleTime=10');
  assert.equal((await second).value, '10');
});

test('requests are issued one at a time, in order', async () => {
  const h = harness();
  const a = h.q.submit('read A', { match: matchVariable('A'), timeoutMs: 500 });
  const b = h.q.submit('read B', { match: matchVariable('B'), timeoutMs: 500 });
  const c = h.q.submit('read C', { match: matchVariable('C'), timeoutMs: 500 });
  assert.equal(h.q.pending, 3);
  assert.deepEqual(h.sent, ['read A']);

  h.feed('A=1');
  await a;
  assert.deepEqual(h.sent, ['read A', 'read B']);

  h.feed('B=2');
  await b;
  h.feed('C=3');
  assert.equal((await c).value, '3');
  assert.equal(h.q.pending, 0);
});

test('expectsSample is only set for sample-answered commands', async () => {
  const h = harness();
  const req = h.q.submit('Run!', { match: matchSample(), expectsSample: true, timeoutMs: 500 });
  assert.equal(h.q.expectsSample, true);
  assert.equal(h.feed('4242 0 999'), true);
  const r = await req;
  assert.equal(r.pos, 4242);
  assert.equal(h.q.expectsSample, false);
});

test('rejectAll fails the in-flight request and the whole backlog', async () => {
  const h = harness();
  const a = h.q.submit('read A', { match: matchVariable('A'), timeoutMs: 5000 });
  const b = h.q.submit('read B', { match: matchVariable('B'), timeoutMs: 5000 });
  h.q.rejectAll(new Error('connection closed'));
  await assert.rejects(a, /connection closed/);
  await assert.rejects(b, /connection closed/);
  assert.equal(h.q.pending, 0);
});

test('a send failure rejects rather than wedging the queue', async () => {
  const q = new CommandQueue({
    send: () => { throw new Error('not connected'); }
  });
  await assert.rejects(q.submit('read A', { match: matchVariable('A'), timeoutMs: 500 }), /not connected/);
  assert.equal(q.pending, 0);
});
