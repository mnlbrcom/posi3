'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LineAssembler } = require('../src/core/line-assembler');

const b = (s) => Buffer.from(s, 'latin1');

test('one record per chunk', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('100 0 5\n')), ['100 0 5']);
  assert.deepEqual(la.pushAll(b('101 0 7\n')), ['101 0 7']);
  assert.equal(la.pending, 0);
});

test('coalesced records in one chunk are all returned', () => {
  // This is the legacy driver's fatal case: it parsed only "1 0 1" and
  // silently dropped the other four.
  const la = new LineAssembler();
  const lines = la.pushAll(b('1 0 1\n2 0 2\n3 0 3\n4 0 4\n5 0 5\n'));
  assert.deepEqual(lines, ['1 0 1', '2 0 2', '3 0 3', '4 0 4', '5 0 5']);
  assert.equal(la.pending, 0);
});

test('a record split mid-number across two chunks is reassembled', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('123')), []);
  assert.equal(la.pending, 3);
  assert.deepEqual(la.pushAll(b('4567 0 9\n')), ['1234567 0 9']);
});

test('a record split into single bytes still arrives intact', () => {
  const la = new LineAssembler();
  const src = '12345678 -42 999\n';
  const out = [];
  for (const ch of src) la.push(b(ch), (l) => out.push(l));
  assert.deepEqual(out, ['12345678 -42 999']);
});

test('a split exactly between CR and LF is handled', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('7 0 1\r')), []);
  assert.deepEqual(la.pushAll(b('\n8 0 2\r\n')), ['7 0 1', '8 0 2']);
});

test('CRLF and bare LF may be mixed in one stream', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('a\r\nb\nc\r\n')), ['a', 'b', 'c']);
});

test('empty lines are swallowed', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('\n')), []);
  assert.deepEqual(la.pushAll(b('\r\n')), []);
  assert.deepEqual(la.pushAll(b('x\n\n\ny\n')), ['x', 'y']);
});

test('a trailing partial line is retained, not emitted', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.pushAll(b('1 0 1\n2 0')), ['1 0 1']);
  assert.equal(la.pending, 3);
  assert.deepEqual(la.pushAll(b(' 2\n')), ['2 0 2']);
});

test('overflow guard fires when no terminator ever arrives (BINARY mode)', () => {
  const overflows = [];
  const la = new LineAssembler({ maxLineBytes: 1024, onOverflow: (n) => overflows.push(n) });
  for (let i = 0; i < 20; i++) la.pushAll(Buffer.alloc(100, 0x41));
  assert.equal(overflows.length, 1);
  assert.ok(overflows[0] > 1024);
  assert.equal(la.stats.overflows, 1);
  // Buffering stops rather than growing without bound while sync is lost.
  assert.ok(la.pending <= 1024);
});

test('after an overflow it resynchronises on the next record boundary', () => {
  const la = new LineAssembler({ maxLineBytes: 512 });
  la.pushAll(Buffer.alloc(1000, 0x41));
  // The tail of the garbage must be discarded, not fused onto the next line.
  assert.deepEqual(la.pushAll(b('BBBB\n1 0 1\n')), ['1 0 1']);
  // ...and normal operation continues from there.
  assert.deepEqual(la.pushAll(b('2 0 2\n')), ['2 0 2']);
});

test('reset drops the partial line so stale bytes cannot cross a reconnect', () => {
  const la = new LineAssembler();
  la.pushAll(b('999999'));
  assert.equal(la.pending, 6);
  la.reset();
  assert.equal(la.pending, 0);
  assert.deepEqual(la.pushAll(b('1 0 1\n')), ['1 0 1']);
});

test('stats track chunks, bytes and lines', () => {
  const la = new LineAssembler();
  la.pushAll(b('a\nb\n'));
  la.pushAll(b('c\n'));
  assert.equal(la.stats.chunks, 2);
  assert.equal(la.stats.bytes, 6);
  assert.equal(la.stats.lines, 3);
});
