'use strict';
/**
 * Assembles a running bridge: config store, link manager, API and HTTP server.
 *
 * Both entry points use this — `bin/posi3.js` for a headless process and the
 * Electron main process for the desktop app. Keeping the assembly in one place
 * is what makes "the window shows the same UI as the browser" true by
 * construction rather than by discipline.
 */

const os = require('node:os');
const path = require('node:path');

const { LinkManager } = require('../core/link-manager');
const { ConfigStore } = require('../core/config-store');
const { Logger } = require('../core/logger');
const { LogFile } = require('../core/log-file');
const { acquire } = require('../core/instance-lock');
const { createApi } = require('./api');
const { createServer } = require('./http');
const { isLoopback } = require('./security');
const { listInterfaces } = require('./validate');

/**
 * The commit this build came from, best effort.
 *
 * A packaged build carries `revision.json`, written by `npm run stamp`. A
 * development run has no such file but does have `.git`, and reading HEAD by
 * hand avoids spawning git on every start. Neither is fatal: a build that
 * cannot name its revision simply does not show one.
 */
function buildRevision() {
  const fs = require('node:fs');
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'revision.json'), 'utf8')).revision;
  } catch { /* not a packaged build */ }
  try {
    const gitDir = path.join(__dirname, '..', '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(path.join(gitDir, ref), 'utf8').trim() : head;
    return sha.slice(0, 7);
  } catch {
    return null;
  }
}

/** Where the profile lives when Electron is not around to tell us. */
function defaultDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'posi3');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'posi3');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'posi3');
}

/**
 * @param {object} opts
 * @param {string}  [opts.dataDir]
 * @param {string}  [opts.bindHost]  defaults to loopback
 * @param {number}  [opts.port]
 * @param {string}  [opts.token]     generated when binding beyond loopback
 * @param {object}  [opts.env]       extra facts for appInfo (version, paths…)
 * @param {(s:object)=>void} [opts.onSettings]
 */
let guardInstalled = false;
/**
 * Keep the bridge alive through an unexpected throw.
 *
 * The HTTP handler is wrapped, so a request cannot become an unhandled
 * rejection any more — this is the floor beneath that: a bug anywhere else
 * that would otherwise kill a process feeding a live show is logged and
 * survived instead. Exiting on `uncaughtException` is the Node default and
 * the wrong trade here; a frozen encoder stream is recoverable, a dead
 * process is not.
 */
function installProcessGuard(logger) {
  if (guardInstalled) return;
  guardInstalled = true;
  const note = (what, err) => {
    try {
      logger.push({ level: 'error', dir: 'app', text: `${what}: ${(err && err.stack) || err}` });
    } catch { /* logging must never be the thing that throws here */ }
  };
  process.on('unhandledRejection', (err) => note('unhandled rejection', err));
  process.on('uncaughtException', (err) => note('uncaught exception', err));
}

async function startService(opts = {}) {
  const dataDir = opts.dataDir || defaultDataDir();
  const bindHost = opts.bindHost || '127.0.0.1';
  // Not `opts.port || 8710`: port 0 means "any free port", and it is falsy, so
  // that spelling silently substituted the default. The desktop app's
  // fall-back-to-an-ephemeral-port path therefore retried the very port it had
  // just found busy, and the window never opened.
  const port = opts.port === undefined || opts.port === null ? 8710 : Number(opts.port);

  // Claim the profile before anything opens a socket. Two bridges sharing one
  // profile would fight over the port and, far worse, open rival connections to
  // the same encoder — which accepts only a handful of clients.
  const lock = acquire(dataDir, { mode: opts.mode || 'headless' }, !!opts.force);

  const store = new ConfigStore(dataDir);
  store.load();

  const logger = new Logger();
  installProcessGuard(logger);
  const manager = new LinkManager({ logger, telemetryHz: store.settings.telemetryHz });

  // Always on for warnings and errors: a packaged app has no console, so
  // without this a failure before the UI is up leaves no trace anywhere.
  // `logToFile` widens it to every line.
  const logFile = new LogFile(dataDir, { verbose: !!store.settings.logToFile });
  manager.on('log', (batch) => logFile.write(batch));

  /**
   * Keep what the encoder said about itself.
   *
   * The link learns the scaling and the cycle time from the device and used to
   * hold them in memory only, so every restart forgot them and started from a
   * fabricated default again — which is what made a first read report itself as
   * a change. The profile is the state the encoder has; the device is the only
   * thing that writes it.
   *
   * The link is not re-synced: it already holds these values, and pushing the
   * config back would restart a running connection to tell it what it just told
   * us.
   */
  manager.on('encoderMeta', (e) => {
    const conn = store.find(e.id);
    if (!conn) return;
    const next = Object.assign({}, conn.encoderMeta);
    for (const key of ['countsPerRev', 'totalCounts', 'cycleTimeMs']) {
      if (e[key] != null) next[key] = e[key];
    }
    const before = conn.encoderMeta || {};
    if (['countsPerRev', 'totalCounts', 'cycleTimeMs'].every((k) => before[k] === next[k])) return;
    store.upsertConnection({ id: e.id, encoderMeta: next });
    announceConfigChange();
  });
  // Both places, deliberately. The file is for diagnosing a start-up that never
  // reached a UI; the ring is what the Log screen and Export show. This was
  // file-only, so a profile that failed to load raised a banner in the browser
  // and left nothing in the log the operator would be asked to send.
  if (store.loadWarning) {
    logFile.note(store.loadWarning, 'warn');
    logger.push({ level: 'warn', dir: 'app', text: store.loadWarning });
  }
  if (store.readOnly) {
    logger.push({
      level: 'warn', dir: 'app',
      text: 'This profile was written by a newer build and is loaded read-only — changes will not be saved'
    });
  }

  // Reaching beyond loopback exposes flash writes and the encoder's IP
  // settings to the whole LAN. What guards that is now the operator's own
  // choice in Settings — a password, or knowingly none — so no token is
  // invented here. `opts.token` remains for scripting and the headless flag.
  const token = opts.token || null;

  // Set once the HTTP server exists; every config mutation pokes it so other
  // open browsers refetch instead of quietly showing stale settings.
  let announceConfigChange = () => {};

  const api = createApi({
    manager,
    store,
    syncLink: (conn) => manager.upsert(conn),
    onConfigChanged: () => announceConfigChange(),
    onSettings: (settings) => {
      logFile.setVerbose(!!settings.logToFile);
      if (opts.onSettings) opts.onSettings(settings);
    },
    // A changed password must not leave yesterday's browsers logged in.
    onSessionsInvalidated: () => { if (http && http.sessions) http.sessions.clear(); },
    env: () => Object.assign({
      version: require('../../package.json').version,
      revision: buildRevision(),
      platform: process.platform,
      node: process.versions.node,
      dataDir,
      webUrl: http.url(),
      bindHost,
      // `env` is evaluated lazily per request and spread into JSON, so this is
      // the live bound port, not a function and not the requested one.
      port: (http.server.address() || {}).port || port,
      tokenRequired: !!token,
      passwordSet: !!store.settings.webPassword,
      // Every address this machine can be reached on *from the network*, not
      // merely the first: a show server has several NICs and the one the
      // operator's laptop is on is rarely the one that sorts first. Loopback
      // is excluded — it is not an address anyone else can use, and listing
      // it under "reachable" would be an invitation to type the wrong one.
      addresses: listInterfaces().filter((i) => !i.internal).map((i) => i.address)
    }, opts.env || {})
  });

  // Register every configured connection so the UI can start one without a
  // round trip through the config store.
  for (const conn of store.connections) manager.upsert(conn);

  const http = createServer({
    api, manager, bindHost, port, token,
    // Read per request, so setting or clearing the password in Settings takes
    // effect at once rather than at the next restart.
    password: () => store.settings.webPassword || null
  });
  logFile.note(`posi3 ${require('../../package.json').version} starting — profile ${dataDir}`, 'warn');
  // The access posture, in the record, at every start. An operator who widened
  // the bind months ago and forgot should find it here rather than discover it.
  if (!isLoopback(bindHost)) {
    const how = token ? 'an access token is required'
      : store.settings.webPassword ? 'a password is required'
        : 'NO PASSWORD IS SET — anyone on this network who knows the address can control the rig';
    logger.push({
      level: store.settings.webPassword || token ? 'info' : 'warn',
      dir: 'app',
      text: `Web interface reachable on the network at ${http.url()} — ${how}.`
    });
  }
  announceConfigChange = () => http.hub.broadcast('configChanged', { t: Date.now() });
  try {
    await http.listen();
  } catch (err) {
    lock.release();
    throw err;
  }
  // The tokened form, because this URL exists to be *opened*: the second
  // instance's "posi3 is already running — open it" dialog launches it, and
  // without the token a non-loopback bind answers that click with a 401. The
  // lock file lives in the profile directory, which is this user's own — the
  // token guards the LAN, not the machine's owner.
  lock.update({ url: token ? `${http.url()}/?token=${encodeURIComponent(token)}` : http.url() });

  /**
   * Auto-start is deliberately not tied to a window loading. It used to hang
   * off the renderer's `did-finish-load`, which meant a headless process — or
   * a desktop launch straight to the tray — would never connect anything.
   */
  const autoStarted = [];
  if (store.settings.autoStartOnLaunch) {
    for (const conn of store.connections) {
      if (!conn.autoStart) continue;
      try {
        manager.start(conn.id);
        autoStarted.push(conn.id);
        // Started without anyone pressing anything, so its destinations
        // establish their own state the same way they would after a click.
        api.establishDisguiseState({ id: conn.id });
      } catch { /* surfaced through link state */ }
    }
  }

  return {
    store,
    manager,
    logger,
    logFile,
    api,
    http,
    token,
    dataDir,
    url: http.url(),
    autoStarted,
    async stop() {
      // dispose(), not stopAll(): it also detaches listeners and stops the
      // telemetry timer, which stopAll leaves running.
      manager.dispose();
      store.flushNow();
      await http.close();
      logFile.close();
      lock.release();
    }
  };
}

module.exports = { startService, defaultDataDir };
