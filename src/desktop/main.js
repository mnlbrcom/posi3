'use strict';
/**
 * Application entry point.
 *
 * Owns the window, the LinkManager and the config store, and forwards manager
 * events to the renderer. Nothing on the data path lives here — see
 * encoder-link.js for that.
 */

const path = require('node:path');
const { app, BrowserWindow, powerSaveBlocker, shell, Menu } = require('electron');

const { LinkManager } = require('../core/link-manager');
const { ConfigStore } = require('../core/config-store');
const { Logger } = require('../core/logger');
const { registerIpc } = require('./ipc');
const { CH } = require('../shared/constants');

const isDev = process.argv.includes('--dev');

// A minimised or hidden window must never stall the telemetry tick.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;
let store = null;
let manager = null;
let powerBlockerId = null;

// Two copies would open rival sockets to the same encoder, and the encoder only
// accepts a handful of TCP clients.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

function start() {
  store = new ConfigStore(app.getPath('userData'));
  store.load();

  manager = new LinkManager({
    logger: new Logger(),
    telemetryHz: store.settings.telemetryHz
  });

  wireManagerEvents();

  registerIpc({
    manager,
    store,
    getWindow: () => mainWindow,
    syncLink: (conn) => manager.upsert(conn)
  });

  createWindow();

  // Register every configured connection so it can be started from the UI
  // without a round trip through the config store.
  for (const conn of store.connections) manager.upsert(conn);

  if (store.settings.autoStartOnLaunch) {
    // After the window exists, so its first state events are not lost.
    mainWindow.webContents.once('did-finish-load', () => {
      for (const conn of store.connections) {
        if (conn.autoStart) {
          try { manager.start(conn.id); } catch { /* reported through link state */ }
        }
      }
    });
  }
}

function wireManagerEvents() {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  manager.on('telemetry', (p) => send(CH.TELEMETRY, p));
  manager.on('state', (p) => {
    send(CH.LINK_STATE, p);
    updatePowerBlocker();
  });
  manager.on('encoderEvent', (p) => send(CH.ENC_EVENT, p));
  manager.on('fieldLayout', (p) => send(CH.ENC_EVENT, {
    id: p.id,
    kind: p.inferred ? 'fieldLayoutInferred' : 'fieldLayout',
    text: p.inferred
      ? `Field layout inferred${p.why ? ` (${p.why})` : ''}`
      : `Field layout read from encoder`,
    fields: p.fields
  }));
  manager.on('log', (p) => send(CH.LOG, p));
}

/** Hold off App Nap / sleep while anything is streaming. */
function updatePowerBlocker() {
  const shouldBlock = manager.runningCount > 0;
  if (shouldBlock && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldBlock && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    show: !store.settings.startMinimized,
    backgroundColor: '#191518', // must match --bg, or the window flashes on open
    title: 'd3driver',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The UI must keep updating when the window is behind the d3 interface.
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // This app has no business opening windows or navigating anywhere.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (process.env.D3D_SHOT) maybeCapture();
  if (process.env.D3D_PROBE) maybeProbeLayout();

  mainWindow.on('closed', () => { mainWindow = null; });

  Menu.setApplicationMenu(buildMenu());
}

/**
 * Development aid: render the window off-screen to PNG files.
 *
 * D3D_SHOT="delayMs:view:outfile,delayMs:view:outfile,..."
 * `view` is a sidebar view name; it is dispatched into the renderer's router.
 */
function maybeCapture() {
  const jobs = String(process.env.D3D_SHOT).split(',').map((spec) => {
    const [delay, view, out] = spec.split(':');
    return { delay: Number(delay) || 1500, view, out };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    let elapsed = 0;
    for (const job of jobs) {
      elapsed += job.delay;
      setTimeout(async () => {
        try {
          if (job.view) {
            await mainWindow.webContents.executeJavaScript(
              `window.__d3dNav && window.__d3dNav(${JSON.stringify(job.view)})`);
            await new Promise((r) => setTimeout(r, 500));
          }
          const image = await mainWindow.webContents.capturePage();
          require('node:fs').writeFileSync(job.out, image.toPNG());
          console.log(`[shot] wrote ${job.out}`);
        } catch (err) {
          console.error(`[shot] ${job.out} failed: ${err.message}`);
        }
      }, elapsed);
    }
    setTimeout(() => app.quit(), elapsed + 1500);
  });
}

/**
 * Development aid: prove the layout does not move while values update.
 *
 * Live readouts change digit count constantly, and with auto-sized columns the
 * browser re-measures on every frame, which reads as the whole UI shivering.
 * This samples the geometry of every live element and reports any that shifted.
 *
 * D3D_PROBE="<view>:<durationMs>"
 */
function maybeProbeLayout() {
  const [view = 'connections', durationRaw] = String(process.env.D3D_PROBE).split(':');
  const duration = Number(durationRaw) || 4000;

  mainWindow.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    await mainWindow.webContents.executeJavaScript(
      `window.__d3dNav && window.__d3dNav(${JSON.stringify(view)})`);
    await new Promise((r) => setTimeout(r, 600));

    const report = await mainWindow.webContents.executeJavaScript(`(async () => {
      const sel = '.num, .statline b, .readouts dd, .pill, td, th, .status-detail';
      const samples = new Map();
      const take = () => {
        for (const node of document.querySelectorAll(sel)) {
          if (!node.__probeId) node.__probeId = Math.random().toString(36).slice(2);
          const r = node.getBoundingClientRect();
          const key = node.__probeId;
          const rec = samples.get(key) || {
            tag: node.tagName.toLowerCase() + '.' + (node.className || ''),
            left: [], width: [], top: []
          };
          rec.left.push(Math.round(r.left * 100) / 100);
          rec.width.push(Math.round(r.width * 100) / 100);
          rec.top.push(Math.round(r.top * 100) / 100);
          samples.set(key, rec);
        }
      };
      const end = performance.now() + ${duration};
      while (performance.now() < end) {
        take();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const moved = [];
      for (const rec of samples.values()) {
        const spread = (a) => Math.max(...a) - Math.min(...a);
        const dl = spread(rec.left), dw = spread(rec.width), dt = spread(rec.top);
        if (dl > 0.5 || dw > 0.5 || dt > 0.5) {
          moved.push({ tag: rec.tag, dLeft: dl, dWidth: dw, dTop: dt });
        }
      }
      return { tracked: samples.size, frames: samples.values().next().value.left.length, moved };
    })()`);

    console.log(`[probe] ${view}: tracked ${report.tracked} elements over ${report.frames} frames`);
    if (!report.moved.length) {
      console.log('[probe] LAYOUT STABLE — nothing moved or resized');
    } else {
      console.log(`[probe] ${report.moved.length} element(s) MOVED:`);
      for (const m of report.moved.slice(0, 15)) {
        console.log(`  ${m.tag}  Δleft=${m.dLeft}  Δwidth=${m.dWidth}  Δtop=${m.dTop}`);
      }
    }
    app.quit();
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Start all connections',
          accelerator: 'CmdOrCtrl+R',
          click: () => manager.startAll()
        },
        {
          label: 'Stop all connections',
          accelerator: 'CmdOrCtrl+.',
          click: () => manager.stopAll()
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  return Menu.buildFromTemplate(template);
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Close encoder sockets cleanly: a half-open session can occupy one of the
  // encoder's few TCP client slots until it times out.
  if (manager) manager.dispose();
  if (store) store.flushNow();
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
});
