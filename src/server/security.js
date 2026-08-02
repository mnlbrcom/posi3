'use strict';
/**
 * Guards for the HTTP surface.
 *
 * Worth being precise about why this exists. In the Electron-only build, the
 * process boundary *was* the authentication — only our own sandboxed renderer
 * could reach these operations. Serving them on a port removes that boundary,
 * and these operations are not harmless: they can write the encoder's flash
 * (a finite ~100,000-cycle resource) and change the device's IP address, which
 * on a show floor means losing the encoder until someone can reach the
 * hardware.
 *
 * So: loopback by default, and anything wider is opt-in and needs a token.
 */

const crypto = require('node:crypto');

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Timing-safe compare that tolerates length mismatch. */
function tokenMatches(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {object} opts
 * @param {string} opts.bindHost
 * @param {number} opts.port
 * @param {string|null} opts.token  required when not bound to loopback
 */
function createGuard(opts) {
  const loopbackOnly = isLoopback(opts.bindHost);

  /**
   * Reject requests whose Host header we do not recognise.
   *
   * This is the defence against DNS rebinding: an attacker's page resolves
   * their domain to 127.0.0.1 and then talks to a server that believes it is
   * safely private. Checking Host means such a request arrives labelled with
   * their domain and is refused.
   */
  function checkHostHeader(req) {
    const host = String(req.headers.host || '');
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (isLoopback(name)) return true;
    if (name === opts.bindHost) return true;
    // 0.0.0.0 means "every address on this machine", so any literal IP is ours.
    if (opts.bindHost === '0.0.0.0' && /^[\d.]+$/.test(name)) return true;
    return false;
  }

  /**
   * Mutations must be JSON.
   *
   * A browser can be made to POST a cross-origin HTML form without any consent
   * from the user, but it cannot set `Content-Type: application/json` on one.
   * Requiring it turns every mutation into a request that needs CORS
   * permission we never grant.
   */
  function checkContentType(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return ct === 'application/json';
  }

  function checkToken(req, url) {
    if (loopbackOnly && !opts.token) return true;
    if (!opts.token) return false;
    const header = String(req.headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    return tokenMatches(bearer || url.searchParams.get('token'), opts.token);
  }

  /** @returns {{code:number, message:string}|null} null when the request may proceed */
  function check(req, url, { mutating }) {
    if (!checkHostHeader(req)) {
      return { code: 421, message: 'Unrecognised Host header' };
    }
    if (!checkToken(req, url)) {
      return { code: 401, message: 'Missing or invalid access token' };
    }
    if (mutating && !checkContentType(req)) {
      return { code: 415, message: 'Mutations require Content-Type: application/json' };
    }
    return null;
  }

  return { check, loopbackOnly };
}

/**
 * Headers applied to every response.
 *
 * `connect-src 'self'` is the one that had to change: the packaged app shipped
 * `connect-src 'none'`, which is correct for a `file://` renderer talking only
 * over IPC and fatal for one that must reach its own API. Serving the policy as
 * a header rather than a `<meta>` tag is what lets us set `frame-ancestors`,
 * which a meta tag cannot express.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

module.exports = { createGuard, newToken, isLoopback, SECURITY_HEADERS };
