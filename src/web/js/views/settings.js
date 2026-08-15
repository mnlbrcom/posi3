/**
 * Application settings, plus the notes an operator actually needs at a venue.
 */

import { el, clear, toast, select, checkbox, panel, input, field } from '../ui.js';
import { store } from '../store.js';

/**
 * Who can reach this interface, and from where.
 *
 * Bind address and port take effect at the next start — the socket is opened
 * before any of this is reachable — so the panel says so rather than letting
 * an operator wonder why nothing changed. The password takes effect at once.
 */
function webAccessPanel(s, info, save) {
  const nics = [
    { value: '127.0.0.1', label: 'This machine only (127.0.0.1)' },
    { value: '0.0.0.0', label: 'Any interface — reachable on the network' }
  ].concat((info.interfaces || [])
    .filter((i) => !i.internal)
    .map((i) => ({ value: i.address, label: `${i.name} only — ${i.address}` })));

  const pw = input({ type: 'password', placeholder: info.passwordSet ? '••••••••' : 'no password set' });

  const open = s.webBindHost !== '127.0.0.1' && !info.passwordSet;
  const reachable = s.webBindHost === '127.0.0.1'
    ? [`http://127.0.0.1:${info.port}`]
    : (info.addresses || []).map((a) => `http://${a}:${info.port}`);

  return panel('Web interface', [
    field('Reachable from',
      select(nics, s.webBindHost, (v) => save({ webBindHost: v })),
      'Takes effect the next time posi3 starts.'),

    field('Port',
      input({
        class: 'num-input', type: 'number', value: s.webPort, style: 'width:110px',
        onchange: (e) => save({ webPort: Number(e.target.value) })
      }),
      'Takes effect the next time posi3 starts.'),

    field('Password',
      el('div', { class: 'row-inline' },
        pw,
        el('button', {
          class: 'btn shrink', text: 'Set',
          onclick: async () => {
            try {
              await window.d3d.security.setPassword(pw.value);
              pw.value = '';
              store.info = await window.d3d.appInfo();
              toast('info', 'Password set — other browsers must sign in again');
              renderSettings(document.getElementById('content'));
            } catch (err) { toast('error', err.message); }
          }
        }),
        info.passwordSet ? el('button', {
          class: 'btn shrink ghost', text: 'Remove',
          onclick: async () => {
            try {
              await window.d3d.security.setPassword('');
              pw.value = '';
              store.info = await window.d3d.appInfo();
              toast('warn', 'Password removed');
              renderSettings(document.getElementById('content'));
            } catch (err) { toast('error', err.message); }
          }
        }) : null),
      'Asked for once per browser, then remembered for the session. ' +
      'Leave it empty for no password. Requests from this machine never need it.'),

    el('div', { class: 'field' },
      el('label', { text: reachable.length > 1 ? 'Open at (any of these)' : 'Open at' }),
      el('div', { class: 'open-at' },
        // Full address and port, shown whole — the old statline value column
        // capped this at 116px and ellipsised the port off the end.
        ...reachable.map((u) => el('code', { class: 'open-url', text: u })),
        // Only in the desktop window, never in a browser tab — you would not
        // ask the page you are already looking at to open itself. The check is
        // on the client's user-agent, so it hides on a remote browser even
        // when the desktop app is the server.
        /Electron/i.test(navigator.userAgent)
          ? el('button', {
            class: 'btn shrink', text: 'Open in browser',
            onclick: async () => {
              try { await window.d3d.system.openInBrowser(); }
              catch (err) { toast('error', err.message); }
            }
          })
          : null)),

  ], el('span', {
    // Both the access explainer and the open-network warning, merged into one
    // hover. The marker turns amber when the panel is wide-open with no
    // password, so that risky state still catches the eye without a banner.
    class: 'panel-info' + (open ? ' warn' : ''),
    text: 'i',
    title:
      'posi3 always answers on this machine without a password — the password only guards ' +
      'the network, and anyone at this keyboard can already change the profile. ' +
      'With no password set and posi3 reachable on the network, anyone who knows the address ' +
      'can start and stop connections, write encoder flash and change an encoder\'s IP.'
  }));
}

export function renderSettings(root) {
  clear(root);
  const view = el('div', { class: 'view' });
  const s = store.profile.settings;
  const info = store.info;

  const save = async (patch) => {
    try {
      const updated = await window.d3d.config.setSettings(patch);
      store.profile.settings = updated;
      toast('info', 'Saved');
    } catch (err) { toast('error', err.message); }
  };

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' }, el('h1', { text: 'Settings' }))));

  view.appendChild(panel('Behaviour', [
    el('div', { class: 'field' },
      el('label', { text: 'Interface refresh rate' }),
      select(info.constants.TELEMETRY_HZ_CHOICES.map((h) => ({ value: h, label: `${h} Hz` })),
        s.telemetryHz, (v) => save({ telemetryHz: Number(v) })),
      el('div', { class: 'hint', text: 'How often the display updates. This has no effect on the data sent to disguise, which always runs at full rate.' })),

    checkbox('Start connections marked “auto start” when the app launches', s.autoStartOnLaunch,
      (v) => save({ autoStartOnLaunch: v })),
    checkbox('Launch posi3 when this computer starts', s.launchAtLogin,
      (v) => save({ launchAtLogin: v })),
    checkbox('Start minimised to the tray', s.startMinimized, (v) => save({ startMinimized: v }))
  ], null,
  'Auto start plus launch at login means a show server can reboot and come back streaming ' +
  'without anyone touching a keyboard.'));

  view.appendChild(webAccessPanel(s, info, save));

  view.appendChild(panel('Profile', [
    el('div', { class: 'row-inline' },
      el('button', {
        class: 'btn', text: 'Export Profile',
        onclick: async () => {
          try {
            const r = await window.d3d.config.exportFile();
            // In a browser the file goes wherever downloads go, and there is no
            // path to report — showing the server's would be actively wrong.
            if (r.written) toast('info', r.filePath ? `Saved to ${r.filePath}` : 'Profile downloaded');
          } catch (err) { toast('error', err.message); }
        }
      }),
      el('button', {
        class: 'btn', text: 'Import Profile',
        onclick: async () => {
          try {
            const r = await window.d3d.config.importFile();
            if (r.imported) {
              store.setProfile(await window.d3d.config.get());
              toast('info', 'Profile imported');
            }
          } catch (err) { toast('error', err.message); }
        }
      }))
  ], null,
  `Profiles live in ${info.dataDir}. Export one to carry your encoder setup from the ` +
  'prep room to the show server.'));

  view.appendChild(panel('About', [
    // The same wordmark the titlebar wears, built from the same two spans —
    // the name is a mashup and the mark shows the seam.
    el('div', { class: 'about-mark' },
      el('span', { class: 'wordmark' },
        el('span', { class: 'wordmark-name', text: 'posi' }),
        el('span', { class: 'wordmark-die', text: '3' })),
      el('span', { class: 'titlebar-sub' }, 'POSITAL\u00a0IXARC', el('span', { class: 'titlebar-x' }, '\u00d7'), 'DISGUISE')),

    el('div', { class: 'statline' },
      el('span', {}, 'Version ', el('b', { text: info.version })),
      // The commit this build came from. Absent only when neither a packaged
      // stamp nor a .git directory is there to ask.
      info.revision ? el('span', {}, 'Revision ', el('b', { class: 'mono', text: info.revision })) : null,
      el('span', {}, 'Author ', el('b', { text: 'mnlbr' }))),

    el('div', { class: 'statline' },
      // Absent when the bridge runs headless, which is a supported mode.
      info.electron ? el('span', {}, 'Electron ', el('b', { text: info.electron })) : null,
      el('span', {}, 'Node ', el('b', { text: info.node })),
      el('span', {}, 'Platform ', el('b', { text: info.platform })))
  ], null,
  'Converts Posital data string to Disguise Navigator string "1:12345,0;\\n".'));

  root.appendChild(view);
  return { refreshLive() {} };
}
