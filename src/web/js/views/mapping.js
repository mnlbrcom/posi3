/**
 * Disguise mapping — one card per receiver.
 *
 * A card for every disguise machine on the rig, not one for whichever
 * connection happened to be selected. That mattered for more than tidiness:
 * the numbers were computed from `conn.d3`, the legacy mirror of the *first*
 * destination, so a fan-out to a director and an understudy produced one set of
 * values describing the director and never mentioned the other machine at all —
 * which is exactly the one nobody is looking at until it has to take over.
 *
 * Each card carries everything that receiver needs: its own device ID, its own
 * port, its own mapping, and the encoder feeding it. The mapping belongs to the
 * receiver (schema 4), so two machines fed by one encoder can drive different
 * properties.
 *
 * Structure follows Connections and Encoder Config: a header card with the
 * screen's actions, then a list of cards, each with retractable groups.
 */

import {
  el, clear, pill, groupDigits, fixed, setText, toast, select, input, checkbox, confirmModal
} from '../ui.js';
import { store } from '../store.js';

/** Receivers survive navigation with their groups as the operator left them. */
const openGroups = new Set();

/**
 * What disguise last said about each receiver, by destination id.
 *
 * Module scope, because a card is rebuilt on every navigation and a local would
 * be lost with it — the pill went back to claiming `receiving` the moment the
 * screen was left and returned to, which is the one thing asking had just
 * disproved. What disguise said does not stop being true because a view was
 * re-rendered.
 */
const lastAsked = new Map();

export function renderMapping(root) {
  {
    // Keyed by destination id, kept at module scope to survive rebuilds — and
    // pruned here so they do not survive the destination itself.
    const live = new Set();
    for (const c of store.connections) for (const d of c.destinations || []) live.add(d.id);
    for (const id of lastAsked.keys()) if (!live.has(id)) lastAsked.delete(id);
    for (const key of openGroups) if (!live.has(String(key).split(':')[0])) openGroups.delete(key);
  }

  clear(root);
  const view = el('div', { class: 'view' });
  const conns = store.connections;

  const saveAllBtn = el('button', { class: 'btn', text: 'Save All' });

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Disguise Mapping' }),
      el('span', { class: 'spacer' }),
      saveAllBtn)));

  // Every receiver on the rig, each remembering which encoder feeds it.
  const receivers = [];
  for (const conn of conns) {
    for (const dest of conn.destinations || []) receivers.push({ conn, dest });
  }

  if (!receivers.length) {
    view.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No disguise receivers configured' }),
      el('p', { text: 'Add a connection with at least one destination — this screen produces the values to type into its Navigator driver and axis.' }),
      el('button', {
        class: 'btn primary', text: 'Go to Connections',
        onclick: () => store.setView('connections')
      })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  const cards = receivers.map(({ conn, dest }) => receiverCard(conn, dest));
  view.appendChild(el('div', { class: 'cfg-list' }, ...cards.map((c) => c.node)));
  root.appendChild(view);

  saveAllBtn.onclick = async () => {
    saveAllBtn.disabled = true;
    try {
      // Grouped by connection: each save writes the whole connection, so one
      // call per encoder rather than one per receiver — otherwise two receivers
      // on the same encoder would each overwrite the other's mapping.
      for (const conn of conns) {
        const mine = cards.filter((c) => c.connId === conn.id);
        if (!mine.some((c) => c.dirty())) continue;
        await saveConnection(conn, mine);
      }
      store.setProfile(await window.d3d.config.get());
      toast('info', 'Mappings saved');
    } catch (err) {
      toast('error', err.message);
    } finally {
      saveAllBtn.disabled = false;
    }
  };

  return {
    refreshLive() {
      for (const card of cards) card.refreshLive();
    }
  };
}

/** Write every changed receiver of one connection in a single save. */
async function saveConnection(conn, cards) {
  const next = JSON.parse(JSON.stringify(conn));
  for (const card of cards) {
    const d = next.destinations.find((x) => x.id === card.destId);
    if (d) d.mapping = card.mapping();
  }
  await window.d3d.config.saveConnection(next);
  for (const card of cards) card.markSaved();
}

// ---------------------------------------------------------------------------

function receiverCard(conn, dest) {
  const m = Object.assign({
    mode: 'full', revolutions: 1, gearRatio: 1,
    minInput: 0, maxInput: 0, minOutput: 0, maxOutput: 1,
    wrapInput: true, property: 'offset.x', object: ''
  }, dest.mapping || {});
  let saved = JSON.stringify(m);

  const where = `${dest.host}:${dest.port}`;
  const title = dest.name || where;
  const groupKey = (g) => `${dest.id}:${g}`;

  const saveBtn = el('button', { class: 'btn primary', text: 'Save', disabled: true });
  // On demand only: disguise's documentation says the Python endpoint must not
  // be polled and is not for use during a show. A button, and nothing else.
  const askBtn = el('button', { class: 'btn', text: 'Ask disguise' });
  const verdict = el('div', { class: 'map-verdict' });

  const pillHolder = el('span', { class: 'pill-holder' }, pill('idle'));
  const resultHolder = el('div', { class: 'map-result' });

  const dirty = () => JSON.stringify(m) !== saved;
  const refreshDirty = () => { saveBtn.disabled = !dirty(); };

  // -- the range this axis is driven over -----------------------------------

  const minBox = input({
    type: 'number', class: 'num-input', value: m.minInput,
    oninput: (e) => { m.minInput = Number(e.target.value); changed(); }
  });
  const maxBox = input({
    type: 'number', class: 'num-input', value: m.maxInput,
    oninput: (e) => { m.maxInput = Number(e.target.value); changed(); }
  });

  const captureRow = el('div', { class: 'map-rows' },
    el('div', { class: 'field' },
      el('label', {}, 'Start of travel ', el('code', { text: 'min_input' })),
      el('div', { class: 'row-inline' }, minBox,
        el('button', { class: 'btn shrink', text: 'Capture', onclick: () => capture('min') }))),
    el('div', { class: 'field' },
      el('label', {}, 'End of travel ', el('code', { text: 'max_input' })),
      el('div', { class: 'row-inline' }, maxBox,
        el('button', { class: 'btn shrink', text: 'Capture', onclick: () => capture('max') }))),
    el('div', { class: 'hint' },
      'Drive the axis to each end and press Capture — faster and more exact than working the steps out.'));

  const revRow = el('div', { class: 'map-rows' },
    el('div', { class: 'field' },
      el('label', { text: 'Revolutions of travel' }),
      input({
        type: 'number', class: 'num-input', value: m.revolutions, min: 0.01, step: 0.25,
        oninput: (e) => { m.revolutions = Number(e.target.value); changed(); }
      })),
    el('div', { class: 'field' },
      el('label', { text: 'Gear ratio — encoder turns per driven turn' }),
      input({
        type: 'number', class: 'num-input', value: m.gearRatio, min: 0.01, step: 0.1,
        oninput: (e) => { m.gearRatio = Number(e.target.value); changed(); }
      })));

  const modeArea = el('div');

  const inputBody = el('div', { class: 'cfg-body' },
    el('div', { class: 'field' },
      el('label', { text: 'How the input range is defined' }),
      select([
        { value: 'full', label: 'The encoder’s whole travel' },
        { value: 'revolutions', label: 'A number of revolutions' },
        { value: 'capture', label: 'Two captured endpoints' }
      ], m.mode, (v) => { m.mode = v; renderMode(); changed(); })),
    modeArea,
    el('div', { class: 'row-inline' },
      el('div', { class: 'field' },
        el('label', {}, el('code', { text: 'min_output' })),
        input({
          type: 'number', class: 'num-input', value: m.minOutput,
          oninput: (e) => { m.minOutput = Number(e.target.value); changed(); }
        })),
      el('div', { class: 'field' },
        el('label', {}, el('code', { text: 'max_output' })),
        input({
          type: 'number', class: 'num-input', value: m.maxOutput,
          oninput: (e) => { m.maxOutput = Number(e.target.value); changed(); }
        }))),
    el('div', { class: 'field' },
      el('label', { text: 'Property to drive' }),
      input({
        class: 'mono-input', value: m.property,
        oninput: (e) => { m.property = e.target.value; changed(); }
      }),
      el('div', { class: 'hint', text: 'A disguise expression: offset.x, rotation.y, brightness.' })),
    el('div', { class: 'field' },
      el('label', { text: 'Object (optional)' }),
      input({
        class: 'mono-input', value: m.object, placeholder: 'objects/screen2/surface 1.apx',
        oninput: (e) => { m.object = e.target.value; changed(); }
      })),
    checkbox('Wrap input — the span crosses the encoder’s rollover', m.wrapInput,
      (v) => { m.wrapInput = v; changed(); }));

  const groups = [
    detailsGroup('Input range and output', inputBody, groupKey('input')),
    detailsGroup('Type these into disguise', resultHolder, groupKey('fields'))
  ];

  const node = el('div', { class: 'card cfg-card' },
    el('div', { class: 'card-head' },
      el('span', { class: 'card-name', text: title }),
      pillHolder,
      el('div', { class: 'card-actions' }, askBtn, saveBtn)),
    // Same shape as an encoder card: what this is, and where, under the name.
    el('div', { class: 'card-addr' },
      `${where} · id ${dest.devid}` +
      (dest.enabled === false ? ' · disabled' : '') +
      ` · fed by ${conn.name} at ${conn.encoder.host}:${conn.encoder.port}`),
    verdict,
    ...groups);

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await saveConnection(conn, [api]);
      store.setProfile(await window.d3d.config.get());
      toast('info', `${title}: mapping saved`);
    } catch (err) {
      toast('error', err.message);
      saveBtn.disabled = false;
    }
  };

  const showAnswer = (r) => {
    verdict.className = `map-verdict ${r.matches ? 'ok' : 'warn'}`;
    clear(verdict);
    verdict.appendChild(el('div', { text: r.verdict }));
    // No second list. The verdict already names the receiver, every Navigator
    // driver it has and their ports — and, on an id mismatch, the axis ids —
    // so a per-receiver line underneath printed the same drivers again. One
    // statement, and it is the same one that goes into the log.
  };
  // What `lastAsked` is *for*: navigating away and back rebuilds this card,
  // and an answer the operator asked for must not vanish because they looked
  // at another screen. It was stored from the day the map was added and never
  // read — kept in a closure the rebuild threw away.
  if (lastAsked.has(dest.id)) showAnswer(lastAsked.get(dest.id));

  askBtn.onclick = async () => {
    askBtn.disabled = true;
    setText(verdict, `Asking ${dest.host}…`);
    verdict.className = 'map-verdict';
    try {
      const r = await window.d3d.disguise.inspect(conn.id, dest.id);
      lastAsked.set(dest.id, r);
      showAnswer(r);
    } catch (err) {
      // An unanswerable question tells us nothing about the destination, so the
      // pill keeps whatever the network says.
      lastAsked.delete(dest.id);
      verdict.className = 'map-verdict err';
      setText(verdict, err.message);
    } finally {
      askBtn.disabled = false;
    }
  };

  function renderMode() {
    clear(modeArea);
    if (m.mode === 'capture') modeArea.appendChild(captureRow);
    else if (m.mode === 'revolutions') modeArea.appendChild(revRow);
  }

  function capture(which) {
    const t = store.telemetryOf(conn.id);
    if (!t) { toast('warn', `${conn.name} is not running — start it to capture a position.`); return; }
    if (which === 'min') { m.minInput = t.pos; minBox.value = t.pos; }
    else { m.maxInput = t.pos; maxBox.value = t.pos; }
    changed();
  }

  let pending = null;
  function changed() {
    refreshDirty();
    if (pending) clearTimeout(pending);
    pending = setTimeout(recompute, 60);
  }

  async function recompute() {
    try {
      const res = await window.d3d.mapping.compute(conn.id, dest.id, m);
      clear(resultHolder).appendChild(renderResult(conn, res));
    } catch (err) {
      clear(resultHolder).appendChild(el('div', { class: 'err-text-inline', text: err.message }));
    }
  }

  renderMode();
  recompute();

  let lastState = null;
  const api = {
    node,
    connId: conn.id,
    destId: dest.id,
    dirty,
    mapping: () => JSON.parse(JSON.stringify(m)),
    markSaved() { saved = JSON.stringify(m); refreshDirty(); },
    refreshLive() {
      const t = store.telemetryOf(conn.id);

      // The receiver's own health, not the encoder's: this card is about the
      // disguise machine. Only on a real change — this runs every frame.
      const d = (t && (t.destinations || []).find((x) => x.id === dest.id)) || null;
      let state = d ? d.health : 'idle';
      // `receiving` and `mismatch` are decided on the server from the last
      // disguise answer, so every screen and every client says the same thing.
      if (state !== lastState) {
        clear(pillHolder).appendChild(pill(state));
        // The verdict described the state that has just ended. "Everything
        // matches" above a destination that has gone offline is a sentence
        // about a moment that is over, and it stayed on screen through the
        // change. It is re-established by asking, automatically or by hand.
        // Forgotten from the store as well, or the next rebuild would restore
        // the very sentence being cleared here.
        if (lastState !== null) {
          clear(verdict);
          lastAsked.delete(dest.id);
        }
        lastState = state;
      }
    }
  };
  return api;
}

/** A retractable group that remembers whether it was open. */
function detailsGroup(label, body, key) {
  const node = el('details', { class: 'cfg-group' },
    el('summary', { text: label }),
    body);
  if (openGroups.has(key)) node.open = true;
  node.addEventListener('toggle', () => {
    if (node.open) openGroups.add(key); else openGroups.delete(key);
  });
  return node;
}

// ---------------------------------------------------------------------------

function renderResult(conn, res) {
  const { mapped, fields, suggestedPreset } = res;
  const wrap = el('div');

  for (const w of mapped.warnings) {
    wrap.appendChild(el('div', { class: `map-warn ${w.level}` },
      el('div', { class: w.level === 'error' ? 'err-text-inline' : 'warn-text', text: w.text }),
      w.action === 'preset'
        ? el('button', {
          class: 'btn', text: `Move the rollover away — set Preset=${suggestedPreset}`,
          onclick: () => writePreset(conn, suggestedPreset)
        })
        : null));
  }

  wrap.appendChild(el('div', { class: 'statline' },
    el('span', {}, 'Span ', el('b', { text: `${groupDigits(mapped.rawSpan)} steps` })),
    el('span', {}, 'Rotation ', el('b', {
      text: `${fixed(mapped.revsUsed, 3)} rev (${fixed(mapped.revsUsed * 360, 1)}°)`
    })),
    el('span', {}, 'Resolution ', el('b', {
      text: mapped.unitsPerCount ? `${mapped.unitsPerCount.toExponential(2)} units / step` : '—'
    }))));

  const card = el('div', { class: 'd3card' });
  for (const section of fields) {
    card.appendChild(el('h4', { text: section.section }));
    for (const row of section.rows) {
      card.appendChild(el('div', { class: 'd3row' },
        el('span', { class: 'kk', text: row.key }),
        el('span', { class: 'vv', text: row.value || '(empty)' }),
        row.note ? el('span', { class: 'nn', text: row.note }) : null));
    }
  }
  wrap.appendChild(card);
  wrap.appendChild(el('div', { class: 'hint' },
    'Create a Position Receiver, add a Navigator driver inside it, then an Axis. ' +
    'Engage the position receiver last.'));

  return wrap;
}

async function writePreset(conn, value) {
  const ok = await confirmModal({
    title: 'Move the count rollover?',
    body: [
      el('div', { class: 'flash-warn' },
        el('strong', { text: 'This writes to the encoder’s flash. ' }),
        'Do not power off the encoder until it confirms.'),
      el('div', { class: 'cmd-preview' }, el('div', { text: `set Preset=${value}` })),
      el('p', { class: 'dim', text: 'Re-capture both endpoints afterwards — every position shifts.' })
    ],
    confirmLabel: 'Write preset',
    danger: true
  });
  if (!ok) return;
  try {
    await window.d3d.encoder.preset(conn.id, value);
    toast('info', 'Preset accepted — re-capture your endpoints once it confirms.');
  } catch (err) { toast('error', err.message); }
}
