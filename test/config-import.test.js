'use strict';
/**
 * Importing a profile.
 *
 * The import route is the one config path that arrives from a file rather
 * than from a validated form, and it used to go straight into the store:
 * no field validation, no destination cap, prototype keys merged through
 * `Object.assign`'s [[Set]], and every conclusion about the *old* profile's
 * destinations left standing. Re-importing an exported profile — same ids —
 * meant no destination ever established disguise state again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LinkManager } = require('../src/core/link-manager');
const { ConfigStore } = require('../src/core/config-store');
const { createApi } = require('../src/server/api');

function apiWith() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-import-'));
  const store = new ConfigStore(dir);
  store.load();
  const manager = new LinkManager({});
  const api = createApi({
    manager, store,
    syncLink: (conn) => manager.upsert(conn),
    onConfigChanged: () => {}, onSettings: () => {}, env: () => ({})
  });
  return { api, store, manager };
}

const CONN = {
  id: 'c1', name: 'Revolve',
  encoder: { host: '127.0.0.1', port: 65534 },
  destinations: [{ id: 'd1', host: '127.0.0.1', port: 65533, devid: 1 }]
};

test('an invalid profile is refused whole, before anything is replaced', () => {
  const { api, store } = apiWith();
  api.configSaveConnection(CONN);
  const before = store.connections.length;

  assert.throws(() => api.configImport({
    version: 4,
    connections: [{ name: 'bad', encoder: { host: 'not an address!', port: 70000 } }]
  }), /address|port/i);
  assert.equal(store.connections.length, before,
    'the store still holds what it held — refusal must precede replacement');
});

test('a profile from a newer build is refused, not half-adopted', () => {
  const { api } = apiWith();
  assert.throws(() => api.configImport({ version: 99, connections: [] }), /newer/i);
});

test('prototype keys are stripped at every depth', () => {
  const { api, store } = apiWith();
  const hostile = JSON.parse(
    '{"version": 4, "connections": [' + JSON.stringify(CONN).slice(0, -1) +
    ', "encoder2": {"__proto__": {"pendingHost": "192.0.2.9"}}}]}');
  api.configImport(hostile);
  const c = store.connections[0];
  assert.equal(c.encoder.pendingHost, undefined,
    'nothing may be readable from the config that JSON.stringify cannot see');
  assert.equal(Object.getPrototypeOf(c.encoder2 || {}), Object.prototype,
    'no imported object may carry a rewritten prototype');
});

test('an import forgets every conclusion about the old destinations', () => {
  const { api, manager } = apiWith();
  api.configSaveConnection(CONN);
  // A verdict and a health history for the destination the import replaces.
  manager.disguiseChecks.set('d1', { matches: true, at: 1 });
  manager._lastDestHealth.set('d1', 'connected');

  api.configImport({ version: 4, connections: [CONN] });
  assert.equal(manager.disguiseChecks.has('d1'), false,
    'same id, new profile: the old verdict must not be inherited');
  assert.equal(manager._lastDestHealth.has('d1'), false);
});

test('deleting a connection forgets its destinations too', () => {
  const { api, manager } = apiWith();
  api.configSaveConnection(CONN);
  manager.disguiseChecks.set('d1', { matches: false, at: 1 });

  api.configDeleteConnection({ id: 'c1' });
  assert.equal(manager.disguiseChecks.has('d1'), false,
    'a deleted destination leaves nothing concluded behind');
});
