'use strict';
/**
 * Input validation for everything crossing into the bridge.
 *
 * Every payload is treated as untrusted. That mattered when the only caller was
 * our own sandboxed renderer; it matters far more now that the same operations
 * are reachable over HTTP, where the caller may be any browser on the show LAN.
 *
 * The sharpest edge is the encoder command channel: data and commands share one
 * TCP socket, so a value containing CR or LF becomes an extra command. Every
 * variable name is checked against the known table and every value is checked
 * for line breaks.
 */

const os = require('node:os');
const net = require('node:net');

const constants = require('../shared/constants');
const { ENCODER_VAR_BY_NAME, VELOCITY_POLICIES, UDP_SEND_POLICIES } = constants;
const { assertSafeValue } = require('../core/encoder-link');

/** Sanity bound on fan-out. A redundant disguise rig is a handful of machines. */
const MAX_DESTINATIONS = 16;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function checkHost(value, label) {
  const s = String(value || '').trim();
  if (!s) fail('EINVAL', `${label} is required`);
  if (net.isIP(s)) return s;
  // Allow hostnames too — some installations use DNS names for show servers.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(s)) {
    fail('EINVAL', `${label} is not a valid IP address or hostname: ${s}`);
  }
  return s;
}

function checkPort(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail('EINVAL', `${label} must be between 1 and 65535`);
  return n;
}

function checkDevid(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) fail('EINVAL', 'Device ID must be between 0 and 65535');
  return n;
}

function checkId(value) {
  const s = String(value || '');
  if (!s) fail('EINVAL', 'Connection id is required');
  return s;
}

function checkVariable(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) fail('EINVAL', `Not a valid variable name: ${s}`);
  if (!ENCODER_VAR_BY_NAME.has(s.toLowerCase())) {
    fail('EINVAL', `${s} is not a known encoder variable`);
  }
  // Return the table's canonical spelling: the encoder is case-sensitive.
  return ENCODER_VAR_BY_NAME.get(s.toLowerCase()).name;
}

function checkValue(value) {
  const s = String(value);
  // The single most important check in this file.
  assertSafeValue(s);
  if (s.length > 256) fail('EINVAL', 'Value is too long');
  return s;
}

/** Case- and separator-insensitive, because the device answers `CYCLIC`. */
function foldKey(v) {
  return String(v).trim().toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * A value checked against the variable it is being written to.
 *
 * `checkValue` alone only stops a line break turning into a second command,
 * which is the dangerous case but not the only one: without this, `set
 * CycleTime=abc`, a negative resolution or a malformed address all travelled to
 * the encoder to be rejected there — a round trip, an ERROR line in front of
 * the operator, and for the ranged variables a value the firmware may accept
 * and then behave oddly on. Everything the table knows about a variable is
 * enforced here, on the server, where a hand-made HTTP request meets it too.
 *
 * @returns {{variable: string, value: string}} canonical spellings for both
 */
function checkVarWrite(name, value) {
  const variable = checkVariable(name);
  const raw = checkValue(value).trim();
  const spec = ENCODER_VAR_BY_NAME.get(variable.toLowerCase());

  if (spec.type === 'int') {
    if (!/^-?\d+$/.test(raw)) fail('EINVAL', `${variable} takes a whole number, not "${raw}"`);
    const n = Number(raw);
    const min = spec.min === undefined ? -Infinity : spec.min;
    const max = spec.max === undefined ? Infinity : spec.max;
    if (n < min || n > max) {
      fail('EINVAL', `${variable} must be between ${min} and ${max}${spec.unit ? ` ${spec.unit}` : ''}`);
    }
    return { variable, value: String(n) };
  }

  if (spec.type === 'enum') {
    const key = foldKey(raw);
    const match = spec.values.find((v) => foldKey(v) === key) ||
      (spec.aliases && spec.aliases[key]);
    if (!match) fail('EINVAL', `${variable} must be one of: ${spec.values.join(', ')}`);
    // Recognised, so it can be displayed and repaired — but refused as a write.
    if ((spec.unsupported || []).includes(match)) {
      fail('EINVAL', `${variable}=${match} is not supported by this app and would stop the stream`);
    }
    return { variable, value: match };
  }

  if (spec.type === 'flags') {
    // A concatenation of the declared tokens, e.g. Position_Velocity_. Empty is
    // legitimate: it is how you tell the encoder to send nothing.
    let rest = raw;
    const picked = [];
    while (rest.length) {
      const flag = spec.flags.find((f) => foldKey(rest).startsWith(foldKey(f)));
      if (!flag) fail('EINVAL', `${variable} must be made of: ${spec.flags.join(', ')}`);
      picked.push(flag);
      rest = rest.slice(flag.length);
    }
    // Checked, not rewritten. Rebuilding from the canonical spelling would undo
    // the caller's choice of dialect — and this firmware refuses the manual's
    // `Position_Velocity_` in favour of its own `POSITION_VELOCITY`.
    return { variable, value: raw };
  }

  if (spec.type === 'ip') {
    const parts = raw.split('.');
    const ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
    if (!ok) fail('EINVAL', `${variable} must be an address a.b.c.d with each part 0 to 255`);
    return { variable, value: parts.map((p) => String(Number(p))).join('.') };
  }

  return { variable, value: raw };
}

/** Normalise an incoming connection object down to fields we recognise. */
function sanitiseConnection(raw) {
  if (!raw || typeof raw !== 'object') fail('EINVAL', 'Expected a connection object');
  const out = {};
  if (raw.id) out.id = checkId(raw.id);
  out.name = String(raw.name || 'Encoder').slice(0, 120);
  out.autoStart = !!raw.autoStart;
  out.logRaw = !!raw.logRaw;
  out.notes = String(raw.notes || '').slice(0, 2000);

  const enc = raw.encoder || {};
  out.encoder = {
    host: checkHost(enc.host, 'Encoder address'),
    port: checkPort(enc.port, 'Encoder port'),
    localAddress: enc.localAddress ? checkHost(enc.localAddress, 'Local interface') : null,
    // Remembered alongside the address so a DHCP lease change can be reported
    // as "the adapter moved" rather than an opaque bind failure.
    localIfName: enc.localIfName ? String(enc.localIfName).slice(0, 120) : null
  };

  // Destinations. Accepts the schema-1 lone `d3` too, so an older profile or a
  // script written against the previous API still validates.
  const rawDests = Array.isArray(raw.destinations) && raw.destinations.length
    ? raw.destinations
    : [raw.d3 || {}];
  if (rawDests.length > MAX_DESTINATIONS) {
    fail('EINVAL', `At most ${MAX_DESTINATIONS} destinations per encoder`);
  }
  out.destinations = rawDests.map((d, i) => ({
    id: d.id ? String(d.id).slice(0, 64) : `dest-${i}`,
    name: String(d.name || '').slice(0, 120),
    host: checkHost(d.host, 'disguise address'),
    port: checkPort(d.port, 'disguise port'),
    devid: checkDevid(d.devid),
    enabled: d.enabled !== false,
    localAddress: d.localAddress ? checkHost(d.localAddress, 'Local interface') : null,
    localIfName: d.localIfName ? String(d.localIfName).slice(0, 120) : null,
    localPort: d.localPort ? checkPort(d.localPort, 'Local source port') : null
  }));

  // Two destinations on the same address and port would send disguise the same
  // axis twice per sample — harmless for position, but it doubles the traffic
  // and makes the rate figures lie, so it is almost certainly a mistake.
  const seen = new Set();
  for (const d of out.destinations) {
    const key = `${d.host}:${d.port}/${d.devid}`;
    if (seen.has(key)) fail('EINVAL', `Duplicate destination ${key}`);
    seen.add(key);
  }

  // Mirror of the first destination, for the screens that legitimately mean
  // "the primary destination". Derived, never authoritative.
  out.d3 = Object.assign({}, out.destinations[0]);

  out.velocityPolicy = VELOCITY_POLICIES.includes(raw.velocityPolicy) ? raw.velocityPolicy : 'zero';
  out.udpSendPolicy = UDP_SEND_POLICIES.includes(raw.udpSendPolicy) ? raw.udpSendPolicy : 'every';
  out.maxSendHz = Math.max(0, Math.min(2000, Number(raw.maxSendHz) || 0));

  if (raw.parser) {
    out.parser = {
      outputType: String(raw.parser.outputType || 'ASCII_SHORT'),
      autoDetect: raw.parser.autoDetect !== false,
      fields: Array.isArray(raw.parser.fields)
        ? raw.parser.fields.filter((f) => f === 0 || f === 1 || f === 2)
        : null
    };
  }
  if (raw.encoderMeta) {
    out.encoderMeta = {
      countsPerRev: Math.max(1, Number(raw.encoderMeta.countsPerRev) || 8192),
      totalCounts: Math.max(1, Number(raw.encoderMeta.totalCounts) || 33554432),
      cycleTimeMs: Math.max(1, Number(raw.encoderMeta.cycleTimeMs) || 10)
    };
  }
  if (raw.reconnect) {
    out.reconnect = {
      enabled: raw.reconnect.enabled !== false,
      minDelayMs: Math.max(50, Number(raw.reconnect.minDelayMs) || 250),
      maxDelayMs: Math.max(250, Number(raw.reconnect.maxDelayMs) || 5000)
    };
  }
  if (raw.mapping && typeof raw.mapping === 'object') {
    const m = raw.mapping;
    out.mapping = {
      mode: ['full', 'revolutions', 'capture'].includes(m.mode) ? m.mode : 'full',
      revolutions: Number(m.revolutions) || 1,
      gearRatio: Number(m.gearRatio) || 1,
      minInput: Number(m.minInput) || 0,
      maxInput: Number(m.maxInput) || 0,
      minOutput: Number(m.minOutput) || 0,
      maxOutput: m.maxOutput === undefined ? 1 : Number(m.maxOutput),
      wrapInput: m.wrapInput !== false,
      property: String(m.property || 'offset.x').slice(0, 200),
      object: String(m.object || '').slice(0, 300)
    };
  }
  return out;
}

/** IPv4 interfaces for the multi-NIC picker on show servers. */
function listInterfaces() {
  const out = [];
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4') continue;
      out.push({ name, address: a.address, cidr: a.cidr, internal: a.internal });
    }
  }
  return out;
}

module.exports = {
  fail, checkHost, checkPort, checkDevid, checkId, checkVariable, checkValue, checkVarWrite,
  sanitiseConnection, listInterfaces
};
