'use strict';
/**
 * No test fixture may point at the encoder subnet.
 *
 * A fixture on 10.x is one refactor away from real hardware: a test that
 * omitted its address inherited `defaultConnection()`'s 10.10.10.10 — the
 * live encoder on this rig — reached a write path nobody thought it could,
 * and moved the device's zero point (Offset 43156 → 124642). Addresses in
 * fixtures are loopback when a socket may open, and TEST-NET-1 (192.0.2.0/24,
 * reserved and routed nowhere) when they are pure data.
 *
 * Comments citing rig measurements keep their addresses — they are history,
 * not fixtures — and discover/write-validation test the factory address as a
 * *string* through pure functions, so only host fields are policed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no fixture host lives on a routable private subnet', () => {
  const offences = [];
  for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith('.test.js')) continue;
    const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/host:\s*['"`]10\./.test(code) || /host:\s*['"`]172\.16\./.test(code) ||
          /host:\s*['"`]192\.168\./.test(code)) {
        offences.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offences, [],
    `fixture hosts on routable subnets:\n${offences.join('\n')}`);
});
