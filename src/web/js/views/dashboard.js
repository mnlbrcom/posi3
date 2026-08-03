/**
 * Dashboard — every encoder at a glance.
 *
 * The one screen to leave open during a show. It answers three questions
 * without a click: is each encoder streaming, is disguise receiving, and is
 * anything degrading.
 *
 * Two clocks, as everywhere in this UI: the card structure is rebuilt only when
 * the profile or a link's state name changes, while the numbers are repainted
 * from the shared requestAnimationFrame loop through `setText`, which skips the
 * write when the string is unchanged. A 500 Hz link never triggers a re-render.
 */

import { el, clear, pill, groupDigits, fixed, hz, micros, duration, setText, svgEl } from '../ui.js';
import { store } from '../store.js';

/** Seconds of position history kept per encoder for the sparkline. */
const TRACE_SECONDS = 12;
const TRACE_POINTS = 120;

/**
 * Position history, keyed by connection id. Lives at module scope so it
 * survives navigation — coming back to the dashboard should not blank the
 * traces. Trimmed whenever a connection disappears.
 */
const traces = new Map();

function pushTrace(id, pos) {
  let t = traces.get(id);
  if (!t) { t = []; traces.set(id, t); }
  const last = t[t.length - 1];
  if (last && last.pos === pos && t.length > 1) {
    last.t = Date.now(); // idle: extend the flat run rather than growing forever
    return t;
  }
  t.push({ t: Date.now(), pos });
  if (t.length > TRACE_POINTS) t.splice(0, t.length - TRACE_POINTS);
  return t;
}

export function renderDashboard(root) {
  clear(root);
  const view = el('div', { class: 'view' });
  const conns = store.connections;

  // Drop traces for connections that no longer exist.
  for (const id of [...traces.keys()]) {
    if (!conns.some((c) => c.id === id)) traces.delete(id);
  }

  view.appendChild(el('div', { class: 'view-head' },
    el('h1', { text: 'Dashboard' }),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn', text: 'Start all',
      onclick: () => window.d3d.link.startAll().catch(() => {})
    }),
    el('button', {
      class: 'btn', text: 'Stop all',
      onclick: () => window.d3d.link.stopAll().catch(() => {})
    })));

  if (!conns.length) {
    view.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No encoders configured' }),
      el('p', { text: 'Add one on the Connections screen to start bridging to disguise.' }),
      el('button', {
        class: 'btn primary', text: 'Go to Connections',
        onclick: () => store.setView('connections')
      })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  // -- summary strip --------------------------------------------------------
  // One hero figure for the view: total datagrams per second reaching disguise.
  // That is the number that means "the show is being driven".
  const heroValue = el('div', { class: 'hero-value', text: '—' });
  const heroNote = el('div', { class: 'hero-note', text: 'to disguise' });
  const summaryStats = {
    streaming: statTile('Streaming', 'of ' + conns.length),
    inRate: statTile('Samples in', 'per second'),
    faults: statTile('Faults', 'none')
  };

  view.appendChild(el('div', { class: 'summary' },
    el('div', { class: 'hero' },
      el('div', { class: 'hero-label', text: 'Packets out' }),
      heroValue, heroNote),
    el('div', { class: 'summary-stats' },
      summaryStats.streaming.node,
      summaryStats.inRate.node,
      summaryStats.faults.node)));

  // -- one card per encoder -------------------------------------------------
  const cards = conns.map((conn) => buildCard(conn));
  view.appendChild(el('div', { class: 'dash-grid' }, ...cards.map((c) => c.node)));

  root.appendChild(view);

  return {
    refreshLive() {
      let out = 0;
      let inRate = 0;
      let streaming = 0;
      // Counted apart, because "9 faults" says nothing an operator can act on.
      // A dead destination and a misconfigured encoder need opposite responses.
      let sendFails = 0;
      let encoderErrors = 0;
      let unparsed = 0;
      const unreachable = [];
      const faulted = new Set();

      for (const card of cards) {
        const t = card.refresh();
        if (!t) continue;
        out += t.txHz || 0;
        inRate += t.rxHz || 0;
        if (t.state === 'streaming') streaming++;
        sendFails += t.txErrors || 0;
        encoderErrors += t.errors || 0;
        unparsed += t.unknownLines || 0;
        for (const d of t.destinations || []) {
          // Named by connection *and* destination: with several encoders,
          // "cannot reach 10.10.10.5:6000" does not say whose link is failing.
          if (d.txErrors) unreachable.push(`${card.name} → ${d.name || `${d.host}:${d.port}`}`);
        }
        if ((t.errors || 0) + (t.unknownLines || 0) > 0) faulted.add(card.name);
      }
      const faults = sendFails + encoderErrors + unparsed;

      setText(heroValue, hz(out));
      setText(heroNote, out > 0 ? 'to disguise' : 'nothing being sent');
      setText(summaryStats.streaming.value, String(streaming));
      setText(summaryStats.inRate.value, hz(inRate));
      setText(summaryStats.faults.value, groupDigits(faults));
      summaryStats.faults.value.classList.toggle('bad', faults > 0);
      // Name the dominant cause. Sending is listed first because an
      // unreachable destination is the one an operator can usually fix.
      setText(summaryStats.faults.caption,
        !faults ? 'none'
          : sendFails ? `cannot reach ${[...new Set(unreachable)].join(', ') || 'a destination'}`
            : encoderErrors ? `errors from ${[...faulted].join(', ') || 'the encoder'}`
              : `unparsed lines from ${[...faulted].join(', ') || 'the encoder'}`);
      summaryStats.faults.node.title = faults
        ? `${sendFails} send failures · ${encoderErrors} encoder errors · ${unparsed} unparsed lines`
        : '';
    }
  };
}

/** Label + big value + caption. Some captions carry the explanation. */
function statTile(label, caption) {
  const value = el('div', { class: 'stat-value', text: '—' });
  const cap = el('div', { class: 'stat-caption', text: caption });
  const node = el('div', { class: 'stat' },
    el('div', { class: 'stat-label', text: label }),
    value, cap);
  return { node, value, caption: cap };
}

function buildCard(conn) {
  const pillHolder = el('span', { class: 'pill-holder' });
  const detail = el('div', { class: 'card-detail', text: '' });

  // Position is the headline. Tabular figures on purpose: this repaints many
  // times a second and proportional digits make the whole card twitch as the
  // value changes width. (The usual advice — proportional for big standalone
  // numbers — assumes a value that sits still.)
  const posValue = el('div', { class: 'card-pos', text: '—' });
  const posDerived = el('div', { class: 'card-derived', text: '' });

  const spark = sparkline();

  // Every figure in the summary strip has a counterpart here, so a number seen
  // at the top can always be traced to the connection that produced it.
  const metrics = {
    velocity: metric('Velocity', 'steps/s'),
    rate: metric('In / out', 'Hz'),
    latency: metric('Latency', 'p50 / p99'),
    uptime: metric('Uptime', ''),
    sent: metric('Sent', 'packets out'),
    faults: metric('Faults', 'this connection')
  };
  const faultRow = el('div', { class: 'card-faults' });

  const node = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('button', {
        class: 'card-name', text: conn.name,
        title: 'Open this connection',
        onclick: () => store.setView('detail', conn.id)
      }),
      pillHolder),
    el('div', { class: 'card-target', title: targetTitle(conn) }, targetLine(conn)),
    detail,
    el('div', { class: 'card-body' },
      el('div', { class: 'card-readout' }, posValue, posDerived),
      spark.node),
    el('div', { class: 'card-metrics' },
      metrics.velocity.node, metrics.rate.node, metrics.latency.node,
      metrics.uptime.node, metrics.sent.node, metrics.faults.node),
    faultRow);

  let lastState = null;
  let lastDetailText = null;

  return {
    node,
    name: conn.name,
    refresh() {
      const state = store.stateOf(conn.id);
      const t = store.telemetryOf(conn.id);
      const s = store.states.get(conn.id);

      // Rebuilding the pill every frame was one of the causes of the UI
      // shivering, so only touch it on a real change.
      if (state !== lastState) {
        clear(pillHolder).appendChild(pill(state));
        lastState = state;
      }
      const detailText = s && s.detail ? s.detail : '';
      if (detailText !== lastDetailText) {
        setText(detail, detailText);
        lastDetailText = detailText;
      }

      if (!t) {
        setText(posValue, '—');
        setText(posDerived, '');
        return null;
      }

      setText(posValue, groupDigits(t.pos));
      setText(posDerived, `${fixed(t.angleDeg, 2)}°  ·  rev ${groupDigits(t.revs)}`);
      setText(metrics.velocity.value, groupDigits(t.outVel));
      setText(metrics.rate.value, `${hz(t.rxHz || 0)} / ${hz(t.txHz || 0)}`);
      setText(metrics.latency.value,
        t.latencyUs ? `${micros(t.latencyUs.p50)} / ${micros(t.latencyUs.p99)}` : '—');
      setText(metrics.uptime.value, duration(t.uptimeMs));
      setText(metrics.sent.value, groupDigits(t.txTotal));

      const ownFaults = (t.errors || 0) + (t.txErrors || 0) + (t.unknownLines || 0);
      setText(metrics.faults.value, groupDigits(ownFaults));
      metrics.faults.value.classList.toggle('bad', ownFaults > 0);

      const faults = [];
      if (t.errors) faults.push(`${t.errors} error${t.errors > 1 ? 's' : ''}`);
      if (t.txErrors) faults.push(`${t.txErrors} send failure${t.txErrors > 1 ? 's' : ''}`);
      if (t.unknownLines) faults.push(`${t.unknownLines} unparsed`);
      if (t.reconnects) faults.push(`${t.reconnects} reconnect${t.reconnects > 1 ? 's' : ''}`);
      if (t.wraps) faults.push(`${t.wraps} wrap${t.wraps > 1 ? 's' : ''}`);
      setText(faultRow, faults.join(' · '));
      faultRow.classList.toggle('has-faults', faults.length > 0);

      spark.push(conn.id, t.pos, conn.encoderMeta ? conn.encoderMeta.totalCounts : null);
      return t;
    }
  };
}

/** "encoder → first destination (+N more)". Full list on hover. */
function destsOf(conn) {
  return (conn.destinations && conn.destinations.length ? conn.destinations : [conn.d3])
    .filter(Boolean);
}

function targetLine(conn) {
  const on = destsOf(conn).filter((d) => d.enabled !== false);
  const first = on[0];
  const extra = on.length - 1;
  if (!first) return `${conn.encoder.host}:${conn.encoder.port} → nowhere`;
  return `${conn.encoder.host}:${conn.encoder.port} → ${first.host}:${first.port}` +
    ` · id ${first.devid}${extra > 0 ? `  +${extra} more` : ''}`;
}

function targetTitle(conn) {
  return destsOf(conn)
    .map((d) => `${d.host}:${d.port} · id ${d.devid}${d.enabled === false ? ' (disabled)' : ''}`)
    .join('\n');
}

function metric(label, caption) {
  const value = el('div', { class: 'metric-value', text: '—' });
  const node = el('div', { class: 'metric' },
    el('div', { class: 'metric-label', text: label }),
    value,
    caption ? el('div', { class: 'metric-caption', text: caption }) : null);
  return { node, value };
}

/**
 * A single-series position trace. One series, so no legend — the card names it.
 * Drawn as an SVG polyline rather than a canvas so it scales with the card and
 * inherits theme colours through CSS.
 */
function sparkline() {
  const W = 220;
  const H = 44;
  const line = svgEl('polyline', { class: 'spark-line', points: '', fill: 'none' });
  const svg = svgEl('svg', {
    class: 'spark', viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none', 'aria-hidden': 'true'
  });
  svg.appendChild(line);

  let lastPoints = '';

  return {
    node: el('div', { class: 'spark-wrap' }, svg),
    push(id, pos, totalCounts) {
      const t = pushTrace(id, pos);
      if (t.length < 2) return;

      const now = Date.now();
      const cutoff = now - TRACE_SECONDS * 1000;
      const pts = t.filter((p) => p.t >= cutoff);
      if (pts.length < 2) return;

      // Scale to the range actually visited, not the encoder's full 33.5M
      // counts — otherwise real movement is a flat line. A floor on the span
      // keeps sensor noise from being amplified into a mountain range.
      let min = Infinity;
      let max = -Infinity;
      for (const p of pts) { if (p.pos < min) min = p.pos; if (p.pos > max) max = p.pos; }
      const floor = Math.max(1, (totalCounts || 33554432) / 100000);
      const span = Math.max(max - min, floor);
      const mid = (min + max) / 2;
      const lo = mid - span / 2;

      const t0 = pts[0].t;
      const dt = Math.max(1, now - t0);
      const out = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const x = ((pts[i].t - t0) / dt) * W;
        const y = H - ((pts[i].pos - lo) / span) * (H - 4) - 2;
        out[i] = `${x.toFixed(1)},${y.toFixed(1)}`;
      }
      const points = out.join(' ');
      if (points !== lastPoints) {
        line.setAttribute('points', points);
        lastPoints = points;
      }
    }
  };
}
