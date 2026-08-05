'use strict';
/**
 * What the log says, and who it says said it.
 *
 * Two defects this pins down, both of which made the log quietly untrue rather
 * than visibly broken:
 *
 * 1. `rx` and `tx` were used for anything encoder-related, so the app's own
 *    conclusions were logged as though the device had said them — and worse,
 *    logged *instead of* the reply they were derived from.
 * 2. The per-tick forwarding cap was 25, sized for a raw-sample firehose that
 *    is never logged. A config read of two encoders is ~56 lines inside one
 *    tick, so a third of them vanished with only a note beside the toolbar to
 *    show for it, and nothing at all in the exported log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Logger } = require('../src/core/logger');
const { LinkManager } = require('../src/core/link-manager');
const { LOG_SOURCES } = require('../src/shared/constants');

/** Lines the manager actually forwarded to clients. */
function collect(manager) {
  const seen = [];
  manager.on('log', (batch) => seen.push(...batch.lines));
  return seen;
}

test('a full config read of two encoders reaches the log intact', () => {
  // 14 variables each, sent and answered, inside a few milliseconds. This is
  // the ordinary case that used to lose a third of itself.
  const logger = new Logger();
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  for (let i = 0; i < 14; i++) {
    for (const id of ['a', 'b']) {
      logger.push({ id, dir: 'tx', text: `read Var${i}` });
      logger.push({ id, dir: 'rx', text: `Var${i}=${i}` });
    }
  }
  manager._tick();

  assert.equal(forwarded.length, 56, 'every line of the sweep must be forwarded');
  assert.equal(forwarded.filter((l) => l.dir === 'tx').length, 28);
  assert.equal(forwarded.filter((l) => l.dir === 'rx').length, 28);
});

test('lines that cannot be forwarded are reported in the log itself', () => {
  // Not beside the Export button, where a reader of the log will not look, and
  // where the exported log carried no trace of the gap at all.
  const logger = new Logger({ maxPerFlush: 5 });
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  for (let i = 0; i < 12; i++) logger.push({ id: 'a', dir: 'rx', text: `line ${i}` });
  manager._tick();
  assert.equal(forwarded.length, 5, 'the cap still applies');

  // The notice lands on the following tick, so it cannot enlarge the batch
  // that just overflowed.
  forwarded.length = 0;
  manager._tick();

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].dir, 'app', 'the app is saying this, not the encoder');
  assert.equal(forwarded[0].level, 'warn');
  assert.match(forwarded[0].text, /7 lines arrived faster/);

  // And it does not talk about itself for ever.
  forwarded.length = 0;
  manager._tick();
  assert.deepEqual(forwarded, []);
});

test('nothing is lost from the record, only from the live view', () => {
  // Export reads the ring buffer, which is why the notice can promise it.
  const logger = new Logger({ maxPerFlush: 5 });
  for (let i = 0; i < 12; i++) logger.push({ id: 'a', dir: 'rx', text: `line ${i}` });

  const kept = logger.tail({ limit: 100 });
  assert.equal(kept.length, 12, 'every line stays in the buffer Export reads');
  assert.equal(kept[11].text, 'line 11');
});

test('a link state change is the app talking, not the encoder', (t) => {
  const logger = new Logger();
  const manager = new LinkManager({ logger });
  const forwarded = collect(manager);

  manager.upsert({
    id: 'a', name: 'test',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ host: '127.0.0.1', port: 65535, devid: 1 }],
    reconnect: { enabled: false }
  });
  // A real state change: starting takes it to CONNECTING. (Stopping a link that
  // was never started deliberately emits nothing — see the stop() guard.)
  manager.start('a');
  manager._tick();
  t.after(() => manager.stop('a'));

  const states = forwarded.filter((l) => /^\[/.test(l.text));
  assert.ok(states.length > 0, 'expected at least one state line');
  for (const l of states) {
    assert.equal(l.dir, 'app', `"${l.text}" must be marked as the app, not rx/tx`);
  }
});

test('every source a log line can carry is a known one', () => {
  // The UI colours and filters by these; a fifth invented in passing would be
  // unstyled and unfilterable, which is how `null` behaved before.
  assert.deepEqual(LOG_SOURCES, ['rx', 'tx', 'app', 'user']);
});

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

const { createApi } = require('../src/server/api');
const { ConfigStore } = require('../src/core/config-store');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

/** A real store and manager, so these exercise the paths the UI actually calls. */
function apiWith() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-log-'));
  const store = new ConfigStore(dir);
  store.load();
  const logger = new Logger();
  const manager = new LinkManager({ logger });
  const api = createApi({ manager, store, syncLink: () => {}, env: () => ({}) });
  return { api, store, logger, manager };
}

/**
 * An address that cannot be an encoder, and answers instantly.
 *
 * Every fixture here reaches the API, and the API reaches `writeOffline`, which
 * opens a real socket. A fixture that omits the address gets
 * `defaultConnection()`'s `10.10.10.10` — **a live encoder on this rig** — and
 * a test asserting that an in-range Preset passes validation duly wrote Preset
 * to it and moved its zero point.
 *
 * Loopback with a closed port rather than an unroutable one: ECONNREFUSED comes
 * back at once, where TEST-NET-1 would sit on the connect timeout instead.
 */
const TEST_ENCODER = { host: '127.0.0.1', port: 65534 };

/** Lines the operator caused, newest last. */
const userLines = (logger) => logger.tail({ limit: 200 }).filter((l) => l.dir === 'user');

test('starting and stopping a connection is always logged', () => {
  // Both are reachable from the Controls popup, which is the surface an
  // operator uses mid-show. An action that changes whether data is flowing has
  // to be in the record — "who stopped encoder 2" is a real question.
  const { api, store, logger, manager } = apiWith();
  const conn = store.upsertConnection({
    name: 'Revolve', encoder: { host: '127.0.0.1', port: 65000 },
    destinations: [{ host: '127.0.0.1', port: 65001, devid: 1 }]
  });
  manager.upsert(conn); // what syncLink does when a connection is started

  api.linkStop({ id: conn.id });
  const stopped = userLines(logger).at(-1);
  assert.equal(stopped.text, 'stop');
  assert.equal(stopped.name, 'Revolve', 'the line must name the connection');
});

test('a stop that cannot happen is not written down as though it did', () => {
  // The line used to be logged before the attempt, so a connection the manager
  // has never heard of produced a "stop" in the record and then an error to the
  // caller. Same rule as everywhere else here: only what actually happened.
  const { api, store, logger } = apiWith();
  const conn = store.upsertConnection({ name: 'Never started', encoder: TEST_ENCODER });

  assert.throws(() => api.linkStop({ id: conn.id }), /No such connection/);
  assert.deepEqual(userLines(logger), [], 'nothing happened, so nothing is logged');
});

test('deleting a connection is logged, and keeps its name', () => {
  // The connection is out of the store by the time the line is written, so the
  // name has to be carried explicitly -- and this is the one line whose name
  // matters most, being the last that connection will ever have.
  const { api, store, logger } = apiWith();
  const conn = store.upsertConnection({
    name: 'Trap Lift', encoder: { host: '10.10.10.99', port: 6000 },
    destinations: [{ host: '127.0.0.1', port: 6000, devid: 9 }]
  });

  api.configDeleteConnection({ id: conn.id });

  const line = userLines(logger).at(-1);
  assert.equal(line.name, 'Trap Lift', 'a deleted connection is still named on its own last line');
  assert.equal(line.level, 'warn', 'deleting is not routine');
  assert.match(line.text, /deleted — was encoder 10\.10\.10\.99:6000/);
  assert.match(line.text, /127\.0\.0\.1:6000 id 9/, 'where it was sending is part of what was lost');
  assert.equal(store.find(conn.id), null, 'and it really is gone');
});

test('an edit records both values', () => {
  const { api, store, logger } = apiWith();
  const conn = store.upsertConnection({
    name: 'Revolve', encoder: TEST_ENCODER,
    destinations: [{ host: '127.0.0.1', port: 6000, devid: 1 }]
  });

  api.configSaveConnection(Object.assign(JSON.parse(JSON.stringify(conn)), {
    velocityPolicy: 'passthrough'
  }));

  const line = userLines(logger).at(-1);
  assert.match(line.text, /velocityPolicy zero → passthrough/,
    'before and after, because "what was it before" is the question asked afterwards');
});

test('stopping what is already stopped does nothing and says nothing', () => {
  // Reported from the rig: Encoder 2 had never been started, yet Stop All
  // produced "[idle] stopped" for it — and "stop all (2 connections)" counted
  // what existed rather than what was running, so the same line appeared with
  // nothing to stop.
  const { api, store, logger, manager } = apiWith();
  const a = store.upsertConnection({ name: 'Revolve', encoder: TEST_ENCODER });
  const b = store.upsertConnection({ name: 'Encoder 2', encoder: TEST_ENCODER });
  manager.upsert(a);
  manager.upsert(b);

  const stateLines = () => logger.tail({ limit: 200 }).filter((l) => /^\[/.test(l.text));
  assert.equal(stateLines().length, 0, 'nothing has been started, so nothing has changed state');

  api.linkStopAll();

  assert.equal(stateLines().length, 0,
    'a link that was never started has not stopped, and must not say it has');
  assert.match(userLines(logger).at(-1).text, /nothing was running/,
    'the count must describe what happened, not how many connections exist');
});

test('log lines are delivered when nothing is running', () => {
  // The drain lived on the telemetry timer, which stopped whenever no link was
  // running — so stopping a connection, editing one, deleting one or a failed
  // read produced lines that were written and never sent. They arrived only
  // after a page reload, which re-reads the ring buffer directly. That is
  // exactly when the log is being read to find out what happened.
  const { api, store, logger, manager } = apiWith();
  const conn = store.upsertConnection({ name: 'Revolve', encoder: TEST_ENCODER });
  manager.upsert(conn);

  const delivered = [];
  manager.on('log', (batch) => delivered.push(...batch.lines));

  assert.equal(manager.runningCount, 0, 'nothing is running');
  api.configSaveConnection(Object.assign(JSON.parse(JSON.stringify(conn)), { name: 'Renamed' }));

  // The timer has to have been woken by the line itself.
  manager._tick();
  assert.ok(delivered.some((l) => /name Revolve → Renamed/.test(l.text)),
    'an edit with nothing running must still reach the log window');
});

test('an idle rig does not hold a timer open for nothing', () => {
  // The other half: waking on demand must not mean running for ever.
  const { manager, logger } = apiWith();
  assert.equal(manager._timer, null, 'idle at rest');

  logger.push({ text: 'something happened' });
  assert.ok(manager._timer, 'a line wakes the drain');

  manager._tick();
  assert.equal(manager._timer, null, 'and it goes back to sleep once delivered');
});

test('pause freezes the window at a point, and keeps recording past it', () => {
  // The view is a browser module, so this reads its source. Two defects, found
  // in that order:
  //
  //   1. `ingestLog` returned early while paused, so lines arriving during a
  //      pause were discarded and Resume showed nothing that had happened.
  //   2. Pause was then a boolean the live loop consulted — but the view
  //      re-renders for reasons of its own (a link changing state re-renders
  //      the screen) and every rebuild ends in a repaint, so new lines appeared
  //      anyway the moment another client did something.
  //
  // The fix for the second is that pause is a point in the stream: `visible()`
  // decides what is shown, so it holds however the repaint was reached.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'log.js'), 'utf8');

  const ingest = src.slice(src.indexOf('export function ingestLog'));
  assert.doesNotMatch(ingest.slice(0, ingest.indexOf('\n}')), /\bpaused/i,
    'ingestLog must keep recording while the window is paused');

  const visible = src.slice(src.indexOf('function visible()'));
  assert.match(visible.slice(0, visible.indexOf('\n  }')), /pausedAtSeq === null \|\| l\.seq <= pausedAtSeq/,
    'what is shown must be bounded by the freeze point, not by who called repaint');

  // A sequence number, not an index: the buffer is trimmed from the front.
  assert.match(src, /pausedAtSeq = isPaused\(\) \? null : \(buffer\.length \? buffer\[buffer\.length - 1\]\.seq : 0\)/,
    'the freeze point is the newest line held at the moment Pause was pressed');
});

test('throughput is averaged over a second and shown as a whole number', () => {
  // Two settings that have to agree: a one-second window is steady enough to
  // read without rounding to tens, and rounding to tens hid the difference
  // between a link at 96 and one at 104 while making 98 read as 100.
  const lm = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'link-manager.js'), 'utf8');
  assert.match(lm, /const RATE_WINDOW_MS = 1000;/, 'the average covers one second');

  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'ui.js'), 'utf8');
  const fn = ui.slice(ui.indexOf('export function hz'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.doesNotMatch(body, /\/ 10\) \* 10/, 'the rate is not rounded to the nearest ten');
  assert.match(body, /Math\.round\(n\)/);
  // A trickle is not nothing: those call for opposite responses.
  assert.match(body, /'<1'/);
});

test('a link delivering a known rate reports it', () => {
  // This is the check that was missing. Shortening the averaging window to one
  // second broke the rate outright — the guard against too little history was
  // a fixed `span >= 1`, which the window itself then capped, so a link at 100
  // packets a second read 0 Hz. Nothing failed, because nothing measured the
  // number the readout exists to show.
  const { manager } = apiWith();
  manager.upsert({
    id: 'r', name: 'Rate',
    encoder: { host: '127.0.0.1', port: 65534 },
    destinations: [{ host: '127.0.0.1', port: 65535, devid: 1 }]
  });
  const link = manager.get('r');

  // Stand in for the socket: a link that reports counters and calls itself
  // running, without needing an encoder.
  let rx = 0;
  Object.defineProperty(link, 'running', { get: () => true });
  link.telemetry = () => ({ id: 'r', rxTotal: rx, txTotal: rx, destinations: [] });

  const rates = [];
  manager.on('telemetry', (p) => rates.push(p.links[0]));

  // Two seconds at 100/s, ticking at the real telemetry rate of ~33 ms.
  //
  // The cadence matters: at exactly 100 ms the span lands on 1000 ms and the
  // old fixed `span >= 1` guard happened to pass. At 33 ms it lands just under,
  // which is why the readout showed 0 Hz on the rig while a test with a tidier
  // clock saw nothing wrong.
  let clock = Date.now();
  let exact = 0;
  const realNow = Date.now;
  try {
    Date.now = () => clock;
    for (let i = 0; i < 60; i++) {
      manager._tick();
      clock += 33;
      exact += 100 * 0.033;
      rx = Math.round(exact);
    }
  } finally {
    Date.now = realNow;
  }

  const last = rates[rates.length - 1];
  assert.ok(last, 'telemetry was emitted');
  assert.ok(Math.abs(last.rxHz - 100) < 5,
    `expected about 100 Hz, got ${last.rxHz}`);
});

test('a rate readout holds still without lying', () => {
  // The one-second average is steady; painting it thirty times a second was
  // not. Each repaint slides the window by a sample, so with integer counters
  // a whole-number readout flickered 98 / 99 / 100 continuously.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'ui.js'), 'utf8');
  const fn = ui.slice(ui.indexOf('export function steady'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // Both gates, and both on the display only.
  assert.match(body, /everyMs = 500/, 'the shown figure changes at most twice a second');
  assert.match(body, /deadband = 2/, 'and only when the real value has moved enough to matter');
  // Stopping is the one change nobody should wait for.
  assert.match(body, /value === 0 \|\| shown === 0/);

  // Every rate readout uses it: a steadied dashboard beside a twitching footer
  // would just look broken.
  for (const [file, count] of [
    ['views/dashboard.js', 4], ['views/connections.js', 2], ['app.js', 3]
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', file), 'utf8');
    assert.ok((src.match(/steady/g) || []).length >= count,
      `${file} must run its rate through steady()`);
  }
});

test('a position value is bounded by what the device reports, not the family ceiling', async () => {
  // Preset and Offset live inside TotalScaledRes, which is programmable. The
  // static table can only carry the family ceiling of 1,073,741,824; the
  // encoders here are scaled to 300,000 and 100,000. Without this the caption
  // under the field stated the real bound while the server accepted anything
  // under the family limit -- and the value reaches flash before the encoder
  // gets to object, which is a spent cycle either way.
  const { api, store } = apiWith();
  // TEST_ENCODER, never the default: the default encoder address is a live
  // device on the reference rig, and writeOffline will happily open a socket to
  // it. A fixture that omits the address wrote Preset to real hardware.
  const conn = store.upsertConnection({
    name: 'Revolve', encoder: TEST_ENCODER,
    encoderMeta: { countsPerRev: 8192, totalCounts: 300000, cycleTimeMs: 10 }
  });

  await assert.rejects(
    () => api.encoderWriteMany({ id: conn.id, entries: [{ variable: 'Preset', value: '500000' }] }),
    /Preset must be 0 – 299,999 on this encoder/);

  // The bound is the device's, so a value inside it passes this check and
  // fails later for want of a link -- not for being out of range.
  await assert.rejects(
    () => api.encoderWriteMany({ id: conn.id, entries: [{ variable: 'Preset', value: '299999' }] }),
    (err) => !/must be 0 –/.test(err.message));

  // Unknown scaling is not a licence to guess a bound: before the encoder has
  // been read, the static range is all there is.
  const fresh = store.upsertConnection({ name: 'Unread', encoder: TEST_ENCODER });
  assert.equal(fresh.encoderMeta.totalCounts, null);
  await assert.rejects(
    () => api.encoderWriteMany({ id: fresh.id, entries: [{ variable: 'Preset', value: '500000' }] }),
    (err) => !/must be 0 –/.test(err.message),
    'unknown scaling is not a licence to invent a bound');
});
