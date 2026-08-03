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
const HZ_ALPHA = 0.35;

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
      this.logger.push({ id: e.id, level: e.state === 'error' ? 'error' : 'info', text: `[${e.state}] ${e.detail}` });
    });
    link.on('encoderEvent', (e) => this.emit('encoderEvent', e));
    link.on('fieldLayout', (e) => this.emit('fieldLayout', e));
    link.on('encoderMeta', (e) => this.emit('encoderMeta', e));
    link.on('log', (e) => this.logger.push(e));

    this._links.set(config.id, link);
    this._rates.set(config.id, { rx: 0, tx: 0, lastRx: 0, lastTx: 0 });
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
      if (rate && dt > 0) {
        const rxHz = (t.rxTotal - rate.lastRx) / dt;
        const txHz = (t.txTotal - rate.lastTx) / dt;
        rate.lastRx = t.rxTotal;
        rate.lastTx = t.txTotal;
        rate.rx += HZ_ALPHA * (rxHz - rate.rx);
        rate.tx += HZ_ALPHA * (txHz - rate.tx);
        t.rxHz = rate.rx;
        t.txHz = rate.tx;
      } else {
        t.rxHz = 0;
        t.txHz = 0;
      }
      links.push(t);
    }

    if (links.length) this.emit('telemetry', { t: Date.now(), links });

    const logBatch = this.logger.drain();
    if (logBatch) this.emit('log', logBatch);
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
