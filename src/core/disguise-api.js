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
 * **This is on demand and never polled.** disguise's own documentation is
 * explicit: *"this endpoint MUST NOT be polled"* and *"calling this endpoint too
 * frequently or during a show is not a supported workflow — this is intended for
 * show programming tasks, not during production."* So it is wired to a button
 * and to nothing else: not to the send-error path, not to a timer, not to a
 * screen that happens to be open. A diagnosis that destabilises the machine
 * being diagnosed is not worth having.
 */

const DEFAULT_API_PORT = 80;
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Every UDP receiver in the session, with the port it is bound to.
 *
 * Defensive by construction: it runs against whatever version the venue has, so
 * a missing attribute skips one device rather than failing the call. `Port`,
 * `ipFromFilter` and `multicastAddress` are the documented properties of
 * `UdpReceiverDriver`, which `NavigatorDriver` inherits and adds nothing to.
 */
const SCRIPT = `
out = []
try:
    devices = state.devices
except Exception:
    devices = []
for d in devices:
    try:
        if not isinstance(d, UdpReceiverDriver):
            continue
        out.append({
            'kind': type(d).__name__,
            'name': str(getattr(d, 'path', '') or getattr(d, 'name', '') or ''),
            'port': int(d.Port),
            'multicastAddress': str(getattr(d, 'multicastAddress', '') or ''),
            'ipFromFilter': str(getattr(d, 'ipFromFilter', '') or ''),
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
      ? `${host} is serving HTTP but has no ${new URL(url).pathname} — this Designer is older ` +
        'than the Python API, or what is answering on that address is not Designer at all.'
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

  // The endpoint wraps the script's return value; which key varies by version,
  // so take the first thing that looks like our list rather than insisting on
  // one shape and breaking at a venue.
  const candidates = [body, body.result, body.data, body.value, body.returnValue];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((r) => r && Number.isFinite(Number(r.port)));
  }
  const e = new Error(`${host} ran the query but returned no receiver list: ${text.slice(0, 200)}`);
  e.code = 'EDISGUISE_API';
  throw e;
}

module.exports = { inspectReceivers, SCRIPT, DEFAULT_API_PORT };
