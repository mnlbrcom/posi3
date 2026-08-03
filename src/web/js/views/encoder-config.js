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
  el, clear, pill, toast, confirmModal, select, input, checkbox, banner, dismissBanner,
  setText, groupDigits, fixed
} from '../ui.js';
import { store } from '../store.js';

const GROUP_LABELS = {
  output: 'Output and Timing',
  scaling: 'Scaling and Zero Point',
  network: 'Network',
  diagnostics: 'Diagnostics'
};

export function renderEncoderConfig(root) {
  clear(root);
  const view = el('div', { class: 'view' });
  const conns = store.connections;

  // One button for the whole screen and one on every card. Reading every
  // encoder at once is the usual thing before a show; reading one is what you
  // do after changing something on it.
  const readAllBtn = el('button', { class: 'btn', text: 'Read Configs From All Encoders' });

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Encoder Config' }),
      el('span', { class: 'spacer' }),
      readAllBtn)));

  if (!conns.length) {
    view.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No encoders configured' }),
      el('p', { text: 'Add a connection first — this screen talks to each encoder over the same TCP session its data stream uses.' }),
      el('button', {
        class: 'btn primary', text: 'Go to Connections',
        onclick: () => store.setView('connections')
      })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  const cards = conns.map((c) => encoderCard(c));
  for (const card of cards) view.appendChild(card.node);
  root.appendChild(view);

  readAllBtn.onclick = async () => {
    readAllBtn.disabled = true;
    try {
      // Sequential on purpose. Every read is a burst of commands down a TCP
      // session that is also carrying the data stream, and firing several
      // encoders' worth at once is how you turn a config read into a visible
      // gap in the position feed.
      for (const card of cards) await card.readAll();
    } finally {
      readAllBtn.disabled = false;
    }
  };

  return {
    refreshLive() {
      for (const card of cards) card.refreshLive();
    }
  };
}

/**
 * One encoder: its own header, its own read/revert/apply, its own variables.
 *
 * This screen used to show a single encoder chosen by a picker, which meant the
 * target was implied by whatever was last clicked elsewhere — and the thing
 * being configured writes flash and can change an IP address. Every encoder is
 * on the page now, each in a card that names the device it writes to and shows
 * its live position, because POSITAL encoders carry no serial number, firmware
 * version or any other identifier over the wire. The address is the only handle
 * there is, and turning the shaft is the only way to be sure of the unit.
 */
function encoderCard(conn) {
  const vars = store.info.constants.ENCODER_VARS;
  const current = new Map(); // name -> value read from the device
  const edited = new Map();  // name -> pending value
  const controls = new Map();
  const currentCells = new Map();
  const rows = new Map();

  const applyBtn = el('button', { class: 'btn primary', text: 'Apply changes', disabled: true });
  const revertBtn = el('button', { class: 'btn', text: 'Revert', disabled: true });
  const readBtn = el('button', { class: 'btn', text: 'Read' });
  const statusText = el('span', { class: 'faint meta' });
  const pillHolder = el('span', { class: 'pill-holder' }, pill(store.stateOf(conn.id)));
  const livePos = el('span', { class: 'target-pos', text: '—' });

  const nic = conn.encoder.localAddress
    ? `via ${conn.encoder.localAddress}`
    : 'via the default route';

  // -- the variables, grouped and retractable --------------------------------

  const groupNodes = [];
  for (const group of store.info.constants.VAR_GROUPS) {
    const groupVars = vars.filter((v) => v.group === group);
    if (!groupVars.length) continue;

    const table = el('table', { class: 'vartable' });
    for (const spec of groupVars) {
      const curCell = el('td', { class: 'cur', text: '—' });
      currentCells.set(spec.name, curCell);

      const ctl = buildControl(spec, (value) => {
        // Compare like with like: the device may have answered `CYCLIC` where
        // the control offers `Cyclic`, and that is not an edit.
        const cur = current.get(spec.name);
        const norm = (v) => (ctl && ctl.normalise ? ctl.normalise(v) || String(v) : String(v));
        if (norm(value) === norm(cur)) edited.delete(spec.name);
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
      table.appendChild(row);
    }

    // Network stays shut and stays marked: changing the IP drops the
    // connection, and hardware switch 2 can make it look like nothing happened
    // at all. Everything else opens, because it is what you came to read.
    const danger = group === 'network';
    groupNodes.push(el('details', {
      class: `cfg-group${danger ? ' danger-zone' : ''}`,
      open: danger ? undefined : true
    },
      el('summary', {
        text: danger
          ? 'Network — changing these will drop the connection'
          : (GROUP_LABELS[group] || group)
      }),
      el('div', { class: 'cfg-body' },
        danger
          ? el('p', { class: 'help faint' },
            'A new IP address only takes effect after the encoder is power-cycled. ' +
            'If hardware switch 2 in the connection cap is ON, the encoder stays at ' +
            `${store.info.constants.DEFAULT_ENCODER_IP} no matter what is programmed here — ` +
            'that is the most common reason a changed address appears to do nothing.')
          : null,
        table)));
  }

  const node = el('div', { class: 'card cfg-card' },
    el('div', { class: 'card-head' },
      el('span', { class: 'card-name', text: conn.name }),
      pillHolder,
      el('div', { class: 'card-actions' }, statusText, readBtn, revertBtn, applyBtn)),
    el('div', { class: 'cfg-target' },
      el('span', { class: 'target-addr' }, `${conn.encoder.host}:${conn.encoder.port} · ${nic}`),
      el('span', { class: 'target-live' },
        el('span', { class: 'target-live-label', text: 'Live position' }),
        livePos,
        el('span', { class: 'target-hint', text: 'turn the shaft to confirm this is the right encoder' }))),
    ...groupNodes);

  // -- behaviour -------------------------------------------------------------

  /**
   * Some limits are not constants. Preset and Offset are bounded by the scaled
   * resolution actually in force, which is a value on the device — on the
   * reference encoder that is 300 000, not the 33 million its type label
   * implies. Stating a fixed number under those fields would be wrong on any
   * commissioned unit, so the field names its dependency until the value has
   * been read and then shows it.
   */
  function applyDependentRanges() {
    for (const spec of vars) {
      if (!spec.rangeFrom) continue;
      const ctl = controls.get(spec.name);
      if (!ctl || !ctl.setRange) continue;
      const n = Number(current.get(spec.rangeFrom));
      ctl.setRange(Number.isFinite(n) && n > 0
        ? `0 – ${(n - 1).toLocaleString('en-US')}  (one less than ${spec.rangeFrom})`
        : spec.range);
    }
  }

  function refreshDirty() {
    for (const [name, row] of rows) row.classList.toggle('dirty', edited.has(name));
    applyBtn.disabled = edited.size === 0;
    revertBtn.disabled = edited.size === 0;
    applyBtn.textContent = edited.size ? `Apply ${edited.size} change${edited.size > 1 ? 's' : ''}` : 'Apply changes';
  }

  async function readAll() {
    if (store.stateOf(conn.id) === 'idle') {
      statusText.textContent = 'connection is stopped';
      return;
    }
    readBtn.disabled = true;
    statusText.textContent = 'reading…';
    try {
      // Write-only variables answer with an ERROR; asking for them would put a
      // spurious failure in front of the operator on every read.
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
      applyDependentRanges();
      statusText.textContent = `read ${ok} of ${vars.length} variables`;
    } catch (err) {
      toast('error', `${conn.name}: ${err.message}`);
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
      title: `Write ${entries.length} Setting${entries.length > 1 ? 's' : ''} To ${conn.name}?`,
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
        'Use “Read” on its card to check before power-cycling it.', { key: 'flash-unknown' });
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

  let lastState = null;

  return {
    node,
    readAll,
    refreshLive() {
      const state = store.stateOf(conn.id);
      if (state !== lastState) {
        clear(pillHolder).appendChild(pill(state));
        lastState = state;
      }
      const t = store.telemetryOf(conn.id);
      if (!t) {
        setText(livePos, state === 'idle' ? 'not running' : '—');
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
    const sel = select(spec.values, spec.values[0], onChange);
    /**
     * Resolve whatever the device said to one of our options.
     *
     * The encoder does not answer in the manual's spelling: `TimeMode` comes
     * back as `CYCLIC`, and POSITAL's own applet writes the third mode as
     * `COS`. Assigning an unmatched value to a <select> silently leaves it
     * blank, so a literal comparison would show the operator no current mode
     * at all — or worse, the first option, which is wrong rather than absent.
     */
    const resolve = (v) => {
      const raw = String(v == null ? '' : v).trim();
      if (!raw) return '';
      const key = raw.toLowerCase().replace(/[\s_-]/g, '');
      const exact = spec.values.find((o) => o.toLowerCase().replace(/[\s_-]/g, '') === key);
      if (exact) return exact;
      const alias = spec.aliases && spec.aliases[key];
      return alias || '';
    };
    return {
      node: sel,
      set: (v) => {
        const match = resolve(v);
        sel.value = match || spec.values[0];
        // Say so rather than quietly showing something plausible.
        sel.title = match ? '' : `Encoder reported "${v}", which is not a value this build knows`;
        sel.classList.toggle('unknown-value', !match && String(v || '') !== '');
      },
      /** The canonical spelling, for comparing against an edit. */
      normalise: resolve
    };
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
    const range = spec.range ? el('div', { class: 'field-range', text: spec.range }) : null;
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
        // Deliberately not stated as fact: POSITAL's own documents disagree.
        // FAQ 4 gives a ~2 ms internal sensor update; §1.2 advertises cycle
        // times under 2 ms; the datasheet says >= 10 ms. Flag it, do not rule.
        (ms < 2 ? '  ⚠ below the ~2 ms the manual gives for the internal sensor update — values may repeat' : '');
      hint.className = ms < 2 ? 'hint warn-text' : 'hint';
    }

    return {
      node: el('div', {}, box, range, hint),
      set: (v) => { box.value = v; updateHint(v); },
      setRateHint: updateHint,
      /** Replace the stated range once the value it depends on is known. */
      setRange: (text) => { if (range) setText(range, text); }
    };
  }

  // ip and free text
  const box = input({ class: 'mono-input', oninput: (e) => onChange(e.target.value) });
  const range = spec.range ? el('div', { class: 'field-range', text: spec.range }) : null;
  return { node: el('div', {}, box, range), set: (v) => { box.value = v; } };
}
