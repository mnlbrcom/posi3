'use strict';
/**
 * Desktop interaction check.
 *
 * Launches the real Electron app and exercises it two ways.
 *
 * **Mouse events at coordinates.** Clicks are dispatched at element centres
 * rather than with `element.click()`, so they go through the page's own
 * hit-testing: an invisible overlay, a mis-stacked z-index or a zero-size
 * target fails here and would not fail a `.click()` test.
 *
 * **Drag regions, read from the live window.** This is a separate mechanism and
 * needs a separate check. The titlebar is a drag region so the window can be
 * moved by it, and a drag region swallows mouse input on every control inside
 * it — which is exactly how the menu toggle came to be dead in the desktop app
 * while working fine in a browser.
 *
 * A synthetic click cannot catch that. The region is enforced in the browser
 * process, above the renderer, and CDP's `Input.dispatchMouseEvent` is
 * delivered straight to the renderer — so the click lands whether or not a real
 * one would. Verified by deleting the fix and watching this file still pass.
 *
 * What does catch it is reading the property back: `-webkit-app-region` is not
 * inherited, so a control's effective region is the nearest ancestor-or-self
 * that sets one. Any interactive element whose nearest is `drag` is unclickable.
 * That is computed below from the running window, not matched in a stylesheet.
 *
 *   npm run desktopcheck
 *   node tools/desktopcheck.js --keep     leave the window open afterwards
 *
 * Exits non-zero on the first failure, so it can gate CI.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('./cli-args');
const { CDP, sleep, waitForEndpoint } = require('./cdp');

const opts = parseArgs(process.argv, {
  port: 9470,
  /** Under the rail breakpoint, so the menu toggle is the nav. */
  narrow: 420,
  wide: 1200,
  height: 780,
  keep: false
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}\n`);
}

async function main() {
  // Its own profile, so the instance lock and any real configuration are left
  // alone and the check cannot disturb a running bridge.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-desktopcheck-'));
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electron)) {
    throw new Error('electron is not installed — run npm install');
  }

  const child = spawn(electron, [
    path.join(__dirname, '..'),
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${profile}`,
    // CI runners have no user namespaces for Chromium's sandbox to use. This
    // is a test window loading our own localhost, so dropping it costs nothing
    // there — but it stays on for a developer running the check locally.
    ...(process.env.CI ? ['--no-sandbox'] : [])
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    cdp = await CDP.connect(await waitForEndpoint(opts.port));

    // The app's own window, not a target we made.
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://'));
      if (!page) await sleep(250);
    }
    check('the window opens and loads the local UI', !!page, page && page.url);
    if (!page) return;

    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    /** A click that goes through hit-testing, like a person's. */
    const clickAt = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
      await sleep(350);
    };

    /** Centre of the first element matching a selector, or null. */
    const centreOf = (selector) => evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    })()`);

    const setWidth = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: Number(opts.height), deviceScaleFactor: 1, mobile: false
      }, sessionId);
      await sleep(500);
    };

    await evaluate('window.__d3dNav && window.__d3dNav("dashboard")');
    await sleep(300);

    // -- narrow: the menu ---------------------------------------------------
    await setWidth(Number(opts.narrow));

    const togglePos = await centreOf('#nav-toggle');
    check('the menu toggle is visible below the rail breakpoint', !!togglePos,
      togglePos && `at ${togglePos.join(',')}`);
    if (!togglePos) return;

    await clickAt(...togglePos);
    const opened = await evaluate('document.getElementById("sidebar").classList.contains("open")');
    check('a click at the toggle\'s coordinates opens the menu', opened === true,
      opened ? '' : 'something is covering the toggle');

    const expanded = await evaluate('document.getElementById("nav-toggle").getAttribute("aria-expanded")');
    check('the toggle reports its state', expanded === 'true', `aria-expanded="${expanded}"`);

    const itemPos = await centreOf('#sidebar .nav-item[data-view="settings"]');
    check('menu items are hit-testable', !!itemPos, itemPos && `at ${itemPos.join(',')}`);
    if (itemPos) {
      await clickAt(...itemPos);
      const after = await evaluate(`({
        heading: (document.querySelector(".view-head h1") || {}).textContent,
        stillOpen: document.getElementById("sidebar").classList.contains("open")
      })`);
      check('choosing an item navigates', after.heading === 'Settings', `heading "${after.heading}"`);
      check('choosing an item closes the menu', after.stillOpen === false);
    }

    // -- wide: the rail -----------------------------------------------------
    await setWidth(Number(opts.wide));
    await evaluate('window.__d3dNav && window.__d3dNav("dashboard")');
    await sleep(300);

    const hidden = await evaluate('getComputedStyle(document.getElementById("nav-toggle")).display');
    check('the toggle gives way to the rail when there is room', hidden === 'none', `display: ${hidden}`);

    const railPos = await centreOf('#sidebar .nav-item[data-view="log"]');
    check('rail items are hit-testable', !!railPos, railPos && `at ${railPos.join(',')}`);
    if (railPos) {
      await clickAt(...railPos);
      const heading = await evaluate('(document.querySelector(".view-head h1") || {}).textContent');
      check('a real click on the rail navigates', heading === 'Log', `heading "${heading}"`);
    }

    // -- anything else that only a pointer can reach ------------------------
    // Back to a screen that has header controls; Log does not.
    await evaluate('window.__d3dNav && window.__d3dNav("dashboard")');
    await sleep(300);
    const startAll = await centreOf('.view-head .btn');
    check('header buttons are hit-testable', !!startAll, startAll && `at ${startAll.join(',')}`);

    // -- drag regions -------------------------------------------------------
    // Every interactive element, at both widths, since the toggle only exists
    // at one of them and a future control could be added at either.
    const swallowed = [];
    for (const width of [Number(opts.narrow), Number(opts.wide)]) {
      await setWidth(width);
      if (width <= 720) await clickAt(...(await centreOf('#nav-toggle')));  // open the menu
      const found = await evaluate(`(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;               // not on screen anyway
          // Not an inherited property: the nearest ancestor-or-self that sets
          // one decides, and 'drag' means the browser process takes the click.
          let region = 'none';
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const v = getComputedStyle(n).getPropertyValue('-webkit-app-region');
            if (v && v !== 'none') { region = v; break; }
          }
          if (region === 'drag') {
            out.push(el.id || el.className || el.tagName.toLowerCase());
          }
        }
        return out;
      })()`);
      swallowed.push(...found.map((n) => `${n} @${width}px`));
    }
    check('no interactive control sits inside a drag region', swallowed.length === 0,
      swallowed.length
        ? `${swallowed.join(', ')} — needs -webkit-app-region: no-drag`
        : 'checked at both widths');
  } finally {
    if (cdp) cdp.close();
    if (!opts.keep) child.kill();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

process.stdout.write('posi3 desktop check — real mouse events in the Electron window\n');
main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(failed.length
      ? `\n${failed.length} of ${results.length} checks failed\n`
      : `\nall ${results.length} checks passed\n`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((err) => {
    process.stderr.write(`desktop check failed to run: ${err.message}\n`);
    process.exit(2);
  });
