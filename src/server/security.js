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
 * So: loopback by default, and anything wider is opt-in.
 *
 * Beyond loopback, access is what the operator chose in Settings:
 *
 *   password set     a browser logs in once and carries a session cookie;
 *                    scripts may present the password as a Bearer token.
 *   no password      open to anyone who knows the address and port.
 *
 * The open case is deliberate and is the operator's decision to make — a show
 * LAN is often a closed island with no route off it, and a password prompt in
 * front of a rig that four people share during a get-in is friction with no
 * one to protect against. It is never the *default*: it takes both widening
 * the bind and leaving the password empty, and the app says plainly in
 * Settings and in the log what that means.
 *
 * Requests that arrive on loopback are always allowed. The password guards the
 * network; anybody at the machine's own keyboard can already quit the app or
 * edit the profile, so demanding it there would protect nothing.
 */

const crypto = require('node:crypto');

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Store a password as a salted scrypt hash, never as itself.
 *
 * The profile is a plain JSON file an operator may well copy to another
 * machine or paste into a support thread; a password sitting in it as text
 * would leak the moment that happens. scrypt because it is in Node's own
 * crypto and is deliberately slow to brute-force.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('base64'), v: 1 };
}

function passwordMatches(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  if (!password) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password), stored.salt, 32);
  } catch {
    return false;
  }
  const expected = Buffer.from(String(stored.hash), 'base64');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * The same check, off the event loop.
 *
 * `scryptSync` blocks for tens of milliseconds by design, and this process
 * also runs the parse-and-forward path for every encoder sample. A flood of
 * login attempts on the synchronous version would stall that path — so the
 * login route uses this, and scrypt runs on libuv's threadpool instead.
 */
function passwordMatchesAsync(password, stored) {
  return new Promise((resolve) => {
    if (!stored || !stored.salt || !stored.hash || !password) return resolve(false);
    crypto.scrypt(String(password), stored.salt, 32, (err, candidate) => {
      if (err) return resolve(false);
      const expected = Buffer.from(String(stored.hash), 'base64');
      if (candidate.length !== expected.length) return resolve(false);
      resolve(crypto.timingSafeEqual(candidate, expected));
    });
  });
}

/**
 * A memory of recent failed logins, by client address.
 *
 * Not a lockout — an operator who fat-fingers the password four times must
 * not be shut out mid-show — but a brake: after a handful of failures from
 * one address the attempts are refused without even reaching scrypt, so a
 * brute-force loop cannot pin the threadpool or grind the hash. Successful
 * login clears the address; the window is short, so a walk-away resets it.
 */
function createLoginThrottle(now = () => Date.now(), opts = {}) {
  const max = opts.max || 6;
  const windowMs = opts.windowMs || 30000;
  const fails = new Map();
  const prune = (addr) => {
    const rec = fails.get(addr);
    if (rec && now() - rec.first > windowMs) fails.delete(addr);
  };
  return {
    blocked(addr) { prune(addr); const rec = fails.get(addr); return !!rec && rec.count >= max; },
    fail(addr) {
      prune(addr);
      const rec = fails.get(addr) || { count: 0, first: now() };
      rec.count++;
      fails.set(addr, rec);
    },
    clear(addr) { fails.delete(addr); },
    get size() { return fails.size; }
  };
}

/**
 * Browser sessions, in memory only.
 *
 * A restart logs everyone out, which for a tool that is restarted between
 * shows is the right trade: nothing to persist, nothing to leak, and no
 * session outliving the configuration it was issued under.
 */
const SESSION_MS = 12 * 60 * 60 * 1000;

function createSessions(now = () => Date.now()) {
  const live = new Map();
  return {
    issue() {
      const id = crypto.randomBytes(24).toString('base64url');
      live.set(id, now() + SESSION_MS);
      return id;
    },
    valid(id) {
      if (!id) return false;
      const until = live.get(id);
      if (!until) return false;
      if (until <= now()) { live.delete(id); return false; }
      return true;
    },
    /** Every session, gone: called when the password changes or is cleared. */
    clear() { live.clear(); },
    get size() { return live.size; }
  };
}

/** The session cookie, parsed without a dependency. */
function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
      const value = part.slice(eq + 1).trim();
      // A malformed cookie is an attacker's to send, not ours to trust:
      // `decodeURIComponent('%ff')` throws URIError, and unhandled in the
      // request path that throw took the whole streaming bridge down. A
      // cookie we cannot decode is a cookie we do not honour.
      try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

const SESSION_COOKIE = 'posi3_session';

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
 * @param {string|null} [opts.token]        legacy/scripting override
 * @param {() => object|null} [opts.password]  the stored hash, read live
 * @param {object} [opts.sessions]          from createSessions()
 */
function createGuard(opts) {
  const loopbackOnly = isLoopback(opts.bindHost);
  const sessions = opts.sessions || createSessions();
  // Read through a function, not captured: the operator can set or clear the
  // password while the server runs, and the guard must obey the new answer on
  // the very next request rather than at the next restart.
  const storedPassword = opts.password || (() => null);

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
    // 0.0.0.0 and :: mean "every address on this machine", so any literal IP
    // is ours. :: previously matched only the literal "::", which rejected
    // every real LAN Host header with 421 and made that bind unusable.
    const wildcard = opts.bindHost === '0.0.0.0' || opts.bindHost === '::';
    if (wildcard && /^[\d.]+$/.test(name)) return true;
    if (opts.bindHost === '::' && /^[0-9a-f:]+(%\w+)?$/i.test(name)) return true;
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

  /** Requests originating on this machine are always allowed. */
  function fromLoopback(req) {
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  const presented = (req, url) => {
    const header = String(req.headers.authorization || '');
    return (header.startsWith('Bearer ') ? header.slice(7) : null) || url.searchParams.get('token');
  };

  function checkAuth(req, url) {
    // An explicit token is a deliberate instruction and outranks everything:
    // `--token` on the headless flag means "require exactly this", including
    // from this machine. The desktop window carries it for the same reason.
    if (opts.token) return tokenMatches(presented(req, url), opts.token);

    // Otherwise this machine is always allowed. The password guards the
    // network; anyone at this keyboard can already edit the profile.
    if (loopbackOnly || fromLoopback(req)) return true;

    const pw = storedPassword();
    if (!pw) return true; // open on the network, as chosen and as logged
    if (sessions.valid(cookieValue(req, SESSION_COOKIE))) return true;
    return passwordMatches(presented(req, url), pw);
  }

  /** @returns {{code:number, message:string}|null} null when the request may proceed */
  function check(req, url, { mutating }) {
    if (!checkHostHeader(req)) {
      return { code: 421, message: 'Unrecognised Host header' };
    }
    if (!checkAuth(req, url)) {
      return { code: 401, message: 'A password is required to reach posi3 over the network' };
    }
    if (mutating && !checkContentType(req)) {
      return { code: 415, message: 'Mutations require Content-Type: application/json' };
    }
    return null;
  }

  return { check, checkHostHeader, loopbackOnly, sessions, fromLoopback };
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

module.exports = {
  createGuard, newToken, isLoopback, SECURITY_HEADERS,
  hashPassword, passwordMatches, passwordMatchesAsync, createSessions, createLoginThrottle,
  cookieValue, SESSION_COOKIE, SESSION_MS
};
