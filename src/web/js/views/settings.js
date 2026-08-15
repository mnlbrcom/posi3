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

    open ? el('div', { class: 'banner warn', style: 'position:static;margin:8px 0 0' },
      'No password is set and posi3 is reachable on the network. ' +
      'Anyone who knows this address can start and stop connections, write encoder ' +
      'flash and change an encoder\'s IP.') : null
  ], null,
  'posi3 answers on this machine without a password whatever is set here — the password ' +
  'guards the network, and anyone at this keyboard can already change the profile.');
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

  view.appendChild(panel('If something is not working', [
    el('div', { class: 'help dim' },
      el('p', {}, el('b', { text: 'No packets reaching disguise? ' }),
        'Point the connection at a laptop running the bundled UDP sink first ' +
        '(node tools/udp-sink.js). If packets arrive there, the bridge is fine and the ' +
        'problem is on the disguise side — check that the NavigatorDriver port matches and ' +
        'that the position receiver is engaged.'),
      el('p', {}, el('b', { text: 'Cannot connect to the encoder? ' }),
        'The encoder accepts only a handful of simultaneous TCP clients. A leftover Java tool, ' +
        'a browser applet, or the old d3driver.exe still running on another machine can be ' +
        'holding the slot.'),
      el('p', {}, el('b', { text: 'Changed the IP and nothing happened? ' }),
        `A new address only applies after a power cycle, and hardware switch 2 in the connection ` +
        `cap forces ${info.constants.DEFAULT_ENCODER_IP} regardless of what is programmed.`),
      info.platform === 'darwin'
        ? el('p', {}, el('b', { text: 'macOS 15 or later: ' }),
          'the first connection attempt triggers a Local Network permission prompt. If it was ' +
          'denied, every connection fails instantly — re-enable it under System Settings › ' +
          'Privacy & Security › Local Network.')
        : el('p', {}, el('b', { text: 'Windows Firewall: ' }),
          'allow posi3 on both Private and Public networks. Show LANs are usually classified ' +
          'as Public, and that box is easy to miss.')
    )
  ]));

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
  'Replaces d3driver.exe (2016). The packet format sent to disguise is unchanged, so existing ' +
  'projects keep working exactly as before.'));

  root.appendChild(view);
  return { refreshLive() {} };
}
