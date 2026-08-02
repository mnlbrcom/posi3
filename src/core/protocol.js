'use strict';
/**
 * POSITAL IXARC OCD-EM wire protocol: classification, parsing and the disguise
 * output packet. Pure — no sockets, no state beyond the parser instance.
 *
 * The awkward part of this protocol is that the data stream and the command
 * channel share one TCP socket on port 6000. While the encoder streams in
 * Cyclic mode, command replies are interleaved with samples:
 *
 *     12345678 0 998877          <- sample      (OutputType=ASCII_SHORT)
 *     CycleTime=10               <- reply to `read CycleTime`
 *     ERROR: unknown variable    <- rejected command
 *     Parameters successfully written!   <- unsolicited, sent to ALL clients
 *
 * So every line has to be classified, and the order of the checks matters:
 * ASCII (verbose) data lines contain '=' too, and would otherwise be
 * misread as variable replies.
 */

const { TOTAL_COUNTS } = require('../shared/constants');

/** What a line turned out to be. */
const KIND = {
  SAMPLE: 'sample',
  REPLY: 'reply',
  STATUS: 'status', // ERROR: / WARNING:
  EVENT: 'event', // Parameters successfully written!
  UNKNOWN: 'unknown'
};

/** Field identifiers, as small ints so the hot path compares numbers. */
const FIELD = { POSITION: 0, VELOCITY: 1, TIMESTAMP: 2 };

const FIELD_BY_TOKEN = {
  position: FIELD.POSITION,
  velocity: FIELD.VELOCITY,
  timestamp: FIELD.TIMESTAMP
};

/** Default when OutputMode could not be read: infer from how many fields arrive. */
const INFERRED_MAPS = [
  [],
  [FIELD.POSITION],
  [FIELD.POSITION, FIELD.VELOCITY],
  [FIELD.POSITION, FIELD.VELOCITY, FIELD.TIMESTAMP]
];

const SPACE = 32;
const TAB = 9;
const MINUS = 45;
const PLUS = 43;
const ZERO = 48;
const NINE = 57;

/** Digits beyond this can't be represented exactly; treat the line as garbage. */
const MAX_DIGITS = 15;

const RE_STATUS = /^(ERROR|WARNING)\b[:\s]*(.*)$/i;
const RE_PARAMS_WRITTEN = /^parameters\s+successfully\s+written\s*!?$/i;
const RE_REPLY = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const RE_ASCII_FIELD = /(POSITION|VELOCITY|TIMESTAMP)\s*=\s*(-?\d+)/gi;

/**
 * Result of classifying one line.
 *
 * Deliberately reused between calls so the data path allocates nothing per
 * sample. Read the fields you need immediately; never retain the object.
 */
class ParseResult {
  constructor() {
    this.kind = KIND.UNKNOWN;
    this.pos = 0;
    this.vel = null;
    this.ts = null;
    this.variable = '';
    this.value = '';
    this.severity = '';
    this.text = '';
  }
}

class Parser {
  constructor() {
    this._result = new ParseResult();
    this._nums = [0, 0, 0, 0];
    /** null => infer per line from the field count. */
    this._fieldMap = null;
  }

  /**
   * Pin the field layout, normally from `read OutputMode`.
   *
   * This matters more than it looks. In ASCII_SHORT a two-number line is
   * ambiguous: it is `position velocity` under OutputMode=Position_Velocity_,
   * but `position timestamp` under Position_Timestamp_. Guessing wrong feeds a
   * microsecond timestamp into disguise as a velocity — wrong, and very hard to
   * spot downstream.
   *
   * @param {number[]|null} map array of FIELD.* in wire order, or null to infer
   */
  setFieldMap(map) {
    this._fieldMap = Array.isArray(map) && map.length ? map.slice() : null;
  }

  get fieldMap() {
    return this._fieldMap ? this._fieldMap.slice() : null;
  }

  /**
   * Classify one line (terminator already stripped).
   * @param {string} line
   * @returns {ParseResult} reused instance — do not retain
   */
  classify(line) {
    const r = this._result;
    const len = line.length;
    if (len === 0) {
      r.kind = KIND.UNKNOWN;
      r.text = '';
      return r;
    }

    // 1. ASCII (verbose) data lines, e.g. "POSITION=123 VELOCITY=0".
    //    Must be tried before the generic `<Var>=<Value>` reply pattern, which
    //    would otherwise capture POSITION as a variable name.
    const c0 = line.charCodeAt(0);
    if (c0 === 80 /* P */ || c0 === 86 /* V */ || c0 === 84 /* T */) {
      if (this._parseAsciiVerbose(line, r)) return r;
    }

    // 2. ASCII_SHORT: bare space-separated integers. The hot path.
    const n = this._scanInts(line);
    if (n > 0) {
      const map = this._fieldMap || INFERRED_MAPS[n] || INFERRED_MAPS[3];
      r.kind = KIND.SAMPLE;
      r.pos = 0;
      r.vel = null;
      r.ts = null;
      const upto = n < map.length ? n : map.length;
      for (let i = 0; i < upto; i++) {
        const f = map[i];
        if (f === FIELD.POSITION) r.pos = this._nums[i];
        else if (f === FIELD.VELOCITY) r.vel = this._nums[i];
        else if (f === FIELD.TIMESTAMP) r.ts = this._nums[i];
      }
      return r;
    }

    // 3. ERROR: / WARNING:
    const st = RE_STATUS.exec(line);
    if (st) {
      r.kind = KIND.STATUS;
      r.severity = st[1].toLowerCase();
      r.text = st[2] || line;
      return r;
    }

    // 4. The unsolicited flash-commit broadcast. Never a reply to anything —
    //    the encoder sends it to every connected TCP client.
    if (RE_PARAMS_WRITTEN.test(line)) {
      r.kind = KIND.EVENT;
      r.text = 'paramsWritten';
      return r;
    }

    // 5. `<Variable>=<Value>` command reply.
    const rep = RE_REPLY.exec(line);
    if (rep) {
      r.kind = KIND.REPLY;
      r.variable = rep[1];
      r.value = rep[2].trim();
      return r;
    }

    r.kind = KIND.UNKNOWN;
    r.text = line;
    return r;
  }

  /**
   * Scan up to 4 whitespace-separated integers into this._nums.
   * @returns {number} count found, or -1 if the line is not purely numeric
   *                   (which includes the >3 field case — the protocol has at
   *                   most three, so more means our assumptions are wrong)
   */
  _scanInts(line) {
    const nums = this._nums;
    const len = line.length;
    let n = 0;
    let i = 0;

    while (i < len) {
      let c = line.charCodeAt(i);
      while (c === SPACE || c === TAB) {
        i++;
        if (i >= len) break;
        c = line.charCodeAt(i);
      }
      if (i >= len) break;

      if (n >= 4) return -1;

      let neg = false;
      if (c === MINUS) {
        neg = true;
        i++;
      } else if (c === PLUS) {
        i++;
      }
      if (i >= len) return -1;

      c = line.charCodeAt(i);
      if (c < ZERO || c > NINE) return -1;

      let v = 0;
      let digits = 0;
      while (i < len) {
        c = line.charCodeAt(i);
        if (c < ZERO || c > NINE) break;
        v = v * 10 + (c - ZERO);
        digits++;
        i++;
      }
      if (digits > MAX_DIGITS) return -1;

      nums[n++] = neg ? -v : v;
    }

    if (n === 0 || n > 3) return -1;
    return n;
  }

  /** @returns {boolean} true if the line was a verbose ASCII sample */
  _parseAsciiVerbose(line, r) {
    RE_ASCII_FIELD.lastIndex = 0;
    let m;
    let found = 0;
    let pos = 0;
    let vel = null;
    let ts = null;
    let covered = 0;

    while ((m = RE_ASCII_FIELD.exec(line)) !== null) {
      found++;
      covered += m[0].length;
      const v = Number(m[2]);
      const key = m[1].toUpperCase();
      if (key === 'POSITION') pos = v;
      else if (key === 'VELOCITY') vel = v;
      else ts = v;
    }
    if (found === 0) return false;

    // Guard against a variable reply that merely happens to start with one of
    // these words. A real data line is almost entirely made of these pairs.
    const slack = line.length - covered;
    if (slack > found + 2) return false;

    r.kind = KIND.SAMPLE;
    r.pos = pos;
    r.vel = vel;
    r.ts = ts;
    return true;
  }
}

// ---------------------------------------------------------------------------
// OutputMode <-> field map
// ---------------------------------------------------------------------------

/**
 * "Position_Velocity_Timestamp_" -> [0, 1, 2]
 * Tolerates missing trailing underscores and any separator/casing the encoder
 * or a user might produce.
 * @returns {number[]|null} null when nothing recognisable was found
 */
function parseOutputMode(value) {
  if (typeof value !== 'string') return null;
  const map = [];
  const seen = new Set();
  const tokens = value.split(/[^A-Za-z]+/);
  for (const tok of tokens) {
    if (!tok) continue;
    const f = FIELD_BY_TOKEN[tok.toLowerCase()];
    if (f === undefined || seen.has(f)) continue;
    seen.add(f);
    map.push(f);
  }
  return map.length ? map : null;
}

/** [0, 1, 2] -> "Position_Velocity_Timestamp_" */
function formatOutputMode(map) {
  const names = ['Position_', 'Velocity_', 'Timestamp_'];
  return (map || []).map((f) => names[f]).join('');
}

// ---------------------------------------------------------------------------
// disguise output packet
// ---------------------------------------------------------------------------

const COLON = 58;
const COMMA = 44;
const SEMI = 59;
const NEWLINE = 10;

/** Longest possible packet: devid + 25-bit position + signed velocity + ";\n". */
const MAX_PACKET_BYTES = 48;

/** Write a base-10 integer into buf at off. @returns {number} new offset */
function writeInt(buf, off, v) {
  if (!Number.isFinite(v)) v = 0;
  v = Math.trunc(v);
  if (v < 0) {
    buf[off++] = MINUS;
    v = -v;
  }
  if (v === 0) {
    buf[off++] = ZERO;
    return off;
  }
  const start = off;
  let end = off;
  while (v > 0) {
    buf[end++] = ZERO + (v % 10);
    v = Math.floor(v / 10);
  }
  for (let i = start, j = end - 1; i < j; i++, j--) {
    const t = buf[i];
    buf[i] = buf[j];
    buf[j] = t;
  }
  return end;
}

/**
 * Write the disguise NavigatorDriver packet: `<devid>:<pos>,<vel>;\n`
 *
 * Byte-for-byte identical to what `d3driver.c` produced with
 * `snprintf(out, sizeof(out), "%d:%d,%d;\n", devid, pos, vel)`. This is a hard
 * compatibility requirement — existing d3 projects must keep working untouched.
 *
 * Digits are written directly rather than via a template literal so the
 * forwarding path allocates nothing at all.
 *
 * @returns {number} byte length written
 */
function writePacket(buf, devid, pos, vel) {
  let o = 0;
  o = writeInt(buf, o, devid);
  buf[o++] = COLON;
  o = writeInt(buf, o, pos);
  buf[o++] = COMMA;
  o = writeInt(buf, o, vel);
  buf[o++] = SEMI;
  buf[o++] = NEWLINE;
  return o;
}

/** Convenience for tests and logging. */
function formatPacket(devid, pos, vel) {
  return `${devid}:${pos},${vel};\n`;
}

// ---------------------------------------------------------------------------
// Position maths
// ---------------------------------------------------------------------------

/**
 * Shortest signed distance from prev to curr on a circular count.
 *
 * Without this, every pass through the 33,554,432 -> 0 rollover produces a
 * one-sample velocity spike of +/-33 million steps/s and a full-scale jump in
 * any derived value.
 */
function wrapDelta(curr, prev, total = TOTAL_COUNTS) {
  let d = curr - prev;
  const half = total / 2;
  if (d > half) d -= total;
  else if (d < -half) d += total;
  return d;
}

/** Position -> angle within the current revolution, in degrees. */
function angleDeg(pos, countsPerRev) {
  const m = ((pos % countsPerRev) + countsPerRev) % countsPerRev;
  return (m / countsPerRev) * 360;
}

/** Position -> completed revolution index. */
function revolution(pos, countsPerRev) {
  return Math.floor(pos / countsPerRev);
}

/** steps/s -> rpm. */
function stepsPerSecToRpm(stepsPerSec, countsPerRev) {
  return (stepsPerSec / countsPerRev) * 60;
}

module.exports = {
  KIND,
  FIELD,
  Parser,
  ParseResult,
  parseOutputMode,
  formatOutputMode,
  writeInt,
  writePacket,
  formatPacket,
  MAX_PACKET_BYTES,
  wrapDelta,
  angleDeg,
  revolution,
  stepsPerSecToRpm
};
