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

/**
 * Throughput is averaged over this window rather than smoothed exponentially.
 *
 * An EMA at 30 Hz reacts within a fraction of a second, so the figure twitched
 * constantly and read as noise on a screen left open all show. A flat window
 * gives a number that holds still long enough to be read and quoted down a
 * headset.
 *
 * One second, not ten: at ten the figure was steady but slow to admit anything
 * had changed — a connection that stopped delivering kept reading near its old
 * rate for several seconds. One second still averages ~100 samples at a normal
 * cycle time, which is plenty to stop it flickering, and it now says what is
 * happening rather than what was happening.
 */
const RATE_WINDOW_MS = 1000;

class LinkManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._links = new Map();
    this._rates = new Map();
    this.logger = opts.logger || new Logger();

    /**
     * What a disguise session last said about each destination, by destination
     * id: `{ matches, at }`.
     *
     * Held here rather than in a browser so every screen agrees, and so the
     * answer survives a re-render, a second client, and navigation. It is the
     * only *positive* evidence this app can obtain: UDP confirms nothing, so
     * `connected` — packets leaving, nothing objecting — is the most the network
     * can ever say. A destination can be perfectly connected and receiving
     * nothing, which is what a laptop at the far end looks like.
     */
    this.disguiseChecks = new Map();

    /**
     * The network state each destination was last seen in, by destination id.
     *
     * Evaluated on every tick, which costs nothing — it is ICMP and a clock. A
     * *change* is the signal to ask disguise again, and the only signal that
     * does not involve polling it: something that has just come back may have
     * come back different, and something that has just gone is worth knowing
     * about at once. A destination sitting healthily at `receiving` is never
     * queried, which is the case disguise's documentation protects.
     */
    this._lastDestHealth = new Map();

    /** Set by the host: (connectionId, destination, health) => void. */
    this.onDestinationStateChange = null;
    /**
     * Log delivery must not depend on anything streaming.
     *
     * `_tick()` is what drains the log to clients, and the timer that drives it
     * used to stop whenever no link was running — so with everything stopped,
     * lines were written and never sent. Stopping a connection, editing one,
     * deleting one, a failed read: all invisible until something started again
     * or the page was reloaded, which re-reads the ring buffer directly. That is
     * precisely when an operator is reading the log to find out what happened.
     */
    this.logger.onFirstPending = () => this._startTimer();
    this._telemetryHz = opts.telemetryHz || DEFAULT_TELEMETRY_HZ;
    this._timer = null;
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
        id: e.id, name: link.config.name, dir: 'app',
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
    for (const [id, link] of this._links) {
      // Same reason as start(): link.start() zeroes the counters, so samples
      // held from the previous run make the first second's average negative.
      // This loop skipped that reset and Stop All → Start All read -3000 Hz.
      const rate = this._rates.get(id);
      if (rate) rate.samples.length = 0;
      link.start();
    }
    this._syncTimer();
  }

  /** @returns {number} how many links actually had to be stopped. */
  stopAll() {
    let stopped = 0;
    for (const link of this._links.values()) if (link.stop()) stopped++;
    this._syncTimer();
    return stopped;
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
    if (this.runningCount > 0 || this.logger.pending) this._startTimer();
    else this._stopTimer();
  }

  _startTimer() {
    if (this._timer) return;
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
    const links = [];
    for (const link of this._links.values()) {
      if (!link.running) continue;

      const raw = link.telemetry();
      this._watchDestinationHealth(link.id, raw);
      const t = this.applyDisguiseChecks(raw);
      const rate = this._rates.get(link.id);
      if (rate) {
        // Counters, not deltas: the oldest sample still inside the window and
        // the newest give the average directly, and a dropped or late tick
        // cannot skew it the way a per-tick delta would.
        const now = Date.now();
        rate.samples.push({ t: now, rx: t.rxTotal, tx: t.txTotal });
        // Drop the oldest only while the *next* one is still beyond the window,
        // so the retained span always covers the window rather than falling
        // just short of it. Pruning on the oldest itself capped the span at the
        // window and left it hovering under the minimum below, which reported
        // 0 Hz for a link delivering a hundred packets a second.
        while (rate.samples.length > 2 && now - rate.samples[1].t > RATE_WINDOW_MS) {
          rate.samples.shift();
        }
        const first = rate.samples[0];
        const span = (now - first.t) / 1000;
        // Too little history says nothing useful yet; a link that has just
        // started reads 0 rather than a wild extrapolation. Proportional to the
        // window, not a fixed second — that coupling is what broke when the
        // window was shortened to one.
        if (span * 1000 >= RATE_WINDOW_MS / 2) {
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
    // Nothing running and nothing left to send: stop until something happens.
    // The timer costs little, but a show server should not hold a 30 Hz wakeup
    // open all night for an idle rig.
    if (this.runningCount === 0 && !this.logger.pending) this._stopTimer();

    if (logBatch && logBatch.dropped) {
      this.logger.push({
        level: 'warn', dir: 'app',
        text: `${logBatch.dropped} lines arrived faster than they could be sent to the ` +
          'log window and are missing above; they are in the exported log'
      });
    }
  }

  /**
   * Raise `connected` to `receiving`, or lower it to `mismatch`.
   *
   * Only where a disguise session has actually been asked; with no answer,
   * `connected` stands. A method rather than a few lines in the tick because
   * `linkSnapshot` returns telemetry too — applying it in one place and not the
   * other gave two endpoints two different answers about the same destination.
   */
  /**
   * Drop everything this manager has concluded about a destination. Called
   * when the destination itself goes — deleted, or replaced by an import.
   * Conclusions outliving their subject is how a recreated destination
   * inherited a dead one's verdict.
   */
  forgetDestination(id) {
    this.disguiseChecks.delete(id);
    this._lastDestHealth.delete(id);
  }

  forgetAllDestinations() {
    this.disguiseChecks.clear();
    this._lastDestHealth.clear();
  }

  applyDisguiseChecks(t) {
    for (const d of (t && t.destinations) || []) {
      const check = this.disguiseChecks.get(d.id);
      if (!check) continue;
      d.confirmed = check.matches;
      if (d.health === 'connected') d.health = check.matches ? 'receiving' : 'mismatch';
    }
    return t;
  }

  /**
   * Notice a destination changing network state, and say so once.
   *
   * `connected` and `offline` are the two the network can tell us apart without
   * asking anything. Whichever way it moves, what disguise is doing may have
   * moved with it — so this is where the check is triggered, rather than on a
   * timer that would be polling by another name.
   */
  _watchDestinationHealth(id, t) {
    for (const d of (t && t.destinations) || []) {
      // Before the disguise answer is folded in, so a `receiving` that is really
      // a confirmed `connected` does not read as a change of its own.
      const now = d.health === 'receiving' || d.health === 'mismatch' ? 'connected' : d.health;
      const before = this._lastDestHealth.get(d.id);
      this._lastDestHealth.set(d.id, now);
      if (before === undefined || before === now) continue;
      if (this.onDestinationStateChange) this.onDestinationStateChange(id, d, now);
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
        // From the same window the telemetry rate uses. This read `rate.tx`,
        // a field that has never existed on a rate entry, so packetsPerSec
        // was NaN from the day it was written — latent only because nothing
        // calls this yet; wrong the day the header bar it is documented for
        // arrives.
        const first = rate.samples[0];
        const last = rate.samples[rate.samples.length - 1];
        if (first && last && last.t > first.t) {
          pkts += (last.tx - first.tx) / ((last.t - first.t) / 1000);
        }
      }
    }
    return { total: this._links.size, running, packetsPerSec: Math.round(pkts) };
  }
}

module.exports = { LinkManager };
