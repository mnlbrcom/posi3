'use strict';
/**
 * Connection profiles on disk.
 *
 * Writes are atomic (temp file -> fsync -> rename) and keep one generation of
 * backup. A show server can lose power at any moment; a half-written
 * profile.json that silently starts the app with zero connections would be a
 * bad way to find that out.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  COUNTS_PER_REV, TOTAL_COUNTS, DEFAULT_ENCODER_IP, DEFAULT_ENCODER_PORT,
  DEFAULT_D3_PORT, DEFAULT_TELEMETRY_HZ
} = require('../shared/constants');

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

function defaultSettings() {
  return {
    telemetryHz: DEFAULT_TELEMETRY_HZ,
    autoStartOnLaunch: false,
    startMinimized: false,
    launchAtLogin: false,
    defaultLocalAddress: null,
    defaultVelocityPolicy: 'zero',
    logToFile: false
  };
}

function defaultConnection(overrides = {}) {
  return Object.assign({
    id: crypto.randomUUID(),
    name: 'New encoder',
    autoStart: false,
    encoder: { host: DEFAULT_ENCODER_IP, port: DEFAULT_ENCODER_PORT, localAddress: null },
    d3: { host: '127.0.0.1', port: DEFAULT_D3_PORT, devid: 1, localAddress: null, localPort: null },
    velocityPolicy: 'zero',
    udpSendPolicy: 'every',
    maxSendHz: 0,
    parser: { outputType: 'ASCII_SHORT', fields: null, autoDetect: true },
    encoderMeta: { countsPerRev: COUNTS_PER_REV, totalCounts: TOTAL_COUNTS, cycleTimeMs: 10 },
    reconnect: { enabled: true, minDelayMs: 250, maxDelayMs: 5000 },
    mapping: {
      mode: 'full',
      minInput: 0,
      maxInput: TOTAL_COUNTS - 1,
      minOutput: 0,
      maxOutput: 1,
      wrapInput: true,
      property: 'offset.x',
      object: ''
    },
    logRaw: false,
    notes: ''
  }, overrides);
}

class ConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'profile.json');
    this.backup = path.join(dir, 'profile.bak.json');
    this.profile = { version: SCHEMA_VERSION, settings: defaultSettings(), connections: [] };
    this.readOnly = false;
    this.loadWarning = null;
    this._saveTimer = null;
  }

  load() {
    const primary = this._tryRead(this.file);
    if (primary.ok) {
      this._adopt(primary.data);
      return this.profile;
    }

    if (primary.missing) {
      this.profile = { version: SCHEMA_VERSION, settings: defaultSettings(), connections: [] };
      return this.profile;
    }

    // The file exists but is unusable. Preserve it for forensics rather than
    // overwriting, and fall back to the backup.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = path.join(this.dir, `profile.corrupt-${stamp}.json`);
    try {
      fs.renameSync(this.file, quarantine);
    } catch { /* best effort */ }

    const backup = this._tryRead(this.backup);
    if (backup.ok) {
      this._adopt(backup.data);
      this.loadWarning = `profile.json was unreadable (${primary.error}). ` +
        `It has been kept as ${path.basename(quarantine)} and the backup was loaded.`;
    } else {
      this.profile = { version: SCHEMA_VERSION, settings: defaultSettings(), connections: [] };
      this.loadWarning = `profile.json was unreadable (${primary.error}) and no usable backup ` +
        `was found. It has been kept as ${path.basename(quarantine)} and an empty profile started.`;
    }
    return this.profile;
  }

  _tryRead(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, missing: true };
      return { ok: false, error: err.message };
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !Array.isArray(data.connections)) {
        return { ok: false, error: 'not a profile document' };
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${err.message}` };
    }
  }

  _adopt(data) {
    if (Number(data.version) > SCHEMA_VERSION) {
      // Written by a newer build. Show it, but refuse to save over it.
      this.readOnly = true;
      this.loadWarning = `This profile was written by a newer version of d3driver ` +
        `(schema ${data.version}, this build understands ${SCHEMA_VERSION}). ` +
        `It has been loaded read-only so it cannot be downgraded.`;
    }
    this.profile = {
      version: SCHEMA_VERSION,
      settings: Object.assign(defaultSettings(), data.settings || {}),
      connections: (data.connections || []).map((c) => migrateConnection(c))
    };
  }

  // -------------------------------------------------------------------------

  get connections() { return this.profile.connections; }
  get settings() { return this.profile.settings; }

  find(id) { return this.profile.connections.find((c) => c.id === id) || null; }

  upsertConnection(partial) {
    const existing = partial.id ? this.find(partial.id) : null;
    if (existing) {
      Object.assign(existing, migrateConnection(Object.assign({}, existing, partial)));
      this.save();
      return existing;
    }
    const created = defaultConnection(migrateConnection(partial));
    if (!partial.id) created.id = crypto.randomUUID();
    this.profile.connections.push(created);
    this.save();
    return created;
  }

  deleteConnection(id) {
    const before = this.profile.connections.length;
    this.profile.connections = this.profile.connections.filter((c) => c.id !== id);
    if (this.profile.connections.length !== before) this.save();
    return this.profile.connections.length !== before;
  }

  duplicateConnection(id) {
    const src = this.find(id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = crypto.randomUUID();
    copy.name = `${src.name} copy`;
    copy.autoStart = false; // never silently start a clone
    copy.d3.devid = this.nextFreeDevid();
    this.profile.connections.push(copy);
    this.save();
    return copy;
  }

  /** Lowest device id not already claimed — duplicate ids silently collide in d3. */
  nextFreeDevid() {
    const used = new Set(this.profile.connections.map((c) => Number(c.d3.devid)));
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  reorder(ids) {
    const byId = new Map(this.profile.connections.map((c) => [c.id, c]));
    const next = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (c) { next.push(c); byId.delete(id); }
    }
    for (const c of byId.values()) next.push(c); // anything not listed keeps its place at the end
    this.profile.connections = next;
    this.save();
  }

  setSettings(partial) {
    Object.assign(this.profile.settings, partial || {});
    this.save();
    return this.profile.settings;
  }

  replaceProfile(data) {
    this._adopt(data);
    for (const c of this.profile.connections) if (!c.id) c.id = crypto.randomUUID();
    this.readOnly = false;
    this.save({ immediate: true });
    return this.profile;
  }

  // -------------------------------------------------------------------------

  save(opts = {}) {
    if (this.readOnly) return;
    if (opts.immediate) {
      this._flush();
      return;
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), SAVE_DEBOUNCE_MS);
  }

  _flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.readOnly) return;

    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.profile, null, 2);
    try {
      fs.mkdirSync(this.dir, { recursive: true });

      // Keep the previous good file before replacing it.
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.backup); } catch { /* best effort */ }
      }

      // Temp file in the SAME directory so the rename is atomic (a rename
      // across filesystems is a copy, and a copy can be interrupted).
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, json, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Never take the app down over a failed settings write.
      console.error(`[config] could not save profile: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Call before quitting so a debounced save is not lost. */
  flushNow() { this._flush(); }
}

/** Fill in anything a older or hand-edited profile is missing. */
function migrateConnection(c) {
  const base = defaultConnection();
  const out = Object.assign({}, base, c);
  out.encoder = Object.assign({}, base.encoder, c.encoder);
  out.d3 = Object.assign({}, base.d3, c.d3);
  out.parser = Object.assign({}, base.parser, c.parser);
  out.encoderMeta = Object.assign({}, base.encoderMeta, c.encoderMeta);
  out.reconnect = Object.assign({}, base.reconnect, c.reconnect);
  out.mapping = Object.assign({}, base.mapping, c.mapping);
  return out;
}

module.exports = {
  ConfigStore,
  defaultConnection,
  defaultSettings,
  migrateConnection,
  SCHEMA_VERSION
};
