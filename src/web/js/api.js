/**
 * Browser transport.
 *
 * Installs `window.d3d` with exactly the surface the Electron preload exposes,
 * over `fetch` and `EventSource` instead of IPC. Every view calls the same
 * method names with the same arguments and gets the same shapes back, which is
 * why none of them needed changing to run in a browser.
 *
 * If a preload has already installed `window.d3d` — i.e. we are inside the
 * desktop window before it moves onto HTTP — this module does nothing.
 */

const BASE = '';

/**
 * The token, when the server is bound beyond loopback.
 *
 * It arrives once as `?token=…`, then moves into sessionStorage and out of the
 * address bar: a token sitting in a URL gets copied into chat messages, pasted
 * into tickets, and left in browser history.
 */
const token = (() => {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try { sessionStorage.setItem('posi3.token', fromUrl); } catch { /* private mode */ }
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try { return sessionStorage.getItem('posi3.token'); } catch { return null; }
})();

function authHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra);
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Append the token to a plain navigation URL (downloads cannot set headers). */
function withToken(path) {
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

/**
 * Unwrap the {ok, data|error} envelope, so callers see a resolved value or a
 * thrown Error — identical to the preload's behaviour.
 */
async function call(name, payload) {
  let res;
  try {
    res = await fetch(`${BASE}/api/${name}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload === undefined ? null : payload)
    });
  } catch {
    // fetch only rejects on a transport failure, which here means the bridge
    // process is gone — worth saying plainly rather than "Failed to fetch".
    const err = new Error('Cannot reach the posi3 service. Is it still running?');
    err.code = 'EOFFLINE';
    throw err;
  }

  if (res.status === 401) {
    const err = new Error('Access token required or invalid. Reopen the link from the posi3 tray menu.');
    err.code = 'EDENIED';
    throw err;
  }

  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (body && body.ok) return body.data;

  const err = new Error((body && body.error && body.error.message) || `Request failed (HTTP ${res.status})`);
  err.code = (body && body.error && body.error.code) || 'EFAIL';
  if (body && body.error && body.error.retryAfterMs) err.retryAfterMs = body.error.retryAfterMs;
  throw err;
}

// ---------------------------------------------------------------------------
// Events
//
// One EventSource for all four streams, demultiplexed by event name. The
// browser handles reconnection itself, which is the point: a browser left open
// on a show server has to survive the bridge restarting with nobody at the
// keyboard.
// ---------------------------------------------------------------------------

let source = null;
const listeners = new Map(); // event name -> Set<fn>

function ensureSource() {
  if (source) return source;
  source = new EventSource(withToken('/api/events'));
  for (const name of ['telemetry', 'linkState', 'encoderEvent', 'log', 'configChanged']) {
    source.addEventListener(name, (ev) => {
      const subs = listeners.get(name);
      if (!subs || !subs.size) return;
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      for (const fn of subs) {
        try { fn(payload); } catch (err) { console.error(`${name} handler failed`, err); }
      }
    });
  }
  return source;
}

function on(name, fn) {
  ensureSource();
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

// ---------------------------------------------------------------------------
// Downloads and uploads
//
// The packaged app opened native file dialogs here. Over HTTP that would put
// the file picker on the show server rather than on the operator's machine, so
// these become an ordinary browser download and an ordinary file input.
// ---------------------------------------------------------------------------

function download(path) {
  const a = document.createElement('a');
  a.href = withToken(path);
  a.rel = 'noopener';
  // The server sets Content-Disposition; this is a hint for the odd browser
  // that ignores it.
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // `filePath: null` tells the caller the browser chose where it went.
  return { written: true, filePath: null };
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    // There is no reliable "cancelled" event across engines, so a cancel simply
    // leaves the promise unresolved until the page is navigated. Guard against
    // that by resolving on window focus if nothing was chosen.
    const finish = (file) => {
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    const onFocus = () => setTimeout(() => { if (!input.files.length) finish(null); }, 400);

    input.addEventListener('change', () => finish(input.files[0] || null));
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

// ---------------------------------------------------------------------------

if (!window.d3d) {
  window.d3d = {
    appInfo: () => call('appInfo'),

    config: {
      get: () => call('configGet'),
      saveConnection: (conn) => call('configSaveConnection', conn),
      deleteConnection: (id) => call('configDeleteConnection', { id }),
      reorder: (ids) => call('configReorder', { ids }),
      setSettings: (partial) => call('configSetSettings', partial),
      exportFile: async () => download('/api/download/profile'),
      importFile: async () => {
        const file = await pickFile();
        if (!file) return { imported: false };
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          const err = new Error('That file is not valid JSON');
          err.code = 'EINVAL';
          throw err;
        }
        return call('configImport', data);
      }
    },

    link: {
      start: (id) => call('linkStart', { id }),
      stop: (id) => call('linkStop', { id }),
      startAll: () => call('linkStartAll'),
      stopAll: () => call('linkStopAll'),
      snapshot: (id) => call('linkSnapshot', { id })
    },

    encoder: {
      read: (id, variable) => call('encoderRead', { id, variable }),
      readMany: (id, variables) => call('encoderReadMany', { id, variables }),
      cached: (id) => call('encoderCached', { id }),
      write: (id, variable, value) => call('encoderWrite', { id, variable, value }),
      writeMany: (id, entries, force) => call('encoderWriteMany', { id, entries, force }),
      preset: (id, value, force) => call('encoderPreset', { id, value, force }),
      run: (id) => call('encoderRun', { id })
    },

    mapping: {
      compute: (id, mapping) => call('mappingCompute', { id, mapping })
    },

    net: {
      interfaces: () => call('interfaces'),
      discoverInterfaces: () => call('discoverInterfaces'),
      discoverEncoders: (localAddress, port) => call('discoverEncoders', { localAddress, port })
    },

    log: {
      tail: (opts) => call('logTail', opts),
      export: async () => download('/api/download/log')
    },

    events: {
      onTelemetry: (fn) => on('telemetry', fn),
      onLinkState: (fn) => on('linkState', fn),
      onEncoderEvent: (fn) => on('encoderEvent', fn),
      onLog: (fn) => on('log', fn),
      onConfigChanged: (fn) => on('configChanged', fn)
    }
  };
}

/**
 * Shims for the desktop preload, which predates these operations. Keeps the
 * views free of "does this transport have it?" checks while both exist.
 */
if (!window.d3d.events.onConfigChanged) window.d3d.events.onConfigChanged = () => () => {};
if (!window.d3d.net) window.d3d.net = { interfaces: async () => (await window.d3d.appInfo()).interfaces };
