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
  scanSubnet, scannableInterfaces, readVariablesOnce, writeVariablesOnce, probe
} = require('../core/discover');
const flashBudget = require('../core/flash-budget');
const { inspectReceivers } = require('../core/disguise-api');

/**
 * Paths that say nothing an operator changed.
 *
 * `id` is a UUID, `d3` is a mirror of the first destination kept for older
 * screens, and `encoderMeta` is what the device reported about itself — that is
 * the encoder's state, logged when the encoder says it, not an edit.
 */
const NOT_AN_EDIT = new Set(['id', 'd3', 'encoderMeta']);

const shown = (v) => {
  if (v === undefined) return '—';
  if (v === null) return 'none';
  if (v === '') return '""';
  return String(v);
};

/** Every leaf of an object as `a.b[0].c` -> value. */
function flatten(value, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(value || {})) {
    if (NOT_AN_EDIT.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => (item && typeof item === 'object'
        ? flatten(item, `${path}[${i}]`, out)
        : (out[`${path}[${i}]`] = item)));
    } else if (v && typeof v === 'object') {
      flatten(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

/**
 * What actually changed, as `field: before → after`.
 *
 * Both sides, always: "who changed that, and what was it before" is the
 * question asked after a show, and a log saying only the new value cannot
 * answer it.
 */
function describeEdit(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const parts = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] === b[key]) continue;
    parts.push(`${key} ${shown(a[key])} → ${shown(b[key])}`);
  }
  return parts;
}

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

  /**
   * The connection's name at the moment the line is written.
   *
   * Resolved here rather than by the reader: a reader matching the id against
   * the current connections shows a bare UUID as soon as one is deleted, which
   * is exactly when the log is being read to find out what happened to it.
   */
  const nameOf = (id) => {
    const conn = id && store.find(id);
    return conn ? conn.name : null;
  };

  /** Announce a config mutation, then hand the value back to the caller. */
  const announce = (value) => {
    changed();
    return value;
  };

  /**
   * An operator did something that changes how the rig behaves.
   *
   * Only significant actions: what was added, edited, deleted, started or
   * stopped. Moving around the UI is not an event — nothing happened to the
   * show — and none of it reaches this layer anyway.
   */
  const userLog = (id, text, level = 'info', name = null) =>
    manager.logger.push({
      id: id || null, name: name || nameOf(id), level, dir: 'user', text, ts: Date.now()
    });

  /**
   * The app reporting on itself: a failure, a risk, a state it has entered.
   *
   * The rule this serves: **anything worth a banner is worth a log line.** A
   * banner is drawn in one browser and dismissed in seconds; the log is the
   * record and is what Export produces. It has to be written here rather than
   * where the banner is raised, because a line logged in a browser exists only
   * in that browser.
   */
  /**
   * Bound a position value by what the device actually reports.
   *
   * `Preset` and `Offset` live inside `TotalScaledRes`, which is programmable —
   * the static table can only carry the family ceiling of 1,073,741,824, and
   * the encoders here are scaled to 300,000 and 100,000. The UI already shows
   * the real bound under the field; without this the server would still accept
   * anything under the family limit, and the value reaches flash before the
   * encoder gets to object. A refused write is a spent cycle either way.
   *
   * Only enforced once the device has told us. Guessing a bound would be the
   * same mistake as the defaults that used to be invented for encoderMeta.
   */
  const boundToDevice = (conn, checked) => {
    const total = conn.encoderMeta && conn.encoderMeta.totalCounts;
    if (!Number.isFinite(total) || total <= 0) return;
    for (const c of checked) {
      const spec = constants.ENCODER_VARS.find((v) => v.name === c.variable);
      if (!spec || spec.rangeFrom !== 'TotalScaledRes') continue;
      const n = Number(c.value);
      if (Number.isFinite(n) && n > total - 1) {
        fail('EINVAL', `${c.variable} must be 0 – ${(total - 1).toLocaleString('en-US')} ` +
          `on this encoder (one less than its TotalScaledRes of ${total.toLocaleString('en-US')})`);
      }
    }
  };

  const appLog = (id, text, level = 'info') =>
    manager.logger.push({
      id: id || null, name: nameOf(id), level, dir: 'app', text, ts: Date.now()
    });

  /**
   * Read from an encoder that is not connected, over a socket of its own.
   *
   * Throws `EUNREACHABLE` when the device does not answer at all — which is the
   * case worth telling the operator about by name, since it means the encoder
   * has gone from the network rather than merely being stopped here.
   */
  /** Everything a one-shot session says goes in the log, tagged like any other. */
  const offlineLogger = (id) => (level, dir, text) =>
    manager.logger.push({ id, name: nameOf(id), level, dir, text, ts: Date.now() });

  /**
   * The addresses worth trying, newest first.
   *
   * A programmed address does not take effect until the encoder is
   * power-cycled, so for a while the device is at one address and the profile
   * names another. Both are tried rather than making the operator care which
   * side of the power cycle they are on.
   */
  const addressesFor = (conn) =>
    [conn.encoder.pendingHost, conn.encoder.host].filter((h, i, a) => h && a.indexOf(h) === i);

  /**
   * A pending address that answers has become the real one.
   *
   * Promotion on evidence, never on assumption: the encoder was reachable there,
   * so the power cycle has happened. Until then `host` keeps naming the address
   * that works, which is the whole point of the two fields.
   */
  const promoteIfAnswered = (conn, usedHost) => {
    if (!conn.encoder.pendingHost || usedHost !== conn.encoder.pendingHost) return;
    const updated = JSON.parse(JSON.stringify(conn));
    updated.encoder.host = conn.encoder.pendingHost;
    delete updated.encoder.pendingHost;
    store.upsertConnection(updated);
    appLog(conn.id, `now answering at ${usedHost} — address change applied`);
    ctx.syncLink(updated);
    changed();
  };

  const readOffline = async (id, names) => {
    const conn = store.find(checkId(id));
    if (!conn) fail('ENOENT', 'No such connection');
    let last = null;
    for (const host of addressesFor(conn)) {
      try {
        const out = await readVariablesOnce(host, names, {
          port: conn.encoder.port,
          localAddress: conn.encoder.localAddress || null,
          onLog: offlineLogger(conn.id)
        });
        promoteIfAnswered(conn, host);
        return out;
      } catch (err) { last = err; }
    }
    const where = `${addressesFor(conn).join(' or ')}:${conn.encoder.port}`;
    // The operator gets a banner; the record gets a line. A banner is drawn in
    // one browser and gone in five seconds — if it was worth interrupting
    // somebody for, it was worth keeping.
    appLog(conn.id, `read failed — no answer at ${where}` +
      (last ? ` (${last.message})` : ''), 'error');
    const e = new Error(`${conn.name} is unreachable at ${where}`);
    e.code = 'EUNREACHABLE';
    e.cause = last;
    throw e;
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

    // The risk window, on the record. This is the one moment where losing
    // power damages the device's configuration, and until now it existed only
    // as a banner in whichever browser happened to press the button — an
    // exported log showed the `set` going out and nothing about the danger.
    const what = checked.map((c) => `${c.variable}=${c.value}`).join(', ');
    appLog(conn.id, `flash write started — do not power off — ${what}`, 'warn');

    let last = null;
    for (const host of addressesFor(conn)) {
      try {
        const { results } = await writeVariablesOnce(host, checked, {
          port: conn.encoder.port,
          localAddress: conn.encoder.localAddress || null,
          onLog: offlineLogger(conn.id)
        });
        promoteIfAnswered(conn, host);
        // `verified === null` is "this variable cannot be read back", not a
        // failure — only `false` is. Treating them alike reported every Preset
        // write as unconfirmed, including the ones that worked.
        const bad = results.filter((r) => r.verified === false);
        appLog(conn.id, bad.length
          ? `flash write finished — ${results.length - bad.length} of ${results.length} verified, ` +
            `not confirmed: ${bad.map((r) => r.variable).join(', ')}`
          : `flash write confirmed — ${what}`,
        bad.length ? 'warn' : 'info');
        return results;
      } catch (err) { last = err; }
    }
    const where = `${addressesFor(conn).join(' or ')}:${conn.encoder.port}`;
    appLog(conn.id, `flash write status unknown — no answer at ${where}; ` +
      'read the encoder before power-cycling it', 'error');
    const e = new Error(`${conn.name} is unreachable at ${where}`);
    e.code = 'EUNREACHABLE';
    e.cause = last;
    throw e;
  };

  /**
   * Follow the encoder to its new address once it has accepted one.
   *
   * The device keeps answering on its current address until it is power-cycled,
   * so the live session is untouched and the link is deliberately *not*
   * reconfigured — restarting it here would send it at an address that is not
   * live yet. Only the saved connection moves, so the next start finds it.
   */
  /**
   * Record an address the encoder has accepted but is not using yet.
   *
   * Verified, not merely acknowledged: the value was read back from the device.
   * A refusal is acknowledged in exactly the same shape, so an acknowledgement
   * proves nothing.
   *
   * `host` is deliberately left alone. It names where the encoder answers, and
   * it still answers where it did — the programmed address is inert until the
   * device is power-cycled.
   */
  const recordPendingAddress = async (id, results) => {
    const written = results.find((r) => r.ok && r.verified && r.variable === 'IP');
    if (!written) return;
    const conn = store.find(checkId(id));
    if (!conn || conn.encoder.host === written.value) return;

    const updated = JSON.parse(JSON.stringify(conn));
    updated.encoder.pendingHost = written.value;
    store.upsertConnection(updated);
    manager.logger.push({
      id: conn.id, level: 'warn', dir: null, ts: Date.now(),
      text: `address ${written.value} stored on the encoder. It keeps answering on ` +
        `${conn.encoder.host} until it is power-cycled. If hardware switch 2 in the connection ` +
        `cap is ON it will come back at ${constants.DEFAULT_ENCODER_IP} instead.`
    });
    changed();
  };

  /**
   * Settle a pending address before connecting.
   *
   * After a power cycle the encoder is at the programmed address while `host`
   * still names the old one. Probing first means Start works without anyone
   * having to know which side of the power cycle they are on.
   */
  const resolvePending = async (id) => {
    const conn = store.find(checkId(id));
    if (!conn || !conn.encoder.pendingHost) return;
    const hit = await probe(conn.encoder.pendingHost, {
      port: conn.encoder.port,
      localAddress: conn.encoder.localAddress || null
    });
    if (hit) promoteIfAnswered(conn, conn.encoder.pendingHost);
  };

  const requireLink = (id) => {
    const link = manager.get(checkId(id));
    if (!link) fail('ENOENT', 'No such connection');
    if (!link.running) fail('ENOTCONNECTED', 'Connection is not running — start it first');
    return link;
  };

  /**
   * Establish a destination's real state by asking disguise.
   *
   * An indicator has to know its own state rather than inherit one. This answer
   * lives in memory, so restarting the app forgot it and every destination fell
   * back to `connected` — true of the network, and not what the operator had
   * established a minute earlier.
   *
   * So a destination checks itself when its link starts: `auto` marks that
   * call, and it happens **once per destination per process** and never again.
   * That is not polling — disguise's documentation forbids polling this
   * endpoint, and this is one call at the moment a connection comes up. A
   * destination that cannot answer, a laptop or an older Designer, is marked
   * asked so it is not asked twice.
   */
  const checkedOnce = new Set();
  /** Pending re-checks by destination id, so one is in flight at a time. */
  const recheckTimers = new Map();

  /**
   * A wrong answer is worth asking again; a right one is not.
   *
   * The check was a one-shot, so an operator who fixed the axis id in Designer
   * watched posi3 go on saying `mismatch` while the shaft plainly drove the
   * screen. A cached result presented as live state is the flaw — an indicator
   * has to be about now.
   *
   * It cannot be live: UDP says nothing back, and the Python API is the only
   * other channel and must not be polled. So the asymmetry — **while the state
   * is wrong, ask again on a backoff; the moment it is right, stop asking.** A
   * healthy destination is never queried again, which is the case disguise's
   * documentation is protecting: a show that is working is left alone. A broken
   * one is worth the handful of calls it takes to notice it was fixed.
   */
  const RECHECK_MS = [8000, 15000, 30000, 60000];

  /**
   * How many times a destination that will not answer is asked before the
   * routine stops asking.
   *
   * Because it must stop. A Designer too old to have the Python API will never
   * grow one while it is running, and a destination that is not disguise at all
   * — a laptop, a lighting desk — will never answer however patiently it is
   * asked. Retrying those on a minute's backoff for the length of a show is a
   * poller with extra steps, aimed at a machine that has nothing to say.
   *
   * Giving up is safe because it is not permanent: a change of network state
   * asks again, and a Designer starting up is exactly such a change — the port
   * stops refusing the moment its driver binds.
   */
  const UNANSWERED_ATTEMPTS = 4;
  /** Destinations whose software has no API at all: asked once, never again. */
  const noApi = new Set();

  const scheduleRecheck = (conn, dest, attempt = 0) => {
    clearTimeout(recheckTimers.get(dest.id));
    const wait = RECHECK_MS[Math.min(attempt, RECHECK_MS.length - 1)];
    const timer = setTimeout(async () => {
      recheckTimers.delete(dest.id);
      // Only while it is still running and still configured this way.
      const live = store.find(conn.id);
      const still = live && (live.destinations || []).find((d) => d.id === dest.id);
      if (!still || still.enabled === false) return;
      if (!manager.has(conn.id) || !manager.get(conn.id).running) return;
      await establishState(live, still, { auto: true, recheck: attempt + 1 })
        .catch(() => { /* silent by design */ });
    }, wait);
    timer.unref?.();
    recheckTimers.set(dest.id, timer);
  };

  const establishState = async (conn, dest, { auto = false, recheck = 0 } = {}) => {
    if (auto && !recheck) {
      if (checkedOnce.has(dest.id)) return null;
      checkedOnce.add(dest.id);
    }
    // Nothing automatic ever asks a version that has no API to ask.
    if (auto && noApi.has(dest.id)) return null;

    let receivers;
    try {
      receivers = await inspectReceivers(dest.host);
    } catch (err) {
      // An unanswerable question says nothing about the destination, so the
      // network's own verdict stands and no check is recorded. Quiet when the
      // app asked on its own behalf: an operator who has not asked anything
      // should not be told that a laptop is not running Designer.
      if (!auto) {
        appLog(conn.id, `${dest.host}: ${err.message}`, 'warn');
        throw err;
      }
      // No answer is not an answer: the network's verdict stands and nothing is
      // recorded.
      //
      // A version with no API is final — it will not grow one while running — so
      // it is said once and never asked again. Anything else is worth a few more
      // tries, because a Designer that was not up when the connection started is
      // the ordinary case at a get-in. Bounded either way: a change of network
      // state is what asks again, and a Designer starting is such a change.
      if (err.code === 'EDISGUISE_NO_API') {
        if (!noApi.has(dest.id)) {
          noApi.add(dest.id);
          appLog(conn.id, `${dest.name || dest.host}: ${err.message} ` +
            'This destination will show the network state only.', 'warn');
        }
        return null;
      }
      if (recheck < UNANSWERED_ATTEMPTS) scheduleRecheck(conn, dest, recheck);
      return null;
    }

    const NAVIGATOR = 'NavigatorDriver';
    const label = (r) => r.name || r.path || 'a receiver';
    const q = (name, fallback) => `"${name || fallback}"`;
    const navDrivers = (r) => (r.drivers || []).filter((d) => d.type === NAVIGATOR);
    const hasPort = (r) => navDrivers(r).some((d) => Number(d.port) === dest.port);
    const hasAxis = (r) => (r.axes || []).some((a) => String(a.id) === String(dest.devid));

    const matching = receivers.filter((r) => hasPort(r) && hasAxis(r));
    const both = matching[0] || null;
    const portOnly = receivers.filter(hasPort);
    const axisOnly = receivers.filter(hasAxis);
    const allPorts = [...new Set(receivers.flatMap((r) => navDrivers(r).map((d) => Number(d.port))))];
    const allIds = [...new Set(receivers.flatMap((r) => (r.axes || []).map((a) => String(a.id))))];

    const describeNav = (r) => {
      const ds = navDrivers(r);
      if (!ds.length) {
        return `disguise PositionReceiver ${q(r.name, r.path)} has no Navigator driver`;
      }
      return `disguise PositionReceiver ${q(r.name, r.path)} has ` +
        `${ds.length > 1 ? 'these drivers' : 'this driver'}: ` +
        ds.map((d) => `${q(d.name, d.type)} on ${d.port}`).join(', ');
    };

    const idExists = allIds.includes(String(dest.devid));
    const portExists = allPorts.includes(dest.port);

    let verdict;
    let level = 'warn';
    if (!receivers.length) {
      verdict = `${dest.host} has a Designer session, but no PositionReceiver in it. ` +
        'Add one, with a Navigator driver and an axis inside.';
    } else if (!portExists) {
      verdict = `Port mismatch: this connection sends to port ${dest.port}, ` +
        `${receivers.map(describeNav).join('; ')}.`;
    } else if (!idExists) {
      const axesOf = (r) => {
        const ids = (r.axes || []).map((a) => a.id);
        return ids.length ? `axis ${ids.length > 1 ? 'ids' : 'id'} ${ids.join(', ')}` : 'no axes';
      };
      const groups = new Map();
      for (const r of portOnly) {
        const drv = navDrivers(r).find((d) => Number(d.port) === dest.port);
        const key = (drv && drv.uid) || `${drv && drv.name}:${dest.port}`;
        if (!groups.has(key)) groups.set(key, { drv, rs: [] });
        groups.get(key).rs.push(r);
      }
      const parts = [...groups.values()].map(({ drv, rs }) =>
        `driver ${q(drv && drv.name, 'NavigatorDriver')} on ${dest.port} feeds ` +
        rs.map((r) => `disguise PositionReceiver ${q(r.name, r.path)} (${axesOf(r)})`).join(' and '));
      for (const r of receivers.filter((r2) => !portOnly.includes(r2))) {
        parts.push(`disguise PositionReceiver ${q(r.name, r.path)} has ${axesOf(r)}`);
      }
      verdict = `ID mismatch: this connection sends id ${dest.devid}, ${parts.join('; ')}.`;
    } else if (!both) {
      verdict = `Split across receivers: port ${dest.port} is on ` +
        `${portOnly.map((r) => q(r.name, r.path)).join(', ')} and axis id ${dest.devid} is on ` +
        `${axisOnly.map((r) => q(r.name, r.path)).join(', ')} — they have to be in the same one.`;
    } else if (matching.length > 1) {
      verdict = `Matches ${matching.length} receivers: port ${dest.port} with axis id ` +
        `${dest.devid} is in ${matching.map((r) => q(r.name, r.path)).join(', ')} — ` +
        'this connection drives all of them.';
      level = 'info';
    } else {
      verdict = `Everything matches: disguise PositionReceiver ${q(both.name, both.path)} ` +
        `has a driver on port ${dest.port} and an axis for id ${dest.devid}.`;
      level = 'info';
    }

    // Said once per state, not once per check: a re-check that finds the same
    // thing has nothing to add, and this runs on a timer.
    const previous = manager.disguiseChecks.get(dest.id);
    if (!previous || previous.verdict !== verdict) appLog(conn.id, verdict, level);
    manager.disguiseChecks.set(dest.id, { matches: !!both, at: Date.now(), verdict });

    // Wrong: ask again, further off each time. Right: stop.
    if (both) {
      clearTimeout(recheckTimers.get(dest.id));
      recheckTimers.delete(dest.id);
    } else {
      scheduleRecheck(conn, dest, recheck);
    }
    return { receivers, ports: allPorts, ids: allIds, matches: !!both, verdict };
  };

  /**
   * Every enabled destination of a connection checks itself, once.
   *
   * Staggered, so a fan-out to one machine does not arrive as a burst, and
   * delayed so the link is up first. Failures are silent — see `establishState`.
   */
  /**
   * A destination that has just changed network state asks disguise again.
   *
   * The state machine, in full: the network side is evaluated every tick, which
   * costs nothing — a destination going offline or coming back is noticed at
   * once, from ICMP. Only a *change* triggers a question to disguise, because
   * something that has just come back may have come back different. A
   * destination sitting healthily at `receiving` is never queried again, which
   * is the case disguise's documentation protects.
   *
   * Debounced, so a flapping destination cannot turn a state machine into a
   * poller.
   */
  const lastAutoAsk = new Map();
  const AUTO_ASK_GAP_MS = 8000;

  manager.onDestinationStateChange = (connId, dest) => {
    const conn = store.find(connId);
    if (!conn) return;
    const live = (conn.destinations || []).find((d) => d.id === dest.id);
    if (!live || live.enabled === false) return;
    // A change of state is a fresh chance for a destination that had gone
    // quiet: the attempt count starts again. Not for one with no API — that
    // does not change because a cable moved.
    if (noApi.has(dest.id)) return;
    const last = lastAutoAsk.get(dest.id) || 0;
    if (Date.now() - last < AUTO_ASK_GAP_MS) return;
    lastAutoAsk.set(dest.id, Date.now());
    establishState(conn, live, { auto: true, recheck: 1 }).catch(() => { /* silent */ });
  };

  const establishAll = (conn) => {
    let delay = 1500;
    for (const dest of conn.destinations || []) {
      if (dest.enabled === false) continue;
      const at = delay;
      delay += 400;
      setTimeout(() => {
        establishState(conn, dest, { auto: true }).catch(() => { /* silent by design */ });
      }, at).unref?.();
    }
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

    /**
     * Ask a disguise machine what it is actually listening on.
     *
     * ICMP tells us nothing is bound to the port we send to; it cannot tell us
     * which port *is*. Designer can, and that turns "nothing is listening on
     * 6000" into "disguise is listening on 8000".
     *
     * On demand only, and deliberately so — disguise's documentation says this
     * endpoint must not be polled and is not for use during a show. It is wired
     * to a button and to nothing else.
     */
    /** Run each destination's own state check — used after an auto-start. */
    establishDisguiseState: ({ id }) => {
      const conn = store.find(checkId(id));
      if (conn) establishAll(conn);
      return true;
    },

    disguiseInspect: async ({ id, destId }) => {
      const conn = store.find(checkId(id));
      if (!conn) fail('ENOENT', 'No such connection');
      const dest = (conn.destinations || []).find((d) => d.id === destId);
      if (!dest) fail('ENOENT', 'No such disguise receiver');
      userLog(conn.id, `asked ${dest.name || dest.host} what it is listening on`);
      return establishState(conn, dest);
    },

    /**
     * The disguise numbers for one receiver.
     *
     * `destId` names which: a fan-out has several, each with its own device ID,
     * its own port and — since schema 4 — its own mapping. Computing for "the
     * connection" described only the first and left the rest undocumented.
     */
    mappingCompute: ({ id, destId, mapping }) => {
      const conn = store.find(checkId(id));
      if (!conn) fail('ENOENT', 'No such connection');
      const dest = destId
        ? (conn.destinations || []).find((d) => d.id === destId)
        : (conn.destinations || [])[0];
      if (!dest) fail('ENOENT', 'No such disguise receiver');

      const merged = Object.assign({}, dest.mapping, mapping || {}, {
        countsPerRev: conn.encoderMeta.countsPerRev,
        totalCounts: conn.encoderMeta.totalCounts
      });
      const mapped = computeMapping(merged);
      return {
        mapped,
        fields: d3Fields(conn, dest, mapped),
        suggestedPreset: suggestedPreset(mapped.minInput, conn.encoderMeta.countsPerRev)
      };
    },

    // -- config -------------------------------------------------------------

    configGet: () => store.profile,

    configSaveConnection: (payload) => {
      const clean = sanitiseConnection(payload);
      // Snapshot before the store mutates in place, or the diff compares the
      // saved object with itself and every edit looks like nothing happened.
      const was = clean.id && store.find(clean.id)
        ? JSON.parse(JSON.stringify(store.find(clean.id)))
        : null;

      const saved = store.upsertConnection(clean);

      if (!was) {
        userLog(saved.id, `added connection "${saved.name}" — encoder ` +
          `${saved.encoder.host}:${saved.encoder.port}, to ` +
          saved.destinations.map((d) => `${d.host}:${d.port} id ${d.devid}`).join(', '));
      } else {
        const edits = describeEdit(was, saved);
        if (edits.length) userLog(saved.id, `edited "${saved.name}": ${edits.join(' · ')}`);
      }

      // An edit can invalidate what disguise told us — a changed port or device
      // id is exactly the thing the answer was about. Forget it and let the
      // destination establish itself again, the same as it does on a start.
      for (const d of saved.destinations || []) {
        const before = (was && (was.destinations || []).find((x) => x.id === d.id)) || null;
        if (before && before.port === d.port && before.devid === d.devid && before.host === d.host) continue;
        manager.disguiseChecks.delete(d.id);
        checkedOnce.delete(d.id);
        // A changed address may be a different machine, and a different machine
        // may have an API.
        noApi.delete(d.id);
      }
      ctx.syncLink(saved);
      if (manager.has(saved.id) && manager.get(saved.id).running) establishAll(saved);
      return announce(saved);
    },

    configDeleteConnection: ({ id }) => {
      const key = checkId(id);
      const gone = store.find(key);
      manager.remove(key);
      const ok = store.deleteConnection(key);
      if (ok && gone) {
        // Named explicitly: the connection is already out of the store, so
        // nameOf() cannot find it — and this is the line whose name matters
        // most, being the last one that connection will ever have.
        userLog(key, `deleted — was encoder ${gone.encoder.host}:${gone.encoder.port}` +
          `, to ${gone.destinations.map((d) => `${d.host}:${d.port} id ${d.devid}`).join(', ')}`,
        'warn', gone.name);
      }
      return announce(ok);
    },

    configReorder: ({ ids }) => {
      if (!Array.isArray(ids)) fail('EINVAL', 'Expected an array of ids');
      store.reorder(ids.map(checkId));
      return announce(store.profile.connections.map((c) => c.id));
    },

    configSetSettings: (partial) => {
      const was = JSON.parse(JSON.stringify(store.settings));
      const s = store.setSettings(partial || {});
      const edits = describeEdit(was, s);
      if (edits.length) userLog(null, `changed settings: ${edits.join(' · ')}`);
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
      const had = store.connections.length;
      manager.stopAll();
      for (const id of manager.ids()) manager.remove(id);
      const profile = store.replaceProfile(data);
      for (const conn of profile.connections) ctx.syncLink(conn);
      userLog(null, `imported a profile — replaced ${had} connection(s) with ` +
        `${profile.connections.length}: ${profile.connections.map((c) => c.name).join(', ')}`, 'warn');
      return announce({ imported: true, profile });
    },

    // -- links --------------------------------------------------------------

    linkStart: async ({ id }) => {
      await resolvePending(id);
      const key = checkId(id);
      if (!manager.has(key)) {
        const conn = store.find(key);
        if (!conn) fail('ENOENT', 'No such connection');
        ctx.syncLink(conn);
      }
      // Before the state lines, so the log reads as cause then effect: somebody
      // pressed Start, and here is what the link then did about it.
      userLog(key, 'start');
      const snap = manager.start(key).snapshot();
      // The indicator establishes its own state rather than inheriting one.
      establishAll(store.find(key));
      return snap;
    },

    linkStop: ({ id }) => {
      const key = checkId(id);
      // Checked before it is logged, so the record never claims a stop that
      // could not happen; logged before it is done, so the log reads as cause
      // then effect — the operator pressed Stop, and here is what followed.
      if (!manager.has(key)) fail('ENOENT', 'No such connection');
      userLog(key, 'stop');
      return manager.stop(key).snapshot();
    },

    linkStartAll: () => {
      for (const conn of store.connections) ctx.syncLink(conn);
      // What will actually happen, not how many exist. Counting connections
      // said "2" when both were already running and when neither was.
      const idle = store.connections.length - manager.runningCount;
      userLog(null, idle ? `start all — starting ${idle}` : 'start all — everything was already running');
      manager.startAll();
      for (const conn of store.connections) establishAll(conn);
      return manager.ids();
    },

    linkStopAll: () => {
      const running = manager.runningCount;
      userLog(null, running ? `stop all — stopping ${running}` : 'stop all — nothing was running');
      manager.stopAll();
      return manager.ids();
    },

    linkSnapshot: ({ id }) => {
      const link = manager.get(checkId(id));
      if (!link) return null;
      // Through the same filter the telemetry stream uses, or this endpoint and
      // that one disagree about the same destination.
      const snap = link.snapshot();
      manager.applyDisguiseChecks(snap.telemetry);
      return snap;
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

    encoderWriteMany: async ({ id, entries, force }) => {
      if (!Array.isArray(entries) || !entries.length) fail('EINVAL', 'Nothing to write');
      const checked = entries.map((e) => checkVarWrite(e.variable, e.value));
      const conn = store.find(checkId(id));
      if (conn) boundToDevice(conn, checked);
      const link = manager.get(checkId(id));

      // Preset is not an ordinary variable and must not go down the ordinary
      // path. The firmware refuses to store the same value twice in a row —
      // FAQ 1, to protect the ~100,000 cycle budget — and the documented way
      // round costs two cycles, so it is offered rather than taken. `setPreset`
      // knows all of that; a generic `set` knows none of it, which meant the
      // Controls popup and this screen behaved differently for the same write.
      const presets = checked.filter((c) => c.variable === 'Preset');
      const rest = checked.filter((c) => c.variable !== 'Preset');
      if (presets.length && link && link.running) {
        const results = rest.length ? await link.writeMany(rest) : [];
        for (const p of presets) {
          const r = await link.setPreset(Number(p.value), { force: !!force });
          results.push({
            variable: 'Preset', value: p.value, ok: true,
            // Never read back, so never `false`: the echo is the confirmation.
            verified: null, cycles: r.cycles
          });
        }
        await recordPendingAddress(id, results);
        return results;
      }

      // Rate limiting is shared between both paths, so the device's ~100,000
      // write cycles are counted once however they are spent.
      const results = (link && link.running)
        ? await link.writeMany(checked)
        : await writeOffline(id, checked);

      await recordPendingAddress(id, results);
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

    // The name, not the id. An exported log is read by a person, usually one
    // who was not there — a column of UUIDs tells them nothing and costs a
    // third of every line. The id is kept where it is the only thing known.
    logExport: () => manager.logger.tail({ limit: 100000 })
      .map((l) => [
        new Date(l.ts).toISOString(),
        `[${l.level}]`,
        (l.dir || '-').padEnd(4),
        l.name || (l.id ? 'deleted' : '-'),
        l.text
      ].join(' '))
      .join('\n')
  };
}

module.exports = { createApi };
