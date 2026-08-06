'use strict';
/**
 * The venue-argument tool must not repair the defect it exists to catch.
 *
 * disguise drops the final axis when a record's trailing `;` is missing. The
 * sink's old loop split on `;` and re-appended one before matching, so an
 * unterminated stream still parsed clean — the tool would certify exactly the
 * stream disguise truncates. An old FEATURES note; closed here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDatagram } = require('../tools/udp-sink');

test('terminated records parse, in singles and batches', () => {
  assert.deepEqual(parseDatagram('1:12345,0;\n'),
    { records: [{ id: 1, pos: 12345, vel: 0 }], malformed: 0 });
  assert.deepEqual(parseDatagram('1:1,0;2:2,-5;\n').records,
    [{ id: 1, pos: 1, vel: 0 }, { id: 2, pos: 2, vel: -5 }]);
  assert.deepEqual(parseDatagram(''), { records: [], malformed: 0 });
});

test('a missing trailing terminator is malformed, not silently repaired', () => {
  const alone = parseDatagram('1:12345,0');
  assert.equal(alone.records.length, 0, 'disguise would drop this axis; so must we');
  assert.equal(alone.malformed, 1);

  const tail = parseDatagram('1:1,0;2:2,0');
  assert.deepEqual(tail.records, [{ id: 1, pos: 1, vel: 0 }],
    'the terminated prefix still counts');
  assert.equal(tail.malformed, 1, 'and the unterminated tail is the defect');

  assert.equal(parseDatagram('garbage;\n').malformed, 1);
});
