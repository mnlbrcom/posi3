'use strict';
/**
 * Owns every EncoderLink and the one timer that feeds the UI.
 *
 * The point of this class is rate decoupling. An encoder at CycleTime=1 emits
 * ~500 samples/s; five of them is 2500/s. Sending one IPC message per sample
 * would swamp the renderer and, worse, put renderer backpressure on the
 * forwarding path. Instead each link keeps a mutable snapshot, and a single
 * interval here emits ONE message describing all links at ~30 Hz. Cost is
 * O(links) per tick rather than O(samples).
 */

const { EventEmitter } = require('node:events');
const { EncoderLink } = require('./encoder-link');
const { Logger } = require('./logger');
const { DEFAULT_TELEMETRY_HZ } = require('../shared/constants');

/** Smoothing for the packet-rate readouts, so they do not flicker. */
/**
 * Throughput is averaged over this window rather than smoothed exponentially.
 *
 * An EMA at 30 Hz reacts within a fraction of a second, so the figure twitched
 * constantly and read as noise on a screen left open all show. A flat ten
 * seconds gives a number that holds still long enough to be read, compared
 * against, and quoted down a headset.
 */
const RATE_WINDOW_MS = 10000;

class LinkManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._links = new Map();
    this._rates = new Map();
    this.logger = opts.logger || new Logger();
    this._telemetryHz = opts.telemetryHz || DEFAULT_TELEMETRY_HZ;
    this._timer = null;
    this._lastTickMs = 0;
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /** Create or reconfigure a link. Does not start it. */
  upsert(config) {
    const existing = this._links.get(config.id);
    if (existing) {
      existing.reconfigure(config);
      return existing;
    }

    const link = new EncoderLink(config);
    link.on('state', (e) => {
      this.emit('state', e);
      // The app's own state machine, not something the encoder said.
      this.logger.push({
        id: e.id, dir: 'app',
        level: e.state === 'error' ? 'error' : 'info',
        text: `[${e.state}] ${e.detail}`
      });
    });
    link.on('encoderEvent', (e) => this.emit('encoderEvent', e));
    link.on('fieldLayout', (e) => this.emit('fieldLayout', e));
    link.on('encoderMeta', (e) => this.emit('encoderMeta', e));
    link.on('log', (e) => this.logger.push(e));

    this._links.set(config.id, link);
    this._rates.set(config.id, { samples: [] });
    return link;
  }

  get(id) { return this._links.get(id); }
  has(id) { return this._links.has(id); }
  get size() { return this._links.size; }
  ids() { return Array.from(this._links.keys()); }

  remove(id) {
    const link = this._links.get(id);
    if (!link) return false;
    link.stop();
    link.removeAllListeners();
    this._links.delete(id);
    this._rates.delete(id);
    this._syncTimer();
    return true;
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  start(id) {
    const link = this._links.get(id);
    if (!link) throw new Error(`No such connection: ${id}`);
    // start() resets the counters, so history from the previous run would make
    // the average negative for the first ten seconds.
    const rate = this._rates.get(id);
    if (rate) rate.samples.length = 0;
    link.start();
    this._syncTimer();
    return link;
  }

  stop(id) {
    const link = this._links.get(id);
    if (!link) throw new Error(`No such connection: ${id}`);
    link.stop();
    this._syncTimer();
    return link;
  }

  startAll() {
    for (const link of this._links.values()) link.start();
    this._syncTimer();
  }

  stopAll() {
    for (const link of this._links.values()) link.stop();
    this._syncTimer();
  }

  /** Any link that is not idle. */
  get runningCount() {
    let n = 0;
    for (const link of this._links.values()) if (link.running) n++;
    return n;
  }

  dispose() {
    this.stopAll();
    for (const link of this._links.values()) link.removeAllListeners();
    this._links.clear();
    this._rates.clear();
    this._stopTimer();
  }

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  setTelemetryHz(hz) {
    this._telemetryHz = Math.max(1, Math.min(120, hz || DEFAULT_TELEMETRY_HZ));
    if (this._timer) {
      this._stopTimer();
      this._startTimer();
    }
  }

  /** Run the timer only while something is actually streaming. */
  _syncTimer() {
    if (this.runningCount > 0) this._startTimer();
    else this._stopTimer();
  }

  _startTimer() {
    if (this._timer) return;
    this._lastTickMs = performance.now();
    const interval = Math.round(1000 / this._telemetryHz);
    this._timer = setInterval(() => this._tick(), interval);
    if (this._timer.unref) this._timer.unref();
  }

  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const now = performance.now();
    const dt = (now - this._lastTickMs) / 1000;
    this._lastTickMs = now;

    const links = [];
    for (const link of this._links.values()) {
      if (!link.running) continue;

      const t = link.telemetry();
      const rate = this._rates.get(link.id);
      if (rate) {
        // Counters, not deltas: the oldest sample still inside the window and
        // the newest give the average directly, and a dropped or late tick
        // cannot skew it the way a per-tick delta would.
        const now = Date.now();
        rate.samples.push({ t: now, rx: t.rxTotal, tx: t.txTotal });
        while (rate.samples.length > 1 && now - rate.samples[0].t > RATE_WINDOW_MS) {
          rate.samples.shift();
        }
        const first = rate.samples[0];
        const span = (now - first.t) / 1000;
        // Under a second of history says nothing useful yet; a link that has
        // just started reads 0 rather than a wild extrapolation.
        if (span >= 1) {
          t.rxHz = (t.rxTotal - first.rx) / span;
          t.txHz = (t.txTotal - first.tx) / span;
        } else {
          t.rxHz = 0;
          t.txHz = 0;
        }
      } else {
        t.rxHz = 0;
        t.txHz = 0;
      }
      links.push(t);
    }

    if (links.length) this.emit('telemetry', { t: Date.now(), links });

    const logBatch = this.logger.drain();
    if (logBatch) this.emit('log', logBatch);
    // A gap in the log is itself a log entry. It used to be a note beside the
    // toolbar, which is the one place a reader of the log will not look, and it
    // left no trace in the record — so an exported log was silently incomplete.
    // Pushed after the drain, so it arrives on the next tick rather than
    // enlarging the batch that overflowed.
    if (logBatch && logBatch.dropped) {
      this.logger.push({
        level: 'warn', dir: 'app',
        text: `${logBatch.dropped} lines arrived faster than they could be sent to the ` +
          'log window and are missing above; they are in the exported log'
      });
    }
  }

  /** Aggregate for the header bar. */
  summary() {
    let pkts = 0;
    let running = 0;
    for (const [id, rate] of this._rates) {
      const link = this._links.get(id);
      if (link && link.running) {
        running++;
        pkts += rate.tx;
      }
    }
    return { total: this._links.size, running, packetsPerSec: pkts };
  }
}

module.exports = { LinkManager };
