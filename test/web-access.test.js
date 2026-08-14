'use strict';
/**
 * Who may reach the web interface, and how.
 *
 * These operations write encoder flash and can change a device's IP, so the
 * access rules are safety behaviour, not preference. The contract:
 *
 *   loopback bind          nobody else can connect at all
 *   wide bind, password    a browser logs in once and carries a session
 *   wide bind, no password open, deliberately, and said so in the log
 *   explicit --token       outranks everything, including loopback
 *
 * Real HTTP against a real server throughout: a guard is exactly the kind of
 * thing that passes a source-level test and fails on the wire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startService } = require('../src/server/service');
const { hashPassword, passwordMatches, createSessions } = require('../src/server/security');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-access-'));

/** A service bound wide, so the loopback shortcut does not hide the rules. */
async function wideService(t, settings = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    version: 5,
    settings: Object.assign({ webBindHost: '0.0.0.0', webPort: 0 }, settings),
    connections: []
  }));
  const svc = await startService({ dataDir: dir, bindHost: '0.0.0.0', port: 0 });
  t.after(() => svc.stop());
  return svc;
}

const port = (svc) => svc.http.server.address().port;

/** An address of this machine that is not loopback, or null on a lone host. */
const lanAddress = (svc) => (svc.api.appInfo().addresses || [])[0] || null;

test('a password is stored as a hash, never as itself', () => {
  const stored = hashPassword('get-in-2026');
  assert.notEqual(stored.hash, 'get-in-2026');
  assert.ok(stored.salt && stored.hash);
  assert.ok(passwordMatches('get-in-2026', stored));
  assert.equal(passwordMatches('get-in-2025', stored), false);
  assert.equal(passwordMatches('', stored), false);
  assert.equal(passwordMatches('x', null), false);
  // Two hashes of one password differ: the salt is doing its job.
  assert.notEqual(hashPassword('same').hash, hashPassword('same').hash);
});

test('with no password, a wide bind is open — and the log says so', async (t) => {
  const svc = await wideService(t);
  const res = await fetch(`http://127.0.0.1:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(res.status, 200, 'open, as chosen');

  const said = svc.logger.tail({ limit: 50 }).map((l) => l.text).join('\n');
  assert.match(said, /NO PASSWORD IS SET/,
    'an operator who widened the bind months ago should find it in the record');
});

test('with a password, the network needs it and this machine does not', async (t) => {
  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'get-in-2026' });

  // Loopback is always allowed: the desktop window is one of these.
  const local = await fetch(`http://127.0.0.1:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(local.status, 200, 'the app must not lock itself out');

  // A LAN address reaches the same server without the loopback shortcut.
  const lan = lanAddress(svc);
  if (!lan) return; // a machine with no other NIC cannot exercise this half

  const denied = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(denied.status, 401);

  const wrong = await fetch(`http://${lan}:${port(svc)}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-it' })
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`http://${lan}:${port(svc)}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'get-in-2026' })
  });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/, 'no script may read the session');
  assert.match(cookie, /SameSite=Strict/, 'no other site may ride it');

  const withSession = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0] },
    body: '{}'
  });
  assert.equal(withSession.status, 200, 'and the session carries the browser');
});

test('the login surface is the only thing served unauthenticated', async (t) => {
  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'get-in-2026' });
  const lan = lanAddress(svc);
  if (!lan) return;

  for (const p of ['/login', '/js/login.js', '/css/app.css']) {
    const r = await fetch(`http://${lan}:${port(svc)}${p}`, { redirect: 'manual' });
    assert.equal(r.status, 200, `${p} must be reachable, or nobody can type the password`);
  }
  // The app itself is not: a browser is sent to the prompt.
  const app = await fetch(`http://${lan}:${port(svc)}/`, { redirect: 'manual' });
  assert.equal(app.status, 302);
  assert.equal(app.headers.get('location'), '/login');
  // And its script is behind the guard, unlike the login page's.
  const appJs = await fetch(`http://${lan}:${port(svc)}/js/app.js`, { redirect: 'manual' });
  assert.notEqual(appJs.status, 200);
});

test('changing the password signs every browser out', async (t) => {
  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'first-one' });
  const lan = lanAddress(svc);
  if (!lan) return;

  const login = await fetch(`http://${lan}:${port(svc)}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'first-one' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const before = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}'
  });
  assert.equal(before.status, 200);

  await svc.api.securitySetPassword({ password: 'second-one' });
  const after = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}'
  });
  assert.equal(after.status, 401, 'the rules changed, so yesterday\'s session ends');
});

test('a password is refused if it is too short to be one', async (t) => {
  const svc = await wideService(t);
  assert.throws(() => svc.api.securitySetPassword({ password: 'ab' }), (e) => e.code === 'EINVAL');
  // Empty is not "too short" — it is the explicit choice of no password.
  svc.api.securitySetPassword({ password: '' });
  assert.equal(svc.api.appInfo().passwordSet, false);
});

test('sessions expire, and an unknown one is not a session', () => {
  let clock = 1000;
  const s = createSessions(() => clock);
  const id = s.issue();
  assert.ok(s.valid(id));
  assert.equal(s.valid('made-up'), false);
  assert.equal(s.valid(null), false);
  clock += 13 * 60 * 60 * 1000;
  assert.equal(s.valid(id), false, 'twelve hours, then sign in again');
  assert.equal(s.size, 0, 'and the expired one is not kept');
});

test('the profile stores the hash, never the password', async (t) => {
  const dir = tmp();
  const svc = await startService({ dataDir: dir, port: 0 });
  t.after(() => svc.stop());
  svc.api.securitySetPassword({ password: 'plaintext-leak-check' });
  svc.store.flushNow();
  const raw = fs.readFileSync(path.join(dir, 'profile.json'), 'utf8');
  assert.equal(raw.includes('plaintext-leak-check'), false,
    'the profile gets copied between machines and pasted into support threads');
  assert.match(raw, /"webPassword"/);
});

test('a new profile is reachable; an existing one keeps what it says', () => {
  // One app on one machine, opened from whatever laptop is to hand — the
  // point of the thing. But a profile that has been closed for a year must
  // not silently open because a newer build loaded it, so the *fill* default
  // stays loopback and only a brand-new profile is created wide.
  const { ConfigStore, defaultSettings } = require('../src/core/config-store');

  const fresh = new ConfigStore(tmp());
  fresh.load();
  assert.equal(fresh.settings.webBindHost, '0.0.0.0', 'a first run is reachable');
  assert.equal(fresh.settings.webPassword, null, 'and open until someone sets a password');

  assert.equal(defaultSettings().webBindHost, '127.0.0.1',
    'the shape that fills missing keys stays closed');

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    version: 5, settings: { webBindHost: '127.0.0.1' }, connections: []
  }));
  const existing = new ConfigStore(dir);
  existing.load();
  assert.equal(existing.settings.webBindHost, '127.0.0.1',
    'an operator who chose closed stays closed');

  const older = tmp();
  fs.writeFileSync(path.join(older, 'profile.json'), JSON.stringify({
    version: 1, settings: { telemetryHz: 30 }, connections: []
  }));
  const migrated = new ConfigStore(older);
  migrated.load();
  assert.equal(migrated.settings.webBindHost, '127.0.0.1',
    'and a profile with no opinion is not given a permissive one');
});

test('a malformed session cookie is refused, not fatal', async (t) => {
  // The reported crash: decodeURIComponent('%ff') throws URIError, and in the
  // request path that throw ended the whole streaming bridge — unauthenticated,
  // from anyone who could reach the port, in the default bind-wide-with-password
  // deployment. A cookie we cannot decode is a cookie we do not honour.
  const { cookieValue } = require('../src/server/security');
  assert.doesNotThrow(() => cookieValue({ headers: { cookie: 'posi3_session=%ff' } }, 'posi3_session'));

  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'get-in-2026' });
  const lan = lanAddress(svc);
  if (!lan) return;

  const res = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'posi3_session=%ff' },
    body: '{}'
  });
  assert.equal(res.status, 401, 'a bad cookie is just an absent session, not a crash');

  // And the process is still here to answer the next one.
  const again = await fetch(`http://127.0.0.1:${port(svc)}/api/appInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(again.status, 200, 'the bridge survived the malformed request');
});

test('login attempts are throttled before they can grind scrypt', async (t) => {
  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'get-in-2026' });
  const lan = lanAddress(svc);
  if (!lan) return;

  const attempt = () => fetch(`http://${lan}:${port(svc)}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' })
  });

  let sawThrottle = false;
  for (let i = 0; i < 10; i++) {
    const r = await attempt();
    if (r.status === 429) { sawThrottle = true; break; }
    assert.equal(r.status, 401);
  }
  assert.ok(sawThrottle, 'a brute-force loop is refused before it can pin the threadpool');
});

test('an exported profile does not carry the password hash', async (t) => {
  const dir = tmp();
  const svc = await startService({ dataDir: dir, port: 0 });
  t.after(() => svc.stop());
  svc.api.securitySetPassword({ password: 'machine-local-secret' });

  const exported = svc.api.configExport();
  assert.equal('webPassword' in (exported.settings || {}), false,
    'the hash is an offline brute-force target in a file that gets copied around');

  // And importing a file with no password keeps this machine's own.
  svc.api.configImport({ version: 5, settings: { telemetryHz: 30 }, connections: [] });
  assert.ok(svc.store.settings.webPassword, 'the local password survives an import that omits one');
});

test('the password is never hashed on the per-request path — only at login', async (t) => {
  // pr-agent (claude-sonnet-5) caught this: checkAuth fronts every endpoint,
  // and a synchronous scryptSync there let a flood of wrong-Bearer requests to
  // any route block the event loop the encoder forward path shares — the DoS
  // the login throttle closed, through a door left open. The password now
  // authenticates only at /api/login; everything else needs a session.
  const svc = await wideService(t);
  await svc.api.securitySetPassword({ password: 'get-in-2026' });
  const lan = lanAddress(svc);
  if (!lan) return;

  // The correct password as a Bearer token on a normal endpoint must NOT let
  // you in — that path is what forced a per-request hash.
  const bearer = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer get-in-2026' },
    body: '{}'
  });
  assert.equal(bearer.status, 401, 'a Bearer password no longer authenticates a general request');

  // The supported path — log in once, carry the session — still works.
  const login = await fetch(`http://${lan}:${port(svc)}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'get-in-2026' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const withSession = await fetch(`http://${lan}:${port(svc)}/api/appInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}'
  });
  assert.equal(withSession.status, 200);

  // And no source line under the guard calls the synchronous hash any more.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'security.js'), 'utf8');
  const fn = src.slice(src.indexOf('function checkAuth'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.doesNotMatch(body, /passwordMatches\(/, 'checkAuth performs no password hashing');
});
