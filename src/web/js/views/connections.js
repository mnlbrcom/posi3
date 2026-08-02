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
      el('td', { title: destSummary(conn).full },
        el('span', { class: 'route', text: destSummary(conn).short })),
      el('td', { class: 'right num', text: destSummary(conn).ids }),
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

/**
 * One row has to describe a fan-out. Show the first destination and how many
 * more there are, with the full list on hover — a row that silently displayed
 * only the first would hide half the routing.
 */
function destSummary(conn) {
  const ds = (conn.destinations && conn.destinations.length ? conn.destinations : [conn.d3])
    .filter(Boolean);
  const on = ds.filter((d) => d.enabled !== false);
  const first = on[0] || ds[0];
  const extra = on.length - 1;
  const ids = [...new Set(on.map((d) => d.devid))].join(', ') || '—';
  return {
    short: first ? `${first.host}:${first.port}${extra > 0 ? `  +${extra}` : ''}` : '—',
    full: ds.map((d) => `${d.host}:${d.port} · id ${d.devid}${d.enabled === false ? ' (disabled)' : ''}`).join('\n'),
    ids
  };
}

/** Two connections sharing a device ID collide silently inside disguise. */
function duplicateWarnings(connections) {
  const byDevid = new Map();
  const byEncoder = new Map();
  const out = new Map();
  const dests = (c) => c.destinations || [c.d3];

  for (const c of connections) {
    // Every destination counts: two encoders whose *second* destinations
    // collide would silently fight over one axis in disguise just as surely as
    // if their first ones did.
    for (const d of dests(c)) byDevid.set(destKey(d), (byDevid.get(destKey(d)) || 0) + 1);
    const ek = `${c.encoder.host}:${c.encoder.port}`;
    byEncoder.set(ek, (byEncoder.get(ek) || 0) + 1);
  }
  for (const c of connections) {
    const clash = dests(c).find((d) => byDevid.get(destKey(d)) > 1);
    const ek = `${c.encoder.host}:${c.encoder.port}`;
    if (clash) out.set(c.id, `duplicate device ID ${clash.devid}`);
    else if (byEncoder.get(ek) > 1) out.set(c.id, 'same encoder as another connection');
  }
  return out;
}

const destKey = (d) => `${d.host}:${d.port}/${d.devid}`;

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

/**
 * The destination list.
 *
 * One encoder can feed several disguise machines — a redundant rig needs the
 * same tracking data on every machine that might take over. This is done by
 * fanning out the UDP send rather than by defining a second connection,
 * because the scarce resource is the TCP socket to the encoder: it accepts
 * only a handful of clients, and on site a leftover Java applet or an old
 * d3driver.exe may already be holding one.
 */
function destinationsEditor(c, nics, info) {
  const list = el('div', { class: 'dest-list' });

  const draw = () => {
    clear(list);
    c.destinations.forEach((d, i) => list.appendChild(destinationRow(c, d, i, nics, draw)));
    list.appendChild(el('div', { class: 'dest-foot' },
      el('button', {
        class: 'btn sm', type: 'button', text: '+ Add destination',
        onclick: () => {
          const prev = c.destinations[c.destinations.length - 1] || {};
          c.destinations.push({
            id: `dest-${Date.now()}`,
            name: '',
            host: '',
            // A second disguise machine almost always mirrors the first, so
            // carry the port and axis over rather than making them retype it.
            port: prev.port || info.constants.DEFAULT_D3_PORT,
            devid: prev.devid != null ? prev.devid : 1,
            enabled: true,
            localAddress: prev.localAddress || null,
            localIfName: prev.localIfName || null,
            localPort: null
          });
          draw();
        }
      }),
      el('span', {
        class: 'hint',
        text: `The NavigatorDriver port in disguise must match (it defaults to ${info.constants.D3_FACTORY_PORT}), ` +
          'and the Axis id must match the device ID.'
      })));
  };

  draw();
  return el('div', { class: 'dest-block' },
    el('div', { class: 'dest-title', text: 'disguise destinations' }),
    list);
}

function destinationRow(c, d, index, nics, redraw) {
  const only = c.destinations.length === 1;

  return el('div', { class: 'dest-row' + (d.enabled === false ? ' off' : '') },
    el('div', { class: 'row-inline' },
      field(index === 0 ? 'disguise server address' : 'Address', input({
        class: 'mono-input', value: d.host,
        oninput: (e) => { d.host = e.target.value.trim(); }
      })),
      field('Port', input({
        class: 'num-input', type: 'number', value: d.port, style: 'width:88px',
        oninput: (e) => { d.port = Number(e.target.value); }
      })),
      field('Device ID', input({
        class: 'num-input', type: 'number', value: d.devid, style: 'width:88px',
        oninput: (e) => { d.devid = Number(e.target.value); }
      }))),
    el('div', { class: 'row-inline' },
      field('Label', input({
        value: d.name, placeholder: index === 0 ? 'e.g. director' : 'e.g. understudy',
        oninput: (e) => { d.name = e.target.value; }
      })),
      field('Interface',
        select(nics, d.localAddress || '', (v) => {
          d.localAddress = v || null;
          d.localIfName = nicNameFor(nics, v);
        }))),
    el('div', { class: 'dest-actions' },
      checkbox('Enabled', d.enabled !== false, (v) => {
        d.enabled = v;
        redraw();
      }),
      only ? null : el('button', {
        class: 'btn sm ghost', type: 'button', text: 'Remove',
        onclick: () => { c.destinations.splice(index, 1); redraw(); }
      })));
}

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
      destinations: [{
        id: `dest-${Date.now()}`, name: '', host: '', port: info.constants.DEFAULT_D3_PORT,
        devid: nextDevid(), enabled: true, localAddress: null, localIfName: null, localPort: null
      }],
      velocityPolicy: 'zero',
      udpSendPolicy: 'every',
      autoStart: false,
      encoderMeta: { countsPerRev: info.constants.COUNTS_PER_REV, totalCounts: info.constants.TOTAL_COUNTS, cycleTimeMs: 10 }
    };

  // A profile written before destinations existed still arrives d3-shaped.
  if (!Array.isArray(c.destinations) || !c.destinations.length) {
    c.destinations = [Object.assign({ enabled: true }, c.d3)];
  }

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
  for (const addr of [c.encoder.localAddress, ...c.destinations.map((d) => d.localAddress)]) {
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

    destinationsEditor(c, nics, info),

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
      el('div')),
    el('div', { class: 'hint', style: 'margin:-8px 0 12px' },
      'Which NIC to reach the encoder from. Each destination has its own interface ' +
      'setting above, so an isolated encoder network and a production disguise ' +
      'network can be used at the same time.'),

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
  const used = new Set();
  for (const c of store.connections) {
    for (const d of c.destinations || [c.d3]) used.add(Number(d.devid));
  }
  let id = 1;
  while (used.has(id)) id++;
  return id;
}
