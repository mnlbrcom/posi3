'use strict';
/**
 * One bridge per profile.
 *
 * Electron's own single-instance lock only stops a second *desktop* copy. It
 * does nothing about a headless `bin/posi3.js` running alongside one — and that
 * combination is worse than it looks. The visible symptom is a port clash, but
 * the real hazard is two bridges opening rival TCP sockets to the same encoder,
 * which accepts only a handful of clients, and both streaming to disguise. An
 * axis driven by two senders is not obviously wrong on screen.
 *
 * So the lock lives with the profile, not with the window, and covers every
 * entry point that can start a bridge.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOCK_FILE = 'posi3.lock';

/** Is this pid still alive? Signal 0 tests without delivering anything. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still running.
    return err.code === 'EPERM';
  }
}

function read(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claim the profile.
 *
 * @param {string} dir      the profile directory
 * @param {object} info     `{ mode, url }` describing this instance
 * @param {boolean} [force] take the lock even if another instance holds it
 * @returns {{release: () => void, update: (patch: object) => void}}
 * @throws {Error & {code: 'EALREADYRUNNING', holder: object}}
 */
function acquire(dir, info, force = false) {
  const held = read(dir);
  if (held && alive(held.pid) && held.pid !== process.pid && !force) {
    const err = new Error(
      `posi3 is already running (${held.mode || 'unknown'}, pid ${held.pid})` +
      `${held.url ? ` — its interface is at ${held.url}` : ''}. ` +
      'Two bridges on one profile would open rival connections to the same encoder.'
    );
    err.code = 'EALREADYRUNNING';
    err.holder = held;
    throw err;
  }

  const file = path.join(dir, LOCK_FILE);
  const write = (extra) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(
        Object.assign({ pid: process.pid, startedAt: Date.now() }, info, extra), null, 2
      ));
    } catch { /* an unwritable profile is already reported elsewhere */ }
  };
  write();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only remove our own lock: a forced takeover must not delete the file
      // belonging to whoever comes next.
      const current = read(dir);
      if (current && current.pid === process.pid) fs.rmSync(file, { force: true });
    } catch { /* going away anyway */ }
  };

  // A crash or a kill -9 leaves the file behind; the liveness check above is
  // what makes that harmless, so this is a tidy-up rather than a guarantee.
  process.once('exit', release);

  return { release, update: (patch) => write(patch) };
}

module.exports = { acquire, read, alive, LOCK_FILE };
