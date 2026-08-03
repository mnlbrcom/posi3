'use strict';
/**
 * The browser cannot import `src/shared/mapping.js` — it is CommonJS and is not
 * served — so `src/web/js/mapping-span.js` carries a copy of `inputSpan`. Two
 * copies of a rule is how the travel bar came to disagree with the mapping
 * helper about the same encoder, so this runs identical inputs through both and
 * fails the moment they part company.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const shared = require('../src/shared/mapping.js');

const CASES = [
  { name: 'full range, device scaled to 300 000', mode: 'full', countsPerRev: 8192, totalCounts: 300000 },
  { name: 'full range, nameplate device', mode: 'full', countsPerRev: 8192, totalCounts: 33554432 },
  { name: 'full range, device has not reported yet', mode: 'full' },
  { name: 'one revolution', mode: 'revolutions', revolutions: 1, countsPerRev: 8192, totalCounts: 300000 },
  { name: 'quarter turn', mode: 'revolutions', revolutions: 0.25, countsPerRev: 8192, totalCounts: 300000 },
  { name: 'geared 3:1', mode: 'revolutions', revolutions: 2, gearRatio: 3, countsPerRev: 8192, totalCounts: 300000 },
  { name: 'captured span', mode: 'capture', minInput: 1000, maxInput: 250000, totalCounts: 300000 },
  { name: 'captured span across the wrap', mode: 'capture', minInput: 280000, maxInput: 20000, totalCounts: 300000 }
];

test('the web copy of inputSpan agrees with the shared one', async () => {
  const web = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'web', 'js', 'mapping-span.js')).href);
  for (const c of CASES) {
    assert.deepEqual(web.inputSpan(c), shared.inputSpan(c), `disagreement for: ${c.name}`);
  }
});

test('a re-scaled encoder puts the travel bar where the shaft actually is', async () => {
  const web = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'web', 'js', 'mapping-span.js')).href);
  // The reference rig: nameplate 33 554 432, actually commissioned to 300 000.
  // Reading the stored maxInput gave 0.6% of the bar; the span gives ~70%.
  const span = web.inputSpan({ mode: 'full', countsPerRev: 8192, totalCounts: 300000 });
  const frac = (208843 - span.minInput) / (span.maxInput - span.minInput);
  assert.ok(frac > 0.69 && frac < 0.70, `expected about 0.696 of the range, got ${frac}`);

  const stale = (208843 - 0) / (33554431 - 0);
  assert.ok(stale < 0.01, 'sanity: the stored nameplate default is what made the bar look dead');
});
