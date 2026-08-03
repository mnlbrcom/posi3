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
const { newToken, isLoopback } = require('./security');

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
  const manager = new LinkManager({ logger, telemetryHz: store.settings.telemetryHz });

  // Always on for warnings and errors: a packaged app has no console, so
  // without this a failure before the UI is up leaves no trace anywhere.
  // `logToFile` widens it to every line.
  const logFile = new LogFile(dataDir, { verbose: !!store.settings.logToFile });
  manager.on('log', (batch) => logFile.write(batch));
  if (store.loadWarning) logFile.note(store.loadWarning, 'warn');

  // Reaching beyond loopback exposes flash writes and the encoder's IP
  // settings to the whole LAN, so it is never token-less.
  const token = opts.token || (isLoopback(bindHost) ? null : newToken());

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
    env: () => Object.assign({
      version: require('../../package.json').version,
      platform: process.platform,
      node: process.versions.node,
      dataDir,
      webUrl: http.url(),
      bindHost,
      // `env` is evaluated lazily per request and spread into JSON, so this is
      // the live bound port, not a function and not the requested one.
      port: (http.server.address() || {}).port || port,
      tokenRequired: !!token
    }, opts.env || {})
  });

  // Register every configured connection so the UI can start one without a
  // round trip through the config store.
  for (const conn of store.connections) manager.upsert(conn);

  const http = createServer({ api, manager, bindHost, port, token });
  logFile.note(`posi3 ${require('../../package.json').version} starting — profile ${dataDir}`, 'warn');
  announceConfigChange = () => http.hub.broadcast('configChanged', { t: Date.now() });
  try {
    await http.listen();
  } catch (err) {
    lock.release();
    throw err;
  }
  lock.update({ url: http.url() });

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
