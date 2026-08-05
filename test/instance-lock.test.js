'use strict';
/**
 * One bridge per profile.
 *
 * Electron's single-instance lock only stops a second desktop copy. It does
 * nothing about a headless `bin/posi3.js` running alongside one, and that pair
 * is worse than it looks: the visible symptom is a port clash, but the real
 * hazard is two bridges opening rival TCP sockets to the same encoder — which
 * accepts only a handful of clients — and both driving one disguise axis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquire, read, alive, LOCK_FILE } = require('../src/core/instance-lock');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-lock-'));

test('claiming a free profile writes a lock naming this process', () => {
  const dir = tmp();
  const lock = acquire(dir, { mode: 'headless' });
  const held = read(dir);
  assert.equal(held.pid, process.pid);
  assert.equal(held.mode, 'headless');
  lock.release();
  assert.equal(read(dir), null, 'releasing must remove it');
});

test('a live holder blocks a second claim, and says where it is', () => {
  const dir = tmp();
  // A pid that is definitely alive but is not us: the parent.
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({
    pid: process.ppid, mode: 'headless', url: 'http://127.0.0.1:8710'
  }));
  assert.throws(() => acquire(dir, { mode: 'desktop' }), (err) => {
    assert.equal(err.code, 'EALREADYRUNNING');
    assert.match(err.message, /already running/);
    assert.match(err.message, /8710/, 'the running interface must be named');
    assert.equal(err.holder.pid, process.ppid);
    return true;
  });
});

test('a stale lock from a dead process is ignored', () => {
  const dir = tmp();
  // A pid that cannot be running. Node's own max is well below this.
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 0x7ffffff0, mode: 'headless' }));
  const lock = acquire(dir, { mode: 'desktop' });
  assert.equal(read(dir).pid, process.pid, 'the dead claim must be taken over');
  lock.release();
});

test('force takes the lock from a live holder', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.ppid, mode: 'headless' }));
  const lock = acquire(dir, { mode: 'desktop' }, true);
  assert.equal(read(dir).pid, process.pid);
  lock.release();
});

test('the same process may re-claim its own lock', () => {
  // The desktop app calls startService twice when its port is busy — first with
  // the configured port, then with 0. Blocking on our own pid would deadlock
  // that fallback.
  const dir = tmp();
  const first = acquire(dir, { mode: 'desktop' });
  assert.doesNotThrow(() => acquire(dir, { mode: 'desktop' }));
  first.release();
});

test('releasing does not delete a lock taken over by someone else', () => {
  const dir = tmp();
  const lock = acquire(dir, { mode: 'headless' });
  // Somebody forces their way in.
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.ppid, mode: 'desktop' }));
  lock.release();
  assert.equal(read(dir).pid, process.ppid, 'the newer holder must keep its claim');
});

test('a corrupt lock file does not stop the app starting', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, LOCK_FILE), 'not json at all');
  const lock = acquire(dir, { mode: 'headless' });
  assert.equal(read(dir).pid, process.pid);
  lock.release();
});

test('liveness: our own pid is alive, an absurd one is not', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(0x7ffffff0), false);
  assert.equal(alive(-1), false);
  assert.equal(alive(undefined), false);
});

test('the claim is an exclusive create, not a check followed by a write', () => {
  // Two processes starting in the same instant — a login item and a
  // double-click — both passed the liveness check and both wrote the lock, so
  // both ran: the rival-encoder-sockets condition the lock exists to prevent,
  // with the second write silently winning. `wx` makes the filesystem the
  // referee; the loser re-reads and finds a live holder.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'instance-lock.js'), 'utf8');
  assert.match(src, /flag: 'wx'/, 'the first write must be an exclusive create');
  const claim = src.slice(src.indexOf('function acquire'));
  assert.ok(claim.indexOf("flag: 'wx'") < claim.indexOf('alive(held.pid)'),
    'and the liveness check happens after losing the create, not before writing');
});

test('Start All clears the rate windows exactly as start() does', () => {
  // start(id) empties the sample window because link.start() zeroes the
  // counters — held samples make the first second's average negative. The
  // startAll loop skipped that reset, so Stop All → Start All read -3000 Hz
  // until the window drained.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'link-manager.js'), 'utf8');
  const all = src.slice(src.indexOf('startAll()'));
  const body = all.slice(0, all.indexOf('\n  }'));
  assert.match(body, /rate\.samples\.length = 0/, 'the window is emptied');
  assert.ok(body.indexOf('samples.length = 0') < body.indexOf('link.start();'),
    'before the counters reset, not after');
});
