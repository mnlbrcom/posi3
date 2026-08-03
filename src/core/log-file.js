'use strict';
/**
 * Optional log file.
 *
 * A packaged app has no console. When something goes wrong before the UI is up
 * — a port already bound, an unreadable profile — there is otherwise no record
 * of it anywhere, and the operator sees an app that did nothing. So warnings
 * and errors are *always* written; the `logToFile` setting widens that to every
 * line for a session someone is actively debugging.
 *
 * Writes are appended asynchronously and never block the caller. Losing a log
 * line matters far less than delaying a position packet.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Rotate at 10 MB, keeping one previous file. */
const MAX_BYTES = 10 * 1024 * 1024;

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

class LogFile {
  /**
   * @param {string} dir       where to write (alongside the profile)
   * @param {object} [opts]
   * @param {boolean} [opts.verbose] write every line, not just warnings and errors
   */
  constructor(dir, opts = {}) {
    this.file = path.join(dir, 'posi3.log');
    this.prev = path.join(dir, 'posi3.log.1');
    this.verbose = !!opts.verbose;
    this._bytes = 0;
    this._stream = null;
    this._broken = false;

    try {
      fs.mkdirSync(dir, { recursive: true });
      this._bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      this._open();
    } catch {
      // A read-only or missing directory must not stop the bridge starting.
      this._broken = true;
    }
  }

  setVerbose(on) {
    this.verbose = !!on;
  }

  _open() {
    this._stream = fs.createWriteStream(this.file, { flags: 'a' });
    this._stream.on('error', () => { this._broken = true; });
  }

  _rotate() {
    try {
      this._stream.end();
      fs.rmSync(this.prev, { force: true });
      fs.renameSync(this.file, this.prev);
      this._bytes = 0;
      this._open();
    } catch {
      this._broken = true;
    }
  }

  /** @param {{lines: object[]}} batch as emitted by LinkManager's `log` event */
  write(batch) {
    if (this._broken || !batch || !batch.lines || !batch.lines.length) return;

    let chunk = '';
    for (const l of batch.lines) {
      const rank = LEVEL_RANK[l.level] ?? 1;
      if (!this.verbose && rank < LEVEL_RANK.warn) continue;
      chunk += `${new Date(l.ts).toISOString()} [${l.level}] ${l.id || '-'} ` +
        `${l.dir || ''} ${l.text}\n`;
    }
    if (!chunk) return;

    this._bytes += Buffer.byteLength(chunk);
    if (this._bytes > MAX_BYTES) this._rotate();
    try {
      this._stream.write(chunk);
    } catch {
      this._broken = true;
    }
  }

  /** Write one line immediately, bypassing the level filter. For startup and fatals. */
  note(text, level = 'info') {
    this.write({ lines: [{ ts: Date.now(), level: level === 'info' ? 'warn' : level, id: null, dir: null, text }] });
  }

  close() {
    if (this._stream) {
      try { this._stream.end(); } catch { /* going away anyway */ }
      this._stream = null;
    }
  }
}

module.exports = { LogFile };
