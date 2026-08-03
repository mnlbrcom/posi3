/**
 * Encoder configuration over the plain-text TCP command channel.
 *
 * This replaces the POSITAL Java web applet, which needs JRE 7 and Internet
 * Explorer and is effectively dead on current Windows — the whole reason the
 * "Posital Web Controller Guide" folder (and its bundled 29 MB JRE installer)
 * exists.
 *
 * Every write goes to the encoder's flash. Losing power mid-write can destroy
 * the encoder's configuration, so writes are batched, confirmed, rate-limited,
 * and tracked to an explicit confirmation from the device.
 */

import {
  el, clear, toast, confirmModal, select, input, checkbox, banner, dismissBanner,
  setText, groupDigits, fixed
} from '../ui.js';
import { store } from '../store.js';

const GROUP_LABELS = {
  output: 'Output and timing',
  scaling: 'Scaling and zero point',
  network: 'Network',
  diagnostics: 'Diagnostics'
};

export function renderEncoderConfig(root) {
  clear(root);
  const conn = store.selected;
  const view = el('div', { class: 'view' });

  if (!conn) {
    view.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No encoder selected' }),
      el('p', { text: 'Choose one on the Connections screen, then come back here.' }),
      el('button', {
        class: 'btn primary', text: 'Go to Connections',
        onclick: () => store.setView('connections')
      })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  const vars = store.info.constants.ENCODER_VARS;
  const current = new Map(); // name -> value read from the device
  const edited = new Map(); // name -> pending value
  const controls = new Map();
  const currentCells = new Map();
  const rows = new Map();

  const applyBtn = el('button', { class: 'btn primary', text: 'Apply changes', disabled: true });
  const revertBtn = el('button', { class: 'btn', text: 'Revert', disabled: true });
  const readBtn = el('button', { class: 'btn', text: 'Read all from encoder' });
  const statusText = el('span', { class: 'faint', style: 'font-size:11.5px' });

  view.appendChild(el('div', { class: 'view-head' },
    el('button', { class: 'btn sm ghost', text: '‹ Back', onclick: () => store.setView('detail', conn.id) }),
    el('h1', { text: 'Encoder configuration' }),
    statusText,
    el('span', { class: 'spacer' }),
    readBtn, revertBtn, applyBtn));

  // -- who am I about to write to? -----------------------------------------
  //
  // This screen writes the encoder's flash and can change its IP address, and
  // the target used to be implied by whatever was last clicked elsewhere. With
  // several encoders on a network that is not good enough, so the device is
  // named here, switchable here, and confirmable by eye: POSITAL encoders carry
  // no serial number, firmware version or any other identifier over the wire —
  // the address is the only handle there is. The one reliable way to know you
  // have the right physical unit is to turn the shaft and watch the live
  // position below move.

  const livePos = el('span', { class: 'target-pos', text: '—' });

  const picker = store.connections.length > 1
    ? select(
      store.connections.map((c) => ({ value: c.id, label: `${c.name} — ${c.encoder.host}` })),
      conn.id,
      (id) => store.setView('encoder', id)
    )
    : null;

  const nic = conn.encoder.localAddress
    ? `via ${conn.encoder.localAddress}`
    : 'via the default route';

  view.appendChild(el('div', { class: 'target-bar' },
    el('div', { class: 'target-main' },
      el('span', { class: 'target-label', text: 'Writing to' }),
      picker || el('span', { class: 'target-name', text: conn.name })),
    el('div', { class: 'target-addr' }, `${conn.encoder.host}:${conn.encoder.port} · ${nic}`),
    el('div', { class: 'target-live' },
      el('span', { class: 'target-live-label', text: 'Live position' }),
      livePos,
      el('span', { class: 'target-hint', text: 'turn the shaft to confirm this is the right encoder' }))));

  view.appendChild(el('div', { class: 'view-sub' },
    'Reads and writes this encoder directly over its TCP command channel. ' +
    'No Java runtime and no Internet Explorer required — the connection must simply be running.'));

  // -- table ----------------------------------------------------------------

  const table = el('table', { class: 'vartable' });
  const dangerRows = [];

  for (const group of store.info.constants.VAR_GROUPS) {
    const groupVars = vars.filter((v) => v.group === group);
    if (!groupVars.length) continue;

    const target = group === 'network' ? dangerRows : [];
    if (group !== 'network') {
      table.appendChild(el('tr', {}, el('td', { class: 'group-head', colspan: 4, text: GROUP_LABELS[group] || group })));
    }

    for (const spec of groupVars) {
      const curCell = el('td', { class: 'cur', text: '—' });
      currentCells.set(spec.name, curCell);

      const ctl = buildControl(spec, (value) => {
        const cur = current.get(spec.name);
        if (String(value) === String(cur)) edited.delete(spec.name);
        else edited.set(spec.name, String(value));
        refreshDirty();
      });
      controls.set(spec.name, ctl);

      const row = el('tr', {},
        el('td', { class: 'k' }, el('span', { text: spec.label }), el('code', { text: spec.name })),
        curCell,
        el('td', { class: 'ctl' }, ctl.node),
        el('td', { class: 'help', text: spec.help || '' }));

      rows.set(spec.name, row);
      if (group === 'network') target.push(row); else table.appendChild(row);
    }
  }

  view.appendChild(el('div', { class: 'panel' }, table));

  // Network settings sit behind a deliberate extra click: changing the IP drops
  // the connection, and switch 2 can make it look like nothing happened at all.
  const dzTable = el('table', { class: 'vartable' });
  for (const r of dangerRows) dzTable.appendChild(r);
  view.appendChild(el('details', { class: 'danger-zone' },
    el('summary', { text: 'Network settings — changing these will drop the connection' }),
    el('div', { class: 'dz-body' },
      el('p', { class: 'help', style: 'font-size:11.5px;color:var(--text-faint);line-height:1.5' },
        'A new IP address only takes effect after the encoder is power-cycled. ' +
        'If hardware switch 2 in the connection cap is ON, the encoder stays at ' +
        `${store.info.constants.DEFAULT_ENCODER_IP} no matter what is programmed here — ` +
        'that is the most common reason a changed address appears to do nothing.'),
      dzTable)));

  root.appendChild(view);

  // -- behaviour ------------------------------------------------------------

  function refreshDirty() {
    for (const [name, row] of rows) row.classList.toggle('dirty', edited.has(name));
    applyBtn.disabled = edited.size === 0;
    revertBtn.disabled = edited.size === 0;
    applyBtn.textContent = edited.size ? `Apply ${edited.size} change${edited.size > 1 ? 's' : ''}` : 'Apply changes';
  }

  async function readAll() {
    if (store.stateOf(conn.id) === 'idle') {
      toast('warn', 'Start the connection first — configuration uses the same TCP session as the data stream.');
      return;
    }
    readBtn.disabled = true;
    statusText.textContent = 'reading…';
    try {
      // Write-only variables answer with an ERROR; asking for them would put a
      // spurious failure in front of the operator on every Read all.
      const names = vars.filter((v) => !v.writeOnly).map((v) => v.name);
      const res = await window.d3d.encoder.readMany(conn.id, names);
      let ok = 0;
      for (const [name, r] of Object.entries(res)) {
        if (!r.ok) continue;
        ok++;
        current.set(name, r.value);
        const cell = currentCells.get(name);
        if (cell) cell.textContent = r.value;
        const ctl = controls.get(name);
        if (ctl) ctl.set(r.value);
      }
      edited.clear();
      refreshDirty();
      statusText.textContent = `read ${ok} of ${vars.length} variables`;
    } catch (err) {
      toast('error', err.message);
      statusText.textContent = 'read failed';
    } finally {
      readBtn.disabled = false;
    }
  }

  readBtn.onclick = readAll;

  revertBtn.onclick = () => {
    for (const [name, value] of current) {
      const ctl = controls.get(name);
      if (ctl) ctl.set(value);
    }
    edited.clear();
    refreshDirty();
  };

  applyBtn.onclick = async () => {
    const entries = Array.from(edited, ([variable, value]) => ({ variable, value }));
    if (!entries.length) return;

    const ok = await confirmModal({
      title: `Write ${entries.length} setting${entries.length > 1 ? 's' : ''} to the encoder?`,
      body: [
        el('div', { class: 'flash-warn' },
          el('strong', { text: 'Do not power off the encoder or unplug its network cable ' }),
          'until “Parameters successfully written!” appears. The encoder commits these to flash a ' +
          'few seconds after accepting them, and interrupting that can damage its configuration.'),
        el('div', { class: 'cmd-preview' },
          ...entries.map((e) => el('div', { text: `set ${e.variable}=${e.value}` }))),
        entries.some((e) => ['IP', 'NetMask', 'Gateway'].includes(e.variable))
          ? el('p', { class: 'warn-text', text: 'This includes a network change: the connection will drop, and the new address only applies after a power cycle.' })
          : null
      ],
      confirmLabel: 'Write to encoder',
      danger: true
    });
    if (!ok) return;

    applyBtn.disabled = true;
    banner('warn', `FLASH WRITE IN PROGRESS — do not power off ${conn.name}`, { dismissible: false, key: 'flash' });

    // If the encoder never confirms, say so rather than quietly clearing the
    // banner: "write status unknown" is actionable, a vanished banner is not.
    const timeout = setTimeout(() => {
      dismissBanner('flash');
      banner('error',
        `${conn.name}: write status unknown — the encoder did not confirm. ` +
        'Use “Read all from encoder” to check before power-cycling it.', { key: 'flash-unknown' });
    }, 30000);
    pendingFlash.set(conn.id, timeout);

    try {
      const results = await window.d3d.encoder.writeMany(conn.id, entries);
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast('error', `${failed.length} setting(s) rejected: ` +
          failed.map((f) => `${f.variable} (${f.error})`).join(', '));
      }
      for (const r of results.filter((x) => x.ok)) {
        current.set(r.variable, r.value);
        const cell = currentCells.get(r.variable);
        if (cell) cell.textContent = r.value;
        edited.delete(r.variable);
      }
      refreshDirty();
    } catch (err) {
      clearTimeout(timeout);
      pendingFlash.delete(conn.id);
      dismissBanner('flash');
      toast('error', err.message);
    } finally {
      applyBtn.disabled = edited.size === 0;
    }
  };

  if (store.stateOf(conn.id) !== 'idle') readAll();
  else statusText.textContent = 'connection is stopped';

  return {
    refreshLive() {
      const t = store.telemetryOf(conn.id);
      if (!t) {
        setText(livePos, store.stateOf(conn.id) === 'idle' ? 'not running' : '—');
        return;
      }
      // Separated: run together, the count and the angle read as one number.
      setText(livePos, `${groupDigits(t.pos)} counts  ·  ${fixed(t.angleDeg, 2)}°`);
      const cycleCtl = controls.get('CycleTime');
      if (cycleCtl && cycleCtl.setRateHint) cycleCtl.setRateHint(current.get('CycleTime'));
    }
  };
}

/** Timers keyed by connection, cleared when the encoder confirms the commit. */
const pendingFlash = new Map();

/** Called from app.js when the encoder broadcasts its flash confirmation. */
export function onFlashConfirmed(id) {
  const timer = pendingFlash.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingFlash.delete(id);
  }
  dismissBanner('flash');
  dismissBanner('flash-unknown');
}

// ---------------------------------------------------------------------------

function buildControl(spec, onChange) {
  if (spec.type === 'enum') {
    const s = select(spec.values, spec.values[0], onChange);
    return { node: s, set: (v) => { s.value = v; } };
  }

  if (spec.type === 'flags') {
    // OutputMode is a concatenation of tokens, e.g. Position_Velocity_Timestamp_
    const state = new Set();
    const wrap = el('div', {});
    const boxes = [];
    for (const flag of spec.flags) {
      const label = flag.replace(/_$/, '');
      const box = checkbox(label, false, (checked) => {
        if (checked) state.add(flag); else state.delete(flag);
        onChange(spec.flags.filter((f) => state.has(f)).join(''));
      });
      boxes.push({ flag, input: box.querySelector('input') });
      wrap.appendChild(box);
    }
    return {
      node: wrap,
      set: (v) => {
        state.clear();
        const s = String(v || '').toLowerCase();
        for (const b of boxes) {
          const on = s.includes(b.flag.replace(/_$/, '').toLowerCase());
          b.input.checked = on;
          if (on) state.add(b.flag);
        }
      }
    };
  }

  if (spec.type === 'int') {
    const hint = el('div', { class: 'hint' });
    const box = input({
      type: 'number', class: 'num-input',
      min: spec.min, max: spec.max,
      oninput: (e) => { onChange(e.target.value); updateHint(e.target.value); }
    });

    function updateHint(v) {
      if (spec.name !== 'CycleTime') return;
      const ms = Number(v);
      if (!ms || ms <= 0) { hint.textContent = ''; return; }
      const rate = 1000 / ms;
      hint.textContent = `≈ ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} Hz` +
        (ms < 2 ? '  ⚠ the sensor itself only updates every ~2 ms — lower values add no new data' : '');
      hint.className = ms < 2 ? 'hint warn-text' : 'hint';
    }

    return {
      node: el('div', {}, box, hint),
      set: (v) => { box.value = v; updateHint(v); },
      setRateHint: updateHint
    };
  }

  // ip and free text
  const box = input({ class: 'mono-input', oninput: (e) => onChange(e.target.value) });
  return { node: box, set: (v) => { box.value = v; } };
}
