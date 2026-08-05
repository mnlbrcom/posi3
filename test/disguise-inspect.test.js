'use strict';
/**
 * Asking disguise what it is listening on.
 *
 * ICMP says a machine is there and nothing is bound to the port we send to. It
 * cannot say which port *is* bound — and that is the whole answer, so it is
 * worth one question to Designer.
 *
 * These run against a stub HTTP server, never a real machine: the endpoint's own
 * documentation says it must not be polled and is not for use during a show.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { inspectReceivers, SCRIPT } = require('../src/core/disguise-api');

/** A stand-in Designer whose Python endpoint answers however the test wants. */
async function fakeDesigner(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: JSON.parse(body || '{}') });
      handler(req, res);
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => new Promise((r) => server.close(r)));
  return { host: '127.0.0.1', apiPort: port, seen };
}

/** Designer's real envelope: the script's value arrives as a JSON *string*. */
const ok = (value) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: { code: 0, message: '', details: [] },
    d3Log: 'Python script took 4.7ms\n',
    pythonLog: '',
    returnValue: JSON.stringify(value)
  }));
};

/** One receiver, as the rig reports it. */
const receiver = (over = {}) => Object.assign({
  name: 'posi3', path: 'objects/screenpositionreceiver/posi3.apx', uid: '1708',
  started: true, engaged: true, receiving: true,
  drivers: [{ type: 'NavigatorDriver', port: 8000, multicastAddress: '', ipFromFilter: '' }],
  axes: [{ type: 'ScreenPositionAxis', id: '1', property: 'offset.x' }]
}, over);

test('it asks the documented endpoint, with a script that returns a list', async (t) => {
  const d = await fakeDesigner(t, ok([]));
  await inspectReceivers(d.host, { apiPort: d.apiPort });

  assert.equal(d.seen[0].method, 'POST');
  assert.equal(d.seen[0].url, '/api/session/python/execute');
  assert.ok(d.seen[0].body.script, 'the payload key is `script`');
  assert.match(SCRIPT, /state\.devices\.devices/,
    'state.devices is a DeviceManager, not a list — measured against a live session');
  assert.match(SCRIPT, /drivers/, 'it reads the drivers inside each receiver');
  assert.match(SCRIPT, /axes/, 'and the axes, which carry the device ids');
  assert.match(SCRIPT, /^return out$/m, 'the endpoint returns what the script returns');
});

test('a returnValue that is a JSON string is still a list', async (t) => {
  // Designer hands the script's value back as a *string*. Reading it as JSON
  // directly found no list and reported an empty session on a rig that had one.
  const d = await fakeDesigner(t, ok([receiver()]));
  const found = await inspectReceivers(d.host, { apiPort: d.apiPort });
  assert.equal(found.length, 1);
  assert.equal(found[0].drivers[0].port, 8000);
  assert.equal(found[0].axes[0].id, '1');
});

test('a script error arrives as HTTP 200 and is not mistaken for an empty session', async (t) => {
  const d = await fakeDesigner(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: { code: 5000, message: "Failed to run plugin: default_plugin\nTraceback (most recent call last):\nTypeError: 'DeviceManager' object is not iterable" },
      returnValue: null
    }));
  });
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_API' && /Failed to run plugin/.test(err.message));
});

test('a machine with no Designer session is named as such', async (t) => {
  // Not "cannot reach disguise": the machine may be perfectly reachable and
  // simply not running Designer, which is a different thing to go and fix.
  await assert.rejects(
    () => inspectReceivers('127.0.0.1', { apiPort: 9, timeoutMs: 800 }),
    (err) => err.code === 'EDISGUISE_UNREACHABLE' && /Designer must be running/.test(err.message));
});

test('an error from Designer is surfaced, not swallowed', async (t) => {
  const d = await fakeDesigner(t, (req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('NameError: state is not defined');
  });
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_API' && /NameError/.test(err.message));
});

test('a session with no receiver at all is not mistaken for a list', async (t) => {
  const d = await fakeDesigner(t, ok({ logging: 'ran fine', result: undefined }));
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_API' && /no receiver list/.test(err.message));
});

test('an older Designer is named as such, not left as a bare 404', async (t) => {
  // Measured on the rig: 10.10.10.4 serves a web page on port 80 and answers
  // JSON 404 for every /api path. "404" on its own invites the reading that the
  // address is wrong, when the address is fine and the software is old.
  const d = await fakeDesigner(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
  });
  await assert.rejects(
    () => inspectReceivers(d.host, { apiPort: d.apiPort }),
    (err) => err.code === 'EDISGUISE_NO_API' &&
      /No API call possible with the disguise version/.test(err.message) &&
      /not Designer/.test(err.message));
});

test('the script only reads — posi3 never writes to a Designer session', () => {
  // A show machine's configuration belongs to whoever is running the show. The
  // Python API sets `Port` as readily as it reads it, and that is deliberately
  // not used: a bridge that quietly reconfigures the thing it feeds is a bridge
  // nobody can trust. This is the tripwire for that rule, because the script is
  // a string and nothing else would notice it changing.
  const forbidden = [
    /\bd\.\w+\s*=[^=]/,          // d.Port = 8000
    /\bsetattr\s*\(/,            // setattr(d, 'Port', 8000)
    /\bdel\s+/,                  // del …
    /\.remove\s*\(|\.add\s*\(/,  // mutating the session's collections
    /\bcreate\w*\s*\(/i,         // resource creation
    /\bloadOrCreate\b/
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(SCRIPT, pattern,
      `the disguise script must not mutate anything — matched ${pattern}`);
  }
  // And the only assignment it does make is to its own local accumulator.
  const assignments = (SCRIPT.match(/^\s*([A-Za-z_][\w.]*)\s*=[^=]/gm) || [])
    .map((l) => l.trim().split(/\s*=/)[0]);
  assert.deepEqual([...new Set(assignments)].sort(), ['axes', 'devices', 'drivers', 'out'],
    'only the script’s own locals are assigned — nothing in the session');
});

test('the browser reaches it under `disguise`, where the read-only rule is stated', () => {
  // It was added under `mapping` by mistake, so the button threw
  // "Cannot read properties of undefined (reading 'inspect')" the first time a
  // current Designer was available to answer it.
  const shim = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'api.js'), 'utf8');
  assert.match(shim, /disguise: \{\s*\n\s*inspect: \(id, destId\) => call\('disguiseInspect'/,
    'the view calls window.d3d.disguise.inspect');

  const view = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'mapping.js'), 'utf8');
  const used = [...view.matchAll(/window\.d3d\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  for (const name of used) {
    assert.match(shim, new RegExp(`\\b${name.split('.')[0]}\\s*:\\s*\\{`),
      `${name} must exist in the shim`);
  }
});

// ---------------------------------------------------------------------------
// The verdict, through the API
// ---------------------------------------------------------------------------

test('an id that exists nowhere in the show is named as missing', async (t) => {
  // Reported as a requirement: if posi3 sends to an id disguise does not have,
  // say so — that is a whole axis nobody created, not a mistyped field.
  const d = await fakeDesigner(t, ok([receiver({
    drivers: [{ type: 'NavigatorDriver', port: 6000 }],
    axes: [{ type: 'ScreenPositionAxis', id: '10' }]
  })]));
  const found = await inspectReceivers(d.host, { apiPort: d.apiPort });
  const ids = found.flatMap((r) => r.axes.map((a) => a.id));
  assert.deepEqual(ids, ['10'], 'the show has id 10 only');
  assert.ok(!ids.includes('1'), 'so a connection sending as id 1 has no axis to drive');
});

test('while the port is wrong, the device id is not anyone’s next question', async (t) => {
  const d = await fakeDesigner(t, ok([receiver({
    drivers: [{ type: 'NavigatorDriver', port: 8000 }],
    axes: [{ type: 'ScreenPositionAxis', id: '10' }]
  })]));
  const found = await inspectReceivers(d.host, { apiPort: d.apiPort });

  const allIds = found.flatMap((r) => r.axes.map((a) => String(a.id)));
  const allPorts = found.flatMap((r) => r.drivers.map((x) => Number(x.port)));
  assert.ok(!allIds.includes('1'), 'the axis is missing');
  assert.ok(!allPorts.includes(6000), 'and the port is wrong');
  // The verdict text is built in api.js; this pins the inputs it reasons from,
  // so a change to either half cannot silently drop one of the two statements.
  // One problem at a time, in the order they have to be fixed: while the port
  // is wrong nothing arrives at all, so the id cannot be the next question.
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'api.js'), 'utf8');
  assert.match(api, /\} else if \(!portExists\) \{[\s\S]{0,200}No port match/,
    'the port is checked first, on its own');
  assert.match(api, /\} else if \(!idExists\) \{[\s\S]{0,400}ID mismatch/,
    'and the id only once the port agrees');
  assert.doesNotMatch(api, /problems\.join/,
    'the two are never joined into one sentence');

  // Every Navigator driver, by the operator's own name, not just the first:
  // naming one of three read as though it were the only one.
  assert.match(api, /const named = ds\.map\(\(d\) => `\$\{d\.name \|\| d\.type\} on \$\{d\.port\}`\)/,
    'each driver is named, with its port');
  assert.match(api, /axis \$\{ids\.length > 1 \? 'ids' : 'id'\} \$\{list\(ids\)\}/,
    'and an id mismatch lists the ids that do exist');

  // The driver type is part of the match, not decoration: this bridge speaks
  // the Navigator format, and a session here also holds a PosiStageNetDriver.
  assert.match(api, /const NAVIGATOR = 'NavigatorDriver';/);
  assert.match(api, /navDrivers\(r\)\.some\(\(d\) => Number\(d\.port\) === dest\.port\)/,
    'only a Navigator driver can satisfy the port');
});

test('an unusable API version says exactly that', () => {
  // Before any of the port or id reasoning: if Designer cannot answer at all,
  // none of it applies and none of it should be shown.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'disguise-api.js'), 'utf8');
  assert.match(src, /No API call possible with the disguise version on \$\{host\}/);
});

test('the answer is one statement, not a statement and a list of the same thing', () => {
  // The verdict names the receiver, every Navigator driver it has and their
  // ports, so a per-receiver line underneath printed the same drivers again —
  // conspicuous once there were three of them.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'mapping.js'), 'utf8');
  const handler = view.slice(view.indexOf('askBtn.onclick'));
  const body = handler.slice(0, handler.indexOf('\n  };'));

  assert.match(body, /verdict\.appendChild\(el\('div', \{ text: r\.verdict \}\)\)/,
    'the verdict is shown');
  assert.doesNotMatch(body, /for \(const rec of r\.receivers\)/,
    'and nothing enumerates the receivers again underneath it');
});
