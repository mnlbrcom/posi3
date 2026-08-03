'use strict';
/**
 * The variable table against what the hardware actually says.
 *
 * The manual, POSITAL's applet and the device itself use three different
 * spellings for the same values, and the ranges in the table were plain 32-bit
 * integer limits rather than anything the encoder can accept. Both produce
 * quiet wrongness: a dropdown showing the wrong current mode, or a field
 * inviting a value the device will refuse.
 *
 * The strings below are exactly what the reference encoder at 10.10.10.10
 * returned on 2026-08-03.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENCODER_VARS, MAX_RESOLUTION, COUNTS_PER_REV, REVOLUTIONS, TOTAL_COUNTS
} = require('../src/shared/constants');

const byName = (n) => ENCODER_VARS.find((v) => v.name === n);

/** The same resolution the UI's enum control does. Kept in step by these tests. */
function resolve(spec, value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!key) return '';
  const exact = spec.values.find((o) => o.toLowerCase().replace(/[\s_-]/g, '') === key);
  if (exact) return exact;
  return (spec.aliases && spec.aliases[key]) || '';
}

// -- what the device returned -------------------------------------------------

const OBSERVED = {
  OutputType: 'ASCII_SHORT',
  OutputMode: 'POSITION_VELOCITY',
  TimeMode: 'CYCLIC',
  CountingDir: 'CW',
  Verbose: '2',
  AutoArpCacheUpdate: '0'
};

test('every enum value the encoder returned resolves to a known option', () => {
  for (const [name, value] of Object.entries(OBSERVED)) {
    const spec = byName(name);
    if (!spec || spec.type !== 'enum') continue;
    assert.notEqual(resolve(spec, value), '',
      `${name}="${value}" does not resolve — the dropdown would show the wrong mode`);
  }
});

test('TimeMode accepts the device spelling and the applet spelling', () => {
  const spec = byName('TimeMode');
  // The device answers in upper case…
  assert.equal(resolve(spec, 'CYCLIC'), 'Cyclic');
  assert.equal(resolve(spec, 'POLLED'), 'Polled');
  // …and POSITAL's own applet labels the third mode COS.
  assert.equal(resolve(spec, 'COS'), 'Change of state');
  assert.equal(resolve(spec, 'Change of state'), 'Change of state');
  // Something genuinely unknown must not be silently mapped to an option.
  assert.equal(resolve(spec, 'TURBO'), '');
});

test('OutputType resolves regardless of case', () => {
  const spec = byName('OutputType');
  assert.equal(resolve(spec, 'ASCII_SHORT'), 'ASCII_SHORT');
  assert.equal(resolve(spec, 'ascii_short'), 'ASCII_SHORT');
  assert.equal(resolve(spec, 'BINARY'), 'BINARY');
});

// -- ranges, manual §1.1 p.4 --------------------------------------------------

test('the resolution ceiling is the family maximum, not a 32-bit integer limit', () => {
  // "maximum resolution of 65,536 steps per revolution (16 Bit) […] up to
  // 16,384 revolutions (14 Bit). Therefore the largest resulting resolution is
  // 30 Bit = 1,073,741,824 steps."
  assert.equal(MAX_RESOLUTION, 65536 * 16384);
  assert.equal(MAX_RESOLUTION, 2 ** 30);
  for (const name of ['UsedScopeOfPhysRes', 'TotalScaledRes']) {
    assert.equal(byName(name).max, MAX_RESOLUTION, `${name} must stop at the family maximum`);
  }
  for (const name of ['Preset', 'Offset']) {
    assert.equal(byName(name).max, MAX_RESOLUTION - 1, `${name} is a position, so one less`);
  }
});

test('this encoder model sits inside the family ceiling', () => {
  assert.equal(COUNTS_PER_REV, 8192);   // 13 bit singleturn
  assert.equal(REVOLUTIONS, 4096);      // 12 bit multiturn
  assert.equal(TOTAL_COUNTS, 33554432); // 25 bit
  assert.ok(TOTAL_COUNTS < MAX_RESOLUTION);
});

test('CycleTime spans exactly what the manual documents', () => {
  // Manual p.19: "Can have values between 1 ms and 999,999 ms."
  const spec = byName('CycleTime');
  assert.equal(spec.min, 1);
  assert.equal(spec.max, 999999);
  assert.equal(spec.unit, 'ms');
});

test('Preset is write-only and says why', () => {
  // `read Preset` answers "Preset is an unknown variable"; POSITAL's own applet
  // shows the pair as one "Preset/Offset" row — you write a Preset and read
  // back an Offset.
  assert.equal(byName('Preset').writeOnly, true);
  assert.ok(!byName('Offset').writeOnly, 'Offset is the readable half of the pair');
});

test('every variable has a range or a value set, so no field is unbounded', () => {
  for (const v of ENCODER_VARS) {
    if (v.type === 'int') {
      assert.equal(typeof v.min, 'number', `${v.name} needs a minimum`);
      assert.equal(typeof v.max, 'number', `${v.name} needs a maximum`);
      assert.ok(v.max > v.min, `${v.name} range is inverted`);
    } else if (v.type === 'enum') {
      assert.ok(Array.isArray(v.values) && v.values.length, `${v.name} needs values`);
    }
  }
});
