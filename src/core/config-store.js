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
  DEFAULT_ENCODER_IP, DEFAULT_ENCODER_PORT,
  DEFAULT_D3_PORT, DEFAULT_TELEMETRY_HZ
} = require('../shared/constants');

const SCHEMA_VERSION = 5;
const SAVE_DEBOUNCE_MS = 300;

function defaultSettings() {
  return {
    telemetryHz: DEFAULT_TELEMETRY_HZ,
    autoStartOnLaunch: false,
    startMinimized: false,
    launchAtLogin: false,
    logToFile: false,
    /**
     * The web UI's own listener. Loopback by default — the desktop window and
     * a browser on this machine reach it, nothing else does. Widening it turns
     * on token authentication (see src/server/security.js), because these
     * operations can write encoder flash and change a device's IP address.
     */
    webPort: 8710,
    webBindHost: '127.0.0.1'
  };
}

/**
 * How this receiver's axis is driven.
 *
 * On the destination, not the connection: one encoder can feed several disguise
 * machines, and they need not be showing the same thing — a director and an
 * understudy share a mapping, but a second machine driving `rotation.y` from
 * the same shaft is a legitimate rig. Schema 4 moved it here; before that there
 * was one mapping per connection and every receiver after the first was
 * described by the first one's device ID and port.
 */
function defaultMapping(overrides = {}) {
  return Object.assign({
    mode: 'full',
    revolutions: 1,
    gearRatio: 1,
    minInput: 0,
    /* Only mode 'capture' reads this, and nothing has been captured yet. */
    maxInput: 0,
    minOutput: 0,
    maxOutput: 1,
    wrapInput: true,
    property: 'offset.x',
    object: ''
  }, overrides);
}

function defaultDestination(overrides = {}) {
  return Object.assign({
    id: crypto.randomUUID(),
    name: '',
    host: '127.0.0.1',
    port: DEFAULT_D3_PORT,
    devid: 1,
    enabled: true,
    localAddress: null,
    localIfName: null,
    localPort: null,
    mapping: defaultMapping()
  }, overrides);
}

function defaultConnection(overrides = {}) {
  return Object.assign({
    id: crypto.randomUUID(),
    name: 'New encoder',
    autoStart: false,
    encoder: { host: DEFAULT_ENCODER_IP, port: DEFAULT_ENCODER_PORT, localAddress: null, localIfName: null },
    /**
     * Where the position goes. An array since schema 2: a redundant disguise
     * system (director + understudy + actors) needs the same tracking data on
     * every machine that might take over, and duplicating the connection to
     * achieve that would open a second TCP socket to an encoder that only
     * accepts a handful of clients.
     */
    destinations: [defaultDestination()],
    velocityPolicy: 'zero',
    udpSendPolicy: 'every',
    maxSendHz: 0,
    /* No `outputType` claim: the parser recognises both formats from the line
       itself, so the field said nothing anyone read. Schema 5 removed it. */
    parser: { fields: null, autoDetect: true },
    /* Null, not a nameplate figure: before the encoder has answered we do not
       know these, and pretending we do is what made every first read look like
       a change. They are filled in from the device and kept. */
    encoderMeta: { countsPerRev: null, totalCounts: null, cycleTimeMs: null },
    reconnect: { enabled: true, minDelayMs: 250, maxDelayMs: 5000 }
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
      this.loadWarning = `This profile was written by a newer version of posi3 ` +
        `(schema ${data.version}, this build understands ${SCHEMA_VERSION}). ` +
        `It has been loaded read-only so it cannot be downgraded.`;
    }
    this.profile = {
      version: SCHEMA_VERSION,
      // Known settings only: `Object.assign` alone carried keys deleted from
      // the app years ago (defaultLocalAddress, defaultVelocityPolicy) in
      // every profile ever written since.
      settings: pickKnown(Object.assign(defaultSettings(), data.settings || {}), defaultSettings()),
      connections: (data.connections || []).map((c) => migrateConnection(c, Number(data.version) || 0))
    };
  }

  // -------------------------------------------------------------------------

  get connections() { return this.profile.connections; }
  get settings() { return this.profile.settings; }

  find(id) { return this.profile.connections.find((c) => c.id === id) || null; }

  upsertConnection(partial) {
    const existing = partial.id ? this.find(partial.id) : null;
    if (existing) {
      Object.assign(existing, migrateConnection(Object.assign({}, existing, partial), SCHEMA_VERSION));
      this.save();
      return existing;
    }
    const created = defaultConnection(migrateConnection(partial, SCHEMA_VERSION));
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
    // The warning described the file this replacement just superseded.
    // Clearing readOnly but not the warning left appInfo repeating "written
    // by a newer build" about a profile that no longer existed.
    this.loadWarning = null;
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

/**
 * Fill in anything an older or hand-edited profile is missing.
 *
 * @param {object} c
 * @param {number} fromVersion  schema the profile was written by; SCHEMA_VERSION
 *                              for data already in this build's shape.
 */
/** Keep only the keys the reference shape has — the schema-5 rule. */
function pickKnown(obj, reference) {
  for (const k of Object.keys(obj)) {
    if (!(k in reference)) delete obj[k];
  }
  return obj;
}

function migrateConnection(c, fromVersion) {
  const base = defaultConnection();
  const out = Object.assign({}, base, c);
  out.encoder = Object.assign({}, base.encoder, c.encoder);
  out.parser = Object.assign({}, base.parser, c.parser);
  // Schema 2 -> 3: every encoderMeta value in an older profile was invented.
  // Nothing ever wrote what the device reported — the link held it in memory
  // and dropped it on exit — so the numbers on disk are the nameplate defaults
  // regardless of what the encoder is actually set to, and the reference rig
  // proves it: 33,554,432 stored against a device reporting 300,000. Clearing
  // them is not data loss; it is discarding a guess so the first read can put
  // the real value there.
  out.encoderMeta = Number(fromVersion) >= 3
    ? Object.assign({}, base.encoderMeta, c.encoderMeta)
    : Object.assign({}, base.encoderMeta);
  out.reconnect = Object.assign({}, base.reconnect, c.reconnect);
  delete out.mapping;
  out.destinations = migrateDestinations(c, fromVersion);
  // `d3` is kept as a mirror of the first destination — read-only by
  // convention. Several screens legitimately mean "the primary destination"
  // (the mapping helper computes one axis), and this saves them reaching into
  // the array. Never write through it: writes go to `destinations`.
  // Schema 5: the profile carries known keys only, at every depth that has a
  // reference shape. Unknown keys used to ride `Object.assign` forever —
  // `logRaw` twice in the live profile, `notes` no screen ever showed,
  // `parser.outputType`, settings removed years ago — and this runs on every
  // load, not once: a key this build does not know is a key the profile does
  // not keep, so dead keys cannot accrete again.
  pickKnown(out, base);
  pickKnown(out.encoder, Object.assign({ pendingHost: null }, base.encoder));
  pickKnown(out.parser, base.parser);
  const destShape = defaultDestination();
  for (const d of out.destinations) pickKnown(d, destShape);

  // The mirror is derived, not stored knowledge — built after the whitelist,
  // which rightly has no entry for it.
  out.d3 = Object.assign({}, out.destinations[0]);
  return out;
}

/**
 * Schema 1 stored a single `d3` object; schema 2 stores `destinations[]`.
 * A v1 profile is upgraded by promoting `d3` to the first destination, so a
 * profile written by the previous build keeps working untouched.
 */
/**
 * @param {object} c
 * @param {number} fromVersion  schema the profile was written by.
 */
function migrateDestinations(c, fromVersion) {
  const list = Array.isArray(c.destinations) && c.destinations.length
    ? c.destinations
    : [c.d3 || {}];
  // Schema 3 -> 4: the mapping was one per connection, so every receiver after
  // the first was described by the first one's device ID and port. Each takes a
  // copy of it — identical to what the screen used to show, and separable from
  // now on.
  const inherited = Number(fromVersion) < 4 && c.mapping ? c.mapping : null;
  return list.map((d) => defaultDestination(
    inherited && !d.mapping ? Object.assign({}, d, { mapping: defaultMapping(inherited) }) : d));
}

module.exports = {
  ConfigStore,
  defaultConnection,
  defaultSettings,
  migrateConnection,
  SCHEMA_VERSION
};
