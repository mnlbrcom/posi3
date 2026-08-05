/**
 * DOM helpers and formatters.
 *
 * Everything builds nodes through the DOM API rather than innerHTML, so no
 * device-supplied or user-supplied string is ever parsed as markup.
 */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') throw new Error('innerHTML is not used in this app');
    else if (k === 'style') applyStyle(node, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

/**
 * Apply a `prop: value; ...` declaration string through the CSSOM.
 *
 * Not `setAttribute('style', ...)`: this app's CSP is `style-src 'self'`, which
 * blocks inline style ATTRIBUTES outright — they are parsed but silently
 * dropped, so a width set that way simply never takes effect. Programmatic
 * CSSOM writes are not restricted, so setProperty is both safe and effective,
 * and it lets the policy stay strict.
 */
export function applyStyle(node, decls) {
  if (!decls) return node;
  for (const part of String(decls).split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && value) node.style.setProperty(prop, value);
  }
  return node;
}

export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return parent;
}

/**
 * Write text only when it actually differs.
 *
 * The live views are driven from requestAnimationFrame, so these run ~60 times
 * a second. Assigning textContent unconditionally replaces the text node every
 * frame and makes the UI shimmer even when nothing changed.
 */
export function setText(node, value) {
  const s = value === null || value === undefined ? '—' : String(value);
  if (node.__t !== s) {
    node.textContent = s;
    node.__t = s;
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, v);
  }
  return node;
}

// ---------------------------------------------------------------- formatting

/**
 * Grouped every three digits; keeps long counts readable without commas.
 *
 * The separator is U+2007 FIGURE SPACE, which is the width of a digit in a
 * tabular face — which is what every figure here is now set in. It was a thin
 * space, and a thin space is exactly what its name says: in a monospaced font
 * that hardly mattered because the glyph still occupied a full cell, but once
 * the readouts moved to the proportional face the grouping all but vanished
 * and "94 952" read as one blob. U+2007 is also non-breaking, so a grouped
 * figure never wraps mid-number.
 */
export function groupDigits(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return (neg ? '-' : '') + out;
}

export function fixed(n, d = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

export function duration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * A number that stops twitching, without lying about it.
 *
 * The rate is a one-second average, which is steady enough — but it is
 * recomputed on every telemetry tick, and each recomputation slides the window
 * by one sample. With integer counters that moves the result a packet or two
 * either way, so a whole-number readout flickered 98 / 99 / 100 thirty times a
 * second. The measurement was never the problem; painting it thirty times a
 * second was. (Rounding to the nearest ten used to hide this.)
 *
 * Two gates, both on the display only:
 *   everyMs   how often the shown figure may change at all
 *   deadband  how far the real value must move before it is worth changing
 *
 * A slow drift still gets through: the comparison is against what is shown, so
 * successive small moves accumulate until they clear the band.
 *
 * @param {{everyMs?: number, deadband?: number}} [opts]
 * @returns {(value: number) => number}
 */
export function steady({ everyMs = 500, deadband = 2 } = {}) {
  let shown = null;
  let lastAt = -Infinity;
  return (value) => {
    if (!Number.isFinite(value)) return value;
    const now = performance.now();
    // First reading, and any move to or from nothing, land at once: "it
    // stopped" is the one change nobody should wait half a second to see.
    if (shown === null || value === 0 || shown === 0) {
      shown = value;
      lastAt = now;
      return shown;
    }
    if (now - lastAt < everyMs) return shown;
    lastAt = now;
    if (Math.abs(value - shown) >= deadband) shown = value;
    return shown;
  };
}

/**
 * Throughput, as a whole number.
 *
 * The figure behind it is a one-second average, which is steady enough to read
 * without rounding it further — a second at a normal cycle time is about a
 * hundred samples.
 */
export function hz(n) {
  if (!Number.isFinite(n)) return '—';
  if (n <= 0) return '0';
  // The whole number, not the nearest ten: rounding to tens turned 98 Hz into
  // 100 and hid the difference between a link at 96 and one at 104.
  //
  // Something that rounds to zero still says so as `<1`, because "nothing is
  // arriving" and "a trickle is arriving" call for opposite responses and a
  // bare 0 claims the first.
  const rounded = Math.round(n);
  return rounded === 0 ? '<1' : String(rounded);
}

/**
 * The encoder's microsecond counter as a clock: `00:44:15.553`.
 *
 * Raw, it is nine or ten digits of nothing an operator can use. As a duration
 * it reads directly against the shaft: how long since the encoder powered up.
 *
 * It is a 32-bit counter, so it wraps at 01:11:34.967 and starts again — which
 * is why the hours field is kept rather than dropped, and why a jump backwards
 * in this reading is the counter, not a fault.
 */
export function microsToClock(us) {
  if (us === null || us === undefined || Number.isNaN(us)) return '—';
  const total = Math.max(0, Math.trunc(us));
  const ms = Math.floor(total / 1000) % 1000;
  const secs = Math.floor(total / 1e6);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:` +
    `${pad(secs % 60)}.${pad(ms, 3)}`;
}

export function micros(n) {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} ms` : `${Math.round(n)} µs`;
}

export function timeOfDay(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// -------------------------------------------------------------------- pieces

export function pill(state) {
  return el('span', { class: `pill ${state || 'idle'}` },
    el('span', { class: 'dot' }),
    state || 'idle');
}

export function field(label, control, hint) {
  return el('div', { class: 'field' },
    el('label', { text: label }),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null);
}

export function input(attrs = {}) {
  return el('input', Object.assign({ type: 'text' }, attrs));
}

export function select(options, value, onchange) {
  const s = el('select', { onchange: (e) => onchange(e.target.value) });
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    const node = el('option', { value: opt.value, text: opt.label });
    // Shown but unchoosable, so a device reporting a value this app cannot use
    // still displays it truthfully instead of a blank box.
    if (opt.disabled) node.disabled = true;
    if (String(opt.value) === String(value)) node.selected = true;
    s.appendChild(node);
  }
  return s;
}

export function segmented(options, value, onchange) {
  const wrap = el('div', { class: 'seg' });
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    wrap.appendChild(el('button', {
      class: String(opt.value) === String(value) ? 'on' : '',
      text: opt.label,
      title: opt.title || '',
      onclick: () => onchange(opt.value)
    }));
  }
  return wrap;
}

export function checkbox(label, checked, onchange) {
  const id = `cb-${Math.random().toString(36).slice(2)}`;
  const box = el('input', { type: 'checkbox', id, onchange: (e) => onchange(e.target.checked) });
  box.checked = !!checked;
  return el('div', { class: 'check' }, box, el('label', { for: id, text: label }));
}

export function panel(title, bodyChildren, headExtras, note) {
  const head = el('div', { class: 'panel-head' }, el('span', { text: title }), el('span', { class: 'spacer' }));
  if (headExtras) append(head, [headExtras]);
  return el('div', { class: 'panel' },
    head,
    el('div', { class: 'panel-body' }, ...[].concat(bodyChildren)),
    note ? el('div', { class: 'panel-note', text: note }) : null);
}

// -------------------------------------------------------------------- modals

/** @returns {Promise<boolean>} */
/**
 * The dialog shell: backdrop, title, body, footer, and dismissal by backdrop
 * click or Escape.
 *
 * `buildFoot` receives the close function so a caller decides what its buttons
 * do. `onDismiss` fires only for the backdrop and Escape paths, which is what
 * lets a promise-based dialog settle when the user walks away from it rather
 * than leaving the caller waiting.
 */
function modalShell({ title, body, wide = false }, buildFoot, onDismiss) {
  const root = document.getElementById('modal-root');
  let closed = false;

  const onKey = (e) => { if (e.key === 'Escape') close(true); };
  function close(dismissed = false) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    clear(root);
    if (dismissed && onDismiss) onDismiss();
  }

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (e.target === backdrop) close(true); }
  }, el('div', { class: `modal${wide ? ' modal-wide' : ''}` },
    el('h3', { text: title }),
    el('div', { class: 'modal-body' }, ...[].concat(body)),
    el('div', { class: 'modal-foot' }, ...buildFoot(() => close(false)))));

  document.addEventListener('keydown', onKey);
  clear(root).appendChild(backdrop);
  return () => close(false);
}

export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false, wide = false }) {
  return new Promise((resolve) => {
    modalShell({ title, body, wide }, (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { close(); resolve(false); } }),
      el('button', {
        class: `btn ${danger ? 'danger' : 'primary'}`, text: confirmLabel,
        onclick: () => { close(); resolve(true); }
      })
    ], () => resolve(false));
  });
}

/**
 * A dialog with no decision to make: it holds controls that take effect as they
 * are used, so its only footer button closes it. Returns that close function,
 * so a control inside can dismiss the dialog before navigating.
 */
export function openModal({ title, body, closeLabel = 'Close', wide = false }) {
  return modalShell({ title, body, wide },
    (close) => [el('button', { class: 'btn', text: closeLabel, onclick: close })]);
}

/**
 * How long any banner may stay on screen.
 *
 * A banner is an interruption, not a record. Every one of them is also written
 * to the log now, and the state a banner describes — a destination that is not
 * answering, an encoder in the wrong output mode — is on the dashboard
 * continuously. So there is nothing left for a banner to be the only copy of,
 * and one that sits there all night is one that stops being read.
 */
const MAX_BANNER_MS = 30000;

/**
 * A notice across the top of the window.
 *
 * Every banner closes, and now every banner closes *itself*. There used to be a
 * `dismissible: false` for the ones thought too important to lose — the
 * flash-write warning above all — but a notice nobody can clear is a notice
 * that eventually gets ignored, and it left an operator staring at a warning
 * about a write that had already finished. Importance is carried by the wording
 * and the colour, not by trapping it on screen.
 *
 * `ttlMs` shortens that for things true only for a moment; it can never extend
 * it past MAX_BANNER_MS.
 */
export function banner(kind, text, { key, ttlMs = 0 } = {}) {
  const root = document.getElementById('banners');
  if (key) {
    const existing = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (existing) existing.remove();
  }
  const node = el('div', { class: `banner banner-${kind}`, dataset: key ? { key } : {} },
    el('span', { text }),
    el('button', { class: 'banner-close', text: '×', title: 'Dismiss', onclick: () => node.remove() }));
  root.appendChild(node);
  setTimeout(() => node.remove(), ttlMs > 0 ? Math.min(ttlMs, MAX_BANNER_MS) : MAX_BANNER_MS);
  return () => node.remove();
}

export function dismissBanner(key) {
  const node = document.getElementById('banners').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (node) node.remove();
}

export function toast(kind, text, ms = 4500) {
  return banner(kind, text, { ttlMs: ms });
}
