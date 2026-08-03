/**
 * disguise mapping helper.
 *
 * Produces the exact values to type into the NavigatorDriver and
 * ScreenPositionAxis windows, and — more usefully — lets you drive the physical
 * axis to each end and press "Capture current" rather than working the numbers
 * out by hand at the venue.
 */

import {
  el, clear, groupDigits, fixed, setText, toast, select, input, checkbox, panel, confirmModal
} from '../ui.js';
import { store } from '../store.js';

export function renderMapping(root) {
  clear(root);
  const conn = store.selected;
  const view = el('div', { class: 'view' });

  if (!conn) {
    view.appendChild(el('div', { class: 'empty' }, el('h3', { text: 'Select a connection first' })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  const m = Object.assign({
    mode: 'full', revolutions: 1, gearRatio: 1,
    minInput: 0, maxInput: store.info.constants.TOTAL_COUNTS - 1,
    minOutput: 0, maxOutput: 1, wrapInput: true,
    property: 'offset.x', object: ''
  }, conn.mapping || {});

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Disguise Mapping' }),
      el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn primary', text: 'Save mapping',
      onclick: async () => {
        try {
          await window.d3d.config.saveConnection(Object.assign({}, conn, { mapping: m }));
          store.setProfile(await window.d3d.config.get());
          toast('info', 'Mapping saved');
        } catch (err) { toast('error', err.message); }
      }
    }))));

  view.appendChild(el('div', { class: 'view-sub' },
    'Work out min_input / max_input for the disguise Axes window. Drive the axis to each end of ' +
    'its travel and press Capture — that is usually faster and more accurate than calculating counts.'));

  const resultHolder = el('div');
  const livePos = el('span', { class: 'num', text: '—' });

  const minBox = input({ type: 'number', class: 'num-input', value: m.minInput, oninput: (e) => { m.minInput = Number(e.target.value); recompute(); } });
  const maxBox = input({ type: 'number', class: 'num-input', value: m.maxInput, oninput: (e) => { m.maxInput = Number(e.target.value); recompute(); } });

  const captureRow = el('div', {},
    el('div', { class: 'field' },
      el('label', {}, 'Start of travel (min_input)  ', el('span', { class: 'faint', text: 'counts' })),
      el('div', { class: 'row-inline' }, minBox,
        el('button', {
          class: 'btn shrink', text: 'Capture current',
          onclick: () => capture('min')
        }))),
    el('div', { class: 'field' },
      el('label', {}, 'End of travel (max_input)  ', el('span', { class: 'faint', text: 'counts' })),
      el('div', { class: 'row-inline' }, maxBox,
        el('button', {
          class: 'btn shrink', text: 'Capture current',
          onclick: () => capture('max')
        }))),
    el('div', { class: 'hint' }, 'Live position: ', livePos));

  const revBox = input({ type: 'number', class: 'num-input', value: m.revolutions, min: 0.01, step: 0.25, oninput: (e) => { m.revolutions = Number(e.target.value); recompute(); } });
  const gearBox = input({ type: 'number', class: 'num-input', value: m.gearRatio, min: 0.01, step: 0.1, oninput: (e) => { m.gearRatio = Number(e.target.value); recompute(); } });

  const revRow = el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'Revolutions of travel' }), revBox),
    el('div', { class: 'field' },
      el('label', { text: 'Gear / belt ratio (encoder turns per driven turn)' }), gearBox));

  const modeArea = el('div');

  const form = el('div', { class: 'panel-body' },
    el('div', { class: 'field' },
      el('label', { text: 'How is the input range defined?' }),
      select([
        { value: 'full', label: 'Full 25-bit range (0 … 33 554 431)' },
        { value: 'revolutions', label: 'A number of revolutions' },
        { value: 'capture', label: 'Capture two endpoints' }
      ], m.mode, (v) => { m.mode = v; renderMode(); recompute(); })),
    modeArea,
    el('div', { class: 'row-inline' },
      el('div', { class: 'field' }, el('label', { text: 'min_output' }),
        input({ type: 'number', class: 'num-input', value: m.minOutput, oninput: (e) => { m.minOutput = Number(e.target.value); recompute(); } })),
      el('div', { class: 'field' }, el('label', { text: 'max_output' }),
        input({ type: 'number', class: 'num-input', value: m.maxOutput, oninput: (e) => { m.maxOutput = Number(e.target.value); recompute(); } }))),
    el('div', { class: 'field' },
      el('label', { text: 'Property to drive' }),
      input({ class: 'mono-input', value: m.property, oninput: (e) => { m.property = e.target.value; recompute(); } }),
      el('div', { class: 'hint', text: 'A disguise expression, e.g. offset.x, rotation.y, brightness.' })),
    el('div', { class: 'field' },
      el('label', { text: 'Object (optional)' }),
      input({ class: 'mono-input', value: m.object, placeholder: 'objects/screen2/surface 1.apx', oninput: (e) => { m.object = e.target.value; recompute(); } })),
    checkbox('wrapinput', m.wrapInput, (v) => { m.wrapInput = v; recompute(); }));

  view.appendChild(el('div', { class: 'grid-2' },
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', { text: 'Input range' })),
      form),
    resultHolder));

  root.appendChild(view);

  function renderMode() {
    clear(modeArea);
    if (m.mode === 'capture') modeArea.appendChild(captureRow);
    else if (m.mode === 'revolutions') modeArea.appendChild(revRow);
  }

  function capture(which) {
    const t = store.telemetryOf(conn.id);
    if (!t) { toast('warn', 'No live position — start the connection first.'); return; }
    if (which === 'min') { m.minInput = t.pos; minBox.value = t.pos; }
    else { m.maxInput = t.pos; maxBox.value = t.pos; }
    recompute();
  }

  let pending = null;
  async function recompute() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        const res = await window.d3d.mapping.compute(conn.id, m);
        clear(resultHolder).appendChild(renderResult(conn, res, m));
      } catch (err) {
        clear(resultHolder).appendChild(el('div', { class: 'panel' },
          el('div', { class: 'panel-body err-text-inline', text: err.message })));
      }
    }, 60);
  }

  renderMode();
  recompute();

  return {
    refreshLive() {
      const t = store.telemetryOf(conn.id);
      setText(livePos, t ? groupDigits(t.pos) : null);
    }
  };
}

function renderResult(conn, res, m) {
  const { mapped, fields, suggestedPreset } = res;
  const wrap = el('div');

  for (const w of mapped.warnings) {
    const box = el('div', {
      class: 'panel',
      style: `border-color:${w.level === 'error' ? 'var(--err)' : 'var(--warn)'}`
    },
      el('div', { class: 'panel-body' },
        el('div', { class: w.level === 'error' ? 'err-text-inline' : 'warn-text', text: w.text }),
        w.action === 'preset'
          ? el('div', { style: 'margin-top:10px' },
            el('button', {
              class: 'btn sm', text: `Move the rollover away (set Preset=${suggestedPreset})`,
              onclick: async () => {
                const ok = await confirmModal({
                  title: 'Move the count rollover?',
                  body: [
                    el('div', { class: 'flash-warn' },
                      el('strong', { text: 'This writes to the encoder’s flash. ' }),
                      'Do not power off the encoder until it confirms.'),
                    el('div', { class: 'cmd-preview' }, el('div', { text: `set Preset=${suggestedPreset}` })),
                    el('p', { class: 'dim', text: 'Re-capture both endpoints afterwards — every position shifts.' })
                  ],
                  confirmLabel: 'Write preset'
                });
                if (!ok) return;
                try {
                  await window.d3d.encoder.preset(conn.id, suggestedPreset);
                  toast('info', 'Preset accepted — re-capture your endpoints once it confirms.');
                } catch (err) { toast('error', err.message); }
              }
            }))
          : null));
    wrap.appendChild(box);
  }

  const summary = el('div', { class: 'statline', style: 'margin-bottom:12px' },
    el('span', {}, 'Span ', el('b', { text: `${groupDigits(mapped.rawSpan)} counts` })),
    el('span', {}, 'Rotation ', el('b', { text: `${fixed(mapped.revsUsed, 3)} rev (${fixed(mapped.revsUsed * 360, 1)}°)` })),
    el('span', {}, 'Resolution ', el('b', {
      text: mapped.unitsPerCount
        ? `${mapped.unitsPerCount.toExponential(2)} output units / count`
        : '—'
    })));

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

  wrap.appendChild(panel('Type these into disguise', [summary, card], null,
    'Create a Position Receiver, add a Navigator driver inside it, then add an Axis. ' +
    'Values are selectable so you can copy them straight across. Finally, engage the position receiver.'));

  return wrap;
}
