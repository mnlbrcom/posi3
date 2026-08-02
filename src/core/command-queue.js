'use strict';
/**
 * Serialised request/response over the encoder's TCP socket.
 *
 * The catch: there is only one socket, and in Cyclic mode it is already busy
 * carrying samples. Replies arrive interleaved with data and carry no request
 * id, so the only way to match them is by variable name — which means exactly
 * one request may be outstanding at a time.
 *
 * Every request carries a deadline. A timeout rejects that request and moves
 * on rather than wedging the queue behind a command the encoder never answered.
 */

const { TIMEOUTS } = require('../shared/constants');
const { KIND } = require('./protocol');

class CommandQueue {
  /**
   * @param {object}   opts
   * @param {(line: string) => void} opts.send  writes one command line (adds CRLF)
   */
  constructor(opts) {
    this._send = opts.send;
    this._queue = [];
    this._inflight = null;
    this._timer = null;
  }

  get pending() {
    return this._queue.length + (this._inflight ? 1 : 0);
  }

  /**
   * True while the outstanding request is answered by a SAMPLE rather than a
   * reply line (i.e. `Run!`).
   *
   * The data path skips the command queue entirely — samples go straight to
   * forwarding — so it needs a one-boolean check to know when a sample must
   * also be offered here. Without this, `Run!` could only ever time out.
   */
  get expectsSample() {
    return !!(this._inflight && this._inflight.expectsSample);
  }

  /**
   * @param {string} line                 command to write, without terminator
   * @param {object} opts
   * @param {(r: object) => boolean} opts.match  does this parsed line answer us?
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.label]         for logs and error messages
   * @returns {Promise<object>}
   */
  submit(line, opts) {
    return new Promise((resolve, reject) => {
      this._queue.push({
        line,
        match: opts.match,
        timeoutMs: opts.timeoutMs || TIMEOUTS.READ_MS,
        label: opts.label || line,
        expectsSample: !!opts.expectsSample,
        resolve,
        reject
      });
      this._pump();
    });
  }

  _pump() {
    if (this._inflight || !this._queue.length) return;
    const req = this._queue.shift();
    this._inflight = req;
    this._timer = setTimeout(() => {
      const failed = this._inflight;
      this._inflight = null;
      this._timer = null;
      if (failed) {
        const err = new Error(`Encoder did not answer "${failed.label}" within ${failed.timeoutMs} ms`);
        err.code = 'ETIMEDOUT';
        failed.reject(err);
      }
      this._pump();
    }, req.timeoutMs);

    try {
      this._send(req.line);
    } catch (err) {
      this._settle(null, err);
    }
  }

  /**
   * Offer a parsed non-sample line to the outstanding request.
   * @param {object} r reused ParseResult — fields are copied, never retained
   * @returns {boolean} true when this line was consumed as a reply
   */
  handleParsed(r) {
    const req = this._inflight;
    if (!req) return false;

    if (r.kind === KIND.STATUS && r.severity === 'error') {
      const err = new Error(r.text || 'encoder reported an error');
      err.code = 'EENCODER';
      this._settle(null, err);
      return true;
    }

    if (!req.match(r)) return false;

    // Copy out of the reusable parse result before it is overwritten.
    this._settle({
      kind: r.kind,
      variable: r.variable,
      value: r.value,
      pos: r.pos,
      vel: r.vel,
      ts: r.ts,
      text: r.text
    }, null);
    return true;
  }

  _settle(value, err) {
    const req = this._inflight;
    this._inflight = null;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (req) {
      if (err) req.reject(err);
      else req.resolve(value);
    }
    this._pump();
  }

  /** Fail everything — used when the socket drops. */
  rejectAll(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const pending = this._queue.splice(0);
    const inflight = this._inflight;
    this._inflight = null;
    if (inflight) inflight.reject(err);
    for (const req of pending) req.reject(err);
  }
}

/** Matcher for `read <Var>` / `set <Var>=<Val>`: the echoed variable name. */
function matchVariable(name) {
  const want = name.toLowerCase();
  return (r) => r.kind === KIND.REPLY && r.variable.toLowerCase() === want;
}

/** Matcher for `Run!`: the next sample of any shape. */
function matchSample() {
  return (r) => r.kind === KIND.SAMPLE;
}

module.exports = { CommandQueue, matchVariable, matchSample };
