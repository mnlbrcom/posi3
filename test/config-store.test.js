'use strict';
/**
 * Profile persistence.
 *
 * This file holds the encoder addresses, the disguise destinations and the axis
 * mappings for a show. Losing it at 6pm on a get-in day is a real failure mode,
 * so the write path is atomic with a rotated backup and a quarantine for
 * unreadable files — and none of that had a test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore, SCHEMA_VERSION } = require('../src/core/config-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-cfg-'));
}

function loaded(dir) {
  const s = new ConfigStore(dir);
  s.load();
  return s;
}

test('a fresh directory yields usable defaults', () => {
  const s = loaded(tmpDir());
  assert.equal(s.profile.version, SCHEMA_VERSION);
  assert.deepEqual(s.profile.connections, []);
  assert.equal(s.settings.webPort, 8710);
  assert.equal(s.settings.webBindHost, '127.0.0.1');
  assert.equal(s.readOnly, false);
});

test('a new connection claims nothing about a device it has not spoken to', () => {
  // Three states, and only three: unknown until the encoder answers, what the
  // encoder actually said, and what has been programmed but is not in effect
  // yet. A fourth — a plausible-looking figure nobody measured — is what made
  // every first read report itself as a change, put a 33,554,431 travel span on
  // an encoder with 300,000 steps, and claimed ASCII_SHORT on devices that were
  // never asked.
  const s = loaded(tmpDir());
  const c = s.upsertConnection({ name: 'Fresh' });

  for (const key of ['countsPerRev', 'totalCounts', 'cycleTimeMs']) {
    assert.equal(c.encoderMeta[key], null, `encoderMeta.${key} must start unknown`);
  }
  assert.equal(c.parser.outputType, null, 'the output format is the device\'s to state');
  assert.equal(c.parser.fields, null, 'the field layout is read, never assumed');
  assert.equal(c.destinations[0].mapping.maxInput, 0, 'no span has been captured yet');

  // And nothing is pretending to be a future value either.
  assert.equal(c.encoder.pendingHost, undefined,
    'pendingHost exists only once an address has actually been programmed');
});

test('a saved profile round-trips', () => {
  const dir = tmpDir();
  const a = loaded(dir);
  a.upsertConnection({
    name: 'Revolve',
    encoder: { host: '10.10.10.20', port: 6000 },
    destinations: [{ host: '10.10.10.47', port: 6000, devid: 3 }]
  });
  a.flushNow();

  const b = loaded(dir);
  assert.equal(b.profile.connections.length, 1);
  assert.equal(b.profile.connections[0].name, 'Revolve');
  assert.equal(b.profile.connections[0].destinations[0].devid, 3);
});

test('a schema-1 profile on disk is upgraded on load', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    version: 1,
    settings: { telemetryHz: 30 },
    connections: [{
      id: 'old', name: 'Legacy',
      encoder: { host: '10.10.10.10', port: 6000 },
      d3: { host: '10.10.10.47', port: 6000, devid: 7 }
    }]
  }));

  const s = loaded(dir);
  assert.equal(s.profile.version, SCHEMA_VERSION);
  const c = s.profile.connections[0];
  assert.equal(c.destinations.length, 1, 'the lone d3 becomes the first destination');
  assert.equal(c.destinations[0].devid, 7);
  assert.equal(c.d3.devid, 7, 'the mirror stays in step');
});

test('an unreadable profile is quarantined rather than silently replaced', () => {
  // Starting a show with zero connections and no explanation would be worse
  // than refusing: the operator must be told the file was broken.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profile.json'), '{ this is not json');

  const s = loaded(dir);
  assert.ok(s.loadWarning, 'a warning must be surfaced');
  assert.match(s.loadWarning, /profile\.json/);
  assert.deepEqual(s.profile.connections, []);
});

test('a corrupt profile falls back to the backup', () => {
  const dir = tmpDir();
  const a = loaded(dir);
  a.upsertConnection({
    name: 'Important',
    encoder: { host: '10.10.10.20', port: 6000 },
    destinations: [{ host: '10.0.0.1', port: 6000, devid: 1 }]
  });
  a.flushNow();
  // A second save rotates the first into .bak.
  a.setSettings({ telemetryHz: 20 });
  a.flushNow();

  fs.writeFileSync(path.join(dir, 'profile.json'), 'garbage');
  const b = loaded(dir);
  assert.equal(b.profile.connections.length, 1, 'the backup carried the connection through');
  assert.equal(b.profile.connections[0].name, 'Important');
  assert.ok(b.loadWarning);
});

test('a profile from a newer build loads read-only', () => {
  // Saving over it would silently downgrade someone else's config.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    version: 99, settings: {}, connections: []
  }));
  const s = loaded(dir);
  assert.equal(s.readOnly, true);
  assert.match(s.loadWarning, /newer version/);
});

test('a write leaves no temporary file behind', () => {
  const dir = tmpDir();
  const s = loaded(dir);
  s.upsertConnection({
    name: 'A', encoder: { host: '10.0.0.9', port: 6000 },
    destinations: [{ host: '10.0.0.1', port: 6000, devid: 1 }]
  });
  s.flushNow();
  const stray = fs.readdirSync(dir).filter((f) => f.includes('tmp') || f.endsWith('.swp'));
  assert.deepEqual(stray, []);
});

test('deleting a connection removes it and persists', () => {
  const dir = tmpDir();
  const s = loaded(dir);
  const c = s.upsertConnection({
    name: 'A', encoder: { host: '10.0.0.9', port: 6000 },
    destinations: [{ host: '10.0.0.1', port: 6000, devid: 1 }]
  });
  s.deleteConnection(c.id);
  s.flushNow();
  assert.deepEqual(loaded(dir).profile.connections, []);
});

test('a schema-3 mapping is copied onto every receiver', () => {
  // Schema 3 -> 4. The mapping was one per connection, and the disguise screen
  // computed from `conn.d3` -- the mirror of the *first* destination -- so a
  // fan-out to a director and an understudy produced one set of numbers
  // describing the director and never mentioned the other machine.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    version: 3,
    connections: [{
      id: 'fan', name: 'Revolve',
      encoder: { host: '10.10.10.10', port: 6000 },
      destinations: [
        { id: 'a', name: 'director', host: '10.10.10.5', port: 6000, devid: 10 },
        { id: 'b', name: 'US', host: '10.10.10.2', port: 6000, devid: 11 }
      ],
      mapping: { mode: 'revolutions', revolutions: 2.5, property: 'rotation.y', maxOutput: 360 }
    }]
  }));

  const c = loaded(dir).profile.connections[0];
  assert.equal(c.mapping, undefined, 'the connection no longer holds one');
  assert.equal(c.destinations.length, 2);
  for (const d of c.destinations) {
    assert.equal(d.mapping.mode, 'revolutions', `${d.name} inherits what was configured`);
    assert.equal(d.mapping.revolutions, 2.5);
    assert.equal(d.mapping.property, 'rotation.y');
    assert.equal(d.mapping.maxOutput, 360);
  }

  // Separable from now on: changing one leaves the other alone.
  c.destinations[1].mapping.property = 'offset.x';
  assert.equal(c.destinations[0].mapping.property, 'rotation.y',
    'the copies must not share an object');
});
