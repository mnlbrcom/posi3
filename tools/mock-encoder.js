#!/usr/bin/env node
'use strict';
/**
 * POSITAL IXARC OCD-EM simulator.
 *
 * The real encoder is rarely on the desk, and the failure modes that broke the
 * legacy driver (segment coalescing, mid-number splits, silent stalls) are the
 * hardest ones to reproduce by hand. This models them on demand.
 *
 * It reuses the app's own LineAssembler for its command channel, which keeps
 * the two sides honest about framing.
 *
 *   node tools/mock-encoder.js --motion constant --rpm 60 --cycle 2 \
 *                              --coalesce 4 --split --drop-after 5000
 *
 * Options
 *   --port N            listen port                          (6000)
 *   --host H            bind address                         (0.0.0.0)
 *   --cycle MS          initial CycleTime                    (10)
 *   --motion M          constant|sine|jog|stop|jitter        (constant)
 *   --rpm N             speed for constant/jog               (60)
 *   --period S          sweep period for sine                (10)
 *   --span N            sweep span in counts for sine        (8192)
 *   --max-clients N     refuse connections past this         (3)
 *   --seed N            PRNG seed for reproducible chaos     (1)
 *   --quiet             suppress per-connection logging
 *
 * Chaos flags
 *   --coalesce N        pack N records into one write
 *   --split             break each write at random offsets
 *   --drop-after N      destroy the socket after N samples (RST)
 *   --half-close        use end() instead of destroy() (FIN)
 *   --stall-after N     stop emitting but hold the socket open
 *   --garbage           inject a stray non-numeric line every ~200 samples
 *   --latency-jitter MS delay writes by up to this much
 *   --no-crlf           terminate with bare LF instead of CRLF
 *   --wrap-soon         start just below the 33,554,432 rollover
 */

const net = require('node:net');
const { parseArgs, makeRandom } = require('./cli-args');
const { LineAssembler } = require('../src/core/line-assembler');
const { parseOutputMode } = require('../src/core/protocol');
const {
  COUNTS_PER_REV, TOTAL_COUNTS, DEFAULT_ENCODER_PORT, ENCODER_VAR_BY_NAME
} = require('../src/shared/constants');

const opts = parseArgs(process.argv, {
  port: DEFAULT_ENCODER_PORT,
  host: '0.0.0.0',
  cycle: 10,
  motion: 'constant',
  rpm: 60,
  period: 10,
  span: COUNTS_PER_REV,
  maxClients: 3,
  seed: 1,
  quiet: false,
  coalesce: 1,
  split: false,
  dropAfter: 0,
  halfClose: false,
  stallAfter: 0,
  garbage: false,
  latencyJitter: 0,
  crlf: true,
  wrapSoon: false,
  /**
   * Which fields the simulated encoder emits, e.g. `Position_Timestamp_`.
   *
   * There was no way to set this, and a test that tried to — the one covering
   * the two-number ambiguity between "pos vel" and "pos timestamp" — was
   * silently ignored and passed against the default three-field mode instead.
   */
  outputMode: 'Position_Velocity_Timestamp_',
  /** ASCII_SHORT, ASCII (verbose) or BINARY. The formatter honoured all three
   *  already; there was simply no way to ask for one. */
  outputType: 'ASCII_SHORT'
});

const random = makeRandom(opts.seed);
const log = (...a) => { if (!opts.quiet) console.log(...a); };
const EOL = opts.crlf ? '\r\n' : '\n';

// ---------------------------------------------------------------------------
// Encoder variable table — seeded with the documented factory defaults
// ---------------------------------------------------------------------------

const vars = {
  UsedScopeOfPhysRes: String(TOTAL_COUNTS),
  TotalScaledRes: String(TOTAL_COUNTS),
  CountingDir: 'CW',
  Preset: '0',
  Offset: '0',
  TimeMode: 'Cyclic',
  OutputMode: opts.outputMode,
  OutputType: opts.outputType,
  CycleTime: String(opts.cycle),
  IP: '10.10.10.10',
  NetMask: '255.255.255.0',
  Gateway: '0.0.0.0',
  Verbose: '1',
  AutoArpCacheUpdate: '0'
};

const startNs = process.hrtime.bigint();
const nowMs = () => Number(process.hrtime.bigint() - startNs) / 1e6;
/** Encoder timestamps are microseconds since power-up, wrapping at 2^32. */
const nowUs = () => Number((process.hrtime.bigint() - startNs) / 1000n % 4294967296n);

// --wrap-soon: start far enough back that the 33,554,432 rollover happens a
// couple of seconds in, i.e. while something is actually watching. Starting a
// handful of counts short means it wraps on the very first sample, before the
// consumer has a previous position to compare against.
const WRAP_LEAD_SEC = 2;
let basePos = opts.wrapSoon
  ? TOTAL_COUNTS - Math.round((opts.rpm / 60) * COUNTS_PER_REV * WRAP_LEAD_SEC)
  : 0;
let offsetCounts = 0;

// ---------------------------------------------------------------------------
// Motion models
// ---------------------------------------------------------------------------

function motionAt(tMs) {
  const t = tMs / 1000;
  const total = Number(vars.UsedScopeOfPhysRes) || TOTAL_COUNTS;
  const stepsPerSec = (opts.rpm / 60) * COUNTS_PER_REV;

  let pos;
  let vel;
  switch (opts.motion) {
    case 'stop':
      pos = basePos; vel = 0; break;

    case 'jitter':
      pos = basePos + Math.round((random() - 0.5) * 4); vel = 0; break;

    case 'sine': {
      const w = (2 * Math.PI) / opts.period;
      pos = basePos + (opts.span / 2) * (1 - Math.cos(w * t));
      vel = (opts.span / 2) * w * Math.sin(w * t);
      break;
    }

    case 'jog': {
      // 2 s accelerate, 3 s cruise, 2 s decelerate, 3 s dwell
      const p = t % 10;
      const a = stepsPerSec / 2;
      if (p < 2) { vel = a * p; pos = basePos + 0.5 * a * p * p; }
      else if (p < 5) { vel = stepsPerSec; pos = basePos + 0.5 * a * 4 + stepsPerSec * (p - 2); }
      else if (p < 7) {
        const q = p - 5;
        vel = stepsPerSec - a * q;
        pos = basePos + 0.5 * a * 4 + stepsPerSec * 3 + stepsPerSec * q - 0.5 * a * q * q;
      } else { vel = 0; pos = basePos + 0.5 * a * 4 + stepsPerSec * 3 + 0.5 * a * 4; }
      pos += Math.floor(t / 10) * (a * 4 + stepsPerSec * 3);
      break;
    }

    case 'constant':
    default:
      pos = basePos + stepsPerSec * t; vel = stepsPerSec; break;
  }

  if (vars.CountingDir === 'CCW') { pos = -pos; vel = -vel; }
  pos = Math.round(pos) + offsetCounts;
  pos = ((pos % total) + total) % total;
  return { pos, vel: Math.round(vel) };
}

// ---------------------------------------------------------------------------
// Sample formatting, honouring OutputType / OutputMode
// ---------------------------------------------------------------------------

const FIELD_NAMES = ['POSITION', 'VELOCITY', 'TIMESTAMP'];

function fieldValues(pos, vel, ts) {
  const map = parseOutputMode(vars.OutputMode) || [0, 1, 2];
  return map.map((f) => ({ field: f, value: f === 0 ? pos : f === 1 ? vel : ts }));
}

/** @returns {string|Buffer} one encoded sample (no terminator for BINARY) */
function encodeSample(pos, vel, ts) {
  const fields = fieldValues(pos, vel, ts);
  if (vars.OutputType === 'BINARY') {
    const b = Buffer.alloc(fields.length * 4);
    fields.forEach((f, i) => b.writeUInt32BE(f.value >>> 0, i * 4));
    return b;
  }
  if (vars.OutputType === 'ASCII') {
    return fields.map((f) => `${FIELD_NAMES[f.field]}=${f.value}`).join(' ') + EOL;
  }
  return fields.map((f) => f.value).join(' ') + EOL;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let clientSeq = 0;
const clients = new Set();

class Client {
  constructor(socket) {
    this.id = ++clientSeq;
    this.socket = socket;
    this.sampleCount = 0;
    this.stalled = false;
    this.dead = false;
    this.pendingRecords = [];
    this.assembler = new LineAssembler();

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.assembler.push(chunk, (line) => this.onCommand(line)));
    socket.on('error', () => this.destroy());
    socket.on('close', () => { this.dead = true; clients.delete(this); log(`[mock] client ${this.id} closed`); });
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.socket.destroy();
    clients.delete(this);
  }

  /** Raw write, applying the --split and --latency-jitter chaos flags. */
  rawWrite(payload) {
    if (this.dead || this.socket.destroyed) return;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');

    const doWrite = () => {
      if (this.dead || this.socket.destroyed) return;
      if (!opts.split || buf.length < 2) { this.socket.write(buf); return; }
      // Break the write at random offsets, including mid-number and between
      // the CR and the LF. This is what a real network does under load.
      let off = 0;
      while (off < buf.length) {
        const remain = buf.length - off;
        const n = 1 + Math.floor(random() * remain);
        this.socket.write(buf.subarray(off, off + n));
        off += n;
      }
    };

    if (opts.latencyJitter > 0) setTimeout(doWrite, random() * opts.latencyJitter);
    else doWrite();
  }

  /** Queue a sample, flushing once --coalesce records have accumulated. */
  emitSample(pos, vel, ts) {
    if (this.dead || this.stalled) return;

    this.sampleCount++;

    if (opts.stallAfter && this.sampleCount > opts.stallAfter) {
      this.stalled = true;
      log(`[mock] client ${this.id} stalling after ${opts.stallAfter} samples (socket stays open)`);
      return;
    }

    this.pendingRecords.push(encodeSample(pos, vel, ts));

    if (opts.garbage && this.sampleCount % 200 === 0) {
      this.pendingRecords.push('### unsolicited noise ###' + EOL);
    }

    if (this.pendingRecords.length >= Math.max(1, opts.coalesce)) this.flush();

    if (opts.dropAfter && this.sampleCount >= opts.dropAfter) {
      this.flush();
      log(`[mock] client ${this.id} dropping after ${opts.dropAfter} samples`);
      if (opts.halfClose) this.socket.end();
      else this.destroy();
    }
  }

  flush() {
    if (!this.pendingRecords.length) return;
    const parts = this.pendingRecords;
    this.pendingRecords = [];
    this.rawWrite(
      parts.every((p) => typeof p === 'string')
        ? parts.join('')
        : Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))))
    );
  }

  send(line) { this.rawWrite(line + EOL); }

  // -- command channel ------------------------------------------------------

  onCommand(line) {
    const cmd = line.trim();
    if (!cmd) return;
    log(`[mock] client ${this.id} <- ${JSON.stringify(cmd)}`);

    if (cmd === 'Run!') {
      const { pos, vel } = motionAt(nowMs());
      this.rawWrite(encodeSample(pos, vel, nowUs()));
      return;
    }

    let m = /^read\s+([A-Za-z][A-Za-z0-9_]*)$/.exec(cmd);
    if (m) {
      const name = canonicalName(m[1]);
      if (!name) return this.send(`ERROR: unknown variable ${m[1]}`);
      return this.send(`${name}=${vars[name]}`);
    }

    m = /^(?:set\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(cmd);
    if (m) return this.applySet(m[1], m[2].trim());

    this.send('ERROR: syntax');
  }

  applySet(rawName, value) {
    const name = canonicalName(rawName);
    if (!name) return this.send(`ERROR: unknown variable ${rawName}`);

    const spec = ENCODER_VAR_BY_NAME.get(name.toLowerCase());
    if (spec) {
      if (spec.type === 'enum' && !spec.values.includes(value)) {
        return this.send(`ERROR: value out of range`);
      }
      if (spec.type === 'int') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
          return this.send(`ERROR: value out of range`);
        }
      }
    }

    if (name === 'Preset') {
      // Preset means "make the encoder read this value at its current physical
      // position", i.e. it recalculates the internal offset.
      const { pos } = motionAt(nowMs());
      offsetCounts += Number(value) - pos;
      vars.Offset = String(((offsetCounts % TOTAL_COUNTS) + TOTAL_COUNTS) % TOTAL_COUNTS);
    }

    vars[name] = value;
    this.send(`${name}=${value}`);

    if (name === 'CycleTime') reschedule();

    // The real encoder commits to flash a few seconds later and then tells
    // EVERY connected client. It is not a reply to the setting client.
    scheduleFlashCommit();
  }
}

function canonicalName(name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(vars)) if (key.toLowerCase() === lower) return key;
  return null;
}

let flashTimer = null;
function scheduleFlashCommit() {
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    log('[mock] flash committed, broadcasting to all clients');
    for (const c of clients) c.send('Parameters successfully written!');
  }, 3000);
}

// ---------------------------------------------------------------------------
// Cyclic emission — drift-corrected, and batching below timer resolution
// ---------------------------------------------------------------------------

let timer = null;
let nextDueMs = 0;

function reschedule() {
  if (timer) clearTimeout(timer);
  nextDueMs = nowMs();
  tick();
}

function tick() {
  const cycle = Math.max(1, Number(vars.CycleTime) || 10);
  const now = nowMs();

  if (vars.TimeMode === 'Cyclic') {
    // Emit every sample whose slot has come due. Below ~4 ms the host timer
    // cannot keep up, so several land in one pass — which is precisely how a
    // real encoder's records end up coalesced in one TCP segment.
    let guard = 0;
    while (nextDueMs <= now && guard++ < 5000) {
      const { pos, vel } = motionAt(nextDueMs);
      const ts = Math.round(nextDueMs * 1000) % 4294967296;
      for (const c of clients) c.emitSample(pos, vel, ts);
      nextDueMs += cycle;
    }
    if (guard >= 5000) nextDueMs = now + cycle;
  } else {
    nextDueMs = now + cycle;
  }

  for (const c of clients) c.flush();

  timer = setTimeout(tick, Math.max(0, nextDueMs - nowMs()));
}

// ---------------------------------------------------------------------------

const server = net.createServer((socket) => {
  if (clients.size >= opts.maxClients) {
    // The encoder accepts only a handful of simultaneous TCP clients; a
    // leftover session elsewhere is a classic "why won't it connect" cause.
    log(`[mock] refusing connection, ${clients.size}/${opts.maxClients} clients`);
    socket.destroy();
    return;
  }
  const c = new Client(socket);
  clients.add(c);
  log(`[mock] client ${c.id} connected from ${socket.remoteAddress} (${clients.size}/${opts.maxClients})`);
});

server.on('error', (err) => {
  console.error(`[mock] server error: ${err.message}`);
  process.exit(1);
});

server.listen(opts.port, opts.host, () => {
  console.log(`[mock] POSITAL OCD-EM simulator on ${opts.host}:${opts.port}`);
  console.log(`[mock] motion=${opts.motion} rpm=${opts.rpm} CycleTime=${vars.CycleTime}ms ` +
    `OutputType=${vars.OutputType} OutputMode=${vars.OutputMode} eol=${opts.crlf ? 'CRLF' : 'LF'}`);
  const chaos = [
    opts.coalesce > 1 && `coalesce=${opts.coalesce}`,
    opts.split && 'split',
    opts.dropAfter && `drop-after=${opts.dropAfter}${opts.halfClose ? ' (FIN)' : ' (RST)'}`,
    opts.stallAfter && `stall-after=${opts.stallAfter}`,
    opts.garbage && 'garbage',
    opts.latencyJitter && `latency-jitter=${opts.latencyJitter}ms`,
    opts.wrapSoon && 'wrap-soon'
  ].filter(Boolean);
  if (chaos.length) console.log(`[mock] chaos: ${chaos.join(', ')}`);
  reschedule();
});

process.on('SIGINT', () => { console.log('\n[mock] bye'); process.exit(0); });
