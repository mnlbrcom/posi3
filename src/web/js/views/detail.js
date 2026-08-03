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

import {
  el, pill, groupDigits,
  confirmModal, openModal, toast, segmented
} from '../ui.js';
import { store } from '../store.js';

/**
 * Explain the chosen policy in terms of what reaches disguise.
 *
 * The packet shape never varies — it is always `id:pos,vel;` — so the only
 * question is what occupies the velocity slot. Saying that plainly matters
 * because "From encoder" reads like it might send nothing when the encoder is
 * not configured to report velocity, and it does not: it sends 0.
 */
function velocityHint(conn) {
  if (conn.velocityPolicy === 'passthrough') {
    return 'Sends the encoder\'s own value when OutputMode includes Velocity, and 0 when it ' +
      'does not. The packet keeps the same shape either way, so disguise never sees it change.';
  }
  if (conn.velocityPolicy === 'derived') {
    return 'Computed here from position deltas, so it works even when the encoder is not ' +
      'reporting velocity. Smoothed over ~200 ms, so it lags a sudden stop.';
  }
  return 'The original behaviour: disguise derives velocity from position itself via the axis ' +
    'velocitycalcmode. Byte-identical to d3driver.exe.';
}

export function openControls(conn) {
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

  const state = store.stateOf(conn.id);
  const running = state !== 'idle' && state !== 'error';
  const runStop = el('button', {
    class: running ? 'btn' : 'btn primary',
    text: running ? 'Stop' : 'Start',
    onclick: () => toggleLink(conn)
  });

  // Where the dialog was opened from decides where "go to" should land, so
  // close first: leaving a dialog over a screen the user just asked for is the
  // kind of thing that looks like a bug.
  const goTo = (view) => { close(); store.setView(view, conn.id); };

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

      el('div', { class: 'modal-actions' }, pill(state), runStop, zeroBtn, runBtn),

      el('div', { class: 'field' },
        el('label', { text: 'Velocity sent to disguise' }),
        segmented([
          { value: 'zero', label: 'Always zero', title: 'Byte-identical to the original d3driver.exe' },
          {
            value: 'passthrough',
            label: 'From encoder',
            title: "The encoder's own signed steps/s when it sends them, 0 when it does not"
          },
          { value: 'derived', label: 'Derived here', title: 'Computed from position deltas, wrap-aware' }
        ], conn.velocityPolicy, (v) => saveField(conn, { velocityPolicy: v })),
        el('div', { class: 'hint' }, velocityHint(conn))),

      el('div', { class: 'field' },
        el('label', { text: 'When records arrive coalesced' }),
        segmented([
          { value: 'every', label: 'Forward every', title: 'Original behaviour; best for velocity derivation in disguise' },
          { value: 'latest', label: 'Newest only', title: 'Lowest latency when only current position matters' }
        ], conn.udpSendPolicy, (v) => saveField(conn, { udpSendPolicy: v }))),

      el('div', { class: 'field' },
        el('label', { text: 'Go to' }),
        el('div', { class: 'row-inline' },
          el('button', { class: 'btn', text: 'Encoder Config', onclick: () => goTo('encoder') }),
          el('button', { class: 'btn', text: 'Disguise Mapping', onclick: () => goTo('mapping') }),
          el('button', { class: 'btn', text: 'Log', onclick: () => goTo('log') }))),

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

async function saveField(conn, patch) {
  try {
    const updated = Object.assign({}, conn, patch);
    await window.d3d.config.saveConnection(updated);
    store.setProfile(await window.d3d.config.get());
  } catch (err) { toast('error', err.message); }
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
