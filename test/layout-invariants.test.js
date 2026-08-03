'use strict';
/**
 * Guards for the layout rules that actually broke.
 *
 * These assert the *stylesheet*, not the rendering — no substitute for looking
 * at the page, and not pretending to be. Their job is narrower: each one
 * corresponds to a real overflow bug found on a narrow window, so that fixing
 * it once is the last time.
 *
 * Also enforces the project's browser-support rule: this has to behave the same
 * in Blink, WebKit and Gecko, so a Chromium-only feature slipping into the CSS
 * should fail here rather than at a venue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'css', 'app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.html'), 'utf8');

/** Body of the first rule whose selector matches exactly. */
function rule(selector) {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(CSS);
  assert.ok(m, `no rule found for "${selector}"`);
  return m[2];
}

test('the stylesheet is balanced and references no undefined token', () => {
  assert.equal(
    (CSS.match(/\{/g) || []).length,
    (CSS.match(/\}/g) || []).length,
    'unbalanced braces'
  );
  const used = new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], `undefined custom properties: ${missing.join(', ')}`);
});

test('inline form rows can shrink and wrap', () => {
  // A flex child defaults to min-width:auto and refuses to shrink below its
  // content, which is what pushed the connection form out of its panel.
  const body = rule('.row-inline');
  assert.match(body, /flex-wrap:\s*wrap/, '.row-inline must wrap');
  assert.match(rule('.row-inline > *'), /min-width:\s*0/, '.row-inline children must be allowed to shrink');
});

test('wide tables scroll inside their panel rather than the page', () => {
  assert.match(rule('.panel'), /overflow-x:\s*auto/, '.panel must contain its own horizontal overflow');
  // Declaring the minimum is what turns a silent overflow into a scroll.
  assert.match(rule('table.rows'), /min-width:\s*\d+px/, 'table.rows needs an explicit minimum');
  assert.match(rule('.vartable'), /min-width:\s*\d+px/, '.vartable needs an explicit minimum');
});

test('the page body never scrolls sideways', () => {
  assert.match(rule('html, body'), /overflow:\s*hidden/);
  assert.match(rule('.content'), /overflow-x:\s*hidden/);
});

test('viewport-height sizing survives a mobile URL bar', () => {
  // 100vh is the *large* viewport on iOS Safari, so anything sized with it
  // alone ends up under the collapsing URL bar.
  for (const m of CSS.matchAll(/([^\n]*\b\d+vh\b[^\n]*)/g)) {
    const line = m[1];
    const prop = /^\s*([a-z-]+)\s*:/.exec(line);
    if (!prop) continue;
    const after = CSS.slice(m.index + line.length, m.index + line.length + 200);
    assert.match(after, new RegExp(`${prop[1]}\\s*:[^;]*dvh`),
      `"${line.trim()}" needs a dvh companion declaration immediately after it`);
  }
});

test('the narrow-width nav is one menu, not a second bar', () => {
  // Two earlier attempts were wrong in the same way: they put a second strip
  // of chrome under the titlebar. A scrolling strip hid its own contents
  // behind a gesture; a select bar was still a bar. The rail itself now hangs
  // from a toggle, so there is one nav with two placements.
  assert.match(HTML, /id="nav-toggle"/, 'the toggle must exist in the markup');
  assert.match(HTML, /aria-expanded="false"/, 'the toggle must report its state');
  assert.match(HTML, /aria-controls="sidebar"/, 'the toggle must name what it opens');

  assert.match(rule('.nav-toggle'), /display:\s*none/,
    'the toggle must be absent while the rail is a rail');
  assert.ok(/\.sidebar \{[^}]*position: absolute/s.test(CSS),
    'the narrow-width rail must hang from the toggle rather than sit in flow');
  assert.ok(!/\.sidebar \{[^}]*overflow-x:\s*auto/s.test(CSS),
    'the sidebar must not scroll sideways at any width');
  assert.ok(!/nav-select|nav-picker/.test(CSS + HTML),
    'the select-bar approach must be gone, not merely hidden');
});

test('every control in the titlebar escapes the drag region', () => {
  // The desktop window makes the titlebar draggable, and a drag region
  // swallows mouse events on everything inside it. A browser ignores the
  // property, so a control placed there works in the browser and is dead in
  // Electron.
  //
  // This is the cheap half of the guard: it reads the stylesheet, needs no
  // Electron, and runs in `npm test`. `npm run desktopcheck` is the other
  // half — it computes each control's effective region in the running window,
  // so it also catches a control that inherits a drag region from somewhere
  // this regex never looks. Neither a synthetic click nor `element.click()`
  // can catch it at all: the region is enforced above the renderer, so the
  // click lands in a test whether or not a real one would.
  if (!/-webkit-app-region:\s*drag/.test(rule('.titlebar'))) return;
  const interactive = [...HTML.matchAll(/<(button|a|select|input)\b[^>]*class="([^"]*)"/g)]
    .map((m) => m[2])
    .filter((cls) => /nav-toggle/.test(cls));
  assert.ok(interactive.length, 'expected at least one control in the titlebar');
  assert.match(CSS, /\.nav-toggle \{[^}]*-webkit-app-region:\s*no-drag/,
    'a titlebar control must opt out of the drag region or it is unclickable in the desktop app');
});

test('type comes from the scale, not from a number typed at the point of use', () => {
  // Fifteen sizes, most of them half a pixel apart, is not a scale — it is the
  // absence of one. These two assertions are what stop it growing back: a size
  // may only be named in the token block, and there may only be a few tokens.
  const tokens = [...CSS.matchAll(/^\s*(--fs-[a-z]+)\s*:\s*([0-9.]+)px/gm)];
  const names = new Set(tokens.map((m) => m[1]));
  assert.ok(names.size >= 3 && names.size <= 4,
    `the scale should be 3-4 sizes, found ${names.size}: ${[...names].join(', ')}`);

  // Every other font-size must reference one of them. A responsive step-down
  // redefines a token, so those are matched by the rule above, not here.
  const raw = [...CSS.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[0]);
  assert.deepEqual(raw, [], `font sizes written directly: ${raw.join(', ')}`);
  for (const m of CSS.matchAll(/font-size:\s*var\((--[a-z-]+)\)/g)) {
    assert.ok(names.has(m[1]), `${m[1]} is not part of the type scale`);
  }
});

test('only two font families, each with a job', () => {
  // --sans is the default and carries the figures too, with tabular-nums for
  // fixed-width digits; --mono is reserved for text that *is* machine language.
  // `inherit` is allowed: it is how form controls are stopped from falling back
  // to the user agent's font.
  //
  // This reads the stylesheet, so it cannot see an element that sets no family
  // at all and inherits the user agent's instead of the page's. `npm run
  // uicheck` resolves the computed family of every visible element and is the
  // half of this guard that catches that.
  const families = [...CSS.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  const offScale = families.filter((f) => !/^(var\(--(mono|sans)\)|inherit)$/.test(f));
  assert.deepEqual(offScale, [], `font families set outside the tokens: ${offScale.join(' | ')}`);
});

test('figures are set in the prose face, so they must be tabular', () => {
  // Moving the readouts off mono removed what was keeping their digits from
  // changing width. Anything that repaints continuously has to declare
  // tabular-nums explicitly now, or the value jitters as it counts.
  for (const sel of ['.stat-value', '.readouts dd', '.dial svg text', '.agg', '.num']) {
    const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    assert.match(CSS, re, `${sel} shows live figures and must set tabular-nums`);
  }
});

test('the layout re-flows for narrow viewports', () => {
  const widths = [...CSS.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
  assert.ok(widths.some((w) => w <= 480), 'needs a phone breakpoint');
  assert.ok(widths.some((w) => w > 480 && w <= 760), 'needs a tablet breakpoint');
  // The fixed rail is the thing that has to give way.
  assert.match(CSS, /\.shell\s*\{\s*flex-direction:\s*column/,
    'the sidebar must stop being a fixed side rail on a narrow viewport');
});

test('no engine-exclusive CSS without a fallback', () => {
  // Project rule: Blink, WebKit and Gecko all have to work. These are the
  // current Chromium-only tripwires.
  for (const banned of ['anchor-name', 'position-try', 'position-anchor', '@container', 'container-type']) {
    assert.ok(!CSS.includes(banned), `${banned} is Chromium-only — needs a JS-measured fallback`);
  }
  assert.ok(!/\bpopover\b/.test(HTML), 'the popover attribute is not supported everywhere yet');
});

test('no hand-written vendor prefixes for things that do not need them', () => {
  // There is no build step, so Autoprefixer is not in play; the only prefixed
  // properties allowed are ones with no unprefixed equivalent.
  const allowed = new Set(['-webkit-app-region', '-webkit-font-smoothing', '-webkit-overflow-scrolling', '-webkit-details-marker']);
  const found = new Set([...CSS.matchAll(/(-webkit-[a-z-]+|-moz-[a-z-]+|-ms-[a-z-]+)\s*:/g)].map((m) => m[1]));
  const unexpected = [...found].filter((p) => !allowed.has(p));
  assert.deepEqual(unexpected, [], `unexpected vendor prefixes: ${unexpected.join(', ')}`);
});

test('the page declares a mobile viewport', () => {
  assert.match(HTML, /<meta name="viewport"[^>]*width=device-width/);
});
