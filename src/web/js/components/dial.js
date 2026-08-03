/**
 * Angular position dial.
 *
 * Inline SVG, no libraries (nothing external can load under this app's CSP).
 *
 * Built for a 30 Hz update with no layout cost:
 *   - the static layer is drawn once, and the 360 minor ticks are ONE <path>
 *     rather than 360 elements
 *   - each update touches three nodes and only sets `transform` and
 *     `stroke-dashoffset`, both of which the compositor handles without
 *     re-laying out the page
 */

import { svgEl, el } from '../ui.js';

/*
 * Font sizes below are viewBox units, not CSS pixels: they scale with the dial
 * as it is sized by its column, so they sit outside the app's type scale by
 * design. Everything drawn in HTML uses the --fs-* tokens.
 *
 * The family is --sans, like every other figure. Fixed-width digits come from
 * `font-variant-numeric: tabular-nums` in the stylesheet, which is all mono was
 * providing here — and without it the centre readout would shift as it counts.
 */

const SIZE = 320;
const C = SIZE / 2;

const R_OUTER = 148; // tick ring
const R_TICK_MINOR = 138;
const R_TICK_MAJOR = 128;
const R_LABEL = 112;
const R_PROGRESS = 96; // within-revolution arc
const R_MULTITURN = 78; // revolutions arc
const NEEDLE_LEN = 92;

export class Dial {
  constructor() {
    this.node = el('div', { class: 'dial' });
    this._svg = svgEl('svg', {
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      width: SIZE,
      height: SIZE,
      role: 'img',
      'aria-label': 'Encoder position'
    });
    this.node.appendChild(this._svg);
    this._buildStatic();
    this._buildDynamic();
    this._lastAngle = null;
    this._lastFrac = null;
    this._lastRevFrac = null;
    this._lastText = null;
  }

  // -- drawn once -----------------------------------------------------------

  _buildStatic() {
    const g = svgEl('g');

    g.appendChild(svgEl('circle', {
      cx: C, cy: C, r: R_OUTER, fill: 'none', stroke: 'var(--border)', 'stroke-width': 1
    }));

    // 360 one-degree ticks as a single path.
    let minor = '';
    let major = '';
    for (let deg = 0; deg < 360; deg++) {
      const isMajor = deg % 30 === 0;
      const rIn = isMajor ? R_TICK_MAJOR : R_TICK_MINOR;
      const a = ((deg - 90) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const seg = `M${(C + cos * rIn).toFixed(2)} ${(C + sin * rIn).toFixed(2)}` +
        `L${(C + cos * R_OUTER).toFixed(2)} ${(C + sin * R_OUTER).toFixed(2)}`;
      if (isMajor) major += seg; else minor += seg;
    }
    g.appendChild(svgEl('path', { d: minor, stroke: 'var(--border)', 'stroke-width': 1, fill: 'none' }));
    g.appendChild(svgEl('path', { d: major, stroke: 'var(--text-faint)', 'stroke-width': 1.5, fill: 'none' }));

    for (let deg = 0; deg < 360; deg += 30) {
      const a = ((deg - 90) * Math.PI) / 180;
      const t = svgEl('text', {
        x: (C + Math.cos(a) * R_LABEL).toFixed(1),
        y: (C + Math.sin(a) * R_LABEL).toFixed(1),
        fill: 'var(--text-faint)',
        'font-size': '9.5',
        'font-family': 'var(--sans)',
        'text-anchor': 'middle',
        'dominant-baseline': 'central'
      });
      t.textContent = String(deg);
      g.appendChild(t);
    }

    // Track circles behind the two progress arcs.
    for (const r of [R_PROGRESS, R_MULTITURN]) {
      g.appendChild(svgEl('circle', {
        cx: C, cy: C, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': r === R_PROGRESS ? 7 : 4
      }));
    }

    this._svg.appendChild(g);
  }

  // -- updated per frame ----------------------------------------------------

  _buildDynamic() {
    const circ = (r) => 2 * Math.PI * r;

    this._progress = svgEl('circle', {
      cx: C, cy: C, r: R_PROGRESS,
      fill: 'none', stroke: 'var(--accent)', 'stroke-width': 7, 'stroke-linecap': 'round',
      'stroke-dasharray': circ(R_PROGRESS).toFixed(2),
      'stroke-dashoffset': circ(R_PROGRESS).toFixed(2),
      transform: `rotate(-90 ${C} ${C})`
    });
    this._progressCirc = circ(R_PROGRESS);

    // Muted rather than a second saturated colour: the outer ring is the
    // primary reading and should be the only thing shouting on the dial.
    this._multi = svgEl('circle', {
      cx: C, cy: C, r: R_MULTITURN,
      fill: 'none', stroke: 'var(--text-faint)', 'stroke-width': 4, 'stroke-linecap': 'round',
      'stroke-dasharray': circ(R_MULTITURN).toFixed(2),
      'stroke-dashoffset': circ(R_MULTITURN).toFixed(2),
      transform: `rotate(-90 ${C} ${C})`
    });
    this._multiCirc = circ(R_MULTITURN);

    this._svg.appendChild(this._progress);
    this._svg.appendChild(this._multi);

    // Needle: one <g> whose rotate() is the only thing that changes.
    this._needle = svgEl('g', { transform: `rotate(0 ${C} ${C})` });
    this._needle.appendChild(svgEl('path', {
      d: `M${C - 5} ${C} L${C} ${C - NEEDLE_LEN} L${C + 5} ${C} Z`,
      fill: 'var(--text)'
    }));
    this._needle.appendChild(svgEl('circle', { cx: C, cy: C, r: 6, fill: 'var(--surface-3)', stroke: 'var(--border)' }));
    this._svg.appendChild(this._needle);

    // The needle sweeps a full circle and will cross this readout at some
    // angles. Painting a background-coloured stroke behind the glyphs knocks
    // the needle out around the text so it stays legible at every position.
    const halo = { stroke: 'var(--surface)', 'stroke-width': '5', 'paint-order': 'stroke fill' };

    this._value = svgEl('text', Object.assign({
      x: C, y: C + 42, fill: 'var(--text)', 'font-size': '20', 'font-family': 'var(--sans)',
      'text-anchor': 'middle', 'font-weight': '600'
    }, halo));
    this._unit = svgEl('text', Object.assign({
      x: C, y: C + 58, fill: 'var(--text-faint)', 'font-size': '9.5',
      'font-family': 'var(--sans)', 'text-anchor': 'middle', 'letter-spacing': '1'
    }, halo, { 'stroke-width': '4' }));
    this._unit.textContent = 'COUNTS';
    this._svg.appendChild(this._value);
    this._svg.appendChild(this._unit);
  }

  /**
   * @param {object|null} t telemetry frame
   * @param {number} totalRevolutions multiturn range, for the inner arc
   */
  update(t, totalRevolutions = 4096) {
    if (!t) {
      if (this._lastText !== '—') {
        this._value.textContent = '—';
        this._lastText = '—';
      }
      return;
    }

    const angle = t.angleDeg || 0;
    if (angle !== this._lastAngle) {
      this._needle.setAttribute('transform', `rotate(${angle.toFixed(2)} ${C} ${C})`);
      const frac = angle / 360;
      this._progress.setAttribute('stroke-dashoffset', (this._progressCirc * (1 - frac)).toFixed(2));
      this._lastAngle = angle;
    }

    const revFrac = totalRevolutions > 0
      ? Math.min(1, Math.max(0, (t.revs || 0) / totalRevolutions))
      : 0;
    if (revFrac !== this._lastRevFrac) {
      this._multi.setAttribute('stroke-dashoffset', (this._multiCirc * (1 - revFrac)).toFixed(2));
      this._lastRevFrac = revFrac;
    }

    const text = formatCounts(t.pos);
    if (text !== this._lastText) {
      this._value.textContent = text;
      this._lastText = text;
    }
  }
}

function formatCounts(n) {
  if (n === null || n === undefined) return '—';
  const s = String(Math.trunc(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return out;
}

/** Linear position-within-mapped-range bar shown under the dial. */
export class TravelBar {
  constructor() {
    this.fill = el('div', { class: 'travel-fill' });
    this.node = el('div', { class: 'travel' }, this.fill);
    this._last = null;
  }

  update(pos, minInput, maxInput) {
    if (!Number.isFinite(pos) || maxInput === minInput) return;
    const frac = Math.min(1, Math.max(0, (pos - minInput) / (maxInput - minInput)));
    const pct = (frac * 100).toFixed(2) + '%';
    if (pct !== this._last) {
      this.fill.style.width = pct;
      this._last = pct;
    }
  }
}
