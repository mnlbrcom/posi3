'use strict';
/**
 * The bridge's operation surface — transport-free.
 *
 * Every operation the UI can perform lives here as a plain async function. It
 * knows nothing about HTTP, Electron IPC, or who is calling. That is the point:
 * the desktop window and a browser on the show LAN reach the same code, so
 * policy that must be shared (above all the encoder's finite flash-write
 * budget) cannot drift between transports.
 *
 * Errors carry a `code` and are reported as `{ ok: false, error }` by whichever
 * transport is in front.
 */

const constants = require('../shared/constants');
const { computeMapping, d3Fields, suggestedPreset } = require('../shared/mapping');
const {
  fail, checkId, checkHost, checkPort, checkVariable, checkValue, checkVarWrite,
  sanitiseConnection, listInterfaces
} = require('./validate');
const {
  scanSubnet, scannableInterfaces, readVariablesOnce, writeVariablesOnce
} = require('../core/discover');
const flashBudget = require('../core/flash-budget');

/**
 * @param {object} ctx
 * @param {import('../core/link-manager').LinkManager} ctx.manager
 * @param {import('../core/config-store').ConfigStore} ctx.store
 * @param {(conn: object) => void} ctx.syncLink   push config changes into the manager
 * @param {() => object} ctx.env                  host facts (version, paths, …)
 * @param {(settings: object) => void} [ctx.onSettings]  side effects the host owns
 */
function createApi(ctx) {
  const { manager, store } = ctx;
  const changed = ctx.onConfigChanged || (() => {});

  /** Announce a config mutation, then hand the value back to the caller. */
  const announce = (value) => {
    changed();
    return value;
  };

  /**
   * Read from an encoder that is not connected, over a socket of its own.
   *
   * Throws `EUNREACHABLE` when the device does not answer at all — which is the
   * case worth telling the operator about by name, since it means the encoder
   * has gone from the network rather than merely being stopped here.
   */
  /** Everything a one-shot session says goes in the log, tagged like any other. */
  const offlineLogger = (id) => (level, dir, text) =>
    manager.logger.push({ id, level, dir, text, ts: Date.now() });

  const readOffline = async (id, names) => {
    const conn = store.find(checkId(id));
    if (!conn) fail('ENOENT', 'No such connection');
    try {
      return await readVariablesOnce(conn.encoder.host, names, {
        port: conn.encoder.port,
        localAddress: conn.encoder.localAddress || null,
        onLog: offlineLogger(conn.id)
      });
    } catch (err) {
      const e = new Error(`${conn.name} is unreachable at ${conn.encoder.host}:${conn.encoder.port}`);
      e.code = 'EUNREACHABLE';
      e.cause = err;
      throw e;
    }
  };

  /**
   * Write to a stopped connection over a socket of its own.
   *
   * Held open until the flash commit arrives, because the encoder acknowledges
   * a `set` at once and only commits seconds later — closing on the
   * acknowledgement would report "status unknown" for a write that worked.
   */
  const writeOffline = async (id, checked) => {
    const conn = store.find(checkId(id));
    if (!conn) fail('ENOENT', 'No such connection');
    flashBudget.claim(conn.id);
    try {
      const { results } = await writeVariablesOnce(conn.encoder.host, checked, {
        port: conn.encoder.port,
        localAddress: conn.encoder.localAddress || null,
        onLog: offlineLogger(conn.id)
      });
      return results;
    } catch (err) {
      const e = new Error(`${conn.name} is unreachable at ${conn.encoder.host}:${conn.encoder.port}`);
      e.code = 'EUNREACHABLE';
      throw e;
    }
  };

  /**
   * Follow the encoder to its new address once it has accepted one.
   *
   * The device keeps answering on its current address until it is power-cycled,
   * so the live session is untouched and the link is deliberately *not*
   * reconfigured — restarting it here would send it at an address that is not
   * live yet. Only the saved connection moves, so the next start finds it.
   */
  const adoptNewAddress = async (id, results) => {
    const written = results.find((r) => r.ok && r.variable === 'IP');
    if (!written) return;
    const conn = store.find(checkId(id));
    if (!conn || conn.encoder.host === written.value) return;

    const from = conn.encoder.host;
    const updated = JSON.parse(JSON.stringify(conn));
    updated.encoder.host = written.value;
    store.upsertConnection(updated);
    manager.logger.push({
      id: conn.id, level: 'warn', dir: null, ts: Date.now(),
      text: `saved address changed ${from} -> ${written.value}. The encoder keeps answering on ` +
        `${from} until it is power-cycled.`
    });
    changed();
  };

  const requireLink = (id) => {
    const link = manager.get(checkId(id));
    if (!link) fail('ENOENT', 'No such connection');
    if (!link.running) fail('ENOTCONNECTED', 'Connection is not running — start it first');
    return link;
  };

  return {
    // -- app ----------------------------------------------------------------

    appInfo: () => Object.assign({
      loadWarning: store.loadWarning,
      readOnly: store.readOnly,
      interfaces: listInterfaces(),
      // The UI renders reference data it cannot require directly.
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
    }, ctx.env()),

    /**
     * Re-enumerated on demand, not cached at startup: a USB-Ethernet adapter
     * plugged in at a venue used to need an app restart before it appeared.
     */
    interfaces: () => listInterfaces(),

    /** Interfaces this machine could scan from, with the ones too wide marked. */
    discoverInterfaces: () => scannableInterfaces(),

    /**
     * Look for encoders on the subnet of one of this machine's interfaces.
     *
     * `localAddress` selects a NIC — it is not a target. The subnet comes from
     * that NIC's own netmask, so this cannot be pointed at someone else's
     * network: a route that took a range from the caller would be a port
     * scanner with an HTTP front end.
     */
    discoverEncoders: async ({ localAddress, port }) => {
      const nic = checkHost(localAddress, 'Interface address');
      return scanSubnet({
        localAddress: nic,
        port: port === undefined || port === null ? undefined : checkPort(port, 'Encoder port')
      });
    },

    // -- mapping helper -----------------------------------------------------

    mappingCompute: ({ id, mapping }) => {
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
    },

    // -- config -------------------------------------------------------------

    configGet: () => store.profile,

    configSaveConnection: (payload) => {
      const saved = store.upsertConnection(sanitiseConnection(payload));
      ctx.syncLink(saved);
      return announce(saved);
    },

    configDeleteConnection: ({ id }) => {
      const key = checkId(id);
      manager.remove(key);
      return announce(store.deleteConnection(key));
    },

    configReorder: ({ ids }) => {
      if (!Array.isArray(ids)) fail('EINVAL', 'Expected an array of ids');
      store.reorder(ids.map(checkId));
      return announce(store.profile.connections.map((c) => c.id));
    },

    configSetSettings: (partial) => {
      const s = store.setSettings(partial || {});
      manager.setTelemetryHz(s.telemetryHz);
      if (ctx.onSettings) ctx.onSettings(s);
      return announce(s);
    },

    /**
     * Returns the profile for the caller to serialise. The old build opened a
     * native save dialog here, which would have put the file picker on the
     * server rather than on the operator's machine.
     */
    configExport: () => store.profile,

    configImport: (data) => {
      if (!data || !Array.isArray(data.connections)) fail('EINVAL', 'That file is not a posi3 profile');
      manager.stopAll();
      for (const id of manager.ids()) manager.remove(id);
      const profile = store.replaceProfile(data);
      for (const conn of profile.connections) ctx.syncLink(conn);
      return announce({ imported: true, profile });
    },

    // -- links --------------------------------------------------------------

    linkStart: ({ id }) => {
      const key = checkId(id);
      if (!manager.has(key)) {
        const conn = store.find(key);
        if (!conn) fail('ENOENT', 'No such connection');
        ctx.syncLink(conn);
      }
      return manager.start(key).snapshot();
    },

    linkStop: ({ id }) => manager.stop(checkId(id)).snapshot(),

    linkStartAll: () => {
      for (const conn of store.connections) ctx.syncLink(conn);
      manager.startAll();
      return manager.ids();
    },

    linkStopAll: () => {
      manager.stopAll();
      return manager.ids();
    },

    linkSnapshot: ({ id }) => {
      const link = manager.get(checkId(id));
      return link ? link.snapshot() : null;
    },

    // -- encoder command channel --------------------------------------------

    encoderRead: async ({ id, variable }) => {
      const name = checkVariable(variable);
      const link = manager.get(checkId(id));
      if (link && link.running) return link.read(name);
      const r = await readOffline(id, [name]);
      if (!r[name].ok) fail('EENCODER', r[name].error);
      return { variable: name, value: r[name].value };
    },

    encoderReadMany: async ({ id, variables }) => {
      if (!Array.isArray(variables)) fail('EINVAL', 'Expected an array of variables');
      const link = manager.get(checkId(id));
      // A stopped connection has no socket to ask down, so one is opened just
      // for this and closed again. Reading is the one thing worth doing to an
      // encoder that is not streaming: it is how you find out what it is set to
      // before committing to it.
      if (!link || !link.running) return readOffline(id, variables.map(checkVariable));

      const out = {};
      // Sequential on purpose: one socket, one outstanding request.
      for (const raw of variables) {
        const name = checkVariable(raw);
        try {
          out[name] = { ok: true, value: (await link.read(name)).value };
        } catch (err) {
          out[name] = { ok: false, error: err.message };
        }
      }
      return out;
    },

    /** Last seen value of every variable, including changes made by other clients. */
    encoderCached: ({ id }) => {
      const link = manager.get(checkId(id));
      if (!link) fail('ENOENT', 'No such connection');
      return { vars: link.cachedVars(), flashPending: link.flashPending };
    },

    encoderWrite: ({ id, variable, value }) => {
      const w = checkVarWrite(variable, value);
      return requireLink(id).write(w.variable, w.value);
    },

    encoderWriteMany: async ({ id, entries }) => {
      if (!Array.isArray(entries) || !entries.length) fail('EINVAL', 'Nothing to write');
      const checked = entries.map((e) => checkVarWrite(e.variable, e.value));
      const link = manager.get(checkId(id));

      // Rate limiting is shared between both paths, so the device's ~100,000
      // write cycles are counted once however they are spent.
      const results = (link && link.running)
        ? await link.writeMany(checked)
        : await writeOffline(id, checked);

      await adoptNewAddress(id, results);
      return results;
    },

    encoderPreset: ({ id, value, force }) => {
      const link = requireLink(id);
      const w = checkVarWrite('Preset', value === undefined || value === null ? 0 : value);
      return link.setPreset(Number(w.value), { force: !!force });
    },

    encoderRun: ({ id }) => requireLink(id).run(),

    // -- log ----------------------------------------------------------------

    logTail: (opts) => manager.logger.tail(opts || {}),

    logExport: () => manager.logger.tail({ limit: 100000 })
      .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.id || '-'} ${l.dir || ''} ${l.text}`)
      .join('\n')
  };
}

module.exports = { createApi };
