/**
 * Application settings, plus the notes an operator actually needs at a venue.
 */

import { el, clear, toast, select, checkbox, panel } from '../ui.js';
import { store } from '../store.js';

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
    el('div', { class: 'statline' },
      el('span', {}, 'Version ', el('b', { text: info.version })),
      // Absent when the bridge runs headless, which is a supported mode.
      info.electron ? el('span', {}, 'Electron ', el('b', { text: info.electron })) : null,
      el('span', {}, 'Node ', el('b', { text: info.node })),
      el('span', {}, 'Platform ', el('b', { text: info.platform }))),
    el('div', { class: 'statline' },
      el('span', {}, 'Web UI ', el('b', { text: info.webUrl || '—' })),
      el('span', {}, 'Access ', el('b', { text: info.tokenRequired ? 'token required' : 'this machine only' })))
  ], null,
  'Replaces d3driver.exe (2016). The packet format sent to disguise is unchanged, so existing ' +
  'projects keep working exactly as before.'));

  root.appendChild(view);
  return { refreshLive() {} };
}
