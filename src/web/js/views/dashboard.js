/**
 * Dashboard — every encoder at a glance.
 *
 * The one screen to leave open during a show. It answers three questions
 * without a click: is each encoder streaming, is disguise receiving, and is
 * anything degrading.
 *
 * Everything an encoder has to say lives here, in one card per encoder — dial,
 * live values and stream health side by side. There used to be a second,
 * per-connection page carrying the dial and the readouts, which meant the same
 * question was answered in two places and neither was complete. That page now
 * holds only the controls, which are not something you watch.
 *
 * Two clocks, as everywhere in this UI: the card structure is rebuilt only when
 * the profile or a link's state name changes, while the numbers are repainted
 * from the shared requestAnimationFrame loop through `setText`, which skips the
 * write when the string is unchanged. A 500 Hz link never triggers a re-render.
 */

import { el, clear, pill, groupDigits, fixed, hz, steady, micros, microsToClock, duration, setText, svgEl } from '../ui.js';
import { store } from '../store.js';
import { Dial, TravelBar } from '../components/dial.js';
import { inputSpan } from '../mapping-span.js';
import { openEditor } from './connections.js';
import { openControls } from './detail.js';

/** Seconds of position history kept per encoder for the sparkline. */
const TRACE_SECONDS = 12;
/**
 * A ceiling on memory, not the window — the window is time.
 *
 * This was 120, while telemetry arrives at 30 Hz: a moving encoder produced 360
 * points in twelve seconds and the oldest 240 were thrown away, so a graph
 * labelled "last 12 s" held about four and stretched them across the full
 * width. Sized for the fastest telemetry the settings allow (120 Hz) with room
 * to spare; trimming is by age.
 */
const TRACE_POINTS = 2048;

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
  const now = Date.now();
  t.push({ t: now, pos });

  // By age, so the buffer holds the window the graph claims. One point older
  // than the cutoff is kept deliberately: it is the one the leftmost segment is
  // drawn from, and dropping it made the line start partway across.
  const cutoff = now - TRACE_SECONDS * 1000;
  let keepFrom = 0;
  while (keepFrom + 1 < t.length && t[keepFrom + 1].t < cutoff) keepFrom++;
  if (keepFrom > 0) t.splice(0, keepFrom);
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

  // Title, the two global actions and the four totals are one object. They were
  // three stacked bands before — a heading, a hero panel and a row of tiles —
  // which spent the top third of the screen restating that this is the
  // dashboard. The `view-head` class is kept so the header behaves like every
  // other screen's; only its spacing differs inside the panel.
  const summaryStats = {
    out: statTile('Packets out', 'to disguise'),
    streaming: statTile('Streaming', 'of ' + conns.length),
    inRate: statTile('Samples in', 'per second'),
    faults: statTile('Faults', 'none')
  };

  // One per figure: each holds its own last-shown value.
  const steadyOut = steady();
  const steadyIn = steady();

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head dash-head' },
      el('h1', { text: 'Dashboard' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn', text: 'Start All',
        onclick: () => window.d3d.link.startAll().catch(() => {})
      }),
      el('button', {
        class: 'btn', text: 'Stop All',
        onclick: () => window.d3d.link.stopAll().catch(() => {})
      })),
    el('div', { class: 'summary-stats' },
      summaryStats.out.node,
      summaryStats.streaming.node,
      summaryStats.inRate.node,
      summaryStats.faults.node)));

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

  // -- one card per encoder -------------------------------------------------
  const cards = conns.map((conn) => buildCard(conn));
  view.appendChild(el('div', { class: 'dash-list' }, ...cards.map((c) => c.node)));

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
      const perConnection = [];

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

        const parts = [];
        if (t.errors) parts.push(`${t.errors} error${t.errors > 1 ? 's' : ''}`);
        if (t.txErrors) parts.push(`${t.txErrors} send failure${t.txErrors > 1 ? 's' : ''}`);
        if (t.unknownLines) parts.push(`${t.unknownLines} unparsed`);
        if (parts.length) perConnection.push({ name: card.name, parts });
      }
      const faults = sendFails + encoderErrors + unparsed;

      setText(summaryStats.out.value, hz(steadyOut(out)));
      setText(summaryStats.out.caption, out > 0 ? 'to disguise' : 'nothing being sent');
      setText(summaryStats.streaming.value, String(streaming));
      setText(summaryStats.inRate.value, hz(steadyIn(inRate)));
      setText(summaryStats.faults.value, groupDigits(faults));
      summaryStats.faults.value.classList.toggle('bad', faults > 0);
      // Name the dominant cause. Sending is listed first because an
      // unreachable destination is the one an operator can usually fix.
      setText(summaryStats.faults.caption,
        !faults ? 'none'
          : sendFails ? `cannot reach ${nameList([...new Set(unreachable)], 'destination')}`
            : encoderErrors ? `errors from ${nameList([...faulted], 'connection')}`
              : `unparsed lines from ${nameList([...faulted], 'connection')}`);
      // The caption has one line and cannot hold ten names, so the breakdown
      // lives here: per connection, then the totals by kind.
      const title = faults
        ? perConnection.map((f) => `${f.name}: ${f.parts.join(', ')}`).join('\n') +
          `\n\n${sendFails} send failures · ${encoderErrors} encoder errors · ${unparsed} unparsed lines`
        : '';
      // Only on change: this runs per frame, and .title is an attribute write.
      if (summaryStats.faults.node.title !== title) summaryStats.faults.node.title = title;
    }
  };
}

/**
 * Name a couple, then count the rest.
 *
 * The caption is a single ellipsised line. Joining every name read fine with
 * two encoders and became "errors from A, B, C…" with ten — a list long enough
 * to be useless and short enough to look complete. Two names and a count says
 * more in less room, and the full breakdown is on the tile's hover.
 */
function nameList(names, noun) {
  if (!names.length) return `a ${noun}`;
  if (names.length <= 2) return names.join(' and ');
  return `${names.length} ${noun}s`;
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

  const dial = new Dial();
  const travel = new TravelBar();
  const spark = sparkline();
  const basis = readingBasis();
  const steadyRx = steady();
  const steadyTx = steady();

  const destPills = el('span', { class: 'dest-pills' });
  let lastHealth = '';

  // Two columns of figures, deliberately split by the question they answer.
  // "Live values" is what the encoder is doing; "Stream" is whether the bridge
  // is keeping up with it. Mixing them is what made the old layout hard to read
  // at a glance — a bad latency figure sat between two position readings.
  const live = readouts([
    ['pos', 'Position', 'lg'],
    ['angle', 'Angle'],
    ['rev', 'Revolution'],
    ['rpm', 'Speed'],
    ['rawvel', 'Velocity raw'],
    ['outvel', 'Velocity sent'],
    ['ts', 'Timestamp']
  ]);
  const stream = readouts([
    ['rate', 'RX / TX'],
    ['lat', 'App latency'],
    ['gap', 'Arrival gap'],
    ['up', 'Uptime'],
    ['sent', 'Sent'],
    ['faults', 'Faults']
  ]);

  const node = el('div', { class: 'card encoder-card' },
    // One row of devices: the encoder first, then every machine it feeds. Each
    // is built the same way — name and indicator on a line, address beneath —
    // so the row reads across as "this device, going to these", rather than
    // down as though the destinations belonged to something above them.
    el('div', { class: 'card-head' },
      el('div', { class: 'card-ident' },
        el('div', { class: 'card-ident-head' },
          el('span', { class: 'card-name', text: conn.name }),
          pillHolder),
        el('div', {
          class: 'card-addr',
          title: conn.encoder.pendingHost
            ? `${conn.encoder.pendingHost} is stored on the encoder and takes effect after a power cycle`
            : undefined
        }, `${conn.encoder.host}:${conn.encoder.port}`)),
      // A fan-out has several places the data has to arrive, and "the encoder
      // is streaming" says nothing about whether any of them received it.
      destPills,
      // Same class as Start All / Stop All: these are the same kind of thing,
      // and a smaller ghost button read as a link rather than an action.
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn', text: 'Controls', onclick: () => openControls(conn) }),
        el('button', { class: 'btn', text: 'Edit', onclick: () => openEditor(conn) }))),
    el('div', { class: 'encoder-cols' },
      el('div', { class: 'encoder-pane encoder-dial' },
        dial.node,
        travel.node,
        dialLegend(),
        basis.node),
      el('div', { class: 'encoder-pane encoder-col' },
        el('div', { class: 'col-label', text: 'Live values' }), live.node),
      el('div', { class: 'encoder-pane encoder-col' },
        el('div', { class: 'col-label', text: 'Stream' }), stream.node,
        // The trace belongs with the stream figures rather than in a strip of
        // its own: it is the same question — is data still arriving — drawn
        // instead of counted, and it fills the space the figures leave.
        el('div', { class: 'encoder-trace' },
          el('div', { class: 'col-label', text: `Position, last ${TRACE_SECONDS} s` }),
          spark.node))));

  // The travel bar shows the range being sent to disguise. Since schema 4 that
  // belongs to a receiver, and a fan-out has several — the first enabled one is
  // what the dial describes, which is the same one it described before.
  const firstDest = (conn.destinations || []).find((d) => d.enabled !== false) ||
    (conn.destinations || [])[0];
  const mapping = (firstDest && firstDest.mapping) || { mode: 'full' };

  let lastState = null;

  return {
    node,
    name: conn.name,
    refresh() {
      const t = store.telemetryOf(conn.id);

      // Rebuilding the pill every frame was one of the causes of the UI
      // shivering, so only touch it on a real change. The pill is the card's
      // one statement about state: retry countdowns, attempt numbers and
      // error strings stay behind the scenes, in the log.
      const shown = store.encoderIndicator(conn.id);
      if (shown !== lastState) {
        clear(pillHolder).appendChild(pill(shown));
        lastState = shown;
      }
      // While streaming the detail is "receiving from <host>", and the host is
      // already on the line above — so it is shown only for the states where it
      // carries something the card does not already say: which interface is
      // being tried, how long until the next retry, why a connection failed.
      // Rebuilt only when something actually changed: this runs every frame,
      // and replacing the nodes each time is what made earlier versions of this
      // card shiver.
      const dests = (t && t.destinations) || [];
      const key = dests.map((d) => `${d.id}:${d.health}`).join('|');
      if (key !== lastHealth) {
        lastHealth = key;
        clear(destPills);
        for (const d of dests) {
          const where = `${d.host}:${d.port}`;
          // The indicator is the state and nothing else. Folding the name and
          // the address into the pill made the whole block read as one badge,
          // and a pill that contains an address is no longer a status light.
          const p = pill(d.health);
          p.classList.add('dest-pill');
          destPills.appendChild(el('div', {
            class: 'dest-item',
            title: d.health === 'refused'
              ? 'The machine is reachable but nothing is listening on that port, so disguise is probably not running'
              : d.health === 'offline'
                ? 'No answer from the machine at all'
                : undefined
          },
          el('div', { class: 'dest-item-head' },
            // The operator's word for the machine leads: "director" is what
            // they call it, and the address below says which one that is.
            el('span', { class: 'dest-item-name', text: d.name || where }, ), p),
          el('div', { class: 'dest-item-addr', text: `${where} · id ${d.devid}` })));
        }
      }


      // Revolutions of travel as the *encoder* reports its scaling, not as the
      // type label implies. A commissioned unit is often nothing like its
      // nameplate — the reference encoder reports 300 000 counts, 36.62
      // revolutions, against a nameplate 33 554 432 and 4 096.
      const revsAvailable = t && t.totalCounts && t.countsPerRev
        ? t.totalCounts / t.countsPerRev
        : store.info.constants.REVOLUTIONS;
      dial.update(t, revsAvailable);

      if (!t) {
        for (const k of Object.keys(live.cells)) setText(live.cells[k], null);
        for (const k of Object.keys(stream.cells)) setText(stream.cells[k], null);
        return null;
      }
      // Computed from the *device's* scaling each frame, not from the stored
      // maxInput: for mode 'full' that field is a creation-time default and on
      // a re-scaled encoder it is wrong by two orders of magnitude.
      const span = inputSpan({
        mode: mapping.mode,
        minInput: mapping.minInput,
        maxInput: mapping.maxInput,
        revolutions: mapping.revolutions,
        gearRatio: mapping.gearRatio,
        countsPerRev: t.countsPerRev,
        totalCounts: t.totalCounts
      });
      travel.update(t.pos, span.minInput, span.maxInput);
      basis.update(t, span, mapping);

      const revDigits = revsAvailable < 100 ? 2 : 0;
      setText(live.cells.pos, groupDigits(t.pos));
      setText(live.cells.angle, `${fixed(t.angleDeg, 2)}°`);
      setText(live.cells.rev, `${groupDigits(t.revs)} / ${fixed(revsAvailable, revDigits)}`);
      setText(live.cells.rpm, `${fixed(t.rpm, 1)} rpm`);
      setText(live.cells.rawvel, t.rawVel === null || t.rawVel === undefined
        ? 'not sent' : `${groupDigits(t.rawVel)} steps/s`);
      setText(live.cells.outvel, `${groupDigits(t.outVel)} steps/s`);
      // Shown as time since the encoder powered up; the raw counter is on hover
      // for anyone correlating against a capture.
      setText(live.cells.ts, microsToClock(t.ts));
      live.cells.ts.title = t.ts === null || t.ts === undefined
        ? '' : `${groupDigits(t.ts)} µs since the encoder started`;

      setText(stream.cells.rate, `${hz(steadyRx(t.rxHz || 0))} / ${hz(steadyTx(t.txHz || 0))} Hz`);
      setText(stream.cells.lat,
        t.latencyUs ? `${micros(t.latencyUs.p50)} · ${micros(t.latencyUs.p99)}` : '—');
      setText(stream.cells.gap, t.gapMs ? `${fixed(t.gapMs.p50, 2)} ms` : '—');
      setText(stream.cells.up, duration(t.uptimeMs));
      setText(stream.cells.sent, groupDigits(t.txTotal));

      const ownFaults = (t.errors || 0) + (t.txErrors || 0) + (t.unknownLines || 0);
      setText(stream.cells.faults, groupDigits(ownFaults));
      stream.cells.faults.classList.toggle('bad', ownFaults > 0);


      spark.push(conn.id, t.pos, conn.encoderMeta ? conn.encoderMeta.totalCounts : null);
      return t;
    }
  };
}

/**
 * What the readings above are derived from.
 *
 * Angle, revolutions and rpm are not properties of the encoder — they are
 * computed from its scaling, which is set by `UsedScopeOfPhysRes` and
 * `TotalScaledRes` and can be changed by anyone with the Encoder config screen
 * or a telnet session. The travel bar depends on a second, separate choice:
 * the mapping mode. A reading with no stated basis invites the assumption that
 * it is absolute, and the reference encoder is the argument against that — its
 * nameplate says 33 554 432 counts over 4 096 turns and it is commissioned to
 * 300 000 over 36.62.
 *
 * So the basis is stated, and it repaints with everything else: change the
 * scaling on the device and this line follows within a frame.
 */
function readingBasis() {
  const scaling = el('div', { class: 'basis-line', text: '' });
  const range = el('div', { class: 'basis-line', text: '' });
  const node = el('div', { class: 'dial-basis' }, scaling, range);

  return {
    node,
    update(t, span, mapping) {
      const turns = t.countsPerRev > 0 ? t.totalCounts / t.countsPerRev : 0;
      setText(scaling,
        `Encoder scaling: ${groupDigits(t.countsPerRev)} steps/turn · ` +
        `${groupDigits(t.totalCounts)} steps total · ${fixed(turns, turns < 100 ? 2 : 0)} turns`);
      scaling.title = 'Angle, revolution and speed are derived from this. It comes from the ' +
        'encoder\'s UsedScopeOfPhysRes and TotalScaledRes, and changes here as soon as they ' +
        'change on the device — it is not the nameplate figure.';

      setText(range,
        `Range to disguise: ${rangeMode(mapping)} · ` +
        `${groupDigits(span.minInput)} – ${groupDigits(span.maxInput)}`);
      range.title = 'The span the travel bar is measured against, set by the mapping mode on the ' +
        'disguise mapping screen.';
    }
  };
}

function rangeMode(mapping) {
  if (!mapping || !mapping.mode || mapping.mode === 'full') return 'full travel';
  if (mapping.mode === 'revolutions') {
    const r = Number(mapping.revolutions) || 1;
    return `${r} turn${r === 1 ? '' : 's'}`;
  }
  return 'captured span';
}

/**
 * A key for the dial.
 *
 * It used to be one line — "outer: angle · inner: revolutions used · bar:
 * mapped range" — which named three things without pointing at any of them,
 * so the reader had to work out which ring was which. Each row now carries a
 * chip shaped and coloured like the thing it describes: concentric rings for
 * the two arcs, accent for the outer and muted for the inner exactly as they
 * are drawn, and a short bar for the bar.
 */
function dialLegend() {
  const row = (kind, text) => el('div', { class: 'legend-row' },
    el('span', { class: `legend-key legend-${kind}`, 'aria-hidden': 'true' }),
    el('span', { text }));
  return el('div', { class: 'dial-legend' },
    row('outer', 'Angle within this turn'),
    row('inner', 'Revolutions used of the total'),
    row('bar', 'Position in the range sent to disguise'));
}

/** A definition list of live figures. Returns the cells so they can be repainted. */
function readouts(rows) {
  const cells = {};
  const node = el('dl', { class: 'readouts' });
  for (const [key, label, cls] of rows) {
    cells[key] = el('dd', { class: cls || '', text: '—' });
    node.appendChild(el('dt', { text: label }));
    node.appendChild(cells[key]);
  }
  return { node, cells };
}

/**
 * A single-series position trace. One series, so no legend — the card names it.
 * Drawn as an SVG polyline rather than a canvas so it scales with the card and
 * inherits theme colours through CSS.
 */
function sparkline() {
  const W = 600;
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
      const windowMs = TRACE_SECONDS * 1000;
      const cutoff = now - windowMs;
      // Everything in the window, plus the one point before it: without that
      // the line begins wherever the oldest sample happens to be rather than at
      // the left edge.
      const first = t.findIndex((p) => p.t >= cutoff);
      const pts = first <= 0 ? t.slice() : t.slice(first - 1);
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

      // A fixed window: `now - 12s` at the left edge, `now` at the right,
      // always. It was scaled to `now - pts[0].t` — the age of the oldest point
      // held — so the whole trace stretched while the buffer filled and jumped
      // sideways every time a point aged out. That is the squeezing and
      // stuttering: the data was fine, the axis was elastic.
      const out = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const x = Math.max(0, ((pts[i].t - cutoff) / windowMs) * W);
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
