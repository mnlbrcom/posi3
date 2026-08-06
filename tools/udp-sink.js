#!/usr/bin/env node
'use strict';
/**
 * Stand-in for disguise: receives the NavigatorDriver stream and reports on it.
 *
 * Also the fastest way to settle an argument at a venue. Point the app at a
 * laptop running this; if packets arrive here, the bridge works and the problem
 * is on the d3 side.
 *
 *   node tools/udp-sink.js --port 6000
 *   node tools/udp-sink.js --port 6000 --tail
 *
 * Options
 *   --port N     listen port                     (6000)
 *   --host H     bind address                    (0.0.0.0)
 *   --tail       print every packet
 *   --quiet      only the 1 Hz summary line
 *   --counts N   expected total counts for wrap-aware gap analysis (33554432)
 */

const dgram = require('node:dgram');
const { parseArgs } = require('./cli-args');
const { wrapDelta } = require('../src/core/protocol');
const { TOTAL_COUNTS, DEFAULT_D3_PORT } = require('../src/shared/constants');

const opts = parseArgs(process.argv, {
  port: DEFAULT_D3_PORT,
  host: '0.0.0.0',
  tail: false,
  quiet: false,
  counts: TOTAL_COUNTS
});

// The exact grammar the legacy d3driver.exe produced: "<devid>:<pos>,<vel>;"
const RE_PACKET = /^(\d+):(-?\d+),(-?\d+);$/;

/**
 * Parse one datagram into records, strictly.
 *
 * Every record must carry its own terminator. The old loop split on `;` and
 * re-appended one before matching, so a datagram whose final record had *no*
 * terminator still parsed clean — and disguise drops the final axis exactly
 * when that `;` is missing. A sink that quietly repairs the defect it exists
 * to catch certifies streams disguise would truncate.
 */
function parseDatagram(text) {
  const records = [];
  let bad = 0;
  let rest = text.replace(/\r?\n$/, '');
  if (rest === '') return { records, malformed: 0 };
  if (!rest.endsWith(';')) {
    // The unterminated tail is the defect; the terminated prefix still counts.
    bad++;
    rest = rest.slice(0, rest.lastIndexOf(';') + 1);
  }
  for (const raw of rest.split(';')) {
    const rec = raw.trim();
    if (!rec) continue;
    const m = RE_PACKET.exec(rec + ';');
    if (!m) { bad++; continue; }
    records.push({ id: Number(m[1]), pos: Number(m[2]), vel: Number(m[3]) });
  }
  return { records, malformed: bad };
}

/** @type {Map<number, object>} per-device statistics */
const devices = new Map();
let malformed = 0;
let totalPackets = 0;
let lastArrivalNs = 0;
const gaps = [];

function deviceStats(id) {
  let d = devices.get(id);
  if (!d) {
    d = {
      id, count: 0, lastPos: null, minPos: Infinity, maxPos: -Infinity,
      wraps: 0, backwards: 0, jumps: 0, lastVel: 0, sinceReport: 0
    };
    devices.set(id, d);
  }
  return d;
}

module.exports = { parseDatagram };
if (require.main !== module) return;

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('message', (msg) => {
  const nowNs = Number(process.hrtime.bigint());
  if (lastArrivalNs) gaps.push((nowNs - lastArrivalNs) / 1e6);
  lastArrivalNs = nowNs;

  totalPackets++;
  const text = msg.toString('latin1');

  // One datagram may legitimately carry several records.
  const parsed = parseDatagram(text);
  if (parsed.malformed) {
    malformed += parsed.malformed;
    if (!opts.quiet) console.log(`  malformed in: ${JSON.stringify(text)}`);
  }
  for (const { id, pos, vel } of parsed.records) {
    const d = deviceStats(id);

    if (d.lastPos !== null) {
      const delta = wrapDelta(pos, d.lastPos, opts.counts);
      if (Math.sign(pos - d.lastPos) !== Math.sign(delta) && pos !== d.lastPos) d.wraps++;
      if (delta < 0) d.backwards++;
      // A jump larger than 1/16 turn between consecutive samples usually means
      // dropped or reordered records rather than real motion.
      if (Math.abs(delta) > opts.counts / 16) d.jumps++;
    }

    d.count++;
    d.sinceReport++;
    d.lastPos = pos;
    d.lastVel = vel;
    if (pos < d.minPos) d.minPos = pos;
    if (pos > d.maxPos) d.maxPos = pos;

    if (opts.tail) console.log(`${id}:${pos},${vel};`);
  }
});

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

setInterval(() => {
  const sorted = gaps.slice().sort((a, b) => a - b);
  gaps.length = 0;

  const parts = [];
  for (const d of devices.values()) {
    parts.push(`id ${d.id}: ${String(d.sinceReport).padStart(4)} pkt/s  pos ${String(d.lastPos).padStart(9)}  vel ${String(d.lastVel).padStart(7)}`);
    d.sinceReport = 0;
  }
  if (!parts.length) {
    console.log('waiting for packets...');
    return;
  }
  const jitter = sorted.length
    ? `  gap p50 ${percentile(sorted, 50).toFixed(2)}ms p99 ${percentile(sorted, 99).toFixed(2)}ms max ${sorted[sorted.length - 1].toFixed(2)}ms`
    : '';
  console.log(parts.join('   ') + jitter + (malformed ? `  MALFORMED ${malformed}` : ''));
}, 1000).unref?.();

sock.on('error', (err) => {
  console.error(`[sink] ${err.message}`);
  process.exit(1);
});

sock.bind(opts.port, opts.host, () => {
  console.log(`[sink] listening for disguise packets on ${opts.host}:${opts.port}`);
});

process.on('SIGINT', () => {
  console.log('\n--- summary ---');
  console.log(`packets: ${totalPackets}   malformed: ${malformed}`);
  for (const d of devices.values()) {
    console.log(`  id ${d.id}: ${d.count} records, pos ${d.minPos}..${d.maxPos}, ` +
      `${d.wraps} wraps, ${d.backwards} backwards, ${d.jumps} suspicious jumps`);
  }
  process.exit(0);
});
