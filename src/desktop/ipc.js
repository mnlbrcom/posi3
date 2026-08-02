'use strict';
/**
 * The renderer/main boundary.
 *
 * Everything arriving here is treated as untrusted input, even though the
 * renderer is our own code — a compromised or buggy renderer must not be able
 * to reach the network stack or the encoder's command channel in ways the UI
 * never intended.
 *
 * The sharpest edge is the encoder command channel: data and commands share one
 * TCP socket, so a value containing CR or LF becomes an extra command. Every
 * variable name is checked against the known table and every value is checked
 * for line breaks.
 */

const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const { ipcMain, dialog, app } = require('electron');

const constants = require('../shared/constants');
const { CH, ENCODER_VAR_BY_NAME, VELOCITY_POLICIES, UDP_SEND_POLICIES } = constants;
const { computeMapping, d3Fields, suggestedPreset } = require('../shared/mapping');
const { assertSafeValue } = require('../core/encoder-link');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function checkHost(value, label) {
  const s = String(value || '').trim();
  if (!s) fail('EINVAL', `${label} is required`);
  if (net.isIP(s)) return s;
  // Allow hostnames too — some installations use DNS names for show servers.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(s)) {
    fail('EINVAL', `${label} is not a valid IP address or hostname: ${s}`);
  }
  return s;
}

function checkPort(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail('EINVAL', `${label} must be between 1 and 65535`);
  return n;
}

function checkDevid(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) fail('EINVAL', 'Device ID must be between 0 and 65535');
  return n;
}

function checkId(value) {
  const s = String(value || '');
  if (!s) fail('EINVAL', 'Connection id is required');
  return s;
}

function checkVariable(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) fail('EINVAL', `Not a valid variable name: ${s}`);
  if (!ENCODER_VAR_BY_NAME.has(s.toLowerCase())) {
    fail('EINVAL', `${s} is not a known encoder variable`);
  }
  // Return the table's canonical spelling: the encoder is case-sensitive.
  return ENCODER_VAR_BY_NAME.get(s.toLowerCase()).name;
}

function checkValue(value) {
  const s = String(value);
  // The single most important check in this file.
  assertSafeValue(s);
  if (s.length > 256) fail('EINVAL', 'Value is too long');
  return s;
}

/** Normalise an incoming connection object down to fields we recognise. */
function sanitiseConnection(raw) {
  if (!raw || typeof raw !== 'object') fail('EINVAL', 'Expected a connection object');
  const out = {};
  if (raw.id) out.id = checkId(raw.id);
  out.name = String(raw.name || 'Encoder').slice(0, 120);
  out.autoStart = !!raw.autoStart;
  out.logRaw = !!raw.logRaw;
  out.notes = String(raw.notes || '').slice(0, 2000);

  const enc = raw.encoder || {};
  out.encoder = {
    host: checkHost(enc.host, 'Encoder address'),
    port: checkPort(enc.port, 'Encoder port'),
    localAddress: enc.localAddress ? checkHost(enc.localAddress, 'Local interface') : null
  };

  const d3 = raw.d3 || {};
  out.d3 = {
    host: checkHost(d3.host, 'disguise address'),
    port: checkPort(d3.port, 'disguise port'),
    devid: checkDevid(d3.devid),
    localAddress: d3.localAddress ? checkHost(d3.localAddress, 'Local interface') : null,
    localPort: d3.localPort ? checkPort(d3.localPort, 'Local source port') : null
  };

  out.velocityPolicy = VELOCITY_POLICIES.includes(raw.velocityPolicy) ? raw.velocityPolicy : 'zero';
  out.udpSendPolicy = UDP_SEND_POLICIES.includes(raw.udpSendPolicy) ? raw.udpSendPolicy : 'every';
  out.maxSendHz = Math.max(0, Math.min(2000, Number(raw.maxSendHz) || 0));

  if (raw.parser) {
    out.parser = {
      outputType: String(raw.parser.outputType || 'ASCII_SHORT'),
      autoDetect: raw.parser.autoDetect !== false,
      fields: Array.isArray(raw.parser.fields)
        ? raw.parser.fields.filter((f) => f === 0 || f === 1 || f === 2)
        : null
    };
  }
  if (raw.encoderMeta) {
    out.encoderMeta = {
      countsPerRev: Math.max(1, Number(raw.encoderMeta.countsPerRev) || 8192),
      totalCounts: Math.max(1, Number(raw.encoderMeta.totalCounts) || 33554432),
      cycleTimeMs: Math.max(1, Number(raw.encoderMeta.cycleTimeMs) || 10)
    };
  }
  if (raw.reconnect) {
    out.reconnect = {
      enabled: raw.reconnect.enabled !== false,
      minDelayMs: Math.max(50, Number(raw.reconnect.minDelayMs) || 250),
      maxDelayMs: Math.max(250, Number(raw.reconnect.maxDelayMs) || 5000)
    };
  }
  if (raw.mapping && typeof raw.mapping === 'object') {
    const m = raw.mapping;
    out.mapping = {
      mode: ['full', 'revolutions', 'capture'].includes(m.mode) ? m.mode : 'full',
      revolutions: Number(m.revolutions) || 1,
      gearRatio: Number(m.gearRatio) || 1,
      minInput: Number(m.minInput) || 0,
      maxInput: Number(m.maxInput) || 0,
      minOutput: Number(m.minOutput) || 0,
      maxOutput: m.maxOutput === undefined ? 1 : Number(m.maxOutput),
      wrapInput: m.wrapInput !== false,
      property: String(m.property || 'offset.x').slice(0, 200),
      object: String(m.object || '').slice(0, 300)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 * @param {import('./link-manager').LinkManager} ctx.manager
 * @param {import('./config-store').ConfigStore} ctx.store
 * @param {() => Electron.BrowserWindow|null} ctx.getWindow
 * @param {(conn: object) => void} ctx.syncLink   push config changes into the manager
 */
function registerIpc(ctx) {
  const { manager, store } = ctx;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, data: await fn(payload) };
      } catch (err) {
        return { ok: false, error: { code: err.code || 'EFAIL', message: err.message } };
      }
    });
  };

  const requireLink = (id) => {
    const link = manager.get(checkId(id));
    if (!link) fail('ENOENT', 'No such connection');
    if (!link.running) fail('ENOTCONNECTED', 'Connection is not running — start it first');
    return link;
  };

  // -- app ------------------------------------------------------------------

  handle(CH.APP_INFO, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    userDataPath: app.getPath('userData'),
    loadWarning: store.loadWarning,
    readOnly: store.readOnly,
    interfaces: listInterfaces(),
    // The renderer is sandboxed and cannot require shared modules, so the
    // reference data it renders is handed over once at startup.
    constants: {
      COUNTS_PER_REV: constants.COUNTS_PER_REV,
      REVOLUTIONS: constants.REVOLUTIONS,
      TOTAL_COUNTS: constants.TOTAL_COUNTS,
      DEFAULT_ENCODER_IP: constants.DEFAULT_ENCODER_IP,
      DEFAULT_ENCODER_PORT: constants.DEFAULT_ENCODER_PORT,
      DEFAULT_D3_PORT: constants.DEFAULT_D3_PORT,
      D3_FACTORY_PORT: constants.D3_FACTORY_PORT,
      SENSOR_UPDATE_MS: constants.SENSOR_UPDATE_MS,
      STATE: constants.STATE,
      VAR_GROUPS: constants.VAR_GROUPS,
      ENCODER_VARS: constants.ENCODER_VARS,
      TELEMETRY_HZ_CHOICES: constants.TELEMETRY_HZ_CHOICES,
      VELOCITY_POLICIES: constants.VELOCITY_POLICIES,
      UDP_SEND_POLICIES: constants.UDP_SEND_POLICIES
    }
  }));

  // -- mapping helper -------------------------------------------------------

  handle(CH.MAPPING_COMPUTE, ({ id, mapping }) => {
    const conn = store.find(checkId(id));
    if (!conn) fail('ENOENT', 'No such connection');
    const merged = Object.assign({}, conn.mapping, mapping || {}, {
      countsPerRev: conn.encoderMeta.countsPerRev,
      totalCounts: conn.encoderMeta.totalCounts
    });
    const mapped = computeMapping(merged);
    return {
      mapped,
      fields: d3Fields(conn, mapped),
      suggestedPreset: suggestedPreset(mapped.minInput, conn.encoderMeta.countsPerRev)
    };
  });

  // -- config ---------------------------------------------------------------

  handle(CH.CONFIG_GET, () => store.profile);

  handle(CH.CONFIG_SAVE_CONNECTION, (payload) => {
    const clean = sanitiseConnection(payload);
    const saved = store.upsertConnection(clean);
    ctx.syncLink(saved);
    return saved;
  });

  handle(CH.CONFIG_DELETE_CONNECTION, ({ id }) => {
    const key = checkId(id);
    manager.remove(key);
    return store.deleteConnection(key);
  });

  handle(CH.CONFIG_DUPLICATE_CONNECTION, ({ id }) => {
    const copy = store.duplicateConnection(checkId(id));
    if (!copy) fail('ENOENT', 'No such connection');
    ctx.syncLink(copy);
    return copy;
  });

  handle(CH.CONFIG_REORDER, ({ ids }) => {
    if (!Array.isArray(ids)) fail('EINVAL', 'Expected an array of ids');
    store.reorder(ids.map(checkId));
    return store.profile.connections.map((c) => c.id);
  });

  handle(CH.CONFIG_SET_SETTINGS, (partial) => {
    const s = store.setSettings(partial || {});
    manager.setTelemetryHz(s.telemetryHz);
    if (process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin });
    }
    return s;
  });

  handle(CH.CONFIG_EXPORT, async () => {
    const win = ctx.getWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export connection profile',
      defaultPath: 'd3driver-profile.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { written: false };
    fs.writeFileSync(filePath, JSON.stringify(store.profile, null, 2), 'utf8');
    return { written: true, filePath };
  });

  handle(CH.CONFIG_IMPORT, async () => {
    const win = ctx.getWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import connection profile',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths.length) return { imported: false };
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!data || !Array.isArray(data.connections)) fail('EINVAL', 'That file is not a d3driver profile');
    manager.stopAll();
    for (const id of manager.ids()) manager.remove(id);
    const profile = store.replaceProfile(data);
    for (const conn of profile.connections) ctx.syncLink(conn);
    return { imported: true, profile };
  });

  // -- links ----------------------------------------------------------------

  handle(CH.LINK_START, ({ id }) => {
    const key = checkId(id);
    if (!manager.has(key)) {
      const conn = store.find(key);
      if (!conn) fail('ENOENT', 'No such connection');
      ctx.syncLink(conn);
    }
    return manager.start(key).snapshot();
  });

  handle(CH.LINK_STOP, ({ id }) => manager.stop(checkId(id)).snapshot());

  handle(CH.LINK_START_ALL, () => {
    for (const conn of store.connections) ctx.syncLink(conn);
    manager.startAll();
    return manager.ids();
  });

  handle(CH.LINK_STOP_ALL, () => {
    manager.stopAll();
    return manager.ids();
  });

  handle(CH.LINK_SNAPSHOT, ({ id }) => {
    const link = manager.get(checkId(id));
    return link ? link.snapshot() : null;
  });

  // -- encoder command channel ---------------------------------------------

  handle(CH.ENC_READ, ({ id, variable }) => requireLink(id).read(checkVariable(variable)));

  handle(CH.ENC_READ_MANY, async ({ id, variables }) => {
    const link = requireLink(id);
    if (!Array.isArray(variables)) fail('EINVAL', 'Expected an array of variables');
    const out = {};
    // Sequential on purpose: one socket, one outstanding request.
    for (const raw of variables) {
      const name = checkVariable(raw);
      try {
        const r = await link.read(name);
        out[name] = { ok: true, value: r.value };
      } catch (err) {
        out[name] = { ok: false, error: err.message };
      }
    }
    return out;
  });

  handle(CH.ENC_WRITE, ({ id, variable, value }) =>
    requireLink(id).write(checkVariable(variable), checkValue(value)));

  handle(CH.ENC_WRITE_MANY, async ({ id, entries }) => {
    const link = requireLink(id);
    if (!Array.isArray(entries) || !entries.length) fail('EINVAL', 'Nothing to write');
    // Rate limiting and the flash-commit window live in EncoderLink, so every
    // transport shares one budget for the device's ~100,000 write cycles.
    return link.writeMany(entries.map((e) => ({
      variable: checkVariable(e.variable),
      value: checkValue(e.value)
    })));
  });

  handle(CH.ENC_PRESET, ({ id, value, force }) => {
    const link = requireLink(id);
    const v = checkValue(value === undefined || value === null ? 0 : value);
    return link.setPreset(Number(v), { force: !!force });
  });

  handle(CH.ENC_RUN, ({ id }) => requireLink(id).run());

  handle(CH.ENC_RAW, ({ id, line }) => requireLink(id).raw(checkValue(line)));

  // -- log ------------------------------------------------------------------

  handle(CH.LOG_TAIL, (opts) => manager.logger.tail(opts || {}));

  handle(CH.LOG_EXPORT, async () => {
    const win = ctx.getWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export log',
      defaultPath: `d3driver-log-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    });
    if (canceled || !filePath) return { written: false };
    const lines = manager.logger.tail({ limit: 100000 })
      .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.id || '-'} ${l.dir || ''} ${l.text}`)
      .join('\n');
    fs.writeFileSync(filePath, lines, 'utf8');
    return { written: true, filePath };
  });
}

/** IPv4 interfaces for the multi-NIC picker on show servers. */
function listInterfaces() {
  const out = [];
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4') continue;
      out.push({ name, address: a.address, cidr: a.cidr, internal: a.internal });
    }
  }
  return out;
}

module.exports = { registerIpc, sanitiseConnection, listInterfaces, checkVariable, checkValue };
