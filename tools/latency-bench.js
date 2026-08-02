#!/usr/bin/env node
'use strict';
/**
 * End-to-end latency of the bridge itself.
 *
 * The encoder stub, the EncoderLink and the disguise stub all run in ONE
 * process, so a single `performance.now()` clock covers the whole path and the
 * numbers need no correction for clock skew between processes.
 *
 * Measured span: the instant the sample is written to the TCP socket, to the
 * instant the corresponding UDP packet is received. That is everything this app
 * contributes — TCP receive, reassembly, parse, format, UDP send, UDP receive —
 * and it is the figure that has to stay small against the encoder's CycleTime.
 *
 * Each sample carries a unique position, which is what identifies it on the
 * far side.
 *
 *   node tools/latency-bench.js --samples 20000 --cycle 2 --coalesce 4
 *
 * Options
 *   --samples N    samples to send            (20000)
 *   --cycle MS     emission interval          (2)
 *   --coalesce N   records per TCP write      (1)
 *   --warmup PCT   discard this % up front    (10)
 *   --policy P     every|latest               (every)
 */

const net = require('node:net');
const dgram = require('node:dgram');
const { parseArgs } = require('./cli-args');
const { EncoderLink } = require('../src/core/encoder-link');

const opts = parseArgs(process.argv, {
  samples: 20000,
  cycle: 2,
  coalesce: 1,
  warmup: 10,
  policy: 'every'
});

const sentAt = new Float64Array(opts.samples + 16);
const latencies = [];
let received = 0;
let malformed = 0;
let duplicates = 0;
const seen = new Uint8Array(opts.samples + 16);

// ---------------------------------------------------------------------------
// disguise stub
// ---------------------------------------------------------------------------

const sink = dgram.createSocket('udp4');
const RE = /^(\d+):(\d+),(-?\d+);$/;

sink.on('message', (msg) => {
  const now = performance.now();
  for (const rec of msg.toString('latin1').split(';')) {
    const t = rec.trim();
    if (!t) continue;
    const m = RE.exec(t + ';');
    if (!m) { malformed++; continue; }
    const pos = Number(m[2]);
    if (pos >= sentAt.length || sentAt[pos] === 0) { malformed++; continue; }
    if (seen[pos]) { duplicates++; continue; }
    seen[pos] = 1;
    received++;
    latencies.push((now - sentAt[pos]) * 1000); // microseconds
  }
});

// ---------------------------------------------------------------------------
// encoder stub
// ---------------------------------------------------------------------------

let clientSocket = null;
let nextPos = 1;
let emitTimer = null;

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  clientSocket = socket;
  socket.on('data', (chunk) => {
    // Answer the link's OutputType / OutputMode probe so it does not fall back
    // to inference and log a warning mid-benchmark.
    for (const line of chunk.toString('latin1').split(/\r?\n/)) {
      const m = /^read\s+(\w+)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'OutputType') socket.write('OutputType=ASCII_SHORT\r\n');
      else if (m[1] === 'OutputMode') socket.write('OutputMode=Position_Velocity_Timestamp_\r\n');
    }
  });
  socket.on('error', () => {});
});

function emitBatch() {
  if (!clientSocket || clientSocket.destroyed) return;
  let out = '';
  const batch = Math.max(1, opts.coalesce);
  const first = nextPos;

  for (let i = 0; i < batch && nextPos <= opts.samples; i++) {
    out += `${nextPos} 8192 ${nextPos * 1000}\r\n`;
    nextPos++;
  }
  if (!out) return finish();

  // Stamp as close to the write as possible: everything after this point is
  // the bridge's own cost.
  const t0 = performance.now();
  for (let p = first; p < nextPos; p++) sentAt[p] = t0;
  clientSocket.write(out);
}

function tick() {
  emitBatch();
  if (nextPos > opts.samples) {
    // Let the tail drain before reporting.
    setTimeout(finish, 500);
    return;
  }
  emitTimer = setTimeout(tick, opts.cycle * Math.max(1, opts.coalesce));
}

// ---------------------------------------------------------------------------

let done = false;
function finish() {
  if (done) return;
  done = true;
  if (emitTimer) clearTimeout(emitTimer);

  const t = link.telemetry();
  const warm = Math.floor(latencies.length * (opts.warmup / 100));
  const sample = latencies.slice(warm).sort((a, b) => a - b);
  const pct = (p) => (sample.length ? sample[Math.min(sample.length - 1, Math.floor((p / 100) * sample.length))] : 0);
  const mean = sample.reduce((a, b) => a + b, 0) / (sample.length || 1);

  console.log('\n=== bridge latency: TCP write -> UDP receive ===');
  console.log(`sent ${opts.samples}  received ${received}  ` +
    `lost ${opts.samples - received}  duplicates ${duplicates}  malformed ${malformed}`);
  console.log(`cycle ${opts.cycle} ms   coalesce ${opts.coalesce}   policy ${opts.policy}   ` +
    `(discarded first ${opts.warmup}% as warm-up)`);
  console.log('');
  console.log(`  mean   ${mean.toFixed(1).padStart(8)} µs`);
  for (const p of [50, 90, 99, 99.9]) {
    console.log(`  p${String(p).padEnd(5)} ${pct(p).toFixed(1).padStart(8)} µs`);
  }
  console.log(`  max    ${(sample[sample.length - 1] || 0).toFixed(1).padStart(8)} µs`);
  console.log('');
  console.log(`link-internal (parse -> send only): p50 ${t.latencyUs.p50.toFixed(1)} µs, ` +
    `p99 ${t.latencyUs.p99.toFixed(1)} µs, max ${t.latencyUs.max.toFixed(1)} µs`);
  console.log(`link counters: rx ${t.rxTotal}  tx ${t.txTotal}  ` +
    `unparsed ${t.unknownLines}  txErrors ${t.txErrors}`);

  link.stop();
  server.close();
  sink.close();
  process.exit(received === opts.samples && malformed === 0 ? 0 : 1);
}

let link;

sink.bind(0, '127.0.0.1', () => {
  const sinkPort = sink.address().port;
  server.listen(0, '127.0.0.1', () => {
    const encPort = server.address().port;
    link = new EncoderLink({
      id: 'bench',
      name: 'bench',
      encoder: { host: '127.0.0.1', port: encPort },
      d3: { host: '127.0.0.1', port: sinkPort, devid: 1 },
      velocityPolicy: 'zero',
      udpSendPolicy: opts.policy,
      reconnect: { enabled: false }
    });
    link.on('state', (e) => {
      if (e.state === 'connected') setTimeout(tick, 250);
    });
    link.start();
    console.log(`[bench] encoder stub :${encPort} -> link -> sink :${sinkPort}`);
    console.log(`[bench] emitting ${opts.samples} samples...`);
  });
});

process.on('SIGINT', finish);
