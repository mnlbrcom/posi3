'use strict';
/**
 * One encoder -> one or more disguise destinations.
 *
 * Owns a TCP client socket to the encoder (port 6000, data AND commands) and a
 * connected UDP socket per destination. Everything on the data path lives
 * here, in the main process: a renderer GC pause must never be able to delay a
 * packet.
 *
 * Fan-out belongs here rather than in a second connection because the TCP
 * socket is the scarce resource — the encoder accepts only a handful of
 * clients — while an extra UDP send costs microseconds.
 *
 * Latency rules observed in _onLine/_forward, and worth preserving:
 *   - parse and send synchronously in the socket's data handler, no queue
 *   - TCP_NODELAY on, so Nagle cannot sit on a small record
 *   - the UDP socket is *connected*, which skips a per-send address resolution
 *     and — unlike the legacy driver's unconnected sendto — actually surfaces
 *     ECONNREFUSED / EHOSTUNREACH instead of silently dropping
 *   - no allocation per sample: digits are written into pooled buffers and the
 *     parse result object is reused
 *   - no logging on this path at all: samples arrive at ~100/s and would bury
 *     every other line. Everything else the encoder says is logged verbatim.
 */

const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

const { LineAssembler } = require('./line-assembler');
const { CommandQueue, matchVariable, matchSample } = require('./command-queue');
const flashBudget = require('./flash-budget');
const {
  KIND, Parser, parseOutputMode, writePacket, MAX_PACKET_BYTES,
  wrapDelta, angleDeg, revolution, stepsPerSecToRpm
} = require('./protocol');
const {
  STATE, TIMEOUTS, RECONNECT, COUNTS_PER_REV
} = require('../shared/constants');

/** Ring of send buffers: dgram may hold one until the write completes. */
const POOL_SIZE = 8;
/** Recent arrival→send measurements, in microseconds. */
/**
 * How long sends must keep landing before a destination counts as recovered.
 *
 * Long enough that a lone datagram slipping through a down host does not
 * qualify, short enough that a genuine recovery is announced while it still
 * matters.
 */
const RECOVERY_QUIET_MS = 3000;

/**
 * Sending stops after this long of unbroken failure, and one probe datagram
 * goes out every RETRY_MS after that.
 *
 * There is nothing to gain from firing a hundred packets a second at a machine
 * that has told us, by ICMP, that it is not there. disguise exposes no
 * heartbeat — its Python API is `POST /api/session/python/execute` with no
 * documented status endpoint — but the connected UDP socket already answers the
 * question better than a heartbeat would: EHOSTUNREACH means the machine is not
 * on the network, ECONNREFUSED means it is but nothing is bound to the port.
 */
const SEND_GIVE_UP_MS = 2000;
const OFFLINE_RETRY_MS = 5000;

/**
 * How long a probe must go unanswered before the destination counts as back.
 *
 * The subtlety that makes this necessary: on a connected UDP socket the ICMP
 * refusal does not come back through `send()`'s callback. The send succeeds,
 * and the error arrives milliseconds later on the socket. So "no error in the
 * last three seconds" — a backwards-looking test — passes for a machine that is
 * still refusing, and the destination flapped between offline and recovered
 * every five seconds, announcing both.
 *
 * Recovery has to be judged forwards: send one, then wait to see if anything
 * objects.
 */
const PROBE_GRACE_MS = 1000;

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
    /** One connected UDP socket per enabled destination. */
    this._sinks = [];
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
      reconnects: 0, txErrors: 0, commandErrors: 0, startedAtMs: 0
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
    this._flashPending = null; // { sinceMs, timer }

    /** Which `set` syntax this encoder answered to. See write(). */
    this._setDialect = null;
    this._version = null;
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

    // Counters describe this run, not the process lifetime. Uptime already
    // reset here while the rest did not, so a link restarted after a
    // configuration change carried failures from a destination that no longer
    // existed — 3 000 send errors against a setup with none is the sort of
    // thing that gets chased at a venue instead of the real fault.
    Object.assign(this.counters, {
      rx: 0, tx: 0, errors: 0, unknownLines: 0, wraps: 0,
      reconnects: 0, txErrors: 0, commandErrors: 0, startedAtMs: Date.now()
    });
    this._latencyCount = 0; this._latencyIdx = 0;
    this._gapCount = 0; this._gapIdx = 0;
    this._openUdp();
    this._connect();
  }

  /**
   * @returns {boolean} whether there was anything to stop.
   *
   * A link that is idle *and holding nothing* has nothing to tear down, and
   * nothing happened — this used to run the whole teardown regardless and set
   * IDLE/'stopped', so a connection that had never been started announced
   * `[idle] stopped` every time somebody pressed Stop All: a state change in
   * the log for a link whose state had not changed.
   *
   * The resources are checked as well as the state, not instead of it. Idle
   * with a socket or a UDP sink open is reachable — `_openUdp()` runs before
   * `_connect()` sets CONNECTING — and skipping the release there leaks a
   * handle, which is exactly what a coarser `state === IDLE` guard did.
   */
  stop() {
    const holdsNothing = !this._socket && !this._sinks.length &&
      !this._reconnectTimer && !this._watchdog;
    if (this._state === STATE.IDLE && holdsNothing) return false;
    this._stopping = true;
    this._clearTimers();
    this._commands.rejectAll(new Error('link stopped'));
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._closeUdp();
    this._assembler.reset();
    this._setState(STATE.IDLE, 'stopped');
    return true;
  }

  /** Apply a changed configuration. Restarts the link when it is running. */
  reconfigure(config) {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.config = normaliseConfig(Object.assign({}, this.config, config));
    this._minSendGapMs = this.config.maxSendHz > 0 ? 1000 / this.config.maxSendHz : 0;
    if (wasRunning) this.start();
  }

  // -------------------------------------------------------------------------
  // UDP toward disguise
  // -------------------------------------------------------------------------

  /**
   * One connected socket per destination.
   *
   * Fanning out here rather than by defining a second connection is deliberate:
   * the scarce resource is the *TCP* socket to the encoder, which accepts only
   * a handful of clients, and on site a leftover Java applet or an old
   * d3driver.exe may already hold one. An extra UDP destination costs one more
   * `send` in the same tick — microseconds, and no added latency for the
   * destinations ahead of it.
   */
  _openUdp() {
    if (this._sinks.length) return;

    for (const dest of this.config.destinations) {
      if (dest.enabled === false) continue;

      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const sink = {
        dest,
        udp,
        ready: false,
        // Per destination, so one unreachable disguise machine reads as that
        // machine being down rather than as a general fault on the link.
        tx: 0,
        txErrors: 0,
        lastError: null,
        lastErrorCode: null,
        // Announced on a backing-off schedule, not per N failures. A dead
        // destination fails once per sample: at 125 Hz a "every 500 errors"
        // rule shouts every four seconds, indefinitely, about a situation that
        // has not changed — which buries anything that has.
        nextWarnAt: 0,
        warnBackoffMs: 0,
        lastErrorAt: 0,
        /** First failure of the current run of them, or 0 when sending is fine. */
        failingSince: 0,
        /** Sending suppressed; one probe every OFFLINE_RETRY_MS instead. */
        offline: false,
        /** Packets not sent because the destination was known to be down. */
        suppressed: 0,
        nextProbeAt: 0,
        probeSentAt: 0,
        onError: (err) => {
          if (!err) return;
          sink.txErrors++;
          this.counters.txErrors++;
          sink.lastError = err.message;
          // The code, not just the text: ICMP separates a machine that is not
          // on the network from one that is up with nothing bound to the port —
          // which for disguise means the software is not running.
          sink.lastErrorCode = err.code || null;
          // Arm the recovery notice again: a destination that comes back, goes
          // away and comes back once more should say so both times.
          sink.recovered = false;

          const now = Date.now();
          sink.lastErrorAt = now;
          if (!sink.failingSince) sink.failingSince = now;

          // Long enough to rule out a blip, short enough that a show does not
          // spend a minute shouting into a hole.
          if (!sink.offline && now - sink.failingSince >= SEND_GIVE_UP_MS) {
            sink.offline = true;
            sink.nextProbeAt = now + OFFLINE_RETRY_MS;
            const place = dest.name ? `${dest.name} (${dest.host}:${dest.port})` : `${dest.host}:${dest.port}`;
            this._log('warn', 'app',
              `${place} is not answering — pausing sends, retrying every ${OFFLINE_RETRY_MS / 1000}s. ` +
              'The encoder connection stays up.');
            this.emit('encoderEvent', {
              id: this.id, kind: 'destinationDown',
              text: `${place} is offline — sends paused, retrying every ${OFFLINE_RETRY_MS / 1000}s`
            });
          }

          if (now < sink.nextWarnAt) return;
          // 0s, 15s, 60s, 240s, then every 15 minutes.
          sink.warnBackoffMs = sink.warnBackoffMs
            ? Math.min(sink.warnBackoffMs * 4, 900000)
            : 15000;
          sink.nextWarnAt = now + sink.warnBackoffMs;

          const where = dest.name ? `${dest.name} (${dest.host}:${dest.port})` : `${dest.host}:${dest.port}`;
          this._warn(`Cannot reach ${where}: ${err.message}. ${sink.txErrors} packets lost so far.`);
        },
        onSent: () => {
          // Recovery is news too. Without this a destination that came back
          // leaves its last warning as the most recent thing anyone was told.
          if (!sink.txErrors || sink.recovered) return;

          // But one successful send is not recovery. A host that is off flaps:
          // the odd datagram gets through between ARP retries, and treating
          // that as "back" reset the backoff every time. Measured on a disguise
          // machine that was switched off for three hours — 1,294 log lines and
          // 440 recovery claims, where the backoff was designed to produce
          // about fifteen. Recovery means the sends have been landing for a
          // while, not that one did.
          // While offline, the probe path decides — a send callback returning
          // success proves nothing, because ICMP has not had time to arrive.
          if (sink.offline) return;
          if (Date.now() - sink.lastErrorAt < RECOVERY_QUIET_MS) return;

          sink.failingSince = 0;
          sink.lastErrorCode = null;
          this._announceRecovery(sink, dest);
        }
      };

      // Only installed once a failure has been seen, so the happy path stays a
      // bare callback with nothing extra to do per packet.
      sink.onSendResult = (err) => (err ? sink.onError(err) : sink.onSent());
      udp.on('error', sink.onError);

      const afterBind = () => {
        // Connecting the datagram socket removes a per-send address lookup and,
        // unlike the legacy unconnected sendto, lets ICMP errors reach us.
        udp.connect(dest.port, dest.host, () => { sink.ready = true; });
      };

      try {
        if (dest.localAddress || dest.localPort) {
          udp.bind(dest.localPort || 0, dest.localAddress || undefined, afterBind);
        } else {
          afterBind();
        }
      } catch (err) {
        sink.lastError = err.message;
        this._warn(`Could not bind UDP for ${dest.host}:${dest.port}: ${err.message}`);
      }

      this._sinks.push(sink);
    }

    if (!this._sinks.length) {
      this._warn('No enabled destinations — position data has nowhere to go.');
    }
  }

  _closeUdp() {
    for (const sink of this._sinks) {
      try { sink.udp.close(); } catch { /* already closed */ }
    }
    this._sinks = [];
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
    socket.on('end', () => this._log('info', 'app', 'encoder closed the connection (FIN)'));

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
    //
    // Verbatim, always. This is what the encoder actually said, and it is the
    // record. Anything this app concludes from it is logged separately as `app`
    // and never in place of it — the reason `read CycleTime` used to be followed
    // by "cycle time changed on the encoder: 18 ms" with the device's own
    // `CycleTime=18` appearing nowhere at all.
    this._log(rxLevel(r), 'rx', truncate(line));

    const consumed = this._commands.handleParsed(r);

    // Cache every reply, consumed or not — see the note on _varCache.
    if (r.kind === KIND.REPLY) {
      this._varCache.set(r.variable, { value: r.value, atMs: Date.now() });
      this._applyLiveVar(r.variable, r.value);
    }

    switch (r.kind) {
      case KIND.EVENT:
        this._resolveFlash('confirmed');
        this.emit('encoderEvent', { id: this.id, kind: 'paramsWritten', text: 'Parameters successfully written!' });
        break;
      case KIND.STATUS:
        // A rejection of something we asked for is not a fault in the stream.
        // `consumed` means the command queue matched this to an in-flight
        // request — a refused `set`, a read of a write-only variable. Counting
        // those as stream errors left a bad config write sitting on the show
        // dashboard as a permanent fault, next to figures that mean the data
        // path is in trouble. An error nobody asked for still counts.
        if (r.severity === 'error') {
          if (consumed) this.counters.commandErrors++;
          else this.counters.errors++;
        }
        // The line itself is already in the log, at its own severity.
        if (!consumed) this.emit('encoderEvent', { id: this.id, kind: r.severity, text: r.text });
        break;
      case KIND.REPLY:
        if (!consumed) this.emit('encoderEvent', { id: this.id, kind: 'unsolicited', text: `${r.variable}=${r.value}` });
        break;
      default:
        // Logged verbatim above, at warn level, so there is nothing to add.
        this.counters.unknownLines++;
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
    if (this._minSendGapMs > 0) {
      const now = performance.now();
      if (now - this._lastSendMs < this._minSendGapMs) return;
      this._lastSendMs = now;
    }

    const sinks = this._sinks;
    let buf = null;
    let len = 0;
    let builtFor = -1;

    const nowMs = Date.now();
    for (let i = 0; i < sinks.length; i++) {
      const sink = sinks[i];
      if (!sink.ready) continue;

      // A destination that has stopped answering gets one probe every few
      // seconds instead of every sample. UDP is stateless, so resuming costs
      // nothing — there is no session to re-establish, only a send that works.
      if (sink.offline) {
        // A probe that nothing objected to, long enough ago to be sure — and
        // nothing objecting for a while either side of it.
        //
        // `lastErrorAt < probeSentAt` alone asks only "did an error arrive in
        // the second after this probe". On a destination whose cable has been
        // pulled the ICMP can take longer than that, so the probe looked clean,
        // the sink was declared recovered, the next samples failed, and two
        // seconds later it went offline again — flapping, while the dashboard
        // said `receiving` throughout. Measured on the rig with the cable out:
        // 404 send errors and 4,148 suppressed packets, health `receiving`.
        //
        // Sends have to have been quiet for RECOVERY_QUIET_MS as well, which is
        // the same bar the send-callback path already used.
        if (sink.probeSentAt && nowMs - sink.probeSentAt >= PROBE_GRACE_MS &&
            sink.lastErrorAt < sink.probeSentAt &&
            nowMs - sink.lastErrorAt >= RECOVERY_QUIET_MS) {
          sink.offline = false;
          sink.failingSince = 0;
          sink.probeSentAt = 0;
          sink.lastErrorCode = null;
          // `sink.dest`, not `dest`: this is _forward, not the _openUdp loop where
          // that name exists. A ReferenceError here killed the main process the
          // first time a destination actually recovered through the probe path.
          this._announceRecovery(sink, sink.dest);
        } else if (nowMs < sink.nextProbeAt) {
          sink.suppressed++;
          continue;
        } else {
          sink.nextProbeAt = nowMs + OFFLINE_RETRY_MS;
          sink.probeSentAt = nowMs;
        }
      }

      // Destinations usually share a device ID, so the packet is built once and
      // sent to each. Only rebuild when a destination overrides it.
      if (sink.dest.devid !== builtFor) {
        buf = this._pool[this._poolIdx];
        this._poolIdx = (this._poolIdx + 1) % POOL_SIZE;
        // Byte-identical to the legacy `snprintf(out, "%d:%d,%d;\n", ...)`.
        len = writePacket(buf, sink.dest.devid, pos, vel);
        builtFor = sink.dest.devid;
      }

      sink.udp.send(buf, 0, len, sink.txErrors ? sink.onSendResult : sink.onError);
      sink.tx++;
      this.counters.tx++;
    }
  }

  /** Said once per outage, whichever path noticed the destination was back. */
  _announceRecovery(sink, dest) {
    if (sink.recovered) return;
    sink.recovered = true;
    const where = dest.name ? `${dest.name} (${dest.host}:${dest.port})` : `${dest.host}:${dest.port}`;
    this._log('info', 'app', `${where} is reachable again after ${sink.txErrors} lost packets`);
    this.emit('encoderEvent', {
      id: this.id, kind: 'destinationUp',
      text: `${where} is reachable again`
    });
    sink.nextWarnAt = 0;
    sink.warnBackoffMs = 0;
  }

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

    // There used to be a third policy that sent this computed value to
    // disguise. It was removed: the encoder reports a velocity of its own and
    // disguise derives one via the axis velocitycalcmode, so a third figure —
    // differing from the encoder's by a median factor of 0.6 on the reference
    // rig — was a third opinion nobody asked for.
    //
    // The computation stays because the Speed readout is derived from it: rpm
    // comes from position deltas, not from the encoder's velocity field, so it
    // is there whether or not the encoder reports one.
    this._updateDerived(pos, r.ts, nowMs, total);
    return 0;
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

    // A timer needs a number before the encoder has told us its cycle. This is
    // a starting point for the watchdog, not a claim about the device, and it
    // is replaced by the real value the moment CycleTime is read.
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
   * Act on a configuration change, not merely record it.
   *
   * The encoder broadcasts to *every* connected TCP client — not just the
   * reply, but the command itself. So when somebody reconfigures the device
   * from POSITAL's applet, another posi3, or a raw socket, we are told. Until
   * this existed we cached the new value and carried on parsing with the old
   * layout, which is the quiet kind of wrong: benign when a field is removed
   * from the end, but if `OutputMode` ever loses Position from the front, the
   * next field takes its place and disguise is driven by a timestamp.
   *
   * Observed on the reference rig: `OutputMode` went `POSITION_VELOCITY` ->
   * `POSITION` and `CycleTime` 18 -> 8 mid-session, and nothing noticed.
   *
   * A first answer is not a change. Before the encoder has spoken we hold no
   * value for these, so the first one is simply what the device is set to — it
   * is logged as an observation and kept. Only a value that differs from one we
   * already had is a change, because only then did something actually change.
   */
  _applyLiveVar(name, value) {
    switch (name) {
      case 'OutputMode': {
        const map = parseOutputMode(value);
        if (!map) return;
        const before = this._parser.fieldMap;
        if (before && before.length === map.length && before.every((f, i) => f === map[i])) return;
        this._parser.setFieldMap(map);
        this.emit('fieldLayout', { id: this.id, fields: map, inferred: false });
        // Only a warning when a layout we were already parsing with was
        // replaced: that is the case where samples were being read wrongly
        // until this moment. Learning it on connect is routine.
        if (before) this._log('warn', 'app', `field layout changed on the encoder: ${value}`);
        break;
      }
      case 'OutputType':
        if (String(value).toUpperCase() === 'BINARY') {
          this._warn('OutputType was changed to BINARY. This app streams ASCII only.');
          this.emit('encoderEvent', { id: this.id, kind: 'binaryMode', text: 'OutputType=BINARY' });
        }
        break;
      case 'CycleTime': {
        // Feeds the stall watchdog: at CycleTime=8 a gap that is normal at 18
        // would otherwise look like a stall, and vice versa.
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0) return;
        const known = this.config.encoderMeta.cycleTimeMs;
        if (known === ms) return;
        this.config.encoderMeta.cycleTimeMs = ms;
        this.emit('encoderMeta', { id: this.id, cycleTimeMs: ms });
        // "from encoder" for what it is set to, "changed on the encoder" for
        // something that moved. Both are worth a line; only one is an event.
        this._log('info', 'app', known == null
          ? `cycle time from encoder: ${ms} ms`
          : `cycle time changed on the encoder: ${known} ms → ${ms} ms`);
        break;
      }
      case 'TotalScaledRes':
      case 'UsedScopeOfPhysRes': {
        const total = Number((this._varCache.get('TotalScaledRes') || {}).value);
        const scope = Number((this._varCache.get('UsedScopeOfPhysRes') || {}).value);
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(scope) || scope <= 0) return;
        const perRev = Math.round(COUNTS_PER_REV * (total / scope));
        const meta = this.config.encoderMeta;
        if (meta.totalCounts === total && meta.countsPerRev === perRev) return;
        const knew = meta.totalCounts != null;
        meta.totalCounts = total;
        if (perRev > 0) meta.countsPerRev = perRev;
        this.emit('encoderMeta', { id: this.id, totalCounts: total, countsPerRev: meta.countsPerRev, usedScope: scope });
        this._log('info', 'app',
          `${knew ? 'scaling changed on the encoder' : 'scaling from encoder'}: ` +
          `${total} steps total, ${meta.countsPerRev}/turn ` +
          `(${(total / meta.countsPerRev).toFixed(2)} turns of travel)`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Take the encoder's own scaling rather than the type label's.
   *
   * `TotalScaledRes` and `UsedScopeOfPhysRes` are programmable, and a
   * commissioned encoder is often nothing like the 33,554,432 of its
   * nameplate — the unit on the bench here reports 300,000. Deriving degrees
   * and revolutions from the label instead of the device produces confidently
   * wrong readouts, so ask.
   *
   * Scaled counts per revolution = physical counts/rev x (scaled / physical
   * scope), which collapses to the physical figure when the two are equal.
   */
  async _readScaling() {
    try {
      const total = Number((await this.read('TotalScaledRes')).value);
      const scope = Number((await this.read('UsedScopeOfPhysRes')).value);
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(scope) || scope <= 0) return;

      const perRev = Math.round(COUNTS_PER_REV * (total / scope));
      const meta = this.config.encoderMeta;
      if (meta.totalCounts === total && meta.countsPerRev === perRev) return;

      meta.totalCounts = total;
      if (perRev > 0) meta.countsPerRev = perRev;
      this.emit('encoderMeta', { id: this.id, totalCounts: total, countsPerRev: meta.countsPerRev, usedScope: scope });
      this._log('info', 'app',
        `scaling from encoder: ${total} steps total, ${meta.countsPerRev}/turn ` +
        `(${(total / meta.countsPerRev).toFixed(2)} turns of travel)`);
    } catch (err) {
      this._log('warn', 'app', `could not read scaling (${err.message}); using configured values`);
    }
  }

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
        this._log('info', 'app', `field layout from encoder: ${mode.value}`);
      } else {
        this._inferFieldLayout(`OutputMode=${mode.value} not understood`);
      }

      await this._readScaling();
      // Best effort and last: older builds may not know the command, and not
      // knowing the version must never stop a link from streaming.
      try {
        await this.version();
        this._log('info', 'app', `firmware ${this._version}`);
      } catch { /* an encoder that will not say is still an encoder */ }
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

  /**
   * The encoder's firmware version, e.g. `4.50`.
   *
   * `Version` is a bare command, not a variable: `read Version` is not
   * understood. It is undocumented — found because the encoder's own web page
   * has a CheckVersion button — and it matters more than a nameplate would,
   * because behaviour differs between builds. This unit refuses the manual's
   * `Position_Velocity_Timestamp_` and accepts only its own
   * `POSITION_VELOCITY_TIMESTAMP`, which is exactly the sort of difference a
   * version number explains.
   */
  async version() {
    const r = await this._commands.submit('Version', {
      match: matchVariable('Version'),
      timeoutMs: TIMEOUTS.READ_MS,
      label: 'Version'
    });
    this._version = r.value;
    this.emit('encoderMeta', { id: this.id, version: this._version });
    return this._version;
  }

  read(variable) {
    return this._commands.submit(`read ${variable}`, {
      match: matchVariable(variable),
      timeoutMs: TIMEOUTS.READ_MS,
      label: `read ${variable}`
    });
  }

  /**
   * Set a variable, tolerating both command dialects.
   *
   * POSITAL document two different syntaxes for the same operation. The manual
   * (UME-OCD-EM §5.6.1) gives `set <Variable>=<Value>`; their later note
   * "Modbus Encoder Parametrization via Command Lines" gives the bare
   * `Variable=Value`, e.g. `CountingDir=CCW`. Which one a given firmware
   * accepts is not something we can know from here, and picking wrong means
   * every write silently fails on site.
   *
   * So: try the documented form, and if the encoder rejects it outright, try
   * the bare form once. A rejected `set` does not reach flash — the encoder
   * answers ERROR instead of writing — so the retry cannot cost a second
   * cycle. Once one dialect answers, remember it for the connection.
   */
  async write(variable, value) {
    assertSafeValue(value);

    // The remembered dialect goes first, but the other one stays as a fallback
    // rather than being dropped. Remembering it as the *only* form meant a
    // single wrong guess disabled writing for the rest of the connection: every
    // later `set` went out in a dialect the device ignores, with nothing to
    // fall back to and nothing in the log to say why. That is exactly how a
    // CycleTime change that had worked earlier in a session stopped working.
    const withSet = `set ${variable}=${value}`;
    const bare = `${variable}=${value}`;
    const forms = this._setDialect === 'bare' ? [bare, withSet] : [withSet, bare];

    let lastErr = null;
    for (let i = 0; i < forms.length; i++) {
      try {
        const r = await this._commands.submit(forms[i], {
          match: matchVariable(variable),
          timeoutMs: TIMEOUTS.WRITE_MS,
          label: forms[i]
        });
        // The encoder answers a refusal the same way it answers a success:
        // `<Variable>=<Value>`. On refusal the value is the *old* one — "using
        // previous value" — so matching the variable name alone reads a
        // rejection as a write. That is what recorded a bare-form success
        // against an OutputMode the device had just refused, flipped the
        // remembered dialect, and armed a flash banner for a commit that was
        // never going to come.
        if (r && r.value !== undefined && !sameValue(r.value, value)) {
          const err = new Error(
            `${variable} was refused: the encoder still reports ${r.value}`);
          err.code = 'EENCODER';
          throw err;
        }
        const dialect = forms[i] === withSet ? 'set' : 'bare';
        if (dialect !== this._setDialect) {
          this._log('info', 'app', `write dialect for this encoder: "${dialect === 'set' ? 'set Var=Value' : 'Var=Value'}"`);
          this._setDialect = dialect;
        }
        return r;
      } catch (err) {
        lastErr = err;
        // Only an explicit refusal is worth retrying: the encoder answered
        // ERROR, so nothing reached flash. A timeout or a dropped link leaves
        // us not knowing whether the write landed, and repeating it could
        // spend a second of the device's ~100,000 cycles.
        // Say what the device actually objected to. Without this the log showed
        // a retry with no reason for it, and the first form's error was
        // invisible — which is most of why the OutputMode failure took so long
        // to pin down.
        this._log('warn', 'app', `"${forms[i]}" refused: ${err.message}`);
        if (err.code !== 'EENCODER') throw err;
        if (i + 1 < forms.length) {
          this._log('info', 'app', `retrying as "${forms[i + 1]}"`);
        } else if (this._setDialect) {
          // Both forms refused, so what was remembered is no longer trusted —
          // the next write starts from the documented form again instead of
          // inheriting a guess that has just been disproved.
          this._log('warn', 'app', 'both write forms were refused; forgetting the remembered dialect');
          this._setDialect = null;
        }
      }
    }
    throw lastErr;
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
    // Shared with the one-shot writer used when this connection is stopped, so
    // the device's ~100,000 cycles are counted once however they are spent.
    flashBudget.claim(this.id);
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
    //
    // On the firmware tested here `read Preset` answers "Preset is an unknown
    // variable" — it is write-only. When that happens the duplicate cannot be
    // detected in advance, so the write is attempted and the encoder's own
    // refusal is surfaced instead. Better an honest "it declined" than a
    // confident guess.
    let current = null;
    let readable = true;
    try {
      current = Number((await this.read('Preset')).value);
      if (!Number.isFinite(current)) { current = null; readable = false; }
    } catch {
      current = null;
      readable = false;
    }

    if (!readable && !force) {
      this.beginWriteBatch();
      const r = await this.write('Preset', String(target));
      this._armFlash();
      return { written: target, cycles: 1, previous: null, verified: false, reply: r && r.value };
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
      this._log('warn', 'app', 'flash commit not confirmed within 30s');
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

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /** Cheap per-tick payload. Called once per telemetry frame, not per sample. */
  telemetry() {
    const meta = this.config.encoderMeta;
    const pos = this.latest.pos;
    const derived = this._derivedVel;
    // Degrees and revolutions need a divisor before the encoder has answered.
    // The nameplate figure is the honest guess for the arithmetic; what is
    // *reported* below stays null until the device says otherwise, so nothing
    // downstream mistakes the guess for a reading.
    const perRev = meta.countsPerRev || COUNTS_PER_REV;
    return {
      id: this.id,
      state: this._state,
      // Carried on every frame so a client that joined late, or reconnected its
      // event stream, shows the same thing as one that watched the transition.
      detail: this._stateDetail,
      pos,
      rawVel: this.latest.rawVel,
      outVel: this.latest.outVel,
      ts: this.latest.ts,
      angleDeg: angleDeg(pos, perRev),
      revs: revolution(pos, perRev),
      rpm: stepsPerSecToRpm(derived, perRev),
      derivedVel: derived,
      rxTotal: this.counters.rx,
      txTotal: this.counters.tx,
      errors: this.counters.errors,
      commandErrors: this.counters.commandErrors,
      version: this._version,
      txErrors: this.counters.txErrors,
      wraps: this.counters.wraps,
      reconnects: this.counters.reconnects,
      unknownLines: this.counters.unknownLines,
      latencyUs: percentiles(this._latencyUs, this._latencyCount),
      gapMs: percentiles(this._gapMs, this._gapCount),
      uptimeMs: this.counters.startedAtMs ? Date.now() - this.counters.startedAtMs : 0,
      // As read from the device, not as configured — see _readScaling().
      totalCounts: meta.totalCounts,
      countsPerRev: meta.countsPerRev,
      // Per destination, so the UI can show which disguise machine is not
      // receiving rather than only that something is wrong.
      destinations: this._sinks.map((s) => ({
        id: s.dest.id,
        offline: s.offline,
        suppressed: s.suppressed,
        health: destinationHealth(s, this.running),
        name: s.dest.name,
        host: s.dest.host,
        port: s.dest.port,
        devid: s.dest.devid,
        ready: s.ready,
        tx: s.tx,
        txErrors: s.txErrors,
        lastError: s.lastError
      }))
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

  /**
   * The name is stamped here, not looked up when the line is drawn.
   *
   * A reader resolving the id against the current connections shows a bare UUID
   * the moment one is deleted, and Export never had the name at all. Recording
   * the name the connection had when the line was written is also the more
   * truthful record: rename an encoder and yesterday's lines still say what it
   * was called yesterday.
   */
  _log(level, dir, text) {
    this.emit('log', { id: this.id, name: this.config.name, level, dir, text, ts: Date.now() });
  }

  _warn(text) {
    this._log('warn', 'app', text);
    this.emit('encoderEvent', { id: this.id, kind: 'warning', text });
  }
}

// ---------------------------------------------------------------------------

function truncate(s, n = 120) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * What severity to log an encoder line at.
 *
 * The device's own words carry the level, so `ERROR: unknown command` arrives
 * in the log as an error rather than as an info line with the word ERROR in it.
 * A line nothing could parse is a warning: it is either a firmware we do not
 * know or a stream that has gone wrong, and both are worth seeing.
 */
function rxLevel(r) {
  if (r.kind === KIND.STATUS) return r.severity === 'error' ? 'error' : 'warn';
  if (r.kind !== KIND.REPLY && r.kind !== KIND.EVENT) return 'warn';
  return 'info';
}

/**
 * A value containing CR or LF would become an additional command on the shared
 * TCP channel. Refuse it at the boundary.
 */
/**
 * Is the device's echo the value we asked for?
 *
 * Case and separators are ignored: the encoder answers `CYCLIC` where the
 * manual writes `Cyclic`, and that is agreement, not a refusal.
 */
function sameValue(a, b) {
  const fold = (v) => String(v).trim().toLowerCase().replace(/[\s_-]/g, '');
  return fold(a) === fold(b);
}

/**
 * What to tell the operator about one destination.
 *
 *   receiving  packets are arriving there and nothing has objected. Named for
 *              what the destination is doing, so it reads the same way as the
 *              encoder's own pill beside it: one says a device is streaming,
 *              the other that a machine is receiving
 *   refused   the machine answered ICMP port-unreachable — it is on the
 *             network, but nothing is bound to that port. For disguise that
 *             means Designer is closed, or the Navigator driver has not been
 *             started
 *   offline   no answer at all: switched off, unplugged, or a different subnet
 *   idle      the link is not running, so nothing has been tried
 *
 * The distinction between `refused` and `offline` is worth carrying all the way
 * to the screen, because they call for different people: one is "start
 * disguise", the other is "check the machine or the cable".
 */
function destinationHealth(sink, running) {
  if (!running) return 'idle';
  if (!sink.offline) return 'receiving';
  return sink.lastErrorCode === 'ECONNREFUSED' ? 'refused' : 'offline';
}

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

/**
 * Accepts either shape: `destinations[]` (schema 2) or a lone `d3` (schema 1),
 * so the link can be driven straight from an un-migrated object — which the
 * test harness and `tools/link-harness.js` both do.
 */
function normaliseDestinations(c) {
  const raw = Array.isArray(c.destinations) && c.destinations.length
    ? c.destinations
    : [c.d3 || {}];
  return raw.map((d, i) => ({
    id: d.id || `dest-${i}`,
    name: d.name || '',
    host: d.host || '127.0.0.1',
    port: d.port || 6000,
    devid: d.devid != null ? d.devid : 1,
    enabled: d.enabled !== false,
    localAddress: d.localAddress || null,
    localPort: d.localPort || null
  }));
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
    destinations: normaliseDestinations(c),
    velocityPolicy: c.velocityPolicy || 'zero',
    udpSendPolicy: c.udpSendPolicy || 'every',
    maxSendHz: c.maxSendHz || 0,
    parser: {
      autoDetect: c.parser ? c.parser.autoDetect !== false : true,
      fields: (c.parser && c.parser.fields) || null
    },
    // Null until the encoder has answered. Filling these in here would recreate
    // the fabricated baseline that made every first read look like a change.
    encoderMeta: {
      countsPerRev: meta.countsPerRev || null,
      totalCounts: meta.totalCounts || null,
      cycleTimeMs: meta.cycleTimeMs || null
    },
    reconnect: {
      enabled: c.reconnect ? c.reconnect.enabled !== false : true,
      minDelayMs: (c.reconnect && c.reconnect.minDelayMs) || RECONNECT.MIN_DELAY_MS,
      maxDelayMs: (c.reconnect && c.reconnect.maxDelayMs) || RECONNECT.MAX_DELAY_MS
    },
    logRaw: !!c.logRaw,
    autoStart: !!c.autoStart,
    notes: c.notes || ''
  };
}

module.exports = { EncoderLink, normaliseConfig, assertSafeValue };
