'use strict';
/**
 * The persistent-ping liveness helpers.
 *
 * The state machine around them — destAlive, the health matrix, the pills — is
 * tested through the `pingRunner` seam elsewhere and is unchanged. What is new
 * is turning one long-running `ping`'s output into a true/false/null answer, and
 * real ICMP is not a usable fixture (this dev machine's firewall drops even a
 * loopback self-ping, CI often cannot ping at all), so the two pure functions
 * are tested directly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPingReply, pingLiveness } = require('../src/core/encoder-link');

test('isPingReply recognises a reply on every platform, and only a reply', () => {
  // A reply carries a round-trip time.
  assert.equal(isPingReply('64 bytes from 10.10.10.5: icmp_seq=1 ttl=64 time=0.234 ms'), true);
  assert.equal(isPingReply('64 bytes from 10.10.10.5: icmp_seq=0 ttl=64 time=0.1 ms'), true); // macOS
  assert.equal(isPingReply('Reply from 10.10.10.5: bytes=32 time=1ms TTL=64'), true);         // Windows
  assert.equal(isPingReply('Reply from 10.10.10.5: bytes=32 time<1ms TTL=64'), true);         // Windows sub-ms
  // A timeout, an unreachable, or a header does not.
  assert.equal(isPingReply('Request timed out.'), false);                          // Windows
  assert.equal(isPingReply('Request timeout for icmp_seq 0'), false);              // macOS
  assert.equal(isPingReply('Destination Host Unreachable'), false);                // Linux/Windows
  assert.equal(isPingReply('PING 10.10.10.5 (10.10.10.5): 56 data bytes'), false); // header
  assert.equal(isPingReply(''), false);
});

test('pingLiveness: no pinger is no evidence', () => {
  assert.equal(pingLiveness(null, 1000), null);
  assert.equal(pingLiveness(undefined, 1000), null);
});

test('pingLiveness: a recent reply is alive, a stale one is gone', () => {
  const now = 100000;
  assert.equal(pingLiveness({ lastReplyAt: now - 500, startedAt: 0, dead: false }, now), true);
  assert.equal(pingLiveness({ lastReplyAt: now - 2400, startedAt: 0, dead: false }, now), true);  // within 2.5 s
  assert.equal(pingLiveness({ lastReplyAt: now - 3000, startedAt: 0, dead: false }, now), false); // past 2.5 s
});

test('pingLiveness: before the first reply it is unknown, then down', () => {
  const started = 100000;
  // Warming up — under 2 s since start, no reply yet — is null: it changes nothing.
  assert.equal(pingLiveness({ lastReplyAt: null, startedAt: started, dead: false }, started + 500), null);
  // Past warm-up with still no reply: the host is not answering.
  assert.equal(pingLiveness({ lastReplyAt: null, startedAt: started, dead: false }, started + 2500), false);
});

test('pingLiveness: a pinger that could not run is no evidence, not "down"', () => {
  const now = 100000;
  assert.equal(pingLiveness({ lastReplyAt: null, startedAt: now - 5000, dead: true }, now), null);
  // But a recent reply seen before it died still counts as life.
  assert.equal(pingLiveness({ lastReplyAt: now - 500, startedAt: now - 5000, dead: true }, now), true);
});
