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
    disguiseInspect: async ({ id, destId }) => {
      const conn = store.find(checkId(id));
      if (!conn) fail('ENOENT', 'No such connection');
      const dest = (conn.destinations || []).find((d) => d.id === destId);
      if (!dest) fail('ENOENT', 'No such disguise receiver');

      userLog(conn.id, `asked ${dest.name || dest.host} what it is listening on`);
      let receivers;
      try {
        receivers = await inspectReceivers(dest.host);
      } catch (err) {
        appLog(conn.id, `${dest.host}: ${err.message}`, 'warn');
        throw err;
      }

      // The join: on this host, a receiver with a driver on our port, holding
      // an axis with our device id. Each half can match without the other, and
      // they are different faults — a port mismatch is one field in disguise, a
      // missing axis is a whole axis nobody created.
      const label = (r) => r.name || r.path || 'a receiver';
      const hasPort = (r) => (r.drivers || []).some((d) => Number(d.port) === dest.port);
      const hasAxis = (r) => (r.axes || []).some((a) => String(a.id) === String(dest.devid));

      const both = receivers.find((r) => hasPort(r) && hasAxis(r)) || null;
      const portOnly = receivers.filter(hasPort);
      const axisOnly = receivers.filter(hasAxis);
      const allPorts = [...new Set(receivers.flatMap((r) => (r.drivers || []).map((d) => Number(d.port))))];
      const allIds = [...new Set(receivers.flatMap((r) => (r.axes || []).map((a) => String(a.id))))];

      // Two independent facts, reported independently, and each naming the
      // thing an operator has to go and look at. A missing axis is a whole
      // object nobody created; a wrong port is one field. Folding them into a
      // single "nothing matches" hid whichever one they were not thinking of.
      const idExists = allIds.includes(String(dest.devid));
      const portExists = allPorts.includes(dest.port);

      /** "posi3's NavigatorDriver on 8000" — what to go and look at. */
      const describeDriver = (r) => {
        const d = (r.drivers || [])[0];
        return d ? `${label(r)}'s ${d.type} on port ${d.port}` : `${label(r)} (no driver)`;
      };
      const axisList = (r) => {
        const ids = (r.axes || []).map((a) => a.id);
        return ids.length ? `axis ids ${ids.join(', ')}` : 'no axes';
      };

      let verdict;
      let level = 'warn';
      if (!receivers.length) {
        verdict = `${dest.host} has a Designer session, but no position receiver in it. ` +
          'Add one, with a Navigator driver and an axis inside.';
      } else if (both && both.engaged && both.receiving) {
        verdict = `${label(both)} is engaged and receiving on port ${dest.port}, with an axis for ` +
          `id ${dest.devid}. Everything matches.`;
        level = 'info';
      } else if (both && !both.engaged) {
        verdict = `${label(both)} has a driver on ${dest.port} and an axis with id ${dest.devid}, ` +
          'but the receiver is not engaged — so nothing will move until it is.';
      } else if (both) {
        verdict = `${label(both)} matches and is engaged, but reports that it is not receiving. ` +
          'Check that this connection is running and that nothing between them drops the traffic.';
      } else {
        const problems = [];
        if (!portExists) {
          problems.push(`No port match — this connection sends to ${dest.port}, and ` +
            (receivers.length
              ? receivers.map(describeDriver).join('; ')
              : 'nothing is listening'));
        }
        if (!idExists) {
          // Named against the driver, because that is the object whose axes
          // these are and the one that has to be opened to add another.
          const home = portOnly[0] || receivers[0];
          problems.push(`ID mismatch — this connection sends id ${dest.devid}, and ` +
            `${describeDriver(home)} has ${axisList(home)}`);
        }
        if (!problems.length) {
          problems.push(`Port ${dest.port} and axis id ${dest.devid} are in different receivers ` +
            `(${portOnly.map(label).join(', ')} and ${axisOnly.map(label).join(', ')}) — ` +
            'they have to be in the same one');
        }
        verdict = `${problems.join('. ')}.`;
      }

      appLog(conn.id, verdict, level);
      return {
        receivers,
        ports: allPorts,
        ids: allIds,
        matches: !!both && both.engaged && both.receiving,
        verdict
      };
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

      ctx.syncLink(saved);
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
      return manager.start(key).snapshot();
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
      return link ? link.snapshot() : null;
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
