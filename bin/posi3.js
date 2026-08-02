#!/usr/bin/env node
'use strict';
/**
 * Headless entry point.
 *
 * Runs the bridge and its web UI with no Electron and no window — the mode for
 * a show server that is administered from a laptop's browser, and the mode the
 * integration tests drive.
 *
 *   node bin/posi3.js --port 8710
 *   node bin/posi3.js --bind 0.0.0.0 --port 8710      (prints an access token)
 */

const { parseArgs } = require('../tools/cli-args');
const { startService } = require('../src/server/service');

// parseArgs takes the full argv and drops the first two entries itself.
const opts = parseArgs(process.argv, {
  bind: '127.0.0.1',
  port: 8710,
  dataDir: '',
  token: '',
  headless: true
});

startService({
  bindHost: opts.bind,
  port: Number(opts.port),
  dataDir: opts.dataDir || undefined,
  token: opts.token || undefined,
  env: { headless: true }
}).then((svc) => {
  process.stdout.write(`posi3 listening on ${svc.url}\n`);
  process.stdout.write(`profile: ${svc.dataDir}\n`);
  if (svc.token) {
    process.stdout.write(`access token: ${svc.token}\n`);
    process.stdout.write(`  open ${svc.url}/?token=${svc.token}\n`);
  }
  if (svc.autoStarted.length) {
    process.stdout.write(`auto-started ${svc.autoStarted.length} connection(s)\n`);
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n${signal} — stopping links and flushing config\n`);
    try { await svc.stop(); } catch { /* going down anyway */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}).catch((err) => {
  process.stderr.write(`posi3 failed to start: ${err.message}\n`);
  if (err.code === 'EADDRINUSE') {
    process.stderr.write('  another posi3 (or something else) already holds that port\n');
  }
  process.exit(1);
});
