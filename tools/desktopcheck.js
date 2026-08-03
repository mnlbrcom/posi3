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

  // The real binary, not `node_modules/.bin/electron`. That shim is a Node
  // script that spawns Electron as a *child*, so killing it leaves the window
  // running — a stray app with an empty throwaway profile, indistinguishable
  // on screen from the real one except that it cannot see any connection.
  // Requiring the package gives the executable directly, so kill() reaches it.
  let electron;
  try {
    electron = require('electron');
  } catch {
    throw new Error('electron is not installed — run npm install');
  }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) {
    throw new Error('electron did not resolve to a binary — run npm install');
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

  // Ctrl-C and any crash path have to take the window with them, or the stray
  // outlives the check.
  const reap = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  process.once('exit', reap);
  process.once('SIGINT', () => { reap(); process.exit(130); });

  let cdp = null;
  let clearMetrics = null;
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

    /**
     * Reload and wait for the *new* document.
     *
     * A fixed sleep is not good enough: `location.reload()` returns at once and
     * the load can outlast any delay guessed here, so a check that sleeps and
     * then measures may be reading the old page — passing for the wrong reason
     * and hiding a regression. Marking the current document and waiting for the
     * mark to disappear proves the swap actually happened.
     */
    const reloadAndWait = async () => {
      await evaluate('window.__reloadMarker = 1');
      await evaluate('location.reload()');
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        try {
          const done = await evaluate('window.__reloadMarker === undefined && document.readyState === "complete"');
          if (done) return true;
        } catch { /* the context is being torn down; keep waiting */ }
      }
      return false;
    };

    const setWidth = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: Number(opts.height), deviceScaleFactor: 1, mobile: false
      }, sessionId);
      await sleep(500);
    };

    // An override outlives the client that set it, and a later session cannot
    // clear one it does not own — the window is then stuck rendering at a test
    // width inside its real frame, which looks like a layout bug and is not.
    // Only the session that set it can release it, so release it here.
    clearMetrics = async () => {
      try { await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId); } catch { /* window already gone */ }
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

    // -- a reload rescues a viewport left emulated -------------------------
    // A debugging session that dies without detaching leaves the page pinned
    // to its test size inside a full-size window: it reads as a layout bug,
    // resizing does nothing, and before the fix only a restart cleared it.
    // Reproduced properly here — a real child process, killed outright, so the
    // session is abandoned rather than closed.
    await clearMetrics();
    await sleep(400);
    const real = await evaluate('innerWidth');

    const setter = spawn(process.execPath, ['-e', `
      const { CDP, sleep, waitForEndpoint } = require(${JSON.stringify(path.join(__dirname, 'cdp.js'))});
      (async () => {
        const cdp = await CDP.connect(await waitForEndpoint(${Number(opts.port)}));
        const { targetInfos } = await cdp.send('Target.getTargets');
        const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://'));
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: 420, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
        await sleep(60000);
      })().catch(() => process.exit(1));
    `], { stdio: 'ignore' });
    try {
      let stuck = real;
      for (let i = 0; i < 40 && stuck === real; i++) { await sleep(250); stuck = await evaluate('innerWidth'); }
      setter.kill('SIGKILL');            // abandoned: never detaches, never clears
      await sleep(1200);

      const survived = await evaluate('innerWidth');
      check('an abandoned override really does survive its client', survived === 420,
        `${survived}px — the fix is only meaningful if this reproduces`);

      const reloaded = await reloadAndWait();
      check('the window actually reloads', reloaded, reloaded ? '' : 'never saw a fresh document');
      const recovered = await evaluate('innerWidth');
      check('a reload releases a viewport left emulated', recovered === real,
        `${survived}px -> ${recovered}px (window is ${real}px)`);
    } finally {
      setter.kill('SIGKILL');
    }

    // -- a reload is a UI reload, not a restart -----------------------------
    // The bridge runs in the main process; the page is an ordinary HTTP client
    // of it. So Cmd+R must repaint the UI and leave the encoder socket, the
    // UDP sinks and the counters completely alone. Proven against a simulated
    // rig rather than argued from the architecture.
    const sim = [
      spawn(process.execPath, [path.join(__dirname, 'mock-encoder.js'), '--port', '16000', '--cycle', '5', '--motion', 'sine', '--quiet'], { stdio: 'ignore' }),
      spawn(process.execPath, [path.join(__dirname, 'udp-sink.js'), '--port', '16001', '--quiet'], { stdio: 'ignore' })
    ];
    try {
      await sleep(1200);
      const call = async (op, body) => {
        const r = await fetch(`${page.url.replace(/\/$/, '')}/api/${op}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body === undefined ? null : body)
        });
        return r.json();
      };

      const saved = await call('configSaveConnection', {
        name: 'reload check', autoStart: false,
        encoder: { host: '127.0.0.1', port: 16000 },
        destinations: [{ host: '127.0.0.1', port: 16001, devid: 1 }]
      });
      const id = saved.ok && (saved.data.id || (saved.data.connection || {}).id);
      if (!id) {
        check('a reload leaves a running connection alone', false,
          `could not seed a connection: ${JSON.stringify(saved.error || saved)}`);
      } else {
        await call('linkStart', { id });

        // Let it build a real history first. Comparing against a link that is
        // half a second old proves nothing: a link torn down and rebuilt also
        // ends up with a bigger number a few seconds later, so "it went up" is
        // satisfied either way. Establishing several seconds of uptime is what
        // makes the continuity test below able to tell them apart.
        let a = null;
        for (let i = 0; i < 60; i++) {
          await sleep(250);
          const snap = await call('linkSnapshot', { id });
          if (snap.ok && snap.data.state === 'streaming' && snap.data.telemetry.uptimeMs > 5000) { a = snap.data.telemetry; break; }
        }
        check('the simulated rig streams before the reload', !!a,
          a && `${a.rxTotal} samples over ${Math.round(a.uptimeMs / 1000)}s`);

        if (a) {
          const t0 = Date.now();
          await reloadAndWait();
          await sleep(1000);            // let a restarted link, if any, show itself
          const elapsed = Date.now() - t0;
          const b = (await call('linkSnapshot', { id })).data;

          // Continuity, not magnitude. If the link ran straight through, its
          // uptime advanced by exactly the wall time that passed. If it was
          // torn down and rebuilt, its clock restarted, and the advance falls
          // short by however long it had been up before — which is why the
          // history above had to be worth several seconds.
          const advance = b.telemetry.uptimeMs - a.uptimeMs;
          const continuous = Math.abs(advance - elapsed) < 1500;
          const survived = b.state === 'streaming'
            && continuous
            && b.telemetry.rxTotal > a.rxTotal
            && b.telemetry.reconnects === a.reconnects;
          check('a reload leaves a running connection alone', survived,
            `state ${b.state}, uptime advanced ${(advance / 1000).toFixed(1)}s over ${(elapsed / 1000).toFixed(1)}s wall` +
            `${continuous ? '' : ' — the clock restarted, so the link did'}, ` +
            `rx ${a.rxTotal} -> ${b.telemetry.rxTotal}, reconnects ${a.reconnects} -> ${b.telemetry.reconnects}`);

          const tx = (b.telemetry.destinations || [])[0] || {};
          const txBefore = ((a.destinations || [])[0] || {}).tx || 0;
          check('the UDP sink keeps receiving across the reload',
            tx.tx > txBefore && !tx.txErrors, `tx ${txBefore} -> ${tx.tx}, errors ${tx.txErrors}`);

          await call('linkStop', { id });
        }
      }
    } finally {
      for (const p of sim) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    }
  } finally {
    if (clearMetrics) await clearMetrics();
    if (cdp) cdp.close();
    if (!opts.keep) {
      child.kill();
      // Give it a moment to go quietly, then insist.
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
      reap();
    }
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
