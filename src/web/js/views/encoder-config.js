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

  // The module maps outlive the cards on purpose — that is what lets a rebuilt
  // card keep its read values — but they must not outlive the *connection*. A
  // pending flash timer for a deleted encoder would still fire, and its banner
  // key names a connection nobody can find.
  const live = new Set(conns.map((c) => c.id));
  for (const id of pendingFlash.keys()) {
    if (!live.has(id)) {
      clearTimeout(pendingFlash.get(id));
      pendingFlash.delete(id);
      dismissBanner(`flash-${id}`);
      dismissBanner(`flash-unknown-${id}`);
    }
  }
  for (const id of lastRead.keys()) if (!live.has(id)) lastRead.delete(id);

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
  view.appendChild(el('div', { class: 'cfg-list' }, ...cards.map((c) => c.node)));
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
  const pillHolder = el('span', { class: 'pill-holder' }, pill(store.encoderIndicator(conn.id)));
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
      // A write-only variable says so, rather than showing the same dash as one
      // that simply has not been read. Confirmed on the device: `read Preset`
      // answers "Preset is an unknown variable." Leaving it blank invited the
      // reading that the read had failed, next to an Offset showing a number.
      const curCell = spec.writeOnly
        ? el('td', {
          class: 'cur unreadable', text: 'write-only',
          title: `${spec.name} cannot be read back from the encoder. ` +
            'Its effect is visible in Offset.'
        })
        : el('td', { class: 'cur', text: '—' });
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

    // Every group starts folded. With more than one encoder on the page an
    // expanded card is most of a screen, and what the list is for is seeing the
    // encoders — the settings are a click away when you want them. Network
    // stays marked as well as shut: changing an IP drops the connection, and
    // hardware switch 2 can make it look like nothing happened at all.
    const danger = group === 'network';
    groupNodes.push(el('details', { class: `cfg-group${danger ? ' danger-zone' : ''}` },
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
      el('div', { class: 'card-actions' }, readBtn, revertBtn, applyBtn)),
    el('div', { class: 'cfg-target' },
      el('span', {
        class: 'target-addr',
        title: conn.encoder.pendingHost
          ? `${conn.encoder.pendingHost} is stored on the encoder and takes effect after a power cycle`
          : undefined
      }, `${conn.encoder.host}:${conn.encoder.port} · ${nic}`),
      conn.encoder.pendingHost
        ? el('span', { class: 'pending-addr', text: `→ ${conn.encoder.pendingHost} after power cycle` })
        : null,
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
      const known = Number.isFinite(n) && n > 0;
      ctl.setRange(
        known
          ? `0 – ${(n - 1).toLocaleString('en-US')}  (one less than ${spec.rangeFrom})`
          : spec.range,
        known ? n - 1 : undefined);
    }
  }

  function refreshDirty() {
    for (const [name, row] of rows) row.classList.toggle('dirty', edited.has(name));
    applyBtn.disabled = edited.size === 0;
    revertBtn.disabled = edited.size === 0;
    applyBtn.textContent = edited.size ? `Apply ${edited.size} change${edited.size > 1 ? 's' : ''}` : 'Apply changes';
  }

  /** Keyed per connection, so several unreachable encoders do not stack. */
  const unreachableKey = `cfg-gone-${conn.id}`;

  async function readAll() {
    // A stopped connection is no longer a reason not to read: the server opens
    // a socket of its own, asks, and closes it.
    readBtn.disabled = true;
    try {
      // Write-only variables answer with an ERROR; asking for them would put a
      // spurious failure in front of the operator on every read.
      const names = vars.filter((v) => !v.writeOnly).map((v) => v.name);
      const res = await window.d3d.encoder.readMany(conn.id, names);
      for (const [name, r] of Object.entries(res)) {
        if (!r.ok) continue;
        current.set(name, r.value);
        const cell = currentCells.get(name);
        if (cell) cell.textContent = r.value;
        const ctl = controls.get(name);
        if (ctl) ctl.set(r.value);
      }
      edited.clear();
      refreshDirty();
      applyDependentRanges();
      lastRead.set(conn.id, new Map(current));
      // The unknown-status banner asks for exactly this, so answering it has to
      // clear it — otherwise the instruction is a dead end.
      onFlashConfirmed(conn.id);
    } catch (err) {
      // Gone from the network is a different problem from a value being
      // refused, and it is the one worth naming across the top of the window.
      if (err.code === 'EUNREACHABLE') {
        banner('error', `${conn.name} unreachable at ${conn.encoder.host}:${conn.encoder.port}`,
          { key: unreachableKey, ttlMs: 5000 });
      } else {
        toast('error', `${conn.name}: ${err.message}`);
      }
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
    banner('warn', `FLASH WRITE IN PROGRESS — do not power off ${conn.name}`, { key: `flash-${conn.id}` });

    // The write confirms on its echo (under a second) and the server sends
    // flashConfirmed, which clears this banner. This is only the backstop for
    // the server never answering at all — a dead bridge — so the write neither
    // confirms nor errors.
    const timeout = setTimeout(() => {
      dismissBanner(`flash-${conn.id}`);
      banner('error',
        `${conn.name}: write status unknown — the encoder did not confirm. ` +
        'Use “Read” on its card to check before power-cycling it.', { key: `flash-unknown-${conn.id}` });
    }, 15000);
    pendingFlash.set(conn.id, timeout);

    try {
      let results;
      try {
        results = await window.d3d.encoder.writeMany(conn.id, entries);
      } catch (err) {
        // The encoder will not store the same Preset twice in a row, so
        // re-applying the value it already holds needs the documented detour:
        // write value+1, wait for the commit, write value. Two cycles out of
        // about 100,000, so it is asked for rather than assumed — the same
        // choice the Controls popup offers.
        if (err.code !== 'EPRESET_DUPLICATE') throw err;
        clearTimeout(timeout);
        pendingFlash.delete(conn.id);
        dismissBanner(`flash-${conn.id}`);
        const again = await confirmModal({
          title: 'Preset Already At That Value',
          body: el('p', {
            text: `${err.message} Writing it anyway uses two of the encoder's ` +
              'flash cycles instead of one.'
          }),
          confirmLabel: 'Write anyway (2 cycles)',
          danger: true
        });
        if (!again) { applyBtn.disabled = false; return; }
        banner('warn', `FLASH WRITE IN PROGRESS — do not power off ${conn.name}`, { key: `flash-${conn.id}` });
        results = await window.d3d.encoder.writeMany(conn.id, entries, true);
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast('error', `${failed.length} setting(s) rejected: ` +
          failed.map((f) => `${f.variable} (${f.error})`).join(', '));
      }
      // An explicit rejection means the encoder never accepted the value, so
      // there is no commit to wait for. Standing there for 30s and then saying
      // "status unknown" is worse than saying nothing: it puts a do-not-power-
      // off warning in front of an operator when nothing is being written.
      if (failed.length === results.length) {
        clearTimeout(timeout);
        pendingFlash.delete(conn.id);
        dismissBanner(`flash-${conn.id}`);
      }
      for (const r of results.filter((x) => x.ok)) {
        current.set(r.variable, r.value);
        const cell = currentCells.get(r.variable);
        if (cell) cell.textContent = r.value;
        edited.delete(r.variable);
      }
      lastRead.set(conn.id, new Map(current));
      refreshDirty();
    } catch (err) {
      clearTimeout(timeout);
      pendingFlash.delete(conn.id);
      dismissBanner(`flash-${conn.id}`);
      toast('error', err.message);
    } finally {
      applyBtn.disabled = edited.size === 0;
    }
  };

  const cached = lastRead.get(conn.id);
  if (cached && cached.size) {
    // Restore what the last read found, rather than asking again.
    for (const [name, value] of cached) {
      current.set(name, value);
      const cell = currentCells.get(name);
      if (cell) cell.textContent = value;
      const ctl = controls.get(name);
      if (ctl) ctl.set(value);
    }
    applyDependentRanges();
  } else if (store.encoderIndicator(conn.id) !== 'offline') {
    // Nothing cached, so ask the device — unless the indicator already says
    // there is no device to ask. Opening this page with two encoders
    // unplugged used to fire two reads, two toasts and two error lines to
    // report what the pills already said. The Read button still works, and a
    // read against a supposedly-connected encoder that fails is still logged.
    readAll();
  }

  let lastState = null;

  return {
    node,
    readAll,
    refreshLive() {
      // The indicator for the pill; the raw state still decides the wording
      // below, because "not running" is about posi3 and stays true whether
      // the idle device is reachable or not.
      const state = store.stateOf(conn.id);
      const shown = store.encoderIndicator(conn.id);
      if (shown !== lastState) {
        clear(pillHolder).appendChild(pill(shown));
        lastState = shown;
      }
      const t = store.telemetryOf(conn.id);
      if (!t) {
        setText(livePos, state === 'idle' ? 'not running' : '—');
        return;
      }
      // Separated: run together, the count and the angle read as one number.
      setText(livePos, `${groupDigits(t.pos)} steps  ·  ${fixed(t.angleDeg, 2)}°`);
      const cycleCtl = controls.get('CycleTime');
      if (cycleCtl && cycleCtl.setRateHint) cycleCtl.setRateHint(current.get('CycleTime'));
    }
  };
}

/** Timers keyed by connection, cleared when the encoder confirms the commit. */
const pendingFlash = new Map();

/**
 * The last values read from each encoder, kept at module scope so a rebuild of
 * this screen does not re-read them.
 *
 * `onStoreChange` re-renders every view on any link-state change, and each card
 * used to read all fourteen variables as it was constructed. Measured: a second
 * encoder starting and stopping — nothing to do with the card being rebuilt —
 * put **108 reads** down the wire in fourteen seconds, where one sweep is
 * thirteen. Every one of them a round trip on the same TCP session that carries
 * the position stream, all returning values the screen already had.
 *
 * A cached value is exactly as fresh as the last read; the encoder announces
 * its own changes on the same socket, so anything altered elsewhere arrives as
 * a broadcast rather than being discovered by polling.
 */
const lastRead = new Map();

/** Called from app.js when the encoder broadcasts its flash confirmation. */
export function onFlashConfirmed(id) {
  const timer = pendingFlash.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingFlash.delete(id);
  }
  // This encoder's banners, nobody else's. The keys were global, so with two
  // writes in flight, A's confirmation dismissed B's do-not-power-off warning
  // while B was still committing — the one warning this screen calls
  // safety-critical, taken down by the wrong device.
  dismissBanner(`flash-${id}`);
  dismissBanner(`flash-unknown-${id}`);
}

// ---------------------------------------------------------------------------

function buildControl(spec, onChange) {
  if (spec.type === 'enum') {
    const blocked = spec.unsupported || [];
    const sel = select(
      spec.values.map((v) => ({
        value: v,
        label: blocked.includes(v) ? `${v} — not supported` : v,
        disabled: blocked.includes(v)
      })),
      spec.values[0], onChange);
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
    // OutputMode is a concatenation of tokens. The manual writes them as
    // `Position_Velocity_Timestamp_`; this firmware reports and accepts
    // `POSITION_VELOCITY` and refuses the manual's form outright — "is not a
    // valid value for OutputMode. Using previous value."
    //
    // Rather than pick a side, write it back the way the device said it. The
    // style is taken from whatever the last read returned, so a unit that does
    // use the manual's spelling keeps getting it.
    const state = new Set();
    const wrap = el('div', {});
    const boxes = [];
    let style = { upper: false, trailing: true };

    const compose = () => {
      const picked = spec.flags.filter((f) => state.has(f)).map((f) => f.replace(/_$/, ''));
      if (!picked.length) return '';
      const joined = picked.join('_') + (style.trailing ? '_' : '');
      return style.upper ? joined.toUpperCase() : joined;
    };

    for (const flag of spec.flags) {
      const label = flag.replace(/_$/, '');
      const box = checkbox(label, false, (checked) => {
        if (checked) state.add(flag); else state.delete(flag);
        onChange(compose());
      });
      boxes.push({ flag, input: box.querySelector('input') });
      wrap.appendChild(box);
    }
    return {
      node: wrap,
      set: (v) => {
        const raw = String(v || '');
        if (raw) {
          style = { upper: raw === raw.toUpperCase() && /[A-Z]/.test(raw), trailing: /_$/.test(raw) };
        }
        state.clear();
        const s = raw.toLowerCase();
        for (const b of boxes) {
          const on = s.includes(b.flag.replace(/_$/, '').toLowerCase());
          b.input.checked = on;
          if (on) state.add(b.flag);
        }
      },
      /** The canonical spelling, for comparing against an edit. */
      normalise: (v) => String(v).toLowerCase().replace(/[\s_-]/g, '')
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
      // Computed first, assigned only on change: refreshLive calls this every
      // animation frame, and the unconditional write replaced the text node
      // at ~60 Hz with the same characters.
      let text = '';
      if (ms > 0) {
        const rate = 1000 / ms;
        text = `≈ ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} Hz` +
          // Deliberately not stated as fact: POSITAL's own documents disagree.
          // FAQ 4 gives a ~2 ms internal sensor update; §1.2 advertises cycle
          // times under 2 ms; the datasheet says >= 10 ms. Flag it, do not rule.
          (ms < 2 ? '  ⚠ below the ~2 ms the manual gives for the internal sensor update — values may repeat' : '');
      }
      if (hint.textContent !== text) hint.textContent = text;
      const cls = ms > 0 && ms < 2 ? 'hint warn-text' : 'hint';
      if (hint.className !== cls) hint.className = cls;
    }

    return {
      node: el('div', {}, box, range, hint),
      set: (v) => { box.value = v; updateHint(v); },
      setRateHint: updateHint,
      /**
       * Replace the stated range once the value it depends on is known.
       *
       * The field's own limit moves with it. Saying "0 – 299,999" under a box
       * that accepts 1,073,741,823 states a bound and then declines to hold to
       * it, and the value goes to flash before the encoder gets to object.
       */
      setRange: (text, max) => {
        if (range) setText(range, text);
        box.max = Number.isFinite(max) ? String(max) : String(spec.max);
      }
    };
  }

  // ip and free text
  const box = input({ class: 'mono-input', oninput: (e) => onChange(e.target.value) });
  const range = spec.range ? el('div', { class: 'field-range', text: spec.range }) : null;
  return { node: el('div', {}, box, range), set: (v) => { box.value = v; } };
}
