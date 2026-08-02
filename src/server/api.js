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
  fail, checkId, checkVariable, checkValue, sanitiseConnection, listInterfaces
} = require('./validate');

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
      return saved;
    },

    configDeleteConnection: ({ id }) => {
      const key = checkId(id);
      manager.remove(key);
      return store.deleteConnection(key);
    },

    configDuplicateConnection: ({ id }) => {
      const copy = store.duplicateConnection(checkId(id));
      if (!copy) fail('ENOENT', 'No such connection');
      ctx.syncLink(copy);
      return copy;
    },

    configReorder: ({ ids }) => {
      if (!Array.isArray(ids)) fail('EINVAL', 'Expected an array of ids');
      store.reorder(ids.map(checkId));
      return store.profile.connections.map((c) => c.id);
    },

    configSetSettings: (partial) => {
      const s = store.setSettings(partial || {});
      manager.setTelemetryHz(s.telemetryHz);
      if (ctx.onSettings) ctx.onSettings(s);
      return s;
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
      return { imported: true, profile };
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

    encoderRead: ({ id, variable }) => requireLink(id).read(checkVariable(variable)),

    encoderReadMany: async ({ id, variables }) => {
      const link = requireLink(id);
      if (!Array.isArray(variables)) fail('EINVAL', 'Expected an array of variables');
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

    encoderWrite: ({ id, variable, value }) =>
      requireLink(id).write(checkVariable(variable), checkValue(value)),

    encoderWriteMany: ({ id, entries }) => {
      const link = requireLink(id);
      if (!Array.isArray(entries) || !entries.length) fail('EINVAL', 'Nothing to write');
      // Rate limiting and the flash-commit window live in EncoderLink, so every
      // transport shares one budget for the device's ~100,000 write cycles.
      return link.writeMany(entries.map((e) => ({
        variable: checkVariable(e.variable),
        value: checkValue(e.value)
      })));
    },

    encoderPreset: ({ id, value, force }) => {
      const link = requireLink(id);
      const v = checkValue(value === undefined || value === null ? 0 : value);
      return link.setPreset(Number(v), { force: !!force });
    },

    encoderRun: ({ id }) => requireLink(id).run(),

    encoderRaw: ({ id, line }) => requireLink(id).raw(checkValue(line)),

    // -- log ----------------------------------------------------------------

    logTail: (opts) => manager.logger.tail(opts || {}),

    logExport: () => manager.logger.tail({ limit: 100000 })
      .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.id || '-'} ${l.dir || ''} ${l.text}`)
      .join('\n')
  };
}

module.exports = { createApi };
