#!/usr/bin/env node
'use strict';
/**
 * Drives EncoderLink / LinkManager with no Electron and no UI.
 *
 * This is how the bridge gets verified: the whole data path is exercised
 * headless, so a failure here is unambiguously the bridge and not the GUI.
 *
 *   node tools/mock-encoder.js --port 16000 --cycle 2 --coalesce 4 --split --quiet &
 *   node tools/udp-sink.js --port 16001 &
 *   node tools/link-harness.js --encoder-port 16000 --d3-port 16001 --seconds 10
 *
 * Options
 *   --encoder-host H  (127.0.0.1)   --encoder-port N (6000)
 *   --d3-host H       (127.0.0.1)   --d3-port N      (6000)
 *   --devid N         (1)           --links N        (1)  fan out for load tests
 *   --velocity P      zero|passthrough|derived       --send-policy every|latest
 *   --seconds N       run duration, 0 = until Ctrl-C (10)
 *   --read VAR        issue `read VAR` once streaming, to test the shared channel
 *   --verbose         print state transitions and log lines
 */

const { parseArgs } = require('./cli-args');
const { LinkManager } = require('../src/core/link-manager');

const opts = parseArgs(process.argv, {
  encoderHost: '127.0.0.1',
  encoderPort: 6000,
  d3Host: '127.0.0.1',
  d3Port: 6000,
  devid: 1,
  links: 1,
  velocity: 'zero',
  sendPolicy: 'every',
  seconds: 10,
  read: '',
  verbose: false
});

const manager = new LinkManager({ telemetryHz: 4 });

manager.on('state', (e) => {
  if (opts.verbose || e.state !== 'streaming') {
    console.log(`[${e.id}] ${e.state.toUpperCase()} — ${e.detail}`);
  }
});
manager.on('encoderEvent', (e) => console.log(`[${e.id}] event ${e.kind}: ${e.text}`));
manager.on('fieldLayout', (e) => {
  console.log(`[${e.id}] field layout ${e.inferred ? 'INFERRED' : 'from encoder'}: ` +
    (e.fields ? JSON.stringify(e.fields) : 'n/a') + (e.why ? ` (${e.why})` : ''));
});
if (opts.verbose) {
  manager.on('log', (b) => {
    for (const l of b.lines) console.log(`    ${l.level} ${l.dir || ''} ${l.text}`);
    if (b.dropped) console.log(`    ...${b.dropped} log lines dropped`);
  });
}

manager.on('telemetry', ({ links }) => {
  for (const t of links) {
    console.log(
      `[${t.id}] ${t.state.padEnd(9)} pos ${String(t.pos).padStart(9)}  ` +
      `${t.angleDeg.toFixed(1).padStart(6)}°  rev ${String(t.revs).padStart(5)}  ` +
      `${t.rpm.toFixed(1).padStart(7)} rpm  ` +
      `rx ${t.rxHz.toFixed(0).padStart(4)}Hz tx ${t.txHz.toFixed(0).padStart(4)}Hz  ` +
      `lat p50 ${t.latencyUs.p50.toFixed(0)}µs p99 ${t.latencyUs.p99.toFixed(0)}µs max ${t.latencyUs.max.toFixed(0)}µs  ` +
      `gap p50 ${t.gapMs.p50.toFixed(2)}ms  ` +
      `wraps ${t.wraps} err ${t.errors} txerr ${t.txErrors} unk ${t.unknownLines} rc ${t.reconnects}`
    );
  }
});

for (let i = 0; i < opts.links; i++) {
  manager.upsert({
    id: `link${i + 1}`,
    name: `Harness ${i + 1}`,
    encoder: { host: opts.encoderHost, port: opts.encoderPort },
    d3: { host: opts.d3Host, port: opts.d3Port, devid: opts.devid + i },
    velocityPolicy: opts.velocity,
    udpSendPolicy: opts.sendPolicy
  });
}

manager.startAll();
console.log(`[harness] ${opts.links} link(s): ${opts.encoderHost}:${opts.encoderPort} -> ` +
  `${opts.d3Host}:${opts.d3Port} (velocity=${opts.velocity}, send=${opts.sendPolicy})`);

if (opts.read) {
  setTimeout(async () => {
    const link = manager.get('link1');
    try {
      const r = await link.read(opts.read);
      console.log(`[harness] read ${opts.read} -> ${r.variable}=${r.value}`);
    } catch (err) {
      console.log(`[harness] read ${opts.read} FAILED: ${err.message}`);
    }
  }, 2000);
}

function finish() {
  console.log('\n--- final ---');
  for (const id of manager.ids()) {
    const link = manager.get(id);
    const t = link.telemetry();
    console.log(`${id}: state=${t.state} rx=${t.rxTotal} tx=${t.txTotal} ` +
      `errors=${t.errors} txErrors=${t.txErrors} unknown=${t.unknownLines} ` +
      `wraps=${t.wraps} reconnects=${t.reconnects} ` +
      `latency p50=${t.latencyUs.p50.toFixed(1)}µs p99=${t.latencyUs.p99.toFixed(1)}µs max=${t.latencyUs.max.toFixed(1)}µs`);
  }
  manager.dispose();
  process.exit(0);
}

process.on('SIGINT', finish);
if (opts.seconds > 0) setTimeout(finish, opts.seconds * 1000);
