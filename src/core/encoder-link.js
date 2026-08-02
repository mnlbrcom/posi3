'use strict';
/**
 * One encoder <-> one disguise destination.
 *
 * Owns a TCP client socket to the encoder (port 6000, data AND commands) and a
 * connected UDP socket to the d3 server. Everything on the data path lives
 * here, in the main process: a renderer GC pause must never be able to delay a
 * packet.
 *
 * Latency rules observed in _onLine/_forward, and worth preserving:
 *   - parse and send synchronously in the socket's data handler, no queue
 *   - TCP_NODELAY on, so Nagle cannot sit on a small record
 *   - the UDP socket is *connected*, which skips a per-send address resolution
 *     and — unlike the legacy driver's unconnected sendto — actually surfaces
 *     ECONNREFUSED / EHOSTUNREACH instead of silently dropping
 *   - no allocation per sample: digits are written into pooled buffers and the
 *     parse result object is reused
 *   - no logging on this path unless the user explicitly asks for raw lines
 */

const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

const { LineAssembler } = require('./line-assembler');
const { CommandQueue, matchVariable, matchSample } = require('./command-queue');
const {
  KIND, Parser, parseOutputMode, writePacket, MAX_PACKET_BYTES,
  wrapDelta, angleDeg, revolution, stepsPerSecToRpm
} = require('./protocol');
const {
  STATE, TIMEOUTS, RECONNECT, COUNTS_PER_REV, TOTAL_COUNTS
} = require('../shared/constants');

/** Ring of send buffers: dgram may hold one until the write completes. */
const POOL_SIZE = 8;
/** Recent arrival→send measurements, in microseconds. */
const LATENCY_WINDOW = 256;

class EncoderLink extends EventEmitter {
  constructor(config) {
    super();
    this.config = normaliseConfig(config);
    this.id = this.config.id;

    this._state = STATE.IDLE;
    this._stateDetail = '';
    this._lastError = null;
    this._attempt = 0;
    this._nextRetryMs = 0;

    this._socket = null;
    this._udp = null;
    this._udpReady = false;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._stopping = false;
    this._probePending = false;
    this._lastProbeMs = -Infinity;

    this._parser = new Parser();
    this._assembler = new LineAssembler({
      onOverflow: (n) => this._warn(
        `Discarded ${n} bytes with no line terminator. Is OutputType set to BINARY?`
      )
    });
    this._commands = new CommandQueue({ send: (line) => this._writeCommand(line) });

    // -- packet buffers -----------------------------------------------------
    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) this._pool.push(Buffer.allocUnsafe(MAX_PACKET_BYTES));
    this._poolIdx = 0;

    // -- live state, mutated in place ---------------------------------------
    this.latest = {
      pos: 0, rawVel: null, outVel: 0, ts: null,
      angleDeg: 0, revs: 0, rpm: 0, tRxMs: 0
    };
    this.counters = {
      rx: 0, tx: 0, errors: 0, unknownLines: 0, wraps: 0,
      reconnects: 0, txErrors: 0, startedAtMs: 0
    };

    this._prevPos = null;
    this._prevTs = null;
    this._prevMs = null;
    this._derivedVel = 0;

    this._latencyUs = new Float64Array(LATENCY_WINDOW);
    this._latencyCount = 0;
    this._latencyIdx = 0;

    this._gapMs = new Float64Array(LATENCY_WINDOW);
    this._gapCount = 0;
    this._gapIdx = 0;

    // -- per-segment state for udpSendPolicy 'latest' -----------------------
    this._segHasSample = false;
    this._segPos = 0;
    this._segVel = 0;

    this._minSendGapMs = this.config.maxSendHz > 0 ? 1000 / this.config.maxSendHz : 0;
    this._lastSendMs = -Infinity;

    this._onLineBound = (line) => this._onLine(line);
    this._logRaw = !!this.config.logRaw;

    // -- encoder variable cache ---------------------------------------------
    // Every reply lands here, whether or not a command of ours was waiting for
    // it. The encoder broadcasts replies to all connected TCP clients, so this
    // is also how we notice a change made by another posi3 window, a browser,
    // or somebody's leftover Java tool.
    this._varCache = new Map(); // name -> { value, atMs }

    // -- flash-write policy -------------------------------------------------
    // Both of these used to live in the IPC layer, which meant a second
    // transport would have got its own uncoordinated limit, or none at all.
    // The encoder's flash is rated ~100,000 writes; the policy belongs to the
    // device, so it lives with the device.
    this._lastWriteBatchMs = -Infinity;
    this._flashPending = null; // { sinceMs, timer }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  get state() { return this._state; }
  get running() { return this._state !== STATE.IDLE && this._state !== STATE.ERROR; }

  start() {
    if (this.running) return;
    this._stopping = false;
    this._attempt = 0;
    this.counters.startedAtMs = Date.now();
    this._openUdp();
    this._connect();
  }

  stop() {
    this._stopping = true;
    this._clearTimers();
    this._commands.rejectAll(new Error('link stopped'));
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    if (this._udp) {
      try { this._udp.close(); } catch { /* already closed */ }
      this._udp = null;
      this._udpReady = false;
    }
    this._assembler.reset();
    this._setState(STATE.IDLE, 'stopped');
  }

  /** Apply a changed configuration. Restarts the link when it is running. */
  reconfigure(config) {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.config = normaliseConfig(Object.assign({}, this.config, config));
    this._logRaw = !!this.config.logRaw;
    this._minSendGapMs = this.config.maxSendHz > 0 ? 1000 / this.config.maxSendHz : 0;
    if (wasRunning) this.start();
  }

  // -------------------------------------------------------------------------
  // UDP toward disguise
  // -------------------------------------------------------------------------

  _openUdp() {
    if (this._udp) return;
    const { d3 } = this.config;
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this._udp = udp;
    this._udpReady = false;

    udp.on('error', (err) => {
      this.counters.txErrors++;
      this._warn(`UDP to ${d3.host}:${d3.port} failed: ${err.message}`);
    });

    const afterBind = () => {
      // Connecting the datagram socket removes a per-send address lookup and,
      // unlike the legacy unconnected sendto, lets ICMP errors reach us.
      udp.connect(d3.port, d3.host, () => { this._udpReady = true; });
    };

    if (d3.localAddress || d3.localPort) {
      udp.bind(d3.localPort || 0, d3.localAddress || undefined, afterBind);
    } else {
      afterBind();
    }
  }

  // -------------------------------------------------------------------------
  // TCP toward the encoder
  // -------------------------------------------------------------------------

  _connect() {
    const { encoder } = this.config;
    this._setState(STATE.CONNECTING,
      `connecting to ${encoder.host}:${encoder.port}${this._attempt ? ` (attempt ${this._attempt + 1})` : ''}`);

    this._assembler.reset();
    this._parser.setFieldMap(this.config.parser.autoDetect ? null : this.config.parser.fields);

    const socket = new net.Socket();
    this._socket = socket;

    socket.setNoDelay(true);
    socket.setTimeout(TIMEOUTS.CONNECT_MS);

    socket.once('timeout', () => {
      if (this._state === STATE.CONNECTING) {
        socket.destroy();
        this._handleDisconnect(new Error(`connect to ${encoder.host}:${encoder.port} timed out`));
      }
    });

    socket.on('connect', () => {
      // Drop the connect timeout: past this point an idle socket is normal and
      // the stall watchdog is the right detector.
      socket.setTimeout(0);
      socket.setKeepAlive(true, 5000);
      this._attempt = 0;
      this._setState(STATE.CONNECTED, `connected to ${encoder.host}:${encoder.port}`);
      this._startWatchdog();
      if (this.config.parser.autoDetect) this._detectFieldLayout();
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._handleDisconnect(err));
    socket.on('close', () => this._handleDisconnect(this._lastError || new Error('connection closed')));
    socket.on('end', () => this._log('info', 'rx', 'encoder closed the connection (FIN)'));

    socket.connect({
      host: encoder.host,
      port: encoder.port,
      localAddress: encoder.localAddress || undefined
    });
  }

  _handleDisconnect(err) {
    if (this._stopping || this._state === STATE.IDLE) return;

    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._stopWatchdog();
    this._probePending = false;
    this._lastProbeMs = -Infinity;
    this._commands.rejectAll(err);
    this._assembler.reset();
    this._lastError = err;

    if (!this.config.reconnect.enabled) {
      this._setState(STATE.ERROR, err.message);
      return;
    }

    // Exponential backoff with jitter, so a rack full of links coming back
    // after a switch reboot does not retry in lockstep.
    const { minDelayMs, maxDelayMs } = this.config.reconnect;
    const base = Math.min(maxDelayMs, minDelayMs * Math.pow(RECONNECT.FACTOR, this._attempt));
    const jitter = base * RECONNECT.JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(minDelayMs, Math.round(base + jitter));

    this._attempt++;
    this.counters.reconnects++;
    this._nextRetryMs = delay;
    this._setState(STATE.RECONNECTING,
      `${err.message} — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${this._attempt})`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopping) this._connect();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Data path
  // -------------------------------------------------------------------------

  _onData(chunk) {
    this._segHasSample = false;
    this._assembler.push(chunk, this._onLineBound);

    // 'latest' forwards only the newest sample from this segment. When several
    // records arrive coalesced, the older ones are already stale for a consumer
    // that only cares about current position.
    if (this._segHasSample && this.config.udpSendPolicy === 'latest') {
      this._forward(this._segPos, this._segVel);
    }
  }

  _onLine(line) {
    const t0 = performance.now();
    const r = this._parser.classify(line);

    if (r.kind === KIND.SAMPLE) {
      this._onSample(r, t0);
      return;
    }

    // Everything below is cold: replies, errors, events. Safe to allocate.
    if (this._logRaw) this._log('info', 'rx', line);

    const consumed = this._commands.handleParsed(r);

    // Cache every reply, consumed or not — see the note on _varCache.
    if (r.kind === KIND.REPLY) this._varCache.set(r.variable, { value: r.value, atMs: Date.now() });

    switch (r.kind) {
      case KIND.EVENT:
        this._resolveFlash('confirmed');
        this.emit('encoderEvent', { id: this.id, kind: 'paramsWritten', text: 'Parameters successfully written!' });
        this._log('info', 'rx', 'Parameters successfully written!');
        break;
      case KIND.STATUS:
        this.counters.errors += r.severity === 'error' ? 1 : 0;
        if (!consumed) {
          this.emit('encoderEvent', { id: this.id, kind: r.severity, text: r.text });
          this._log(r.severity === 'error' ? 'error' : 'warn', 'rx', `${r.severity.toUpperCase()}: ${r.text}`);
        }
        break;
      case KIND.REPLY:
        if (!consumed) this.emit('encoderEvent', { id: this.id, kind: 'unsolicited', text: `${r.variable}=${r.value}` });
        break;
      default:
        this.counters.unknownLines++;
        if (!this._logRaw) this._log('warn', 'rx', `unparsed: ${truncate(line)}`);
        break;
    }
  }

  _onSample(r, t0) {
    const nowMs = t0;
    const total = this.config.encoderMeta.totalCounts;
    const pos = r.pos;

    if (this._prevPos !== null) {
      const d = wrapDelta(pos, this._prevPos, total);
      if ((pos < this._prevPos && d > 0) || (pos > this._prevPos && d < 0)) this.counters.wraps++;
    }
    if (this._prevMs !== null) this._recordGap(nowMs - this._prevMs);

    const outVel = this._resolveVelocity(r, pos, nowMs, total);

    this._prevPos = pos;
    this._prevTs = r.ts;
    this._prevMs = nowMs;

    this.counters.rx++;
    this.latest.pos = pos;
    this.latest.rawVel = r.vel;
    this.latest.outVel = outVel;
    this.latest.ts = r.ts;
    this.latest.tRxMs = nowMs;

    // A `Run!` is answered by a sample, and samples never travel through the
    // command queue. One boolean test keeps that path correct without putting
    // the queue in the way of normal forwarding.
    const wasProbe = this._commands.expectsSample;
    if (wasProbe) this._commands.handleParsed(r);

    if (this._state !== STATE.STREAMING && !wasProbe) {
      this._setState(STATE.STREAMING, `receiving from ${this.config.encoder.host}`);
    }

    if (this.config.udpSendPolicy === 'latest') {
      this._segHasSample = true;
      this._segPos = pos;
      this._segVel = outVel;
    } else {
      this._forward(pos, outVel);
    }

    this._recordLatency((performance.now() - t0) * 1000);
  }

  /** Write one disguise packet. Allocation-free. */
  _forward(pos, vel) {
    if (!this._udpReady) return;

    if (this._minSendGapMs > 0) {
      const now = performance.now();
      if (now - this._lastSendMs < this._minSendGapMs) return;
      this._lastSendMs = now;
    }

    const buf = this._pool[this._poolIdx];
    this._poolIdx = (this._poolIdx + 1) % POOL_SIZE;
    const len = writePacket(buf, this.config.d3.devid, pos, vel);

    // Byte-identical to the legacy `snprintf(out, "%d:%d,%d;\n", ...)`.
    this._udp.send(buf, 0, len, this._onSendError);
    this.counters.tx++;
  }

  _onSendError = (err) => {
    if (!err) return;
    this.counters.txErrors++;
    if (this.counters.txErrors === 1 || this.counters.txErrors % 500 === 0) {
      this._warn(`UDP send failed (${this.counters.txErrors}x): ${err.message}`);
    }
  };

  _resolveVelocity(r, pos, nowMs, total) {
    const policy = this.config.velocityPolicy;

    if (policy === 'zero') {
      // Legacy default. d3driver.c did `vel = 0; // ignore velocity`, leaving
      // disguise to derive velocity via the axis velocitycalcmode. Kept as the
      // default so existing shows are bit-for-bit unchanged.
      this._updateDerived(pos, r.ts, nowMs, total);
      return 0;
    }
    if (policy === 'passthrough') {
      this._updateDerived(pos, r.ts, nowMs, total);
      return r.vel === null ? 0 : r.vel;
    }
    return Math.round(this._updateDerived(pos, r.ts, nowMs, total));
  }

  /** Wrap-aware velocity from position deltas, smoothed over ~200 ms. */
  _updateDerived(pos, ts, nowMs, total) {
    if (this._prevPos === null) return this._derivedVel;

    let dtSec = 0;
    if (ts !== null && this._prevTs !== null) {
      let dts = ts - this._prevTs;
      if (dts < 0) dts += 4294967296; // the µs counter wraps every ~1.2 h
      dtSec = dts / 1e6;
    } else if (this._prevMs !== null) {
      dtSec = (nowMs - this._prevMs) / 1000;
    }
    if (!(dtSec > 0) || dtSec > 1) return this._derivedVel;

    const inst = wrapDelta(pos, this._prevPos, total) / dtSec;
    const alpha = Math.min(1, dtSec / 0.2);
    this._derivedVel += alpha * (inst - this._derivedVel);
    return this._derivedVel;
  }

  _recordLatency(us) {
    this._latencyUs[this._latencyIdx] = us;
    this._latencyIdx = (this._latencyIdx + 1) % LATENCY_WINDOW;
    if (this._latencyCount < LATENCY_WINDOW) this._latencyCount++;
  }

  _recordGap(ms) {
    this._gapMs[this._gapIdx] = ms;
    this._gapIdx = (this._gapIdx + 1) % LATENCY_WINDOW;
    if (this._gapCount < LATENCY_WINDOW) this._gapCount++;
  }

  // -------------------------------------------------------------------------
  // Stall watchdog
  // -------------------------------------------------------------------------

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => this._checkStall(), 250);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _checkStall() {
    if (this._state !== STATE.STREAMING && this._state !== STATE.STALLED) return;

    const cycle = Number(this.config.encoderMeta.cycleTimeMs) || 10;
    const limit = Math.max(3 * cycle, 1000);
    const since = performance.now() - this.latest.tRxMs;
    if (since < limit) return;

    // Do not stack probes: one in flight, and at most one every 2 s.
    if (this._probePending) return;
    const now = performance.now();
    if (now - this._lastProbeMs < 2000) return;
    this._lastProbeMs = now;

    // The legacy driver spun forever here: recv() kept returning stale bytes and
    // disguise saw a frozen position with nothing indicating anything was wrong.
    if (this._state === STATE.STREAMING) {
      this._setState(STATE.STALLED, `no samples for ${Math.round(since)} ms — probing`);
    }

    this._probePending = true;
    this._commands.submit('Run!', {
      match: matchSample(), expectsSample: true, timeoutMs: TIMEOUTS.RUN_MS, label: 'Run!'
    })
      .then(() => {
        this._probePending = false;
        // It answered, so the link and the encoder are both alive — it simply
        // is not streaming. That is a configuration problem, and saying so is
        // far more useful than flapping back to STREAMING on the probe's own
        // reply and then stalling again a second later.
        this._setState(STATE.STALLED,
          'encoder answers Run! but is not streaming — check TimeMode=Cyclic and CycleTime');
      })
      .catch(() => {
        this._probePending = false;
        if (this._state === STATE.STALLED) {
          this._handleDisconnect(new Error('encoder stopped sending and did not answer Run!'));
        }
      });
  }

  // -------------------------------------------------------------------------
  // Field layout detection
  // -------------------------------------------------------------------------

  /**
   * A two-number ASCII_SHORT line is ambiguous: `pos vel` or `pos ts`. Ask the
   * encoder rather than guess, because guessing wrong sends a microsecond
   * timestamp to disguise as a velocity.
   */
  async _detectFieldLayout() {
    try {
      const type = await this.read('OutputType');
      if (String(type.value).toUpperCase() === 'BINARY') {
        this._warn('OutputType is BINARY. This app streams ASCII only — switch the encoder to ASCII_SHORT.');
        this.emit('encoderEvent', { id: this.id, kind: 'binaryMode', text: 'OutputType=BINARY' });
        return;
      }
      const mode = await this.read('OutputMode');
      const map = parseOutputMode(mode.value);
      if (map) {
        this._parser.setFieldMap(map);
        this.emit('fieldLayout', { id: this.id, fields: map, inferred: false, outputType: type.value });
        this._log('info', 'rx', `field layout from encoder: ${mode.value}`);
      } else {
        this._inferFieldLayout(`OutputMode=${mode.value} not understood`);
      }
    } catch (err) {
      this._inferFieldLayout(err.message);
    }
  }

  _inferFieldLayout(why) {
    this._parser.setFieldMap(null);
    this.emit('fieldLayout', { id: this.id, fields: null, inferred: true, why });
    this._warn(`Could not read OutputMode (${why}). Field layout will be inferred from the field count.`);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  _writeCommand(line) {
    if (!this._socket || this._socket.destroyed) throw new Error('not connected');
    // CRLF: what POSITAL's own Java client sent, so it is what this hardware
    // has always been fed.
    this._socket.write(line + '\r\n');
    this._log('info', 'tx', line);
  }

  read(variable) {
    return this._commands.submit(`read ${variable}`, {
      match: matchVariable(variable),
      timeoutMs: TIMEOUTS.READ_MS,
      label: `read ${variable}`
    });
  }

  write(variable, value) {
    assertSafeValue(value);
    return this._commands.submit(`set ${variable}=${value}`, {
      match: matchVariable(variable),
      timeoutMs: TIMEOUTS.WRITE_MS,
      label: `set ${variable}=${value}`
    });
  }

  // -------------------------------------------------------------------------
  // Flash-write policy
  //
  // Every `set` burns one of the encoder's ~100,000 flash cycles, and the
  // device must not lose power mid-write. Everything that spends a cycle goes
  // through here so that all transports — the desktop window, a browser, a
  // future script — share one budget rather than each keeping their own.
  // -------------------------------------------------------------------------

  /** Last known value of a variable, or null. `{ value, atMs }`. */
  cachedVar(name) {
    return this._varCache.get(name) || null;
  }

  /** All cached variables, as a plain object for the wire. */
  cachedVars() {
    const out = {};
    for (const [name, v] of this._varCache) out[name] = v;
    return out;
  }

  /**
   * Claim the right to spend flash cycles now. Throws `ERATELIMIT` if the last
   * batch was too recent, so an impatient double-click cannot cost two cycles.
   */
  beginWriteBatch() {
    const now = Date.now();
    const since = now - this._lastWriteBatchMs;
    if (since < TIMEOUTS.WRITE_RATE_LIMIT_MS) {
      const wait = Math.ceil((TIMEOUTS.WRITE_RATE_LIMIT_MS - since) / 1000);
      const err = new Error(
        `Please wait ${wait}s before writing to the encoder again (each write uses a flash cycle)`
      );
      err.code = 'ERATELIMIT';
      err.retryAfterMs = TIMEOUTS.WRITE_RATE_LIMIT_MS - since;
      throw err;
    }
    this._lastWriteBatchMs = now;
  }

  /** Write several variables in one rate-limited batch. Never throws per entry. */
  async writeMany(entries) {
    this.beginWriteBatch();
    const results = [];
    for (const e of entries) {
      try {
        await this.write(e.variable, e.value);
        results.push({ variable: e.variable, value: e.value, ok: true });
      } catch (err) {
        results.push({ variable: e.variable, value: e.value, ok: false, error: err.message });
      }
    }
    if (results.some((r) => r.ok)) this._armFlash();
    return results;
  }

  /**
   * Set the Preset (the position the encoder will report at the current shaft
   * angle).
   *
   * The firmware refuses to store the same Preset value twice in a row — the
   * next value must differ, though the one after may repeat. So writing the
   * value the encoder already holds is silently a no-op unless we go the long
   * way round: write `value + 1`, wait for the flash commit, then write
   * `value`. That costs two cycles, so it is never done without being asked.
   *
   * Returns `{ written, cycles, previous }`. Throws `EPRESET_DUPLICATE` when
   * the long way round is required and `force` was not set.
   */
  async setPreset(value, { force = false } = {}) {
    const target = Number(value);
    if (!Number.isInteger(target) || target < 0) {
      const err = new Error('Preset must be a non-negative whole number');
      err.code = 'EINVAL';
      throw err;
    }

    // Read rather than trust the cache: another client may have moved it, and
    // guessing wrong here either wastes a cycle or silently does nothing.
    let current = null;
    try {
      current = Number((await this.read('Preset')).value);
    } catch {
      current = null; // unreadable — fall through and just write it
    }

    if (current === target) {
      if (!force) {
        const err = new Error(
          `Preset is already ${target}. The encoder refuses an identical consecutive value, ` +
          'so setting it again would need two flash cycles.'
        );
        err.code = 'EPRESET_DUPLICATE';
        err.current = current;
        throw err;
      }
      this.beginWriteBatch();
      await this.write('Preset', String(target + 1));
      this._armFlash();
      await this._awaitFlash();
      await this.write('Preset', String(target));
      this._armFlash();
      return { written: target, cycles: 2, previous: current };
    }

    this.beginWriteBatch();
    await this.write('Preset', String(target));
    this._armFlash();
    return { written: target, cycles: 1, previous: current };
  }

  /** True while the encoder may still be committing to flash. */
  get flashPending() {
    return !!this._flashPending;
  }

  /**
   * Start the "do not power off" window. It closes when the encoder broadcasts
   * `Parameters successfully written!`, or times out — previously
   * `FLASH_COMMIT_MS` was declared but never used, so the UI's "waiting for
   * confirmation" state had nothing behind it and could wait forever.
   */
  _armFlash() {
    this._resolveFlash('superseded');
    const sinceMs = Date.now();
    const timer = setTimeout(() => this._resolveFlash('timeout'), TIMEOUTS.FLASH_COMMIT_MS);
    if (timer.unref) timer.unref();
    this._flashPending = { sinceMs, timer, waiters: [] };
    this.emit('encoderEvent', {
      id: this.id,
      kind: 'flashPending',
      text: 'Writing to flash — do not power off the encoder.'
    });
  }

  _resolveFlash(outcome) {
    const pending = this._flashPending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this._flashPending = null;
    for (const done of pending.waiters) done(outcome);
    if (outcome === 'timeout') {
      this.emit('encoderEvent', {
        id: this.id,
        kind: 'flashTimeout',
        text: 'No flash-write confirmation after 30s. Verify the value before power-cycling the encoder.'
      });
      this._log('warn', 'rx', 'flash commit not confirmed within 30s');
    }
  }

  /** Resolves when the current flash write commits, times out, or is superseded. */
  _awaitFlash() {
    if (!this._flashPending) return Promise.resolve('none');
    return new Promise((resolve) => this._flashPending.waiters.push(resolve));
  }

  run() {
    return this._commands.submit('Run!', {
      match: matchSample(),
      expectsSample: true,
      timeoutMs: TIMEOUTS.RUN_MS,
      label: 'Run!'
    });
  }

  raw(line) {
    assertSafeValue(line);
    return this._commands.submit(line, {
      match: (r) => r.kind === KIND.REPLY || r.kind === KIND.STATUS,
      timeoutMs: TIMEOUTS.READ_MS,
      label: line
    });
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /** Cheap per-tick payload. Called once per telemetry frame, not per sample. */
  telemetry() {
    const meta = this.config.encoderMeta;
    const pos = this.latest.pos;
    const derived = this._derivedVel;
    return {
      id: this.id,
      state: this._state,
      pos,
      rawVel: this.latest.rawVel,
      outVel: this.latest.outVel,
      ts: this.latest.ts,
      angleDeg: angleDeg(pos, meta.countsPerRev),
      revs: revolution(pos, meta.countsPerRev),
      rpm: stepsPerSecToRpm(derived, meta.countsPerRev),
      derivedVel: derived,
      rxTotal: this.counters.rx,
      txTotal: this.counters.tx,
      errors: this.counters.errors,
      txErrors: this.counters.txErrors,
      wraps: this.counters.wraps,
      reconnects: this.counters.reconnects,
      unknownLines: this.counters.unknownLines,
      latencyUs: percentiles(this._latencyUs, this._latencyCount),
      gapMs: percentiles(this._gapMs, this._gapCount),
      uptimeMs: this.counters.startedAtMs ? Date.now() - this.counters.startedAtMs : 0
    };
  }

  snapshot() {
    return {
      id: this.id,
      name: this.config.name,
      state: this._state,
      detail: this._stateDetail,
      lastError: this._lastError ? this._lastError.message : null,
      attempt: this._attempt,
      nextRetryMs: this._nextRetryMs,
      fields: this._parser.fieldMap,
      config: this.config,
      telemetry: this.telemetry()
    };
  }

  _setState(state, detail) {
    if (this._state === state && this._stateDetail === detail) return;
    this._state = state;
    this._stateDetail = detail || '';
    this.emit('state', {
      id: this.id,
      state,
      detail: this._stateDetail,
      attempt: this._attempt,
      nextRetryMs: this._nextRetryMs,
      lastError: this._lastError ? this._lastError.message : null
    });
  }

  _clearTimers() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopWatchdog();
    // A pending flash write cannot be confirmed once the socket is gone: the
    // confirmation is an unsolicited broadcast we would no longer be there to
    // hear. Release any waiter rather than leaving it hanging.
    this._resolveFlash('disconnected');
  }

  _log(level, dir, text) {
    this.emit('log', { id: this.id, level, dir, text, ts: Date.now() });
  }

  _warn(text) {
    this._log('warn', 'rx', text);
    this.emit('encoderEvent', { id: this.id, kind: 'warning', text });
  }
}

// ---------------------------------------------------------------------------

function truncate(s, n = 120) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * A value containing CR or LF would become an additional command on the shared
 * TCP channel. Refuse it at the boundary.
 */
function assertSafeValue(value) {
  const s = String(value);
  if (/[\r\n]/.test(s)) {
    const err = new Error('Value may not contain a line break');
    err.code = 'EINVALIDVALUE';
    throw err;
  }
  return s;
}

function percentiles(arr, count) {
  if (!count) return { p50: 0, p99: 0, max: 0 };
  const slice = Array.prototype.slice.call(arr, 0, count).sort((a, b) => a - b);
  return {
    p50: slice[Math.floor(count * 0.5)],
    p99: slice[Math.min(count - 1, Math.floor(count * 0.99))],
    max: slice[count - 1]
  };
}

function normaliseConfig(c) {
  const meta = c.encoderMeta || {};
  return {
    id: c.id,
    name: c.name || 'Encoder',
    encoder: {
      host: (c.encoder && c.encoder.host) || '10.10.10.10',
      port: (c.encoder && c.encoder.port) || 6000,
      localAddress: (c.encoder && c.encoder.localAddress) || null
    },
    d3: {
      host: (c.d3 && c.d3.host) || '127.0.0.1',
      port: (c.d3 && c.d3.port) || 6000,
      devid: (c.d3 && c.d3.devid) != null ? c.d3.devid : 1,
      localAddress: (c.d3 && c.d3.localAddress) || null,
      localPort: (c.d3 && c.d3.localPort) || null
    },
    velocityPolicy: c.velocityPolicy || 'zero',
    udpSendPolicy: c.udpSendPolicy || 'every',
    maxSendHz: c.maxSendHz || 0,
    parser: {
      autoDetect: c.parser ? c.parser.autoDetect !== false : true,
      fields: (c.parser && c.parser.fields) || null
    },
    encoderMeta: {
      countsPerRev: meta.countsPerRev || COUNTS_PER_REV,
      totalCounts: meta.totalCounts || TOTAL_COUNTS,
      cycleTimeMs: meta.cycleTimeMs || 10
    },
    reconnect: {
      enabled: c.reconnect ? c.reconnect.enabled !== false : true,
      minDelayMs: (c.reconnect && c.reconnect.minDelayMs) || RECONNECT.MIN_DELAY_MS,
      maxDelayMs: (c.reconnect && c.reconnect.maxDelayMs) || RECONNECT.MAX_DELAY_MS
    },
    logRaw: !!c.logRaw,
    autoStart: !!c.autoStart,
    mapping: c.mapping || null,
    notes: c.notes || ''
  };
}

module.exports = { EncoderLink, normaliseConfig, assertSafeValue };
