/**
 * Log console.
 *
 * Raw line logging can run at 500 Hz per link, so the main process caps how
 * many lines it forwards per tick and reports how many it dropped. Showing that
 * count matters — a silently thinned log invites the wrong conclusion.
 */

import { el, clear, timeOfDay, toast, select, checkbox } from '../ui.js';
import { store } from '../store.js';

const MAX_RENDERED = 2000;

let buffer = [];
let dropped = 0;
let paused = false;
let filters = { id: '', level: '', dir: '' };

/** Called from app.js for every batch, regardless of which view is showing. */
export function ingestLog(batch) {
  if (paused) return;
  for (const line of batch.lines) buffer.push(line);
  dropped += batch.dropped || 0;
  if (buffer.length > MAX_RENDERED) buffer = buffer.slice(-MAX_RENDERED);
}

export function renderLog(root) {
  clear(root);
  const view = el('div', { class: 'view' });

  const box = el('div', { class: 'logbox' });
  const droppedNote = el('span', { class: 'warn-text meta' });

  const connOptions = [{ value: '', label: 'All connections' }].concat(
    store.connections.map((c) => ({ value: c.id, label: c.name })));

  const pauseBtn = el('button', {
    class: 'btn sm', text: paused ? 'Resume' : 'Pause',
    onclick: (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; }
  });

  const toolbar = el('div', { class: 'log-toolbar' },
    select(connOptions, filters.id, (v) => { filters.id = v; repaint(); }),
    select([
      { value: '', label: 'All levels' },
      { value: 'info', label: 'Info' },
      { value: 'warn', label: 'Warnings' },
      { value: 'error', label: 'Errors' }
    ], filters.level, (v) => { filters.level = v; repaint(); }),
    select([
      { value: '', label: 'All directions' },
      { value: 'rx', label: 'From encoder' },
      { value: 'tx', label: 'To encoder' }
    ], filters.dir, (v) => { filters.dir = v; repaint(); }),
    pauseBtn,
    el('button', { class: 'btn sm', text: 'Clear', onclick: () => { buffer = []; dropped = 0; repaint(); } }),
    el('button', {
      class: 'btn sm', text: 'Export…',
      onclick: async () => {
        try {
          const r = await window.d3d.log.export();
          if (r.written) toast('info', r.filePath ? `Log written to ${r.filePath}` : 'Log downloaded');
        } catch (err) { toast('error', err.message); }
      }
    }),
    droppedNote);

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Log' }),
      el('span', { class: 'spacer' }))));

  view.appendChild(toolbar);
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
    // Render only the tail: a virtualised list is not worth the complexity for
    // a window that is only ever read from the bottom.
    for (const l of lines.slice(-600)) {
      box.appendChild(el('div', { class: `logline ${l.level}` },
        el('span', { class: 't', text: timeOfDay(l.ts) }),
        // Direction is the thing you scan this list for — what we asked versus
        // what the encoder said — so it gets its own colour rather than
        // sharing the muted grey of a timestamp.
        el('span', {
          class: `w${l.level === 'info' && l.dir ? ` dir-${l.dir}` : ''}`,
          text: l.level === 'info' ? (l.dir || '') : l.level
        }),
        l.id ? el('span', { class: 'src', text: names.get(l.id) || l.id }) : null,
        el('span', { text: l.text })));
    }
    box.scrollTop = box.scrollHeight;
    droppedNote.textContent = dropped ? `${dropped} lines dropped (rate limited)` : '';
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
