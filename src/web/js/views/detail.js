/**
 * Per-connection detail: the live dial plus the numbers that tell you whether
 * the link is healthy — including the app's own contribution to latency, so a
 * regression there is visible rather than assumed away.
 */

import {
  el, clear, pill, groupDigits, fixed, hz, micros, duration, setText,
  confirmModal, toast, segmented, panel
} from '../ui.js';
import { store } from '../store.js';
import { Dial, TravelBar } from '../components/dial.js';

export function renderDetail(root) {
  const dialCaption = el('span', { text: '' });
  clear(root);
  const conn = store.selected;
  if (!conn) {
    root.appendChild(el('div', { class: 'view' },
      el('div', { class: 'empty' }, el('h3', { text: 'No connection selected' }))));
    return { refreshLive() {} };
  }

  const view = el('div', { class: 'view' });
  const constants = store.info.constants;

  const pillHolder = el('span', {}, pill(store.stateOf(conn.id)));
  const detailText = el('span', { class: 'status-detail' });

  view.appendChild(el('div', { class: 'view-head' },
    el('button', { class: 'btn sm ghost', text: '‹ Back', onclick: () => store.setView('connections') }),
    el('h1', { text: conn.name }),
    pillHolder,
    detailText,
    el('span', { class: 'spacer' }),
    startStopButton(conn)));

  view.appendChild(el('div', { class: 'route', style: 'margin:-10px 0 16px' },
    `${conn.encoder.host}:${conn.encoder.port}`,
    el('span', { class: 'arrow', text: '→' }),
    `${conn.d3.host}:${conn.d3.port}`,
    el('span', { class: 'arrow', text: '·' }),
    `device ID ${conn.d3.devid}`));

  // -- left column: dial ----------------------------------------------------

  const dial = new Dial();
  const travel = new TravelBar();
  const dialPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-body' },
      el('div', { class: 'dial-wrap' },
        dial.node,
        travel.node,
        el('div', { class: 'dial-caption' }, dialCaption))));

  // -- right column: readouts ----------------------------------------------

  const dd = {};
  const mk = (key, label, cls) => {
    dd[key] = el('dd', { class: cls || '', text: '—' });
    return [el('dt', { text: label }), dd[key]];
  };

  const readouts = el('dl', { class: 'readouts' },
    mk('pos', 'Position', 'lg'),
    mk('angle', 'Angle'),
    mk('rev', 'Revolution'),
    mk('rpm', 'Speed'),
    mk('rawvel', 'Velocity (raw)'),
    mk('outvel', 'Velocity (sent)'),
    mk('ts', 'Timestamp'));

  const stats = el('div', { class: 'statline' });
  const statNodes = {};
  for (const [key, label] of [
    ['rate', 'RX / TX'], ['lat', 'App latency'], ['gap', 'Arrival gap'],
    ['wraps', 'Wraps'], ['errors', 'Errors'], ['rc', 'Reconnects'], ['up', 'Uptime']
  ]) {
    statNodes[key] = el('b', { text: '—' });
    stats.appendChild(el('span', {}, `${label} `, statNodes[key]));
  }

  // -- controls -------------------------------------------------------------

  const zeroBtn = el('button', {
    class: 'btn primary big', text: 'Zero / Preset 0',
    title: 'Make the encoder read 0 at its current physical position',
    onclick: () => doPreset(conn)
  });

  const runBtn = el('button', {
    class: 'btn', text: 'Run! (single sample)',
    onclick: async () => {
      try {
        const r = await window.d3d.encoder.run(conn.id);
        toast('info', `Run! → position ${groupDigits(r.pos)}`);
      } catch (err) { toast('error', err.message); }
    }
  });

  const controls = el('div', { class: 'panel-body', style: 'border-top:1px solid var(--border-soft)' },
    el('div', { class: 'row-inline', style: 'margin-bottom:14px' }, zeroBtn, runBtn),
    el('div', { class: 'field' },
      el('label', { text: 'Velocity sent to disguise' }),
      segmented([
        { value: 'zero', label: 'Zero', title: 'Byte-identical to the original d3driver.exe' },
        { value: 'passthrough', label: 'From encoder', title: "Forward the encoder's signed steps/s" },
        { value: 'derived', label: 'Derived', title: 'Compute from position deltas' }
      ], conn.velocityPolicy, (v) => saveField(conn, { velocityPolicy: v })),
      el('div', { class: 'hint', text: 'Zero is the original behaviour: disguise derives velocity from position via the axis velocitycalcmode.' })),
    el('div', { class: 'field' },
      el('label', { text: 'When records arrive coalesced' }),
      segmented([
        { value: 'every', label: 'Forward every', title: 'Original behaviour; best for velocity derivation in disguise' },
        { value: 'latest', label: 'Newest only', title: 'Lowest latency when only current position matters' }
      ], conn.udpSendPolicy, (v) => saveField(conn, { udpSendPolicy: v }))));

  const rightPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', { text: 'Live values' }), el('span', { class: 'spacer' })),
    el('div', { class: 'panel-body' }, readouts, el('div', { style: 'height:12px' }), stats),
    controls);

  view.appendChild(el('div', { class: 'grid-2' }, dialPanel, rightPanel));

  view.appendChild(panel('Where to go next', [
    el('div', { class: 'row-inline' },
      el('button', { class: 'btn', text: 'Encoder configuration', onclick: () => store.setView('encoder', conn.id) }),
      el('button', { class: 'btn', text: 'disguise mapping helper', onclick: () => store.setView('mapping', conn.id) }),
      el('button', { class: 'btn', text: 'Log', onclick: () => store.setView('log', conn.id) }))
  ]));

  root.appendChild(view);

  const mapping = conn.mapping || { minInput: 0, maxInput: constants.TOTAL_COUNTS - 1 };

  let lastState = null;
  let lastDetail = null;

  return {
    refreshLive() {
      const st = store.states.get(conn.id);
      const state = store.stateOf(conn.id);
      // Rebuild the pill only when the state actually changes. This runs on
      // every animation frame, and recreating the node each time both wastes
      // work and makes the header flicker.
      if (state !== lastState) {
        clear(pillHolder).appendChild(pill(state));
        lastState = state;
      }
      const detail = st && st.detail ? st.detail : '';
      if (detail !== lastDetail) {
        detailText.textContent = detail;
        lastDetail = detail;
      }

      const t = store.telemetryOf(conn.id);
      // Revolutions of travel as the *encoder* reports its scaling, not as the
      // type label implies. A commissioned unit is often nothing like its
      // nameplate — the reference encoder reports 300 000 counts, 36.62
      // revolutions, against a nameplate 33 554 432 and 4 096.
      const revsAvailable = t && t.totalCounts && t.countsPerRev
        ? t.totalCounts / t.countsPerRev
        : constants.REVOLUTIONS;
      setText(dialCaption,
        'Outer ring: angle within one revolution. Inner ring: revolutions used of ' +
        `${fixed(revsAvailable, revsAvailable < 100 ? 2 : 0)}. Bar: position within the mapped range.`);
      dial.update(t, revsAvailable);
      if (t) travel.update(t.pos, mapping.minInput, mapping.maxInput);

      if (!t) {
        for (const k of Object.keys(dd)) setText(dd[k], null);
        for (const k of Object.keys(statNodes)) setText(statNodes[k], null);
        return;
      }

      setText(dd.pos, groupDigits(t.pos));
      setText(dd.angle, `${fixed(t.angleDeg, 2)}°`);
      setText(dd.rev, `${groupDigits(t.revs)} / ${fixed(revsAvailable, revsAvailable < 100 ? 2 : 0)}`);
      setText(dd.rpm, `${fixed(t.rpm, 1)} rpm`);
      setText(dd.rawvel, t.rawVel === null || t.rawVel === undefined
        ? 'not sent' : `${groupDigits(t.rawVel)} steps/s`);
      setText(dd.outvel, `${groupDigits(t.outVel)} steps/s`);
      setText(dd.ts, t.ts === null || t.ts === undefined ? '—' : `${groupDigits(t.ts)} µs`);

      setText(statNodes.rate, `${hz(t.rxHz)} / ${hz(t.txHz)} Hz`);
      setText(statNodes.lat, `${micros(t.latencyUs.p50)} · ${micros(t.latencyUs.p99)}`);
      setText(statNodes.gap, `${fixed(t.gapMs.p50, 2)} ms`);
      setText(statNodes.wraps, String(t.wraps));
      setText(statNodes.errors, t.errors || t.txErrors
        ? `${t.errors} rx / ${t.txErrors} tx` : '0');
      setText(statNodes.rc, String(t.reconnects));
      setText(statNodes.up, duration(t.uptimeMs));
    }
  };
}

function startStopButton(conn) {
  const running = store.stateOf(conn.id) !== 'idle' && store.stateOf(conn.id) !== 'error';
  return el('button', {
    class: running ? 'btn' : 'btn primary',
    text: running ? 'Stop' : 'Start',
    onclick: async () => {
      try {
        if (running) await window.d3d.link.stop(conn.id);
        else await window.d3d.link.start(conn.id);
      } catch (err) { toast('error', err.message); }
    }
  });
}

async function saveField(conn, patch) {
  try {
    const updated = Object.assign({}, conn, patch);
    await window.d3d.config.saveConnection(updated);
    store.setProfile(await window.d3d.config.get());
  } catch (err) { toast('error', err.message); }
}

async function doPreset(conn) {
  const ok = await confirmModal({
    title: 'Zero the encoder at its current position?',
    body: [
      el('div', { class: 'flash-warn' },
        el('strong', { text: 'This writes to the encoder’s flash memory. ' }),
        'Do not power off the encoder or unplug its network cable until the confirmation appears. ' +
        'It may take a few seconds.'),
      el('div', { class: 'cmd-preview' }, el('div', { text: 'set Preset=0' })),
      el('p', {
        class: 'dim',
        text: 'The encoder will report 0 at wherever it is sitting right now, and every later reading ' +
          'is offset from there. This is also the fix when your working range straddles the ' +
          'count rollover.'
      })
    ],
    confirmLabel: 'Write Preset=0'
  });
  if (!ok) return;

  try {
    await window.d3d.encoder.preset(conn.id, 0);
    toast('info', 'Preset accepted — waiting for the encoder to confirm the flash write…');
  } catch (err) {
    if (err.code !== 'EPRESET_DUPLICATE') {
      toast('error', err.message);
      return;
    }
    // The firmware will not store the same Preset twice in a row, so re-zeroing
    // an already-zeroed encoder does nothing at all unless we write a different
    // value first. That costs a second flash cycle, so it is the operator's call.
    const again = await confirmModal({
      title: 'Preset is already 0',
      body: [
        el('p', {
          text: 'The encoder refuses to store the same Preset value twice in a row, so writing 0 ' +
            'again would be ignored. It can be forced by writing 1 first and then 0.'
        }),
        el('p', { class: 'dim', text: 'That uses two of the encoder\'s ~100,000 flash-write cycles instead of one.' })
      ],
      confirmLabel: 'Write it anyway (2 cycles)',
      danger: true
    });
    if (!again) return;
    try {
      const r = await window.d3d.encoder.preset(conn.id, 0, true);
      toast('info', `Preset written using ${r.cycles} flash cycles.`);
    } catch (e2) {
      toast('error', e2.message);
    }
  }
}
