'use strict';
/**
 * Bounded in-memory log with batched delivery.
 *
 * Raw line logging can run at 500 Hz per link, so nothing here may touch the
 * data path synchronously: lines are appended to a ring buffer and drained on
 * the telemetry tick. Beyond `maxPerFlush` we count what was dropped and say so
 * rather than pretending the log is complete.
 */

const DEFAULT_CAPACITY = 5000;

/**
 * Lines forwarded to clients per telemetry tick.
 *
 * 25 was sized for a raw-sample firehose that no longer exists — samples are
 * never logged, because at ~100/s per link they would bury everything else. The
 * real bursts are command sweeps: reading the config of two encoders is 14
 * variables each, sent and answered, and lands as ~56 lines inside a few
 * milliseconds. That is a single tick, so 31 of them were counted as dropped
 * and never reached the log window — the log quietly became incomplete exactly
 * when it was busiest, which is when it matters.
 *
 * 400 covers ten encoders read at once and still bounds the stream (30 ticks a
 * second). The counter stays, because a cap that cannot be reported is a cap
 * that lies.
 */
const DEFAULT_MAX_PER_FLUSH = 400;

class Logger {
  constructor(opts = {}) {
    this.capacity = opts.capacity || DEFAULT_CAPACITY;
    this.maxPerFlush = opts.maxPerFlush || DEFAULT_MAX_PER_FLUSH;
    this._ring = new Array(this.capacity);
    this._head = 0;
    this._size = 0;
    this._seq = 0;

    this._pending = [];
    this._dropped = 0;
  }

  /** @param {{id?:string, level?:string, dir?:string, text:string, ts?:number}} entry */
  push(entry) {
    const line = {
      seq: ++this._seq,
      ts: entry.ts || Date.now(),
      id: entry.id || null,
      level: entry.level || 'info',
      dir: entry.dir || null,
      text: entry.text
    };

    this._ring[this._head] = line;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;

    if (this._pending.length < this.maxPerFlush) this._pending.push(line);
    else this._dropped++;
  }

  /** @returns {{lines: object[], dropped: number}|null} null when there is nothing new */
  drain() {
    if (!this._pending.length && !this._dropped) return null;
    const out = { lines: this._pending, dropped: this._dropped };
    this._pending = [];
    this._dropped = 0;
    return out;
  }

  /** Newest-last slice of the ring, optionally filtered. */
  tail(opts = {}) {
    const limit = opts.limit || 500;
    const out = [];
    for (let i = 0; i < this._size; i++) {
      const idx = (this._head - this._size + i + this.capacity * 2) % this.capacity;
      const line = this._ring[idx];
      if (!line) continue;
      if (opts.id && line.id !== opts.id) continue;
      if (opts.level && line.level !== opts.level) continue;
      if (opts.dir && line.dir !== opts.dir) continue;
      if (opts.search && !line.text.toLowerCase().includes(opts.search.toLowerCase())) continue;
      out.push(line);
    }
    return out.slice(-limit);
  }

  clear() {
    this._ring = new Array(this.capacity);
    this._head = 0;
    this._size = 0;
    this._pending = [];
    this._dropped = 0;
  }

  get size() { return this._size; }
}

module.exports = { Logger };
