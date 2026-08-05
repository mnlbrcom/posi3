'use strict';
/**
 * Asking disguise what it is actually listening on.
 *
 * When a destination refuses our packets the kernel tells us the machine is
 * there and nothing is bound to that port. It cannot tell us which port *is*
 * bound — but disguise can, through the Designer Python API, and that turns
 * "nothing is listening on 6000" into "disguise is listening on 8000", which is
 * the whole answer.
 *
 *   POST http://<host>/api/session/python/execute   { "script": "…" }
 *
 * The script's `return` value comes back as JSON. Python 2.7, and the `d3`
 * package is imported for you on this endpoint.
 *
 * **posi3 never writes to disguise.** Everything here reads. The Python API can
 * set `Port` as readily as read it — it is a plain property — and that is
 * deliberately not used: a show machine's configuration belongs to whoever is
 * running the show, and a bridge that quietly reconfigures the thing it feeds is
 * a bridge nobody can trust. What is wanted from Designer is *information*, so
 * that a port mismatch can be named rather than guessed at. `test/disguise-inspect`
 * fails if a mutating statement ever appears in the script below.
 *
 * **This is on demand and never polled.** disguise's own documentation is
 * explicit: *"this endpoint MUST NOT be polled"* and *"calling this endpoint too
 * frequently or during a show is not a supported workflow — this is intended for
 * show programming tasks, not during production."* So it is wired to a button
 * and to nothing else: not to the send-error path, not to a timer, not to a
 * screen that happens to be open. A diagnosis that destabilises the machine
 * being diagnosed is not worth having.
 */

const DEFAULT_API_PORT = 80;

/** JSON if it is JSON, otherwise the string itself. */
function tryParse(v) {
  try { return JSON.parse(v); } catch { return v; }
}
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Every position receiver in the session, and what is inside it.
 *
 * The object model, read off the running Designer rather than assumed:
 *
 *   state.devices                  a DeviceManager, not a list
 *     .devices                     the devices themselves
 *       ScreenPositionReceiver     description, path, uid
 *         .drivers[]               NavigatorDriver … Port, and `description`
 *                                  for the name the operator gave it
 *         .axes[]                  ScreenPositionAxis … each with an id
 *
 * Which is also how you tell several of anything apart. A **receiver** has a
 * `description` the operator typed — "posi3" — a `path` carrying the same leaf,
 * and a `uid` that survives a rename. A **driver** has no `name` attribute at
 * all, but it has the same `description`: "nav", "testdr". So `description` is
 * the name throughout. An **axis** is identified by its `id`, which is exactly
 * what this bridge puts in every packet.
 *
 * So a destination here — host, port, device id — joins to disguise as: on that
 * host, the receiver with a driver on that port, containing an axis with that
 * id. Each half can match without the other, and each failure is different.
 *
 * `started`, `engaged` and `receiving` are deliberately **not** read. The
 * receiver carries all three and the axes carry none of them, and on the
 * reference rig `engaged` reported False for a receiver whose axes the operator
 * had engaged. Whatever that property tracks, it is not the thing an operator is
 * looking at — and a status nobody can act on, reported confidently, is worse
 * than no status at all.
 *
 * Defensive throughout: it runs against whatever version a venue has, so a
 * missing attribute skips one field rather than failing the call.
 */
const SCRIPT = `
out = []
try:
    devices = state.devices.devices
except Exception:
    devices = []
for d in devices:
    try:
        if not hasattr(d, 'drivers'):
            continue
        drivers = []
        for drv in d.drivers:
            drivers.append({
                'type': type(drv).__name__,
                # No name attribute on a driver; description is what the
                # operator typed and what Designer shows: nav, testdr.
                'name': str(getattr(drv, 'description', '') or ''),
                'path': str(getattr(drv, 'path', '') or ''),
                'port': getattr(drv, 'Port', None),
                'multicastAddress': str(getattr(drv, 'multicastAddress', '') or ''),
                'ipFromFilter': str(getattr(drv, 'ipFromFilter', '') or ''),
            })
        axes = []
        for ax in d.axes:
            axes.append({
                'type': type(ax).__name__,
                'id': str(getattr(ax, 'id', '')),
                'property': str(getattr(ax, 'property', '') or ''),
            })
        out.append({
            # description first: it is the name the operator typed, it is what
            # Designer shows, and it is the only one a driver has. On a receiver
            # both exist and agreed on the session measured, but if they ever
            # diverge the typed one is the one meant.
            'name': str(getattr(d, 'description', '') or getattr(d, 'name', '') or ''),
            'path': str(getattr(d, 'path', '') or ''),
            'uid': str(getattr(d, 'uid', '') or ''),
            'drivers': drivers,
            'axes': axes,
        })
    except Exception:
        pass
return out
`.trim();

/**
 * @param {string} host
 * @param {{apiPort?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{kind: string, name: string, port: number}>>}
 * @throws {Error & {code: string}} EDISGUISE_UNREACHABLE | EDISGUISE_API
 */
async function inspectReceivers(host, opts = {}) {
  const apiPort = opts.apiPort || DEFAULT_API_PORT;
  const url = `http://${host}:${apiPort}/api/session/python/execute`;

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SCRIPT }),
      signal: control.signal
    });
  } catch (err) {
    // Distinguished because they call for different people: no Designer
    // session on that machine is a different problem from a wrong address.
    const e = new Error(control.signal.aborted
      ? `${host} did not answer its Designer API within ${(opts.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s`
      : `Could not reach the Designer API on ${host}: ${err.message}. ` +
        'Designer must be running, with a session open.');
    e.code = 'EDISGUISE_UNREACHABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    // A 404 from a machine that is plainly serving HTTP means the route is not
    // there — which is what an older Designer looks like, since the Python API
    // was added later. Worth saying, because "404" invites the reading that the
    // address is wrong when the address is fine.
    const e = new Error(res.status === 404
      ? `No API call possible with the disguise version on ${host} — it is serving HTTP but has ` +
        `no ${new URL(url).pathname}. Either Designer predates the Python API, or what is ` +
        'answering on that address is not Designer.'
      : `${host} answered ${res.status} — ${text.slice(0, 200)}`);
    e.code = res.status === 404 ? 'EDISGUISE_NO_API' : 'EDISGUISE_API';
    throw e;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const e = new Error(`${host} answered something that is not JSON: ${text.slice(0, 120)}`);
    e.code = 'EDISGUISE_API';
    throw e;
  }

  // Designer answers { status, d3Log, pythonLog, returnValue }, and returnValue
  // is the script's value **as a JSON string** — not as JSON. Measured against
  // a live session; a version that hands back the value directly is handled by
  // the same loop rather than by a second code path.
  const candidates = [body.returnValue, body.result, body.data, body.value, body];
  for (const c of candidates) {
    const v = typeof c === 'string' ? tryParse(c) : c;
    if (Array.isArray(v)) return v;
  }

  // A script error comes back as HTTP 200 with a status code set, which is easy
  // to mistake for an empty session.
  if (body.status && body.status.code) {
    const e2 = new Error(`${host} ran the query and Designer reported: ` +
      String(body.status.message || '').split('Traceback')[0].trim().slice(0, 200));
    e2.code = 'EDISGUISE_API';
    throw e2;
  }
  const e = new Error(`${host} ran the query but returned no receiver list: ${text.slice(0, 200)}`);
  e.code = 'EDISGUISE_API';
  throw e;
}

module.exports = { inspectReceivers, SCRIPT, DEFAULT_API_PORT };
