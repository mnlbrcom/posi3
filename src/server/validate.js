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

  const d3 = raw.d3 || {};
  out.d3 = {
    host: checkHost(d3.host, 'disguise address'),
    port: checkPort(d3.port, 'disguise port'),
    devid: checkDevid(d3.devid),
    localAddress: d3.localAddress ? checkHost(d3.localAddress, 'Local interface') : null,
    localIfName: d3.localIfName ? String(d3.localIfName).slice(0, 120) : null,
    localPort: d3.localPort ? checkPort(d3.localPort, 'Local source port') : null
  };

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
  fail, checkHost, checkPort, checkDevid, checkId, checkVariable, checkValue,
  sanitiseConnection, listInterfaces
};
