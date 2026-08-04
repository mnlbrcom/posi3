'use strict';
/**
 * Headless layout audit.
 *
 * Drives a local Chrome over the DevTools protocol to load the web UI at a
 * range of viewport widths, then reports — per width — anything that overflows
 * its container, any horizontal scroll on the page body, and any console error.
 * Optionally writes a screenshot per width.
 *
 * This exists because the UI was built for several milestones without anyone
 * looking at it, and the overflow bugs that resulted were all mechanically
 * detectable. `test/layout-invariants.test.js` asserts the stylesheet; this
 * asserts the rendering.
 *
 * No dependencies: Node's built-in WebSocket speaks CDP directly.
 *
 *   node tools/uicheck.js --url http://127.0.0.1:8711
 *   node tools/uicheck.js --shots /tmp/posi3        write PNGs
 *   node tools/uicheck.js --views dashboard,connections,encoder
 *   node tools/uicheck.js --widths 1440,900,720,480,390
 *
 * Exits non-zero if anything overflows, so it can gate CI.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('./cli-args');
const { CDP, sleep, waitForEndpoint } = require('./cdp');

const opts = parseArgs(process.argv, {
  url: 'http://127.0.0.1:8711',
  widths: '1440,1024,860,720,480,390',
  views: 'dashboard,connections,encoder,mapping,log,settings',
  height: 900,
  shots: '',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  keepOpen: false,
  settleMs: 700,
  /** Open every <details> before auditing — folded content is never measured. */
  expand: false,
  /** Run an arbitrary expression in the page instead of the audit. */
  eval: ''
});

// ---------------------------------------------------------------------------
// The audit, evaluated inside the page
// ---------------------------------------------------------------------------

/**
 * Reports elements wider than the box that is supposed to contain them.
 *
 * "Contained" means the nearest ancestor that actually clips or scrolls; an
 * ancestor with `overflow: visible` does not contain anything, so walking up to
 * it would produce false negatives. An element inside an `overflow-x: auto`
 * box is fine by definition — that is the intended escape hatch.
 */
const AUDIT = `(() => {
  const docEl = document.documentElement;
  const vw = docEl.clientWidth;

  const label = (n) => {
    const cls = (n.className && typeof n.className === 'string')
      ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.')
      : '';
    const id = n.id ? '#' + n.id : '';
    return n.tagName.toLowerCase() + id + cls;
  };

  const scrollParent = (n) => {
    for (let p = n.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(s.overflowX)) return { node: p, style: s };
    }
    return null;
  };

  const offenders = [];
  const seen = new Set();

  for (const n of document.querySelectorAll('body *')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const holder = scrollParent(n);
    if (!holder) continue;

    // A scrollable ancestor is allowed to be scrolled into; a clipping one
    // (overflow hidden) silently truncates, which is the bug.
    const canScroll = /(auto|scroll)/.test(holder.style.overflowX);
    const hr = holder.node.getBoundingClientRect();
    const overshoot = Math.round(r.right - hr.right);

    if (overshoot > 1 && !canScroll) {
      const key = label(n) + '>' + label(holder.node);
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push({
        el: label(n),
        clippedBy: label(holder.node),
        overshootPx: overshoot,
        text: (n.textContent || '').trim().slice(0, 48)
      });
    }
  }

  // Elements sticking out past the viewport. Anything with a scrollable box
  // *anywhere* above it is excluded: its rect reports full layout width by
  // design, and it is reachable by scrolling that box. Checking only the
  // nearest ancestor is not enough — a table cell is \`overflow: hidden\` for
  // its ellipsis, and sits inside the panel that does the scrolling.
  const inScrollable = (n) => {
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };

  const pastViewport = [];
  for (const n of document.querySelectorAll('body *')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (inScrollable(n)) continue;
    if (r.right > vw + 1) {
      const key = label(n);
      if (pastViewport.some((p) => p.el === key)) continue;
      pastViewport.push({ el: key, right: Math.round(r.right), overshootPx: Math.round(r.right - vw) });
    }
  }

  // Every visible element must resolve to one of the two families. A static
  // test of the stylesheet cannot see this: an element that sets no family at
  // all does not inherit the page's, it falls back to the user agent's — which
  // is how the titlebar's menu button ended up in Arial while every rule in
  // the file looked correct.
  const offFamily = [];
  const seenFamily = new Set();
  for (const n of document.querySelectorAll('body *')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const first = getComputedStyle(n).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (first === 'ui-monospace' || first === 'system-ui') continue;
    const key = label(n) + '|' + first;
    if (seenFamily.has(key)) continue;
    seenFamily.add(key);
    offFamily.push({ el: label(n), family: first, text: (n.textContent || '').trim().slice(0, 32) });
  }

  return {
    viewportWidth: vw,
    offFamily,
    bodyScrollsSideways: docEl.scrollWidth > vw + 1,
    bodyScrollWidth: docEl.scrollWidth,
    offenders: offenders.sort((a, b) => b.overshootPx - a.overshootPx).slice(0, 12),
    pastViewport: pastViewport.sort((a, b) => b.overshootPx - a.overshootPx).slice(0, 12)
  };
})()`;

// ---------------------------------------------------------------------------

async function main() {
  const widths = String(opts.widths).split(',').map((n) => Number(n.trim())).filter(Boolean);
  const views = String(opts.views).split(',').map((v) => v.trim()).filter(Boolean);
  const port = 9333 + (process.pid % 200);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-uicheck-'));

  if (!fs.existsSync(opts.chrome)) {
    throw new Error(`Chrome not found at ${opts.chrome} — pass --chrome <path>`);
  }
  if (opts.shots) fs.mkdirSync(opts.shots, { recursive: true });

  const chrome = spawn(opts.chrome, [
    opts.keepOpen ? '--headless=new' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', // otherwise the scrollbar itself changes the layout width
    'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  let cdp = null;

  try {
    cdp = await CDP.connect(await waitForEndpoint(port));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push(p.args.map((a) => a.description || a.value).join(' '));
      }
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    process.stdout.write(`posi3 ui check — ${opts.url}\n`);

    for (const width of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: Number(opts.height), deviceScaleFactor: 1, mobile: width <= 480
      }, sessionId);

      for (const view of views) {
        consoleErrors.length = 0;
        await cdp.send('Page.navigate', { url: opts.url }, sessionId);
        await sleep(Number(opts.settleMs));

        // Router is in-page, so switch view rather than reloading per screen.
        await cdp.send('Runtime.evaluate', {
          expression: `window.__d3dNav && window.__d3dNav(${JSON.stringify(view)})`,
          awaitPromise: false
        }, sessionId);
        await sleep(250);

        if (opts.eval) {
          // awaitPromise, so an async expression resolves rather than
          // serialising as the empty object a pending Promise becomes.
          const probe = await cdp.send('Runtime.evaluate', {
            expression: opts.eval, returnByValue: true, awaitPromise: true
          }, sessionId);
          if (probe.exceptionDetails) {
            process.stdout.write(`  ${String(width).padStart(4)}px ${view}: THREW ` +
              `${probe.exceptionDetails.exception?.description || probe.exceptionDetails.text}\n`);
            failures++;
            continue;
          }
          process.stdout.write(`  ${String(width).padStart(4)}px ${view}: ` +
            `${JSON.stringify(probe.result.value, null, 2)}\n`);
          if (opts.shots) {
            await sleep(250);
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
            fs.writeFileSync(path.join(opts.shots, `${view}-${width}-eval.png`), Buffer.from(data, 'base64'));
          }
          continue;
        }

        // Below the rail breakpoint the nav is a panel that is display:none
        // until opened, and an element with no box is invisible to the audit —
        // so the menu had never actually been measured at any width. Open it
        // when it exists, and say so in the label.
        const menuOpened = (await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const t = document.getElementById('nav-toggle');
            if (!t || getComputedStyle(t).display === 'none') return false;
            t.click();
            return document.getElementById('sidebar').classList.contains('open');
          })()`,
          returnByValue: true
        }, sessionId)).result.value;
        if (menuOpened) await sleep(250);

        // Collapsed content is not laid out, so a folded <details> is invisible
        // to the audit — which is how the config groups shipped overflowing at
        // every width without a single check failing. Open them and measure.
        const expanded = opts.expand
          ? (await cdp.send('Runtime.evaluate', {
            expression: `(() => {
              const d = [...document.querySelectorAll('details')].filter((n) => !n.open);
              d.forEach((n) => { n.open = true; });
              return d.length;
            })()`,
            returnByValue: true
          }, sessionId)).result.value
          : 0;
        if (expanded) await sleep(350);

        const { result } = await cdp.send('Runtime.evaluate', {
          expression: AUDIT, returnByValue: true
        }, sessionId);
        const r = result.value;

        const problems = r.offenders.length + r.offFamily.length + r.pastViewport.length +
          (r.bodyScrollsSideways ? 1 : 0);
        const tag = problems ? 'FAIL' : ' ok ';
        process.stdout.write(`  [${tag}] ${String(width).padStart(4)}px  ${view}` +
          `${menuOpened ? '  + menu' : ''}${expanded ? `  + ${expanded} expanded` : ''}\n`);

        if (r.bodyScrollsSideways) {
          process.stdout.write(`         page scrolls sideways: ${r.bodyScrollWidth}px content in ${r.viewportWidth}px\n`);
        }
        for (const o of r.offFamily) {
          process.stdout.write(`         ${o.el} is set in ${o.family}, not --sans or --mono  "${o.text}"\n`);
        }
        for (const o of r.offenders) {
          process.stdout.write(`         ${o.el} overflows ${o.clippedBy} by ${o.overshootPx}px  "${o.text}"\n`);
        }
        for (const p of r.pastViewport) {
          process.stdout.write(`         ${p.el} extends ${p.overshootPx}px past the viewport\n`);
        }
        for (const e of consoleErrors) {
          process.stdout.write(`         console error: ${String(e).split('\n')[0]}\n`);
        }
        failures += problems + consoleErrors.length;

        if (opts.shots) {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
          fs.writeFileSync(path.join(opts.shots, `${view}-${width}.png`), Buffer.from(data, 'base64'));
        }
      }
    }

    if (opts.shots) process.stdout.write(`\nscreenshots: ${opts.shots}\n`);
    process.stdout.write(failures ? `\n${failures} problem(s)\n` : '\nno layout problems found\n');
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    // Chrome may still be flushing its profile; the temp dir is disposable.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* leave it to the OS */ }
  }

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`uicheck failed: ${err.message}\n`);
  process.exit(2);
});
