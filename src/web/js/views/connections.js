/**
 * Connection list — the app's home screen.
 *
 * One row per encoder, all of them running from this single window. This is the
 * thing that replaces "open a cmd window for every rotary encoder you want to
 * use, and keep the window open(!)" from the original how-to.
 */

import { el, clear, pill, groupDigits, hz, setText, confirmModal, toast, field, input, select, checkbox, segmented } from '../ui.js';
import { store } from '../store.js';

export function renderConnections(root) {
  clear(root);
  const view = el('div', { class: 'view' });

  const startAll = el('button', {
    class: 'btn primary', text: 'Start all',
    onclick: async () => { await window.d3d.link.startAll(); }
  });
  const stopAll = el('button', {
    class: 'btn', text: 'Stop all',
    onclick: async () => { await window.d3d.link.stopAll(); }
  });

  view.appendChild(el('div', { class: 'view-head' },
    el('h1', { text: 'Connections' }),
    el('span', { class: 'spacer' }),
    startAll, stopAll,
    el('button', {
      class: 'btn', text: '+ Add connection',
      onclick: () => openEditor(null)
    })));

  if (!store.connections.length) {
    view.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No encoders configured yet' }),
      el('p', {
        text: 'Add a connection for each POSITAL encoder. Each one gets its own device ID, ' +
          'and they can all run at the same time from this window.'
      }),
      el('button', { class: 'btn primary', text: 'Add your first encoder', onclick: () => openEditor(null) })));
    root.appendChild(view);
    return { refreshLive() {} };
  }

  const tbody = el('tbody');
  // Explicit column widths, because the position and rate cells change digit
  // count constantly and an auto-sized table would re-measure on every frame.
  const cols = el('colgroup', {},
    el('col', { style: 'width:142px' }),   // status — must clear the widest pill
    el('col', {}),                          // name (takes the slack)
    el('col', { style: 'width:146px' }),   // encoder
    el('col', { style: 'width:146px' }),   // disguise
    el('col', { style: 'width:46px' }),    // id
    el('col', { style: 'width:112px' }),   // position
    el('col', { style: 'width:80px' }),    // rate
    el('col', { style: 'width:108px' }));  // actions
  const table = el('table', { class: 'rows' },
    cols,
    el('thead', {},
      el('tr', {},
        el('th', { text: 'Status' }),
        el('th', { text: 'Name' }),
        el('th', { text: 'Encoder' }),
        el('th', { text: 'disguise' }),
        el('th', { class: 'right', text: 'ID' }),
        el('th', { class: 'right', text: 'Position' }),
        el('th', { class: 'right', text: 'Rate' }),
        el('th', { text: '' }))),
    tbody);

  const live = [];
  const warnings = duplicateWarnings(store.connections);

  for (const conn of store.connections) {
    const state = store.stateOf(conn.id);
    const posCell = el('td', { class: 'right num', text: '—' });
    const rateCell = el('td', { class: 'right num faint', text: '—' });
    const pillCell = el('td', {}, pill(state));

    const running = state !== 'idle' && state !== 'error';
    const toggle = el('button', {
      class: running ? 'btn sm' : 'btn sm primary',
      text: running ? 'Stop' : 'Start',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          if (running) await window.d3d.link.stop(conn.id);
          else await window.d3d.link.start(conn.id);
        } catch (err) { toast('error', err.message); }
      }
    });

    const row = el('tr', {
      class: 'clickable' + (conn.id === store.selectedId ? ' selected' : ''),
      onclick: () => store.setView('detail', conn.id)
    },
      pillCell,
      el('td', {}, el('div', { text: conn.name }),
        warnings.get(conn.id)
          ? el('div', { class: 'tag warn', text: warnings.get(conn.id) })
          : null),
      el('td', { title: `${conn.encoder.host}:${conn.encoder.port}` },
        el('span', { class: 'route', text: `${conn.encoder.host}:${conn.encoder.port}` })),
      el('td', { title: `${conn.d3.host}:${conn.d3.port}` },
        el('span', { class: 'route', text: `${conn.d3.host}:${conn.d3.port}` })),
      el('td', { class: 'right num', text: String(conn.d3.devid) }),
      posCell,
      rateCell,
      el('td', { class: 'right nowrap' },
        toggle,
        ' ',
        el('button', {
          class: 'btn sm ghost', text: '⋯', title: 'More',
          onclick: (e) => { e.stopPropagation(); openRowMenu(conn); }
        })));

    tbody.appendChild(row);
    live.push({ id: conn.id, posCell, rateCell, pillCell, toggle, row });
  }

  view.appendChild(el('div', { class: 'panel' }, table));
  root.appendChild(view);

  return {
    refreshLive() {
      for (const l of live) {
        const t = store.telemetryOf(l.id);
        setText(l.posCell, t ? groupDigits(t.pos) : null);
        setText(l.rateCell, t && t.txHz > 0.5 ? `${hz(t.txHz)} Hz` : null);
      }
    }
  };
}

/** Two connections sharing a device ID collide silently inside disguise. */
function duplicateWarnings(connections) {
  const byDevid = new Map();
  const byEncoder = new Map();
  const out = new Map();
  for (const c of connections) {
    const dk = `${c.d3.host}:${c.d3.port}/${c.d3.devid}`;
    byDevid.set(dk, (byDevid.get(dk) || 0) + 1);
    const ek = `${c.encoder.host}:${c.encoder.port}`;
    byEncoder.set(ek, (byEncoder.get(ek) || 0) + 1);
  }
  for (const c of connections) {
    const dk = `${c.d3.host}:${c.d3.port}/${c.d3.devid}`;
    const ek = `${c.encoder.host}:${c.encoder.port}`;
    if (byDevid.get(dk) > 1) out.set(c.id, `duplicate device ID ${c.d3.devid}`);
    else if (byEncoder.get(ek) > 1) out.set(c.id, 'same encoder as another connection');
  }
  return out;
}

async function openRowMenu(conn) {
  const ok = await confirmModal({
    title: conn.name,
    body: [
      el('p', { class: 'dim', text: 'Duplicating copies every setting and assigns the next free device ID.' }),
      el('div', { class: 'row-inline' },
        el('button', {
          class: 'btn', text: 'Edit…',
          onclick: () => { document.getElementById('modal-root').replaceChildren(); openEditor(conn); }
        }),
        el('button', {
          class: 'btn', text: 'Duplicate',
          onclick: async () => {
            document.getElementById('modal-root').replaceChildren();
            await window.d3d.config.duplicateConnection(conn.id);
            store.setProfile(await window.d3d.config.get());
          }
        }))
    ],
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;

  const sure = await confirmModal({
    title: 'Delete this connection?',
    body: el('p', { text: `“${conn.name}” will be removed from the profile. This cannot be undone.` }),
    confirmLabel: 'Delete',
    danger: true
  });
  if (!sure) return;
  await window.d3d.config.deleteConnection(conn.id);
  store.setProfile(await window.d3d.config.get());
}

// ---------------------------------------------------------------------------

/** Interface name for an address, remembered so a moved DHCP lease is diagnosable. */
function nicNameFor(nics, address) {
  if (!address) return null;
  const hit = nics.find((n) => n.value === address);
  return hit ? String(hit.label).split(' — ')[0] : null;
}

export async function openEditor(existing) {
  const info = store.info;
  const c = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
      name: `Encoder ${store.connections.length + 1}`,
      encoder: { host: info.constants.DEFAULT_ENCODER_IP, port: info.constants.DEFAULT_ENCODER_PORT, localAddress: null },
      d3: { host: '', port: info.constants.DEFAULT_D3_PORT, devid: nextDevid(), localAddress: null, localPort: null },
      velocityPolicy: 'zero',
      udpSendPolicy: 'every',
      autoStart: false,
      encoderMeta: { countsPerRev: info.constants.COUNTS_PER_REV, totalCounts: info.constants.TOTAL_COUNTS, cycleTimeMs: 10 }
    };

  // Enumerated when the form opens, not taken from the startup snapshot: a
  // USB-Ethernet adapter plugged in at the venue, or a DHCP lease that moved,
  // used to need an app restart before it could be selected here.
  let live = info.interfaces;
  try {
    live = await window.d3d.net.interfaces();
  } catch { /* fall back to whatever startup saw */ }

  const nics = [{ value: '', label: 'Any (use the routing table)' }].concat(
    live.filter((i) => !i.internal).map((i) => ({ value: i.address, label: `${i.name} — ${i.cidr || i.address}` })));

  // A saved profile can name an address that is no longer present — a different
  // venue, a different subnet. Keep it selectable and say so, rather than
  // silently resetting the field to "Any" and quietly changing the routing.
  for (const addr of [c.encoder.localAddress, c.d3.localAddress]) {
    if (addr && !nics.some((n) => n.value === addr)) {
      nics.push({ value: addr, label: `${addr} — not present on this machine` });
    }
  }

  const body = [
    field('Name', input({ value: c.name, oninput: (e) => { c.name = e.target.value; } })),

    el('div', { class: 'row-inline' },
      field('Encoder address', input({
        class: 'mono-input', value: c.encoder.host,
        oninput: (e) => { c.encoder.host = e.target.value.trim(); }
      })),
      field('Port', input({
        class: 'num-input shrink', type: 'number', value: c.encoder.port, style: 'width:90px',
        oninput: (e) => { c.encoder.port = Number(e.target.value); }
      }))),
    el('div', { class: 'hint', style: 'margin:-8px 0 12px' },
      `Factory default is ${info.constants.DEFAULT_ENCODER_IP} on TCP ${info.constants.DEFAULT_ENCODER_PORT}. ` +
      'Hardware switch 2 in the connection cap forces that address regardless of what is programmed.'),

    el('div', { class: 'row-inline' },
      field('disguise server address', input({
        class: 'mono-input', value: c.d3.host,
        oninput: (e) => { c.d3.host = e.target.value.trim(); }
      })),
      field('Port', input({
        class: 'num-input', type: 'number', value: c.d3.port, style: 'width:90px',
        oninput: (e) => { c.d3.port = Number(e.target.value); }
      })),
      field('Device ID', input({
        class: 'num-input', type: 'number', value: c.d3.devid, style: 'width:90px',
        oninput: (e) => { c.d3.devid = Number(e.target.value); }
      }))),
    el('div', { class: 'hint', style: 'margin:-8px 0 12px' },
      `The NavigatorDriver port in disguise must match this port (disguise defaults it to ${info.constants.D3_FACTORY_PORT}), ` +
      'and the Axis id must match the device ID.'),

    // Two pickers, not one. The bridge has always bound the encoder socket and
    // the disguise socket independently — the form just tied them together, so
    // there was no way to receive on the encoder's isolated network and send to
    // disguise on the production one, which is a normal show topology.
    el('div', { class: 'row-inline' },
      field('Encoder interface',
        select(nics, c.encoder.localAddress || '', (v) => {
          c.encoder.localAddress = v || null;
          c.encoder.localIfName = nicNameFor(nics, v);
        }),
        'Which NIC to reach the encoder from.'),
      field('disguise interface',
        select(nics, c.d3.localAddress || '', (v) => {
          c.d3.localAddress = v || null;
          c.d3.localIfName = nicNameFor(nics, v);
        }),
        'Usually the same; set it separately when the encoder is on an isolated network.')),
    el('div', { class: 'hint', style: 'margin:-8px 0 12px' },
      'Leave both on “Any” to use the routing table. Pinning is worth it on a show server ' +
      'with several networks, where the default route may not be the one you want.'),

    field('Velocity sent to disguise',
      segmented([
        { value: 'zero', label: 'Zero', title: 'Matches the original driver exactly — disguise derives velocity itself' },
        { value: 'passthrough', label: 'From encoder', title: "Forward the encoder's own signed steps/s" },
        { value: 'derived', label: 'Derived', title: 'Compute from position deltas here' }
      ], c.velocityPolicy, (v) => { c.velocityPolicy = v; }),
      'Zero reproduces the original d3driver.exe byte for byte, so existing disguise projects behave identically.'),

    checkbox('Start this connection automatically when the app launches', c.autoStart, (v) => { c.autoStart = v; })
  ];

  const ok = await confirmModal({
    title: existing ? 'Edit connection' : 'Add connection',
    body,
    confirmLabel: existing ? 'Save' : 'Add'
  });
  if (!ok) return;

  try {
    await window.d3d.config.saveConnection(c);
    store.setProfile(await window.d3d.config.get());
  } catch (err) {
    toast('error', err.message);
  }
}

function nextDevid() {
  const used = new Set(store.connections.map((c) => Number(c.d3.devid)));
  let id = 1;
  while (used.has(id)) id++;
  return id;
}
