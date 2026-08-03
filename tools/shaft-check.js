'use strict';
/**
 * Shaft check — confirm an encoder's scaling by turning it.
 *
 * Reads a connection's live position from a running posi3 and measures how far
 * it actually travelled, wrap-aware. Turn the shaft one revolution by hand and
 * it reports the counts per revolution the hardware really delivers, against
 * what the encoder claims its scaling is.
 *
 * Hand accuracy is enough. A few degrees of error moves the measurement by a
 * couple of hundred counts; the failure modes worth catching — wrong
 * resolution, wrong scaling, a gearbox nobody mentioned — are off by whole
 * multiples.
 *
 *   node tools/shaft-check.js
 *   node tools/shaft-check.js --url http://127.0.0.1:8710 --turns 1
 *
 * It waits for motion, accumulates while the shaft moves, and reports once it
 * has been still for a moment — so there is nothing to time.
 */

const http = require('node:http');
const { parseArgs } = require('./cli-args');

const opts = parseArgs(process.argv, {
  url: 'http://127.0.0.1:8710',
  id: '',
  turns: 1,
  /** Consider the shaft stopped after this long with no change. */
  settleMs: 2000
});

function post(path, body) {
  const data = JSON.stringify(body === undefined ? null : body);
  const u = new URL(opts.url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: `/api/${path}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(s);
          parsed.ok ? resolve(parsed.data) : reject(new Error(parsed.error.message));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Shortest signed distance between two positions on a circular scale.
 *
 * Without this a rollover reads as a nearly-full-scale jump backwards, and one
 * wrap during the turn would ruin the measurement.
 */
function wrapDelta(from, to, total) {
  let d = to - from;
  if (d > total / 2) d -= total;
  else if (d < -total / 2) d += total;
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = await post('configGet');
  const conns = profile.connections || [];
  if (!conns.length) throw new Error('no connections configured');
  const conn = opts.id ? conns.find((c) => c.id === opts.id) : conns[0];
  if (!conn) throw new Error(`no connection with id ${opts.id}`);

  const first = (await post('linkSnapshot', { id: conn.id }));
  if (!first || !first.telemetry) throw new Error('connection is not running — start it first');

  const total = first.telemetry.totalCounts;
  const claimed = first.telemetry.countsPerRev;
  const turns = Number(opts.turns) || 1;

  process.stdout.write(`shaft check — ${conn.name} (${conn.encoder.host})\n`);
  process.stdout.write(`  encoder claims ${claimed} counts/rev over ${total} counts ` +
    `(${(total / claimed).toFixed(2)} revolutions of travel)\n\n`);
  process.stdout.write(`  turn the shaft ${turns === 1 ? 'one full revolution' : `${turns} revolutions`}, ` +
    'then let it rest.\n  waiting for motion…\n');

  let prev = first.telemetry.pos;
  let travelled = 0;
  let moving = false;
  let lastMoveAt = 0;
  let peak = 0;
  let reversals = 0;
  let lastSign = 0;

  for (;;) {
    await sleep(30);
    const t = (await post('linkSnapshot', { id: conn.id })).telemetry;
    const d = wrapDelta(prev, t.pos, total);
    prev = t.pos;

    if (d !== 0) {
      if (!moving) {
        moving = true;
        process.stdout.write('  moving…\n');
      }
      travelled += d;
      lastMoveAt = Date.now();
      const sign = Math.sign(d);
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) reversals++;
      if (sign !== 0) lastSign = sign;
      peak = Math.max(peak, Math.abs(travelled));
      // Carriage-return progress only makes sense on a terminal; through a
      // pipe every update becomes its own line and buries the result.
      if (process.stdout.isTTY) {
        process.stdout.write(
          `\r  travelled ${String(Math.round(travelled)).padStart(8)} counts` +
          `  =  ${(Math.abs(travelled) / claimed).toFixed(3)} rev at the claimed scaling   `);
      }
    } else if (moving && Date.now() - lastMoveAt > Number(opts.settleMs)) {
      break;
    }
  }

  const measured = Math.abs(travelled) / turns;
  const errPct = ((measured - claimed) / claimed) * 100;
  const impliedDeg = (Math.abs(travelled) / claimed) * 360;

  process.stdout.write(`${process.stdout.isTTY ? '\n' : ''}\n  --- result ---\n`);
  process.stdout.write(`  travelled          ${Math.round(travelled)} counts ` +
    `(${travelled < 0 ? 'counter-clockwise' : 'clockwise'})\n`);
  process.stdout.write(`  that is            ${impliedDeg.toFixed(1)}deg at the claimed scaling\n`);
  process.stdout.write(`  counts per turn    ${measured.toFixed(0)}\n`);
  process.stdout.write(`  encoder claims     ${claimed}\n`);
  process.stdout.write(`  difference         ${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)}%` +
    ` (${Math.round(measured - claimed)} counts)\n`);
  if (reversals) process.stdout.write(`  direction changes  ${reversals} — the shaft was rocked, not turned cleanly\n`);

  // A hand-turned revolution lands within a few degrees. Anything inside 10%
  // is the scaling being right; anything outside is a different animal —
  // wrong resolution, an unmentioned gearbox, or a mis-set scaling.
  process.stdout.write('\n  ');
  if (Math.abs(errPct) <= 10) {
    process.stdout.write(`CONFIRMED — ${measured.toFixed(0)} counts/rev matches the claimed ${claimed} ` +
      `within hand-turning accuracy.\n`);
    process.exit(0);
  } else {
    process.stdout.write(`MISMATCH — measured ${measured.toFixed(0)} counts/rev against a claimed ${claimed}.\n`);
    process.stdout.write(`  ratio ${(measured / claimed).toFixed(3)} — check UsedScopeOfPhysRes / TotalScaledRes, ` +
      'or whether there is a gearbox between the shaft and the set.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`shaft check failed: ${err.message}\n`);
  process.exit(2);
});
