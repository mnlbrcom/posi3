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
  const port = opts.port || 8710;

  const store = new ConfigStore(dataDir);
  store.load();

  const logger = new Logger();
  const manager = new LinkManager({ logger, telemetryHz: store.settings.telemetryHz });

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
    onSettings: opts.onSettings,
    env: () => Object.assign({
      version: require('../../package.json').version,
      platform: process.platform,
      node: process.versions.node,
      dataDir,
      webUrl: `http://${isLoopback(bindHost) ? '127.0.0.1' : bindHost}:${port}`,
      bindHost,
      port,
      tokenRequired: !!token
    }, opts.env || {})
  });

  // Register every configured connection so the UI can start one without a
  // round trip through the config store.
  for (const conn of store.connections) manager.upsert(conn);

  const http = createServer({ api, manager, bindHost, port, token });
  announceConfigChange = () => http.hub.broadcast('configChanged', { t: Date.now() });
  await http.listen();

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
    }
  };
}

module.exports = { startService, defaultDataDir };
