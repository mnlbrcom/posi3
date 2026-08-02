/**
 * Renderer bootstrap: router, IPC subscriptions, and the animation loop.
 *
 * Two separate clocks on purpose:
 *   - structural changes (profile edits, state transitions, navigation) rebuild
 *     the current view
 *   - live numbers are painted by one requestAnimationFrame loop that reads the
 *     newest values out of the store
 *
 * So a link streaming at 500 Hz never causes a re-render, and the display rate
 * is independent of the telemetry rate.
 */

// Installs window.d3d over fetch + EventSource when no Electron preload has
// already provided it. Imported first so it exists before boot() runs.
import './api.js';

import { el, clear, hz, toast, banner } from './ui.js';
import { store } from './store.js';
import { renderDashboard } from './views/dashboard.js';
import { renderConnections } from './views/connections.js';
import { renderDetail } from './views/detail.js';
import { renderEncoderConfig, onFlashConfirmed } from './views/encoder-config.js';
import { renderMapping } from './views/mapping.js';
import { renderLog, ingestLog } from './views/log.js';
import { renderSettings } from './views/settings.js';

const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
const aggregate = document.getElementById('aggregate');
const versionNode = document.getElementById('version');
const titlebarSub = document.getElementById('titlebar-sub');

const RENDERERS = {
  dashboard: renderDashboard,
  connections: renderConnections,
  detail: renderDetail,
  encoder: renderEncoderConfig,
  mapping: renderMapping,
  log: renderLog,
  settings: renderSettings
};

/** The active view's live-update hook, swapped on every navigation. */
let activeView = { refreshLive() {} };

// ---------------------------------------------------------------------------

async function boot() {
  try {
    store.info = await window.d3d.appInfo();
    store.setProfile(await window.d3d.config.get());
  } catch (err) {
    banner('error', `Could not start: ${err.message}`, { dismissible: false });
    return;
  }

  versionNode.textContent = `v${store.info.version}`;
  titlebarSub.textContent = 'POSITAL IXARC → disguise';

  if (store.info.loadWarning) {
    banner('warn', store.info.loadWarning, { key: 'profile-warning' });
  }
  if (store.info.readOnly) {
    banner('warn', 'This profile is read-only, so changes will not be saved.', { dismissible: false });
  }

  wireNav();
  wireEvents();
  wireShortcuts();
  wireVisibility();
  store.subscribe(onStoreChange);

  // Lets the main process drive navigation when capturing screenshots.
  window.__d3dNav = (view, id) => store.setView(view, id);

  renderView();
  requestAnimationFrame(tick);

  // Backfill the log. The stream only carries lines produced from now on, so a
  // browser opened after something went wrong would otherwise show an empty
  // console — exactly when the history matters most.
  try {
    ingestLog({ lines: await window.d3d.log.tail({ limit: 500 }), dropped: 0 });
  } catch { /* the console simply starts empty */ }
}

/**
 * Keyboard shortcuts.
 *
 * These used to be a native Electron menu, which a browser does not have. The
 * accelerators cannot be carried over as-is: Cmd/Ctrl+R meant "start all
 * connections" and in a browser it reloads the page. On a show that is the
 * difference between engaging the encoders and dropping every link, so the
 * bindings moved to Shift and are handled in-page.
 */
function wireShortcuts() {
  window.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod || !ev.shiftKey) return;
    const key = ev.key.toLowerCase();
    if (key === 'r') {
      ev.preventDefault();
      window.d3d.link.startAll().catch((err) => toast('error', err.message));
    } else if (key === '.') {
      ev.preventDefault();
      window.d3d.link.stopAll().catch((err) => toast('error', err.message));
    }
  });
}

/**
 * Browsers throttle requestAnimationFrame to a standstill in a background tab,
 * so the whole UI freezes mid-value when it is not visible. The store keeps the
 * newest frame regardless, so returning to the tab just needs one repaint.
 */
function wireVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderView();
  });
}

function wireNav() {
  for (const btn of sidebar.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => store.setView(btn.dataset.view));
  }
}

function wireEvents() {
  window.d3d.events.onTelemetry((frame) => store.applyTelemetry(frame));

  window.d3d.events.onLinkState((payload) => {
    if (payload.state === 'idle') store.clearTelemetry(payload.id);
    store.applyLinkState(payload);
  });

  window.d3d.events.onLog((batch) => ingestLog(batch));

  // Several browsers can now be open at once. Without this, every client except
  // the one that made an edit shows stale config until it is reloaded by hand.
  window.d3d.events.onConfigChanged(async () => {
    try {
      store.setProfile(await window.d3d.config.get());
    } catch { /* the next successful call will resync */ }
  });

  window.d3d.events.onEncoderEvent((e) => {
    const conn = store.find(e.id);
    const who = conn ? conn.name : e.id;

    switch (e.kind) {
      case 'paramsWritten':
        onFlashConfirmed(e.id);
        toast('info', `${who}: parameters successfully written to flash.`);
        break;

      case 'binaryMode':
        banner('warn',
          `${who} is set to OutputType=BINARY, which this app cannot stream. ` +
          'Open Encoder configuration and switch it to ASCII_SHORT.',
          { key: `binary-${e.id}` });
        break;

      case 'fieldLayoutInferred':
        store.fieldLayouts.set(e.id, { fields: e.fields, inferred: true });
        banner('warn',
          `${who}: could not read OutputMode, so the field layout was inferred. ` +
          'If velocity or position look wrong, set OutputMode explicitly in Encoder configuration.',
          { key: `fields-${e.id}` });
        break;

      case 'fieldLayout':
        store.fieldLayouts.set(e.id, { fields: e.fields, inferred: false });
        break;

      case 'error':
        toast('error', `${who}: ${e.text}`);
        break;

      case 'warning':
        toast('warn', `${who}: ${e.text}`);
        break;

      default:
        break;
    }
  });
}

function onStoreChange(reason) {
  if (reason === 'linkDetail') return; // picked up by the animation loop
  renderView();
}

function renderView() {
  const view = store.view;
  for (const btn of sidebar.querySelectorAll('.nav-item')) {
    // 'detail' is reached from the connections list, so keep that item lit.
    const match = btn.dataset.view === view || (view === 'detail' && btn.dataset.view === 'connections');
    btn.classList.toggle('active', match);
  }

  const renderer = RENDERERS[view] || renderConnections;
  try {
    activeView = renderer(content) || { refreshLive() {} };
  } catch (err) {
    console.error(err);
    clear(content).appendChild(el('div', { class: 'view' },
      el('div', { class: 'empty' },
        el('h3', { text: 'This screen failed to render' }),
        el('p', { text: err.message }))));
    activeView = { refreshLive() {} };
  }
  activeView.refreshLive();
}

/**
 * One loop for the whole UI. Reads the newest telemetry rather than reacting to
 * each frame, so rendering cost is bounded by the display, not by the encoder.
 */
function tick() {
  try {
    activeView.refreshLive();
    updateAggregate();
  } catch (err) {
    console.error('live update failed', err);
  }
  requestAnimationFrame(tick);
}

function updateAggregate() {
  let running = 0;
  let pkts = 0;
  for (const conn of store.connections) {
    const state = store.stateOf(conn.id);
    if (state === 'idle' || state === 'error') continue;
    running++;
    const t = store.telemetryOf(conn.id);
    if (t) pkts += t.txHz || 0;
  }
  aggregate.textContent = running
    ? `${running} link${running > 1 ? 's' : ''} · ${hz(pkts)} pkt/s`
    : `${store.connections.length} configured · idle`;
}

boot();
