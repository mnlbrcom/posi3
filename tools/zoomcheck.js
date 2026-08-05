'use strict';
/**
 * Titlebar vs. traffic lights, across page zoom.
 *
 * The macOS window buttons are OS chrome at a fixed physical size. Page zoom
 * (Cmd+- / Cmd+=) rescales CSS pixels but not them, so any clearance written
 * as a CSS constant shrinks under zoom-out until the wordmark sits behind the
 * close button — which is exactly what happened at 78px. The fix reads
 * env(titlebar-area-*); this check proves it, by relaunching the real app at
 * several zoom factors and measuring the rendered titlebar.
 *
 * Physical pixels are CSS pixels × zoom factor. The traffic lights end at
 * about 70 physical px in a hiddenInset titlebar and stand about 24 tall with
 * their margins, so the wordmark must start past the one and the bar must
 * stay at least as tall as the other — at every zoom, not just 100%.
 *
 *   npm run zoomcheck
 *
 * Exits non-zero on the first failure, so it can gate CI on macOS.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CDP, sleep, waitForEndpoint } = require('./cdp');

const PORT = 9482;
const FACTORS = [1, 0.8, 0.67, 0.5];
const LIGHTS_END_PX = 70; // physical: right edge of the fullscreen button
const LIGHTS_TALL_PX = 24; // physical: button row incl. breathing room

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}\n`);
}

/** Launch the app at one zoom factor, measure the titlebar, tear down. */
async function measureAt(factor) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'posi3-zoomcheck-'));
  const electron = require('electron');

  const child = spawn(electron, [
    path.join(__dirname, '..'),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--zoom=${factor}`,
    ...(process.env.CI ? ['--no-sandbox'] : [])
  ], { stdio: 'ignore' });
  const reap = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  process.once('exit', reap);

  let cdp = null;
  try {
    cdp = await CDP.connect(await waitForEndpoint(PORT));
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://'));
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('the window never loaded the local UI');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

    // Let the zoom hook fire and the layout settle.
    await sleep(1200);

    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const bar = document.getElementById('titlebar');
        const mark = document.querySelector('.wordmark');
        const cs = getComputedStyle(bar);
        return {
          inset: document.body.classList.contains('inset-titlebar'),
          paddingLeft: parseFloat(cs.paddingLeft),
          barHeight: bar.getBoundingClientRect().height,
          markLeft: mark.getBoundingClientRect().left
        };
      })()`,
      returnByValue: true
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  } finally {
    if (cdp) { try { cdp.close(); } catch { /* closing anyway */ } }
    reap();
    await sleep(300);
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    process.stdout.write('zoomcheck: traffic lights are a macOS feature — nothing to check here\n');
    return;
  }

  for (const factor of FACTORS) {
    process.stdout.write(`\nzoom ${Math.round(factor * 100)}%\n`);
    const m = await measureAt(factor);

    if (!m.inset) {
      // Without the inset class none of this applies — but then the app is
      // not drawing under the traffic lights either, which would be its own
      // regression worth failing on.
      check(`inset titlebar active at ${factor}`, false, 'body.inset-titlebar missing in the desktop window');
      continue;
    }

    const markPhysical = m.markLeft * factor;
    check(`wordmark clears the traffic lights at ${Math.round(factor * 100)}%`,
      markPhysical >= LIGHTS_END_PX,
      `starts at ${markPhysical.toFixed(0)} physical px (needs ≥ ${LIGHTS_END_PX})`);

    const barPhysical = m.barHeight * factor;
    check(`titlebar stays as tall as the buttons at ${Math.round(factor * 100)}%`,
      barPhysical >= LIGHTS_TALL_PX,
      `${barPhysical.toFixed(0)} physical px tall (needs ≥ ${LIGHTS_TALL_PX})`);

    if (factor < 1) {
      // The mechanism itself: a constant cannot pass this, because a constant
      // does not grow in CSS pixels when zoom shrinks them.
      check(`the clearance grew in CSS px at ${Math.round(factor * 100)}%`,
        m.paddingLeft > 78,
        `padding-left ${m.paddingLeft.toFixed(0)}px CSS (a hardcoded 78px would sit under the buttons)`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`zoomcheck: ${err.message}\n`);
  process.exit(1);
});
