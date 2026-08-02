'use strict';
/**
 * Incremental TCP line reassembly.
 *
 * This exists to kill the legacy driver's worst defect. `d3driver.c` did:
 *
 *     n = recv(in_sock, buf, sizeof(buf), 0);
 *     sscanf(buf, "%d %d", &pos, &vel);
 *
 * which assumes one recv() == exactly one sample. TCP guarantees no such thing.
 * At short cycle times the encoder's records coalesce into one segment and only
 * the first was ever parsed; a segment split mid-number produced a garbage
 * sample. Both failures are silent.
 *
 * A stream is bytes, not records. Buffer, split on '\n', keep the remainder.
 *
 * The encoder speaks ASCII, so latin1 decoding is byte-safe (every byte maps to
 * exactly one char) and cheaper than utf8 — and it cannot mangle a chunk that
 * splits mid-character, because there are no multi-byte characters.
 */

const { StringDecoder } = require('node:string_decoder');
const { MAX_LINE_BYTES } = require('../shared/constants');

const LF = 10;
const CR = 13;

class LineAssembler {
  /**
   * @param {object}   [opts]
   * @param {number}   [opts.maxLineBytes] give up past this without a newline
   * @param {Function} [opts.onOverflow]   called with the discarded byte count
   */
  constructor(opts = {}) {
    this._decoder = new StringDecoder('latin1');
    this._buf = '';
    this._maxLineBytes = opts.maxLineBytes || MAX_LINE_BYTES;
    this._onOverflow = opts.onOverflow || null;
    /** After an overflow: discard bytes until the next record boundary. */
    this._resync = false;

    /** Diagnostics only — never used for control flow. */
    this.stats = { chunks: 0, bytes: 0, lines: 0, overflows: 0 };
  }

  /**
   * Feed one TCP chunk. Calls `onLine` once per complete line, in order, with
   * the line terminator (and any trailing CR) already stripped.
   *
   * Empty lines are swallowed rather than emitted — the encoder produces them
   * around command echoes and they carry no information.
   *
   * Callback style rather than returning an array: this runs once per TCP
   * segment on the data path, and not allocating a result array per segment is
   * free to do here and keeps GC jitter out of the forwarding latency.
   *
   * @param {Buffer}   chunk
   * @param {(line: string) => void} onLine
   */
  push(chunk, onLine) {
    this.stats.chunks++;
    this.stats.bytes += chunk.length;

    let incoming = this._decoder.write(chunk);

    if (this._resync) {
      // We are mid-garbage after an overflow. Throw away everything up to and
      // including the next terminator so we resume on a real record boundary
      // rather than fusing the tail of the garbage onto the next good line.
      const nl = incoming.indexOf('\n');
      if (nl === -1) return;
      incoming = incoming.slice(nl + 1);
      this._resync = false;
    }

    this._buf += incoming;

    let start = 0;
    let idx;
    while ((idx = this._buf.indexOf('\n', start)) !== -1) {
      let end = idx;
      // Tolerate CRLF as well as bare LF. POSITAL's own Java client used
      // println(), so CRLF is what this hardware has always been fed.
      if (end > start && this._buf.charCodeAt(end - 1) === CR) end--;
      if (end > start) {
        this.stats.lines++;
        onLine(this._buf.slice(start, end));
      }
      start = idx + 1;
    }

    if (start > 0) {
      this._buf = this._buf.slice(start);
    } else if (this._buf.length > this._maxLineBytes) {
      // No terminator in a very large buffer. The usual cause is OutputType
      // being set to BINARY, where records are back-to-back 32-bit words with
      // no separator at all and line-oriented reading is meaningless.
      const discarded = this._buf.length;
      this._buf = '';
      this._resync = true;
      this.stats.overflows++;
      if (this._onOverflow) this._onOverflow(discarded);
    }
  }

  /**
   * Array-returning convenience wrapper. For tests and cold paths — the data
   * path uses push() directly.
   * @returns {string[]}
   */
  pushAll(chunk) {
    const out = [];
    this.push(chunk, (line) => out.push(line));
    return out;
  }

  /** Drop any partial line. Call on reconnect so stale bytes can't leak across. */
  reset() {
    this._decoder = new StringDecoder('latin1');
    this._buf = '';
    this._resync = false;
  }

  /** Bytes currently held as an incomplete line. */
  get pending() {
    return this._buf.length;
  }
}

module.exports = { LineAssembler, LF, CR };
