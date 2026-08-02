'use strict';
/**
 * The only bridge between the renderer and main.
 *
 * Named methods only — deliberately no generic `invoke(channel, payload)`, so
 * the renderer cannot reach a channel this file does not explicitly offer.
 *
 * This preload is sandboxed, which means it cannot require the shared modules.
 * That is intentional: reference constants arrive once via appInfo(), and the
 * mapping maths is evaluated in main, so there is exactly one implementation of
 * each rather than a copy that can drift.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  APP_INFO: 'd3d:app:info',
  CONFIG_GET: 'd3d:config:get',
  CONFIG_SAVE_CONNECTION: 'd3d:config:saveConnection',
  CONFIG_DELETE_CONNECTION: 'd3d:config:deleteConnection',
  CONFIG_DUPLICATE_CONNECTION: 'd3d:config:duplicateConnection',
  CONFIG_REORDER: 'd3d:config:reorder',
  CONFIG_SET_SETTINGS: 'd3d:config:setSettings',
  CONFIG_EXPORT: 'd3d:config:exportFile',
  CONFIG_IMPORT: 'd3d:config:importFile',
  LINK_START: 'd3d:link:start',
  LINK_STOP: 'd3d:link:stop',
  LINK_START_ALL: 'd3d:link:startAll',
  LINK_STOP_ALL: 'd3d:link:stopAll',
  LINK_SNAPSHOT: 'd3d:link:snapshot',
  ENC_READ: 'd3d:encoder:read',
  ENC_READ_MANY: 'd3d:encoder:readMany',
  ENC_WRITE: 'd3d:encoder:write',
  ENC_WRITE_MANY: 'd3d:encoder:writeMany',
  ENC_PRESET: 'd3d:encoder:preset',
  ENC_RUN: 'd3d:encoder:run',
  ENC_RAW: 'd3d:encoder:raw',
  LOG_TAIL: 'd3d:log:tail',
  LOG_EXPORT: 'd3d:log:export',
  MAPPING_COMPUTE: 'd3d:mapping:compute',
  TELEMETRY: 'd3d:telemetry',
  LINK_STATE: 'd3d:link:state',
  ENC_EVENT: 'd3d:encoder:event',
  LOG: 'd3d:log'
};

/**
 * Unwrap the {ok, data|error} envelope every handler returns, so callers see a
 * normal resolved value or a thrown Error.
 */
async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (res && res.ok) return res.data;
  const err = new Error((res && res.error && res.error.message) || 'Request failed');
  err.code = (res && res.error && res.error.code) || 'EFAIL';
  throw err;
}

/** Subscribe helper that hands back an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('d3d', {
  appInfo: () => call(CH.APP_INFO),

  config: {
    get: () => call(CH.CONFIG_GET),
    saveConnection: (conn) => call(CH.CONFIG_SAVE_CONNECTION, conn),
    deleteConnection: (id) => call(CH.CONFIG_DELETE_CONNECTION, { id }),
    duplicateConnection: (id) => call(CH.CONFIG_DUPLICATE_CONNECTION, { id }),
    reorder: (ids) => call(CH.CONFIG_REORDER, { ids }),
    setSettings: (partial) => call(CH.CONFIG_SET_SETTINGS, partial),
    exportFile: () => call(CH.CONFIG_EXPORT),
    importFile: () => call(CH.CONFIG_IMPORT)
  },

  link: {
    start: (id) => call(CH.LINK_START, { id }),
    stop: (id) => call(CH.LINK_STOP, { id }),
    startAll: () => call(CH.LINK_START_ALL),
    stopAll: () => call(CH.LINK_STOP_ALL),
    snapshot: (id) => call(CH.LINK_SNAPSHOT, { id })
  },

  encoder: {
    read: (id, variable) => call(CH.ENC_READ, { id, variable }),
    readMany: (id, variables) => call(CH.ENC_READ_MANY, { id, variables }),
    write: (id, variable, value) => call(CH.ENC_WRITE, { id, variable, value }),
    writeMany: (id, entries) => call(CH.ENC_WRITE_MANY, { id, entries }),
    preset: (id, value) => call(CH.ENC_PRESET, { id, value }),
    run: (id) => call(CH.ENC_RUN, { id }),
    raw: (id, line) => call(CH.ENC_RAW, { id, line })
  },

  mapping: {
    compute: (id, mapping) => call(CH.MAPPING_COMPUTE, { id, mapping })
  },

  log: {
    tail: (opts) => call(CH.LOG_TAIL, opts),
    export: () => call(CH.LOG_EXPORT)
  },

  events: {
    onTelemetry: (fn) => on(CH.TELEMETRY, fn),
    onLinkState: (fn) => on(CH.LINK_STATE, fn),
    onEncoderEvent: (fn) => on(CH.ENC_EVENT, fn),
    onLog: (fn) => on(CH.LOG, fn)
  }
});
