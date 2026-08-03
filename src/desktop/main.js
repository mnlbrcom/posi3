'use strict';
/**
 * Desktop shell.
 *
 * The window is a view onto the app's own web UI: it loads
 * http://127.0.0.1:<port>, the same URL a browser on the show LAN would open.
 * There is exactly one interface codebase, so the desktop and the browser
 * cannot drift apart — which is why this file no longer has an IPC layer or a
 * preload script. The bridge itself is assembled by src/server/service.js and
 * is identical to what `bin/posi3.js` runs headless.
 *
 * What is left here is the things only a desktop app can do: a tray icon, a
 * window, launch at login, keeping the machine awake while streaming, and
 * refusing to run twice.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, powerSaveBlocker, shell, dialog, clipboard } = require('electron');

const { startService } = require('../server/service');
const { TRAY_ICON_PNG } = require('./tray-icon');

const isDev = process.argv.includes('--dev');

// A minimised or hidden window must never stall the telemetry tick.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let svc = null;
let mainWindow = null;
let tray = null;
let powerBlockerId = null;
let quitting = false;

// Two copies would open rival sockets to the same encoder, and the encoder
// accepts only a handful of TCP clients.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch(fatal);
}

async function start() {
  svc = await listen();

  // Launch at login is the host's job, not the API's: the service layer has no
  // business knowing about Electron.
  applyLoginItem(svc.store.settings.launchAtLogin);
  svc.manager.on('state', updatePowerBlocker);

  createTray();
  createWindow();
}

/**
 * Bind the configured port, falling back to an ephemeral one.
 *
 * A show server may already have something on 8710 — including a headless
 * posi3 someone left running. Refusing to start would be the wrong answer for
 * a tool whose job is to be running when the show starts, so it takes any port
 * and reports the real URL in the tray menu.
 */
async function listen() {
  try {
    return await startService({
      dataDir: app.getPath('userData'),
      bindHost: readSetting('webBindHost', '127.0.0.1'),
      port: readSetting('webPort', 8710),
      env: { electron: process.versions.electron },
      onSettings: (s) => applyLoginItem(s.launchAtLogin)
    });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    const fallback = await startService({
      dataDir: app.getPath('userData'),
      bindHost: readSetting('webBindHost', '127.0.0.1'),
      port: 0,
      env: { electron: process.versions.electron },
      onSettings: (s) => applyLoginItem(s.launchAtLogin)
    });
    fallback.logger.push({
      level: 'warn', dir: 'rx', ts: Date.now(),
      text: `Port ${readSetting('webPort', 8710)} was busy — the web UI is on ${fallback.url} instead.`
    });
    return fallback;
  }
}

/**
 * Read a setting before the store exists.
 *
 * startService loads the profile itself, so the port it should bind is needed
 * a moment too early. Reading the file directly is uglier than threading it
 * through, but it keeps the service signature honest: it takes a port, it does
 * not go looking for one.
 */
function readSetting(key, fallback) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(app.getPath('userData'), 'profile.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = data && data.settings ? data.settings[key] : undefined;
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Launch at login, and say so when it does not take.
 *
 * macOS refuses this for an app that is unsigned or running from outside
 * /Applications — a development build always fails with "Operation not
 * permitted". Swallowing that meant the checkbox appeared to work and quietly
 * did nothing, which on a show server is the difference between coming back
 * after a reboot and not. Read it back and report the discrepancy.
 */
function applyLoginItem(enabled) {
  if (process.platform === 'linux') return; // no supported mechanism
  const want = !!enabled;
  try {
    app.setLoginItemSettings({ openAtLogin: want });
    const got = app.getLoginItemSettings().openAtLogin;
    if (got !== want && svc) {
      svc.logger.push({
        level: 'warn', dir: 'rx', ts: Date.now(),
        text: `Could not ${want ? 'enable' : 'disable'} launch at login. ` +
          'macOS refuses this for unsigned builds and apps outside /Applications.'
      });
    }
  } catch (err) {
    if (svc) {
      svc.logger.push({
        level: 'warn', dir: 'rx', ts: Date.now(),
        text: `Launch at login could not be changed: ${err.message}`
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380, // the UI reflows to phone width; do not stop it here
    minHeight: 480,
    show: false,
    backgroundColor: '#0d0d0d', // must match --bg, or the window flashes on open
    title: 'posi3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // No preload and no node integration: this is an ordinary web page that
      // talks to the local API over HTTP, exactly as a browser would.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The UI must keep updating when the window is behind the d3 interface.
      backgroundThrottling: false
    }
  });

  mainWindow.loadURL(svc.url);

  // Nothing here should open a window or navigate off the local UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(svc.url)) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    // Safe to honour now: there is a tray icon to get the window back from.
    if (!svc.store.settings.startMinimized) mainWindow.show();
  });

  // Close means "get out of the way", not "stop driving the show". Quitting is
  // explicit, from the tray or the app menu.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'darwin') app.dock?.hide?.();
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  Menu.setApplicationMenu(buildMenu());
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (process.platform === 'darwin') app.dock?.show?.();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Tray
//
// Its absence was a real trap: "start minimised" hid the window with no way to
// bring it back on Windows, because `activate` is macOS-only.
// ---------------------------------------------------------------------------

function trayImage() {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG['16'], 'base64'), { scaleFactor: 1 });
  img.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(TRAY_ICON_PNG['32'], 'base64')
  });
  // macOS recolours a template image for light, dark and highlighted menu bars.
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('posi3');
  refreshTrayMenu();

  // Windows convention: a click opens the app. On macOS a left click should
  // show the menu, which is the platform default for a menu-bar item.
  if (process.platform !== 'darwin') tray.on('click', showWindow);

  svc.manager.on('state', refreshTrayMenu);
}

let trayRefreshQueued = false;
function refreshTrayMenu() {
  // State events arrive in bursts when several links start at once; rebuilding
  // the menu per event would be wasteful and can flicker an open menu.
  if (trayRefreshQueued) return;
  trayRefreshQueued = true;
  setTimeout(() => {
    trayRefreshQueued = false;
    if (!tray || tray.isDestroyed()) return;

    const running = svc.manager.runningCount;
    const total = svc.store.connections.length;
    tray.setToolTip(`posi3 — ${running}/${total} connected`);

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `${running} of ${total} connected`, enabled: false },
      { type: 'separator' },
      { label: 'Open posi3', click: showWindow },
      { label: 'Open web UI in browser', click: () => shell.openExternal(webUrlWithToken()) },
      { label: 'Copy web UI address', click: () => clipboard.writeText(webUrlWithToken()) },
      { type: 'separator' },
      { label: 'Start all connections', click: () => svc.manager.startAll() },
      { label: 'Stop all connections', click: () => svc.manager.stopAll() },
      { type: 'separator' },
      { label: 'Quit posi3', click: quit }
    ]));
  }, 120);
}

/** The token is required off-loopback, so the copied link has to carry it. */
function webUrlWithToken() {
  return svc.token ? `${svc.url}/?token=${encodeURIComponent(svc.token)}` : svc.url;
}

// ---------------------------------------------------------------------------

/** Hold off App Nap / sleep while anything is streaming. */
function updatePowerBlocker() {
  const shouldBlock = svc.manager.runningCount > 0;
  if (shouldBlock && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldBlock && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        // Shift, to match the web UI. Plain Cmd+R reloads the page here, and
        // binding "start all" to it would mean the same keystroke does two
        // different things depending on which surface you are looking at.
        { label: 'Start all connections', accelerator: 'CmdOrCtrl+Shift+R', click: () => svc.manager.startAll() },
        { label: 'Stop all connections', accelerator: 'CmdOrCtrl+Shift+.', click: () => svc.manager.stopAll() },
        { type: 'separator' },
        { label: 'Open web UI in browser', click: () => shell.openExternal(webUrlWithToken()) },
        { label: 'Copy web UI address', click: () => clipboard.writeText(webUrlWithToken()) },
        { type: 'separator' },
        { label: 'Close window', accelerator: 'CmdOrCtrl+W', click: () => mainWindow && mainWindow.hide() },
        { label: 'Quit posi3', accelerator: 'CmdOrCtrl+Q', click: quit }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]);
}

function quit() {
  quitting = true;
  app.quit();
}

/**
 * Die loudly.
 *
 * A packaged app has no console, so a startup failure that only tries a dialog
 * can vanish without trace — which is exactly what happened when the dialog
 * itself was unavailable: the process exited with an empty log and nothing to
 * diagnose. Write the reason down first, then try to show it.
 */
function fatal(err) {
  const detail = err && err.stack ? err.stack : String(err);
  const line = `posi3 failed to start: ${detail}`;

  process.stderr.write(`${line}\n`);
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'posi3.log'),
      `${new Date().toISOString()} [error] - ${line}\n`
    );
  } catch { /* nowhere to write; stderr above is all there is */ }

  try {
    dialog.showErrorBox('posi3 could not start', detail);
  } catch { /* no window server, no dialog — the log has it */ }
  app.exit(1);
}

app.on('activate', showWindow);

// Closing the window hides it, so this should never fire with the tray alive —
// and if it does, the bridge must keep running.
app.on('window-all-closed', () => {});

app.on('before-quit', async () => {
  quitting = true;
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
  // Close encoder sockets cleanly: a half-open session can occupy one of the
  // encoder's few TCP client slots until it times out.
  if (svc) {
    try { await svc.stop(); } catch { /* going down anyway */ }
  }
});
