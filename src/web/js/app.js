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

import { el, clear, hz, setText, toast, banner, dismissBanner, steady } from './ui.js';
import { store } from './store.js';
import { renderDashboard } from './views/dashboard.js';
import { renderConnections } from './views/connections.js';
import { renderEncoderConfig, onFlashConfirmed } from './views/encoder-config.js';
import { renderMapping } from './views/mapping.js';
import { renderLog, ingestLog, mergeLog } from './views/log.js';
import { renderSettings } from './views/settings.js';

const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('nav-toggle');
const aggregate = document.getElementById('aggregate');
const versionNode = document.getElementById('version');

const RENDERERS = {
  dashboard: renderDashboard,
  connections: renderConnections,
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
    banner('error', `Could not start: ${err.message}`);
    return;
  }

  versionNode.textContent = `v${store.info.version}`;

  // The idle handshakes' answers so far, so the first render already says
  // offline/connected instead of waiting a probe interval for the stream.
  for (const [id, alive] of Object.entries(store.info.encoderAlive || {})) {
    store.setEncoderAlive(id, alive);
  }

  if (store.info.loadWarning) {
    banner('warn', store.info.loadWarning, { key: 'profile-warning' });
  }
  if (store.info.readOnly) {
    banner('warn', 'This profile is read-only, so changes will not be saved.');
  }

  // The desktop window uses a hidden-inset title bar on macOS, so the traffic
  // lights sit over our chrome. A browser tab has no such thing.
  if (/Electron/i.test(navigator.userAgent) && /Mac/i.test(navigator.platform)) {
    document.body.classList.add('inset-titlebar');
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
 * Keyboard shortcuts: Cmd/Ctrl+Shift+Comma starts everything, and the key next
 * to it stops everything.
 *
 * These used to be a native Electron menu, which a browser does not have. The
 * accelerators cannot be carried over as-is: Cmd/Ctrl+R meant "start all
 * connections" and in a browser it reloads the page. The first replacement,
 * Shift+R, walked into the same wall one key over — Cmd/Ctrl+Shift+R is the
 * browser's *hard* reload, so refreshing a misbehaving page engaged every
 * encoder. Comma and Period belong to no browser on any engine.
 *
 * Matched by `ev.code` — the physical key — not `ev.key`. With Shift held the
 * `.` key produces `>` on a US layout and `:` on a German one, so a value
 * match made the stop shortcut dead on every layout anyone here uses, while
 * start worked. An emergency stop that does nothing is worse than none.
 */
function wireShortcuts() {
  window.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    // altKey excluded because of Windows: AltGr arrives as Ctrl+Alt, so an
    // AltGr+Shift chord on the comma key — a typing gesture on several
    // European layouts — would otherwise read as Ctrl+Shift+Comma and start
    // every encoder mid-keystroke.
    if (!mod || !ev.shiftKey || ev.altKey) return;
    if (ev.code === 'Comma') {
      ev.preventDefault();
      window.d3d.link.startAll().catch((err) => toast('error', err.message));
    } else if (ev.code === 'Period') {
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
    btn.addEventListener('click', () => {
      store.setView(btn.dataset.view);
      setMenu(false);
    });
  }

  navToggle.addEventListener('click', () => setMenu(!isMenuOpen()));

  // Anywhere else dismisses it, which is what a dropped panel has to do.
  document.addEventListener('pointerdown', (ev) => {
    if (!isMenuOpen()) return;
    if (sidebar.contains(ev.target) || navToggle.contains(ev.target)) return;
    setMenu(false);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isMenuOpen()) {
      setMenu(false);
      navToggle.focus();
    }
  });

  // Widening past the breakpoint brings the rail back; a panel left open would
  // then be an orphaned overlay on top of it.
  window.addEventListener('resize', () => {
    if (isMenuOpen() && getComputedStyle(navToggle).display === 'none') setMenu(false);
  });
}

const isMenuOpen = () => sidebar.classList.contains('open');

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function wireEvents() {
  window.d3d.events.onTelemetry((frame) => store.applyTelemetry(frame));

  window.d3d.events.onLinkState((payload) => {
    if (payload.state === 'idle') {
      store.clearTelemetry(payload.id);
      // "…is offline — sends paused, retrying every 5s" stops being true the
      // moment the link stops: nothing is retrying, because nothing is
      // sending. Leaving it up for the banner's own lifetime states something
      // the app knows is false, so it goes as soon as the link goes.
      dismissBanner(`dest-${payload.id}`);
    }
    store.applyLinkState(payload);
  });

  window.d3d.events.onLog((batch) => ingestLog(batch));

  // A reconnect is a gap: config edits and log lines from the outage were
  // never sent. Telemetry heals itself on the next frame; these two do not,
  // so they are re-fetched. The log is merged by sequence number, not
  // re-ingested — most of the tail is already on screen.
  window.d3d.events.onReconnected(async () => {
    try {
      store.setProfile(await window.d3d.config.get());
      mergeLog(await window.d3d.log.tail({ limit: 500 }));
    } catch { /* still down; the next reconnect tries again */ }
  });

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
      // The idle handshake's answer. Applied silently — the pill is the
      // message — and painted by the next animation frame.
      case 'encoderReachability':
        store.setEncoderAlive(e.id, e.alive);
        break;

      case 'paramsWritten':
        onFlashConfirmed(e.id);
        toast('info', `${who}: parameters successfully written to flash.`);
        break;

      // The encoder never broadcast a commit, so the write was confirmed by
      // reading the value back instead. Same effect on the UI: clear the
      // "do not power off" window.
      case 'flashConfirmed':
        onFlashConfirmed(e.id);
        toast('info', `${who}: ${e.text}`);
        break;

      // Read-back could not prove the value stuck. Clear the do-not-power-off
      // window, then say so where the operator will see it before power-cycling.
      case 'flashUnconfirmed':
        onFlashConfirmed(e.id);
        banner('warn', `${who}: ${e.text}`, { key: `flash-unknown-${e.id}` });
        break;

      case 'binaryMode':
        banner('warn',
          `${who} is set to OutputType=BINARY, which this app cannot stream. ` +
          'Open Encoder Config and switch it to ASCII_SHORT.',
          { key: `binary-${e.id}` });
        break;

      case 'fieldLayoutInferred':
        store.fieldLayouts.set(e.id, { fields: e.fields, inferred: true });
        banner('warn',
          `${who}: could not read OutputMode, so the field layout was inferred. ` +
          'If velocity or position look wrong, set OutputMode explicitly in Encoder Config.',
          { key: `fields-${e.id}` });
        break;

      case 'fieldLayout':
        store.fieldLayouts.set(e.id, { fields: e.fields, inferred: false });
        break;

      case 'destinationDown':
        // A banner, not a toast: this persists until it is fixed, and an
        // operator who looked away should still find it.
        banner('warn', `${who}: ${e.text}`, { key: `dest-${e.id}` });
        break;

      case 'destinationUp':
        dismissBanner(`dest-${e.id}`);
        toast('info', `${who}: ${e.text}`);
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
  // Both link reasons are the animation loop's job. Every view seeds its state
  // pill at build time and keeps it live in refreshLive, so a state-name
  // change needs no structure rebuilt — and rebuilding anyway was destructive:
  // the staged values on an encoder card, a half-edited mapping and its Save,
  // and the "Ask disguise" answer all live in card closures, and an encoder
  // quietly reconnecting threw all of them away while the operator was typing.
  // Structure rebuilds on *config* change; state is not config.
  if (reason === 'linkDetail' || reason === 'linkState') return;
  renderView();
}

function renderView() {
  const view = store.view;
  for (const btn of sidebar.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.view === view);
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

/** The footer's packet rate, held steady like every other rate readout. */
const steadyTotal = steady();

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
  // Through setText, so an unchanged line costs nothing: this runs on every
  // animation frame, and an unconditional textContent write replaces the text
  // node ~60 times a second — the churn the two-clock model exists to avoid.
  setText(aggregate, running
    ? `${running} link${running > 1 ? 's' : ''} · ${hz(steadyTotal(pkts))} pkt/s`
    : `${store.connections.length} configured · idle`);
}

boot();
