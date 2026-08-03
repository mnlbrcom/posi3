'use strict';
/**
 * The HTTP transport: static web UI, JSON API, and the event stream.
 *
 * Deliberately dependency-free — `node:http` and nothing else. The app ships
 * with zero production dependencies today and that is worth keeping: it is what
 * makes the packaged build reproducible and the supply chain inspectable.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { SseHub, bridgeEvents } = require('./sse');
const { createGuard, SECURITY_HEADERS } = require('./security');

const WEB_ROOT = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** Cap on a request body. Profiles are small; anything larger is a mistake. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { code: 'E2BIG' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body is not valid JSON'), { code: 'EINVAL' }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The address to actually tell someone to open.
 *
 * Binding 0.0.0.0 means "every interface", which is not an address anyone can
 * type. Reporting 127.0.0.1 for it was worse than useless: the whole reason to
 * bind wide is to reach the UI from another machine.
 */
function reachableHost(bindHost) {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') return bindHost;
  for (const addrs of Object.values(require('node:os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1'; // nothing routable; loopback is all there is
}

/**
 * POST /api/<name> for every operation on the api object.
 *
 * One verb for everything is unusual for a REST API, and intentional: these are
 * operations on a device, not documents. `encoderPreset` is not a PUT of
 * anything — it spends a flash cycle. Making them all non-idempotent POSTs
 * keeps well-meaning caches and prefetchers away from the hardware.
 */
function createServer(opts) {
  const { api, manager, bindHost = '127.0.0.1', port = 8710, token = null } = opts;

  const hub = new SseHub();
  bridgeEvents(manager, hub);

  const guard = createGuard({ bindHost, port, token });

  const send = (res, code, body, headers = {}) => {
    const payload = Buffer.from(body);
    res.writeHead(code, Object.assign({
      'Content-Length': payload.length
    }, SECURITY_HEADERS, headers));
    res.end(payload);
  };

  const sendJson = (res, code, obj, headers) =>
    send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // Resolve then verify containment: the only defence against `..` that does
    // not depend on getting the string handling exactly right.
    const abs = path.resolve(WEB_ROOT, rel);
    if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) {
      return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    }
    fs.readFile(abs, (err, buf) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      res.writeHead(200, Object.assign({
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache'
      }, SECURITY_HEADERS));
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
    }
    const pathname = url.pathname;
    const isApi = pathname.startsWith('/api/');

    const denied = guard.check(req, url, { mutating: isApi && req.method === 'POST' });
    if (denied) {
      return isApi
        ? sendJson(res, denied.code, { ok: false, error: { code: 'EDENIED', message: denied.message } })
        : send(res, denied.code, denied.message, { 'Content-Type': 'text/plain' });
    }

    if (pathname === '/api/events') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: 'GET only' } });
      return hub.attach(req, res);
    }

    // Downloads are GETs so the browser can save them normally. They read
    // state and change nothing, which is why they sit outside the POST rule.
    if (pathname === '/api/download/profile' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(api.configExport(), null, 2), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="posi3-profile.json"'
      });
    }
    if (pathname === '/api/download/log' && req.method === 'GET') {
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, api.logExport(), {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="posi3-log-${stamp}.txt"`
      });
    }

    if (isApi) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: 'POST only' } });
      }
      const name = pathname.slice('/api/'.length);
      const fn = Object.prototype.hasOwnProperty.call(api, name) ? api[name] : null;
      if (typeof fn !== 'function') {
        return sendJson(res, 404, { ok: false, error: { code: 'ENOENT', message: `No such operation: ${name}` } });
      }
      try {
        const body = await readBody(req);
        // Same envelope the IPC layer used, so the UI's error handling is unchanged.
        return sendJson(res, 200, { ok: true, data: await fn(body) });
      } catch (err) {
        return sendJson(res, 200, {
          ok: false,
          error: { code: err.code || 'EFAIL', message: err.message, retryAfterMs: err.retryAfterMs }
        });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    }
    return serveStatic(req, res, pathname);
  });

  // A show laptop's browser tab left open overnight should not pin a socket.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // The port actually bound, which differs from the requested one whenever 0
  // was asked for. Reporting the request would print "http://127.0.0.1:0".
  let boundPort = port;

  return {
    server,
    hub,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        if (addr && addr.port) boundPort = addr.port;
        resolve(addr);
      });
    }),
    close: () => new Promise((resolve) => {
      hub.close();
      server.close(() => resolve());
    }),
    url: () => `http://${reachableHost(bindHost)}:${boundPort}`
  };
}

module.exports = { createServer, WEB_ROOT };
