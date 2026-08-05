'use strict';
/**
 * Anything worth a banner is worth a log line.
 *
 * A banner is drawn in one browser and dismissed in seconds. The log is the
 * record, and Export is what an operator is asked to send when something went
 * wrong at a venue. Three banners used to leave no trace in it at all — among
 * them "FLASH WRITE IN PROGRESS — do not power off", which is the single
 * highest-consequence message this app produces.
 *
 * The log line cannot be written where the banner is raised: a line logged in a
 * browser exists only in that browser and never reaches Export. So each banner
 * is answered on the server, at the point the operation actually happens, and
 * this file is the inventory that keeps the two in step.
 *
 * **Adding a banner will fail this test.** That is the point. Add the server-
 * side log line first, then add the banner here with a note saying where its
 * line comes from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'src', 'web', 'js');

/**
 * Every banner the UI can raise -> where the matching log line is written.
 *
 * Keyed by `file:firstArgument`, which is stable across rewording. The value is
 * documentation, checked by a human, not by the runner.
 */
const ANSWERED_BY = {
  // Cannot be logged, and is the one honest exception: the client failed to
  // reach the server, so there is no log to write to.
  "app.js:'error'": 'unloggable — the server is unreachable at this moment',

  "app.js:'warn'": 'service.js pushes store.loadWarning and store.readOnly into the ring; ' +
    'binaryMode, fieldLayoutInferred and destinationDown are logged by encoder-link.js ' +
    'at the point the link detects them',

  "encoder-config.js:'error'": 'api.js readOffline logs "read failed — no answer at …"; ' +
    'writeOffline logs "flash write status unknown …"',

  "encoder-config.js:'warn'": 'api.js writeOffline logs "flash write started — do not power off"'
};

/** Source files that may raise a banner. */
function webSources(dir = WEB, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) webSources(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** `banner('warn', …)` call sites, as file:kind. */
function bannerCalls() {
  const found = new Set();
  for (const file of webSources()) {
    // ui.js defines banner(); everywhere else calls it.
    if (path.basename(file) === 'ui.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bbanner\(\s*('[a-z]+'|"[a-z]+")/g)) {
      found.add(`${path.basename(file)}:${m[1].replace(/"/g, "'")}`);
    }
  }
  return found;
}

test('every banner the UI can raise is answered by a log line', () => {
  const raised = [...bannerCalls()].sort();
  const inventoried = Object.keys(ANSWERED_BY).sort();

  const unanswered = raised.filter((b) => !inventoried.includes(b));
  assert.deepEqual(unanswered, [],
    'these banners have no log line recorded for them. Log the event on the server ' +
    'where it happens, then add it to ANSWERED_BY above:\n  ' + unanswered.join('\n  '));

  const stale = inventoried.filter((b) => !raised.includes(b));
  assert.deepEqual(stale, [],
    'these are inventoried but no longer raised — remove them:\n  ' + stale.join('\n  '));
});

test('the server writes the lines the inventory promises', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'api.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'service.js'), 'utf8');
  const link = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'encoder-link.js'), 'utf8');

  // The flash risk window and its outcome.
  assert.match(api, /flash write started — do not power off/);
  assert.match(api, /flash write confirmed/);
  assert.match(api, /flash write status unknown/);

  // A device that has gone from the network.
  assert.match(api, /read failed — no answer at/);

  // A profile that would not load, or that cannot be saved over.
  assert.match(service, /logger\.push\(\{\s*level: 'warn', dir: 'app', text: store\.loadWarning/);
  assert.match(service, /loaded read-only/);

  // The three that were already answered, kept honest.
  assert.match(link, /OutputType was changed to BINARY/);
  assert.match(link, /Field layout will be inferred/);
  assert.match(link, /is not answering — pausing sends/);
});

test('no banner outlives half a minute', () => {
  // A banner is an interruption, not a record. Every one is written to the log,
  // and the state a banner describes is on the dashboard continuously — so
  // there is nothing left for a banner to be the only copy of, and one that
  // sits there all night is one that stops being read.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'ui.js'), 'utf8');

  assert.match(ui, /const MAX_BANNER_MS = 30000;/);

  const fn = ui.slice(ui.indexOf('export function banner'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Unconditional: the old `if (ttlMs > 0)` left every banner without one on
  // screen until somebody clicked it.
  assert.doesNotMatch(body, /if \(ttlMs > 0\) setTimeout/,
    'the timer must not be conditional on a ttl being passed');
  assert.match(body, /Math\.min\(ttlMs, MAX_BANNER_MS\)/,
    'a shorter ttl still shortens; it can never extend past the cap');
});

test('a destination banner goes when its link stops', () => {
  // "…is offline — sends paused, retrying every 5s" stops being true the moment
  // the link stops: nothing is retrying, because nothing is sending. Reported
  // from the rig — the banner stayed up through Stop All.
  //
  // The banner's own 30s lifetime would clear it eventually, but until then the
  // app would be stating something it knows to be false.
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'js', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf('onLinkState(('));
  const body = handler.slice(0, handler.indexOf('\n  });'));

  assert.match(body, /state === 'idle'/);
  assert.match(body, /dismissBanner\(`dest-\$\{payload\.id\}`\)/,
    'going idle must clear the destination banner for that connection');

  // The key has to match the one the banner is raised under, or this silently
  // does nothing.
  assert.match(app, /banner\('warn', `\$\{who\}: \$\{e\.text\}`, \{ key: `dest-\$\{e\.id\}` \}\)/,
    'raised under dest-<connection id>');
});

test('flash banners are keyed by encoder, so one cannot dismiss another', () => {
  // With two writes in flight, encoder A's confirmation dismissed encoder B's
  // "do not power off" warning while B was still committing — a global 'flash'
  // key under a per-connection warning.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'js', 'views', 'encoder-config.js'), 'utf8');
  assert.doesNotMatch(src, /key: 'flash'/, 'no global flash key');
  assert.doesNotMatch(src, /key: 'flash-unknown'/);
  assert.match(src, /key: `flash-\$\{conn\.id\}`/, 'the key names the encoder it warns about');
  const confirmed = src.slice(src.indexOf('function onFlashConfirmed'));
  assert.match(confirmed.slice(0, confirmed.indexOf('\n}')), /flash-\$\{id\}/,
    'and the confirmation dismisses only that encoder\'s banners');
});
