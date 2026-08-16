'use strict';
/**
 * Finding encoders whose address nobody wrote down.
 *
 * POSITAL documents no discovery mechanism — no broadcast, no announce, nothing
 * on the UDP side either (the manual allows UDP only on port 5000, and only for
 * polled reads). The encoder's sole identifying behaviour is that it answers on
 * TCP 6000. So this connects to every host in a subnet and asks.
 *
 * Three properties matter more than speed here:
 *
 *  - **The subnet comes from the machine's own interfaces, never from the
 *    caller.** A route that scanned an arbitrary target would be a port scanner
 *    with an HTTP front end. The caller picks one of its own NICs; the netmask
 *    on that NIC decides what gets probed.
 *
 *  - **A hit is disconnected immediately.** TCP 6000 accepts only a handful of
 *    clients, and on a running show those slots are the difference between the
 *    desk connecting and not. A scan must not hold one open a moment longer
 *    than it takes to identify the device.
 *
 *  - **Identification is positive, not "the port was open".** Something else on
 *    6000 is possible; an encoder either streams samples or answers a `read`.
 */

const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');

const ENCODER_PORT = 6000;

/** Hosts probed at once. High enough to finish a /24 in seconds, low enough
 *  not to exhaust file descriptors on a modest machine. */
const CONCURRENCY = 64;

/** A /24 is 254 probes. Wider masks are refused rather than silently clipped. */
const MAX_HOSTS = 1024;

/**
 * MAC prefixes seen on this hardware. Observed, not documented — POSITAL
 * publishes no OUI list — so this is a hint for the operator, never a test.
 */
const ENCODER_OUIS = ['00:0e:cf'];

/**
 * The IPv4 interfaces this machine could scan from.
 * @returns {Array<{name: string, address: string, netmask: string, cidr: string, hosts: number}>}
 */
function scannableInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const size = subnetSize(a.netmask);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        cidr: a.cidr || `${a.address}/${maskBits(a.netmask)}`,
        hosts: size,
        scannable: size > 0 && size <= MAX_HOSTS
      });
    }
  }
  return out;
}

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!/^\d{1,3}$/.test(part) || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskBits(netmask) {
  const n = ipToInt(netmask);
  if (n === null) return 0;
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) bits++; else break;
  }
  return bits;
}

/** Usable host count for a mask, excluding network and broadcast. */
function subnetSize(netmask) {
  const bits = maskBits(netmask);
  if (bits >= 31 || bits < 8) return 0;
  return Math.pow(2, 32 - bits) - 2;
}

/**
 * Every usable host address in the subnet of `address`, excluding the network
 * address, the broadcast address, and the scanning machine itself.
 */
function hostsInSubnet(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  if (ip === null || mask === null) return [];
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const out = [];
  for (let n = network + 1; n < broadcast; n++) {
    if (n === ip) continue;
    out.push(intToIp(n >>> 0));
  }
  return out;
}

/**
 * Is there an encoder at this address?
 *
 * A live encoder in Cyclic mode starts streaming the moment the socket opens,
 * so most of the time the answer arrives without asking. One in Polled mode
 * says nothing, which is why the `read` goes out too — and why the reply is
 * matched rather than assumed.
 */
function probe(host, { port = ENCODER_PORT, localAddress = null, timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const opts = { host, port };
    if (localAddress) opts.localAddress = localAddress;

    const socket = net.connect(opts);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();          // held open no longer than identification needs
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    socket.on('error', () => done(null));
    socket.on('connect', () => {
      // Harmless on a running encoder: replies are broadcast to every client,
      // so this neither steals data nor changes anything.
      try { socket.write('read TotalScaledRes\r\n'); } catch { /* handled by error */ }
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > 4096) buf = buf.slice(-4096);

      const reply = /TotalScaledRes\s*=\s*(\d+)/i.exec(buf);
      if (reply) {
        done({ host, port, totalScaledRes: Number(reply[1]), evidence: 'answered read TotalScaledRes' });
        return;
      }
      // ASCII_SHORT samples: two or three space-separated integers per line.
      if (/(^|\n)\s*-?\d+(\s+-?\d+){1,2}\s*\r?\n/.test(buf)) {
        done({ host, port, totalScaledRes: null, evidence: 'streaming position data' });
      }
    });
  });
}

/**
 * Addresses this machine has already exchanged packets with.
 *
 * The subnet sweep can only find an encoder that shares our subnet. One left on
 * a foreign address — the usual state of a unit nobody has commissioned yet —
 * is invisible to it. If that device has spoken at all it is in the neighbour
 * table, so those addresses are worth probing even though they are outside the
 * range being swept.
 *
 * Best effort by design: no `arp` binary, an unparsable format, or a platform
 * that words it differently all end the same way, with an empty list and a
 * scan that carries on.
 */
function arpNeighbours() {
  return new Promise((resolve) => {
    execFile('arp', ['-an'], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const out = [];
      // BSD/macOS: "? (10.10.10.10) at 0:e:cf:14:10:67 on en3 ..."
      // Linux:     "? (10.10.10.10) at 00:0e:cf:14:10:67 [ether] on en3"
      for (const m of stdout.matchAll(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{11,17})/gi)) {
        if (/incomplete/i.test(m[0])) continue;
        out.push({ host: m[1], mac: normaliseMac(m[2]) });
      }
      resolve(out);
    });
  });
}

/** BSD prints `0:e:cf:...`; pad it so prefixes can be compared. */
function normaliseMac(mac) {
  return String(mac).toLowerCase().split(':').map((b) => b.padStart(2, '0')).join(':');
}

/**
 * Scan the subnet of one of this machine's interfaces.
 *
 * @param {object} opts
 * @param {string} opts.localAddress an IPv4 address belonging to this machine
 * @param {number} [opts.port]
 * @param {number} [opts.timeoutMs]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{interface: object, scanned: number, found: Array}>}
 */
async function scanSubnet(opts) {
  const nics = scannableInterfaces();
  const nic = nics.find((n) => n.address === opts.localAddress);
  if (!nic) {
    const err = new Error(`${opts.localAddress} is not an address on this machine`);
    err.code = 'EINVAL';
    throw err;
  }
  if (!nic.scannable) {
    const err = new Error(
      `${nic.name} is a /${maskBits(nic.netmask)} — ${nic.hosts.toLocaleString('en-US')} addresses. ` +
      `Scanning is limited to ${MAX_HOSTS} at a time; enter the address by hand instead.`
    );
    err.code = 'ESUBNETTOOBIG';
    throw err;
  }

  const subnet = hostsInSubnet(nic.address, nic.netmask);

  // Neighbours outside the subnet, appended so a device that has spoken from a
  // foreign address is still offered rather than silently missed.
  const seen = new Set(subnet);
  const strangers = (await arpNeighbours())
    .filter((n) => !seen.has(n.host) && n.host !== nic.address);
  const hosts = subnet.concat(strangers.map((n) => n.host));

  const found = [];
  let index = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= hosts.length) return;
      const hit = await probe(hosts[i], {
        port: opts.port || ENCODER_PORT,
        localAddress: nic.address,
        timeoutMs: opts.timeoutMs || 700
      });
      done++;
      if (hit) found.push(hit);
      if (opts.onProgress) opts.onProgress(done, hosts.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, worker));
  found.sort((a, b) => (ipToInt(a.host) - ipToInt(b.host)));

  // A device from the same manufacturer that did not answer is worth naming.
  // It is almost always an encoder holding an address on another subnet, and
  // the answer to that is a hardware switch, not more scanning.
  const answered = new Set(found.map((f) => f.host));
  const silentKin = strangers.filter((n) =>
    !answered.has(n.host) && ENCODER_OUIS.some((o) => n.mac.startsWith(o)));

  return { interface: nic, scanned: hosts.length, found, silentKin };
}

/**
 * Read variables from an encoder without holding a connection open.
 *
 * The configuration channel *is* the data channel, so a stopped connection has
 * no socket to ask down — which meant a stopped encoder's settings could not be
 * looked at at all. This opens one, asks, and closes, exactly as discovery
 * does. The cost is one of the device's few client slots for a fraction of a
 * second, which is why it is a deliberate one-shot rather than something the
 * screen does on a timer.
 *
 * Serialised: one outstanding request at a time, because the encoder's replies
 * are broadcast to every client and are matched by name, not by sequence.
 *
 * @returns {Promise<Object<string, {ok: boolean, value?: string, error?: string}>>}
 */
function readVariablesOnce(host, names, { port = ENCODER_PORT, localAddress = null,
  connectTimeoutMs = 2000, perReadMs = 1200, onLog = null } = {}) {
  const log = onLog || (() => {});
  return new Promise((resolve, reject) => {
    const out = {};
    let queue = names.slice();
    let current = null;
    let buf = '';
    let timer = null;
    let settled = false;

    const opts = { host, port };
    if (localAddress) opts.localAddress = localAddress;
    const socket = net.connect(opts);
    socket.setNoDelay(true);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err); else resolve(out);
    };

    const next = () => {
      clearTimeout(timer);
      if (!queue.length) return finish(null);
      current = queue.shift();
      timer = setTimeout(() => {
        out[current] = { ok: false, error: 'no answer' };
        next();
      }, perReadMs);
      log('info', 'tx', `read ${current}`);
      try { socket.write(`read ${current}\r\n`); } catch (e) { finish(e); }
    };

    timer = setTimeout(() => finish(Object.assign(new Error(
      `${host}:${port} did not answer`), { code: 'EUNREACHABLE' })), connectTimeoutMs);

    socket.on('error', (err) => {
      log('error', 'tx', `${host}:${port} — ${err.message}`);
      finish(Object.assign(err, { code: err.code || 'EUNREACHABLE' }));
    });
    socket.on('connect', () => {
      log('info', 'tx', `opened a one-shot session to ${host}:${port} (connection is stopped)`);
      next();
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (!current || !line) continue;
        // `Var=Value`, or the encoder's refusal for a variable it does not know.
        const m = new RegExp(`^${current}\\s*=\\s*(.*)$`, 'i').exec(line);
        if (m) {
          out[current] = { ok: true, value: m[1].trim() };
          log('info', 'rx', `${current}=${m[1].trim()}`);
          next();
          continue;
        }
        if (/^ERROR/i.test(line)) {
          out[current] = { ok: false, error: line };
          log('error', 'rx', line);
          next();
        }
      }
      if (buf.length > 8192) buf = buf.slice(-8192);
    });
  });
}

/**
 * Write variables to an encoder that is not connected.
 *
 * The device acknowledges a `set` by echoing `<Variable>=<Value>` — the new
 * value on success, the *old* one on a refusal — so the echo, matched by value
 * (not just by name), is the confirmation. It commits to flash a moment later
 * and *sometimes* announces `Parameters successfully written!`, but that
 * broadcast is unreliable (an IP or CycleTime write is accepted and never
 * announced), so nothing waits for it: the echo is enough, the same as the
 * running-connection path. `committed` reports whether a broadcast happened to
 * arrive before the writes finished — a bonus, never depended on.
 *
 * @returns {Promise<{results: Array, committed: boolean}>}
 */
function writeVariablesOnce(host, entries, { port = ENCODER_PORT, localAddress = null,
  connectTimeoutMs = 2000, perWriteMs = 2000, onLog = null } = {}) {
  const log = onLog || (() => {});
  const fold = (v) => String(v).trim().toLowerCase().replace(/[\s_-]/g, '');

  return new Promise((resolve, reject) => {
    const results = [];
    const queue = entries.slice();
    let current = null;
    let usedBare = false;
    let buf = '';
    let timer = null;
    let settled = false;
    let committed = false;

    const opts = { host, port };
    if (localAddress) opts.localAddress = localAddress;
    const socket = net.connect(opts);
    socket.setNoDelay(true);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve({ results, committed });
    };

    const send = (line) => { log('info', 'tx', line); socket.write(`${line}\r\n`); };

    const next = () => {
      clearTimeout(timer);
      // Every write echoed and matched by value — that is the confirmation.
      if (!queue.length) return finish(null);
      current = queue.shift();
      usedBare = false;
      timer = setTimeout(() => {
        results.push({ variable: current.variable, value: current.value, ok: false, error: 'no answer' });
        next();
      }, perWriteMs);
      send(`set ${current.variable}=${current.value}`);
    };

    timer = setTimeout(() => finish(Object.assign(new Error(
      `${host}:${port} did not answer`), { code: 'EUNREACHABLE' })), connectTimeoutMs);

    socket.on('error', (err) => {
      log('error', 'tx', `${host}:${port} — ${err.message}`);
      finish(Object.assign(err, { code: err.code || 'EUNREACHABLE' }));
    });
    socket.on('connect', () => {
      log('info', 'tx', `opened a one-shot session to ${host}:${port} (connection is stopped)`);
      next();
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (!line) continue;

        if (/^parameters\s+successfully\s+written/i.test(line)) {
          log('info', 'rx', 'Parameters successfully written!');
          committed = true;
          if (!current) return finish(null);
          continue;
        }
        if (!current) continue;

        const m = new RegExp(`^${current.variable}\\s*=\\s*(.*)$`, 'i').exec(line);
        if (m) {
          const got = m[1].trim();
          log('info', 'rx', `${current.variable}=${got}`);
          const ok = fold(got) === fold(current.value);
          results.push(ok
            ? { variable: current.variable, value: current.value, ok: true }
            : { variable: current.variable, value: current.value, ok: false,
              error: `refused — the encoder still reports ${got}` });
          next();
          continue;
        }
        if (/^ERROR/i.test(line)) {
          log('error', 'rx', line);
          // The bare dialect is tried once, exactly as the live link does.
          if (!usedBare) {
            usedBare = true;
            send(`${current.variable}=${current.value}`);
            continue;
          }
          results.push({ variable: current.variable, value: current.value, ok: false, error: line });
          next();
        }
      }
      if (buf.length > 8192) buf = buf.slice(-8192);
    });
  });
}

/**
 * Scan every scannable interface in turn — the "Any" answer.
 *
 * "Any" is where a search usually starts: the operator does not know which
 * NIC the encoder hangs off, or they would not be searching. Refusing with
 * "pick an interface first" made the least-informed moment the most demanding
 * one. Sequential per interface, so the probe burst stays one subnet wide at
 * a time; interfaces too large to scan are reported as skipped rather than
 * silently ignored, and a host reachable from two NICs is offered once.
 */
async function scanAllSubnets(opts = {}) {
  const out = { interfaces: [], scanned: 0, found: [], silentKin: [], skipped: [] };
  const seenHosts = new Set();
  const seenKin = new Set();
  for (const nic of scannableInterfaces()) {
    if (!nic.scannable) {
      out.skipped.push(nic);
      continue;
    }
    const r = await scanSubnet({ localAddress: nic.address, port: opts.port, timeoutMs: opts.timeoutMs });
    out.interfaces.push(nic);
    out.scanned += r.scanned;
    for (const f of r.found) {
      if (!seenHosts.has(f.host)) { seenHosts.add(f.host); out.found.push(f); }
    }
    for (const k of r.silentKin) {
      if (!seenKin.has(k.mac)) { seenKin.add(k.mac); out.silentKin.push(k); }
    }
  }
  out.found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
  return out;
}

module.exports = {
  scanSubnet, scanAllSubnets, scannableInterfaces, probe, readVariablesOnce, writeVariablesOnce,
  hostsInSubnet, subnetSize, maskBits,
  ipToInt, intToIp, normaliseMac, arpNeighbours, ENCODER_PORT, MAX_HOSTS, ENCODER_OUIS
};
