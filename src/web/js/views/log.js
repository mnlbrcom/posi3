/**
 * Log console.
 *
 * The bridge caps how many lines it forwards per tick. When that bites it says
 * so as a log line of its own rather than as a note beside the controls — a gap
 * in the log belongs in the log, where it is read and where Export preserves
 * it.
 */

import { el, clear, timeOfDay, toast, select, checkbox } from '../ui.js';
import { store } from '../store.js';

const MAX_RENDERED = 2000;

let buffer = [];
let paused = false;
let filters = { id: '', level: '', dir: '' };

/**
 * Called from app.js for every batch, regardless of which view is showing.
 *
 * Pause freezes the *window*, not the recording. This used to return early
 * while paused, so lines arriving during a pause were thrown away and Resume
 * showed nothing that had happened — they came back only on a reload, which
 * re-reads the server's ring buffer. Pausing to read something and losing what
 * arrived meanwhile is the opposite of what the button is for.
 */
export function ingestLog(batch) {
  for (const line of batch.lines) buffer.push(line);
  if (buffer.length > MAX_RENDERED) buffer = buffer.slice(-MAX_RENDERED);
}

export function renderLog(root) {
  clear(root);
  const view = el('div', { class: 'view' });

  const box = el('div', { class: 'logbox' });

  const connOptions = [{ value: '', label: 'All connections' }].concat(
    store.connections.map((c) => ({ value: c.id, label: c.name })));

  const pauseBtn = el('button', {
    class: 'btn', text: paused ? 'Resume' : 'Pause',
    onclick: (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; }
  });

  const controls = [
    select(connOptions, filters.id, (v) => { filters.id = v; repaint(); }),
    select([
      { value: '', label: 'All levels' },
      { value: 'info', label: 'Info' },
      { value: 'warn', label: 'Warnings' },
      { value: 'error', label: 'Errors' }
    ], filters.level, (v) => { filters.level = v; repaint(); }),
    select([
      { value: '', label: 'All sources' },
      { value: 'rx', label: 'From encoder' },
      { value: 'tx', label: 'To encoder' },
      { value: 'app', label: 'App' },
      { value: 'user', label: 'Operator' }
    ], filters.dir, (v) => { filters.dir = v; repaint(); }),
    pauseBtn,
    el('button', { class: 'btn', text: 'Clear', onclick: () => { buffer = []; repaint(); } }),
    el('button', {
      class: 'btn', text: 'Export',
      onclick: async () => {
        try {
          const r = await window.d3d.log.export();
          if (r.written) toast('info', r.filePath ? `Log written to ${r.filePath}` : 'Log downloaded');
        } catch (err) { toast('error', err.message); }
      }
    })
  ];

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Log' }),
      el('span', { class: 'spacer' }),
      ...controls)));

  view.appendChild(box);

  root.appendChild(view);

  let lastCount = -1;

  function visible() {
    return buffer.filter((l) =>
      (!filters.id || l.id === filters.id) &&
      (!filters.level || l.level === filters.level) &&
      (!filters.dir || l.dir === filters.dir));
  }

  function repaint() {
    const lines = visible();
    clear(box);
    const names = new Map(store.connections.map((c) => [c.id, c.name]));
    // The name the line was written with, first: a connection deleted since is
    // still named here, which is the case where its log lines matter most. The
    // live map covers anything logged before names were stamped.
    //
    // When neither knows it, say so in words. A UUID — whole or shortened — is
    // not something anyone can read; "deleted" is the fact the reader actually
    // needs, and the id is on the tooltip for the rare case it is wanted.
    const who = (l) => l.name || names.get(l.id) || 'deleted';
    // Render only the tail: a virtualised list is not worth the complexity for
    // a window that is only ever read from the bottom.
    for (const l of lines.slice(-600)) {
      box.appendChild(el('div', { class: `logline ${l.level}` },
        el('span', { class: 't', text: timeOfDay(l.ts) }),
        // Who said it. The one column used to show the source for info lines
        // and the level for everything else, so a warning from the encoder was
        // indistinguishable from a warning about it. They are different facts
        // and get a column each.
        el('span', { class: `w${l.dir ? ` dir-${l.dir}` : ''}`, text: l.dir || '' }),
        // Blank on info, which is most lines — the eye should catch the ones
        // that are not.
        el('span', { class: `lv ${l.level}`, text: l.level === 'info' ? '' : l.level }),
        l.id ? el('span', { class: 'src', title: l.id, text: who(l) }) : null,
        el('span', { text: l.text })));
    }
    box.scrollTop = box.scrollHeight;
    lastCount = buffer.length;
  }

  repaint();

  return {
    refreshLive() {
      if (paused || buffer.length === lastCount) return;
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      repaint();
      if (!atBottom) box.scrollTop = box.scrollHeight - box.clientHeight - 41;
    }
  };
}
