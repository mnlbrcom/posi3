'use strict';
/**
 * One flash-write budget per encoder, whoever is doing the writing.
 *
 * Every `set` spends one of the device's ~100,000 flash cycles, so the rate
 * limit has to be shared by every path that can write — the live link, and the
 * one-shot socket used when a connection is stopped. It used to live on the
 * `EncoderLink` instance, which was right while the link was the only writer;
 * the moment a second path existed, a stopped connection could have spent
 * cycles the running one was counting.
 *
 * Keyed by connection id rather than address: two connections pointed at the
 * same encoder is a configuration mistake, not a case to optimise for, and
 * keying by id keeps the budget where the operator can reason about it.
 */

const { TIMEOUTS } = require('../shared/constants');

/** connection id -> epoch ms of the last batch that was allowed through. */
const lastBatchAt = new Map();

/**
 * Claim the right to write to this encoder now.
 * @throws {Error & {code: 'ERATELIMIT', retryAfterMs: number}}
 */
function claim(id) {
  const now = Date.now();
  const since = now - (lastBatchAt.get(id) || 0);
  if (since < TIMEOUTS.WRITE_RATE_LIMIT_MS) {
    const remaining = TIMEOUTS.WRITE_RATE_LIMIT_MS - since;
    const err = new Error(
      `Please wait ${Math.ceil(remaining / 1000)}s before writing to the encoder again ` +
      '(each write uses a flash cycle)'
    );
    err.code = 'ERATELIMIT';
    err.retryAfterMs = remaining;
    throw err;
  }
  lastBatchAt.set(id, now);
}

/** Forget a connection's budget — only for when the connection itself is gone. */
function forget(id) {
  lastBatchAt.delete(id);
}

module.exports = { claim, forget };
