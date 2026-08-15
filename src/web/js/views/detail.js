/**
 * Per-connection controls, as a dialog.
 *
 * This was a page, and before that a page that also carried the dial and the
 * live readouts. The watching moved to the dashboard; what is left is the
 * things you *do* to a connection, and those are a dialog rather than a
 * destination — the same shape as Add and Edit, opened from the card and
 * dismissed when you are done. Keeping them out of the dashboard also keeps a
 * flash-write button off the screen that is open all show.
 *
 * The controls act as they are used, so there is nothing to confirm: the
 * footer only closes.
 */

import { el, pill, groupDigits, confirmModal, openModal, toast } from '../ui.js';
import { store } from '../store.js';

export function openControls(conn) {
  const presetBtn = el('button', {
    class: 'btn', text: 'Preset 0',
    onclick: () => doPreset(conn)
  });

  const offsetBtn = el('button', {
    class: 'btn', text: 'Offset 0',
    onclick: () => doOffset(conn)
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

  const state = store.stateOf(conn.id);
  const running = state !== 'idle' && state !== 'error';
  const runStop = el('button', {
    class: running ? 'btn' : 'btn primary',
    text: running ? 'Stop' : 'Start',
    onclick: () => toggleLink(conn)
  });

  const close = openModal({
    title: `${conn.name} · Controls`,
    closeLabel: 'Done',
    wide: true,
    body: [
      el('div', { class: 'route', style: 'margin-bottom:14px' },
        `${conn.encoder.host}:${conn.encoder.port}`,
        el('span', { class: 'arrow', text: '→' }),
        `${conn.d3.host}:${conn.d3.port}`,
        el('span', { class: 'arrow', text: '·' }),
        `device ID ${conn.d3.devid}`),

      el('div', { class: 'modal-actions' }, pill(store.encoderIndicator(conn.id)), runStop, runBtn),

      // Each of these spends one of the encoder's finite flash-write cycles, so
      // they are set apart from the quick controls, headed as critical, and each
      // says what it does.
      el('div', { class: 'modal-writes' },
        el('p', { class: 'modal-writes-head', text: 'CRITICAL FLASH MEMORY ACTIONS' }),
        el('p', {
          class: 'modal-writes-note',
          text: 'Flash Lifespan (~100,000 Writes), Firmware prevents writing identical consecutive ' +
            'Presets. Wait for posi3 to report "flash write confirmed" before turning off power ' +
            'to avoid Flash corruption.'
        }),
        el('div', { class: 'modal-action-row' },
          presetBtn,
          el('span', { class: 'hint', text: 'The target output number defined by the user for the current physical position.' })),
        el('div', { class: 'modal-action-row' },
          offsetBtn,
          el('span', { class: 'hint', text: 'Resets to Initial State (Raw Uncalibrated Physical Reading).' }))),

      // Deleting used to live in the connections row menu, which is gone. It
      // belongs on the one surface that is about managing a single connection,
      // set apart from the controls above so it is not next to anything you
      // would press in a hurry.
      el('div', { class: 'modal-danger' },
        el('button', {
          class: 'btn danger', text: 'Delete connection…',
          onclick: () => { close(); confirmDelete(conn); }
        }),
        el('span', { class: 'hint', text: 'Removes it from the profile. The encoder is not touched.' }))
    ]
  });

  return close;
}

async function confirmDelete(conn) {
  const sure = await confirmModal({
    title: 'Delete Connection?',
    body: el('p', { text: `“${conn.name}” will be removed from the profile. This cannot be undone.` }),
    confirmLabel: 'Delete',
    danger: true
  });
  if (!sure) return;
  try {
    await window.d3d.config.deleteConnection(conn.id);
    store.setProfile(await window.d3d.config.get());
  } catch (err) { toast('error', err.message); }
}

async function toggleLink(conn) {
  const state = store.stateOf(conn.id);
  const running = state !== 'idle' && state !== 'error';
  try {
    if (running) await window.d3d.link.stop(conn.id);
    else await window.d3d.link.start(conn.id);
  } catch (err) { toast('error', err.message); }
}

async function doOffset(conn) {
  const ok = await confirmModal({
    title: 'Reset Offset?',
    body: [
      el('div', { class: 'flash-warn' },
        el('strong', { text: 'This writes to the encoder’s flash memory. ' }),
        'Do not power off the encoder or unplug its network cable until the confirmation appears. ' +
        'It may take a few seconds.'),
      el('div', { class: 'cmd-preview' }, el('div', { text: 'set Offset=0' })),
      el('p', {
        class: 'dim',
        text: 'Clears any stored offset, so the encoder reports its raw, uncalibrated physical reading again.'
      })
    ],
    confirmLabel: 'Write Offset=0'
  });
  if (!ok) return;

  try {
    const results = await window.d3d.encoder.writeMany(conn.id, [{ variable: 'Offset', value: '0' }]);
    // Confirmation of a landed write arrives on the echo, as a flashConfirmed
    // toast. A refusal comes back in the results.
    const bad = (results || []).filter((r) => !r.ok);
    if (bad.length) toast('error', `Offset not written: ${bad.map((b) => b.error).join(', ')}`);
  } catch (err) {
    toast('error', err.message);
  }
}

async function doPreset(conn) {
  const ok = await confirmModal({
    title: 'Zero Encoder?',
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
    // Confirmation arrives on the echo, as a flashConfirmed toast — no wait here.
  } catch (err) {
    if (err.code !== 'EPRESET_DUPLICATE') {
      toast('error', err.message);
      return;
    }
    // The firmware will not store the same Preset twice in a row, so re-zeroing
    // an already-zeroed encoder does nothing at all unless we write a different
    // value first. That costs a second flash cycle, so it is the operator's call.
    const again = await confirmModal({
      title: 'Preset Already Zero',
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
