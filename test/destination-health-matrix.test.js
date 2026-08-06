'use strict';
/**
 * The destination pill's complete decision matrix.
 *
 * The health of a destination is judged from five kinds of evidence — link
 * running, send recency, send errors and their quiet, ping verdicts, and the
 * disguise answer — and the judgement accreted as guard clauses, one per fix.
 * Each patch edited one clause blind to the rest, and the operator watched
 * the loop: fixing one scenario un-fixed another, four times.
 *
 * This table is the whole contract in one place. Every row is one evidence
 * combination and the word the pill must say for it. A change to the health
 * rules edits this table *first*, sees every neighbour it touches, and only
 * then the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EncoderLink } = require('../src/core/encoder-link');
const { LinkManager } = require('../src/core/link-manager');

const NOW = Date.now();
const FRESH = NOW - 100;        // within every window
const STALE = NOW - 60000;      // beyond every window

/** A sink carrying exactly the named evidence; everything else quiet. */
function sink(over) {
  return Object.assign({
    dest: { host: 'h', port: 1 },
    ready: true, offline: false,
    tx: 0, txErrors: 0, lastError: null, lastErrorCode: null, lastErrorAt: 0,
    failingSince: 0, suppressed: 0, trialUntil: 0, recovered: false,
    aliveAt: 0, destAlive: null, destAliveAt: 0, lastTxAt: 0,
    pingFails: 0, pingEverAnswered: false
  }, over);
}

/** health via the real snapshot path, so the matrix tests what ships. */
function healthOf(s, running) {
  const link = new EncoderLink({
    id: 'm', name: 'm',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ id: 'd', host: '127.0.0.1', port: 65533, devid: 1 }]
  });
  link._sinks = [Object.assign(s, { udp: { close() {} } })];
  if (running) link._state = 'streaming';
  const h = link.telemetry().destinations[0].health;
  link._sinks = [];
  link.stop();
  return h;
}

const ROWS = [
  // ── not running ─────────────────────────────────────────────────────────
  ['link not running', sink({}), false, 'idle'],

  // ── running, nothing sent (encoder not producing) ───────────────────────
  ['nothing sent, ping not yet answered', sink({}), true, 'idle'],
  ['nothing sent, ping says alive', sink({ destAlive: true, destAliveAt: FRESH }), true, 'connected'],
  ['nothing sent, ping says dead', sink({ destAlive: false, destAliveAt: FRESH }), true, 'offline'],

  // ── running, data flowing ───────────────────────────────────────────────
  ['sending, no errors, pings answering',
    sink({ lastTxAt: FRESH, destAlive: true, destAliveAt: FRESH, pingEverAnswered: true }), true, 'connected'],
  ['sending, a proven ping-speaker misses twice — ARP has no errors to offer yet',
    sink({ lastTxAt: FRESH, pingEverAnswered: true, pingFails: 2, destAlive: false, destAliveAt: FRESH }),
    true, 'offline'],
  ['sending, a never-speaker misses forever — stealth silence means nothing',
    sink({ lastTxAt: FRESH, pingEverAnswered: false, pingFails: 50, destAlive: false, destAliveAt: FRESH }),
    true, 'connected'],
  ['sending, speaker misses but the verdict is stale — probes stopped, so it lapses',
    sink({ lastTxAt: FRESH, pingEverAnswered: true, pingFails: 5, destAlive: false, destAliveAt: STALE }),
    true, 'connected'],
  ['sending, one miss only — a dropped packet is not a death',
    sink({ lastTxAt: FRESH, pingEverAnswered: true, pingFails: 1, destAlive: false, destAliveAt: FRESH }),
    true, 'connected'],

  // ── running, the send path itself objects ───────────────────────────────
  ['send errors, not yet given up, not yet quiet',
    sink({ lastTxAt: FRESH, txErrors: 5, lastErrorAt: FRESH, lastErrorCode: 'EHOSTUNREACH' }), true, 'offline'],
  ['send errors from a machine that is up with nothing bound',
    sink({ lastTxAt: FRESH, txErrors: 5, lastErrorAt: FRESH, lastErrorCode: 'ECONNREFUSED' }), true, 'refused'],
  ['declared offline by the give-up', sink({ lastTxAt: FRESH, offline: true, txErrors: 100, lastErrorAt: FRESH }),
    true, 'offline'],
  ['errors long quiet — the silence rule recovers it',
    sink({ lastTxAt: FRESH, txErrors: 5, lastErrorAt: STALE }), true, 'connected'],
  ['errors recent but a ping proved the host back',
    sink({ lastTxAt: FRESH, txErrors: 5, lastErrorAt: FRESH, aliveAt: NOW, destAlive: true, destAliveAt: NOW }),
    true, 'connected'],
];

test('every evidence combination says the specified word', () => {
  for (const [name, s, running, expected] of ROWS) {
    assert.equal(healthOf(s, running), expected, name);
  }
});

test('the disguise answer climbs only from connected, and receiving needs flow', () => {
  const manager = new LinkManager({ logger: { push() {} } });
  manager.disguiseChecks.set('d', { matches: true, at: NOW });
  const climb = (health, sending) => {
    const t = { destinations: [{ id: 'd', health, sending }] };
    manager.applyDisguiseChecks(t);
    return t.destinations[0].health;
  };
  assert.equal(climb('connected', true), 'receiving', 'match plus flow is delivery');
  assert.equal(climb('connected', false), 'connected', 'match without flow is only a match');
  assert.equal(climb('offline', true), 'offline', 'no answer overrides the network');
  manager.disguiseChecks.set('d', { matches: false, at: NOW });
  assert.equal(climb('connected', false), 'mismatch', 'a mismatch is config, and stands without flow');
});
