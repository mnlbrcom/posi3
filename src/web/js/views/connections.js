/**
 * Connection list — the app's home screen.
 *
 * One row per encoder, all of them running from this single window. This is the
 * thing that replaces "open a cmd window for every rotary encoder you want to
 * use, and keep the window open(!)" from the original how-to.
 */

import { el, clear, pill, groupDigits, hz, setText, confirmModal, toast, field, input, select, checkbox, segmented } from '../ui.js';
import { store } from '../store.js';
import { openControls } from './detail.js';

export function renderConnections(root) {
  clear(root);
  const view = el('div', { class: 'view' });

  const startAll = el('button', {
    class: 'btn primary', text: 'Start All',
    onclick: async () => { await window.d3d.link.startAll(); }
  });
  const stopAll = el('button', {
    class: 'btn', text: 'Stop All',
    onclick: async () => { await window.d3d.link.stopAll(); }
  });

  view.appendChild(el('div', { class: 'panel page-head' },
    el('div', { class: 'view-head' },
      el('h1', { text: 'Connections' }),
      el('span', { class: 'spacer' }),
      startAll, stopAll,
      el('button', {
        class: 'btn', text: 'Add Connection',
        onclick: () => openEditor(null)
      }))));

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

  const live = [];
  const warnings = duplicateWarnings(store.connections);
  const list = el('div', { class: 'conn-list' });

  for (const conn of store.connections) {
    const state = store.stateOf(conn.id);
    const running = state !== 'idle' && state !== 'error';
    const pillHolder = el('span', { class: 'pill-holder' }, pill(state));

    // Start and Stop as two buttons rather than one that changes label. A
    // toggle means the control under your finger is whichever one the link
    // was in when the card was drawn, and on a show that is worth avoiding.
    const startBtn = el('button', {
      class: 'btn', text: 'Start', disabled: running || undefined,
      onclick: () => act(() => window.d3d.link.start(conn.id))
    });
    const stopBtn = el('button', {
      class: 'btn', text: 'Stop', disabled: !running || undefined,
      onclick: () => act(() => window.d3d.link.stop(conn.id))
    });

    const dest = destSummary(conn);
    const cells = {
      pos: el('div', { class: 'conn-value', text: '—' }),
      rate: el('div', { class: 'conn-value', text: '—' })
    };

    const card = el('div', { class: 'card conn-card' },
      el('div', { class: 'card-head' },
        el('button', {
          class: 'card-name', text: conn.name, title: 'Open the controls',
          onclick: () => openControls(conn)
        }),
        pillHolder,
        // Grouped, not spaced apart with a filler element: a spacer only
        // right-aligns the row it happens to sit on, so once the buttons
        // wrapped they started again from the left.
        el('div', { class: 'card-actions' },
          startBtn, stopBtn,
          el('button', { class: 'btn', text: 'Controls', onclick: () => openControls(conn) }),
          el('button', { class: 'btn', text: 'Edit', onclick: () => openEditor(conn) }))),

      warnings.get(conn.id)
        ? el('div', { class: 'tag warn', text: warnings.get(conn.id) })
        : null,

      // auto-fit rather than a fixed column count: the same markup carries four
      // fields across a wide window and one per line on a phone, with no
      // sideways scroll at any width in between.
      el('div', { class: 'conn-fields' },
        connField('Encoder', encoderAddressLabel(conn),
          conn.encoder.pendingHost
            ? `${conn.encoder.pendingHost} has been written to the encoder but only takes effect ` +
              'after a power cycle. Both addresses are tried until one answers.'
            : undefined),
        connField('disguise', dest.short, dest.full),
        connField('Device ID', dest.ids),
        connField('Position', cells.pos),
        connField('Rate', cells.rate)));

    list.appendChild(card);
    live.push({ id: conn.id, cells, pillHolder, startBtn, stopBtn, lastState: state });
  }

  view.appendChild(list);
  root.appendChild(view);

  return {
    refreshLive() {
      for (const l of live) {
        const t = store.telemetryOf(l.id);
        setText(l.cells.pos, t ? groupDigits(t.pos) : null);
        setText(l.cells.rate, t && t.txHz > 0.5 ? `${hz(t.txHz)} Hz` : null);

        // Only on a real change: this runs every animation frame, and
        // rebuilding the pill or reassigning `disabled` each time is what made
        // earlier versions of this screen shiver.
        const state = store.stateOf(l.id);
        if (state !== l.lastState) {
          clear(l.pillHolder).appendChild(pill(state));
          const running = state !== 'idle' && state !== 'error';
          l.startBtn.disabled = running;
          l.stopBtn.disabled = !running;
          l.lastState = state;
        }
      }
    }
  };
}

async function act(fn) {
  try { await fn(); } catch (err) { toast('error', err.message); }
}

/**
 * Where the encoder answers, and where it is going.
 *
 * A programmed address is inert until the device is power-cycled, so for a
 * while there are two of them. Showing only one would either name an address
 * that does not answer or hide a change somebody else has to go and apply.
 */
function encoderAddressLabel(conn) {
  const now = `${conn.encoder.host}:${conn.encoder.port}`;
  return conn.encoder.pendingHost ? `${now} → ${conn.encoder.pendingHost}` : now;
}

/** One labelled field in a connection card. Value may be a string or a node. */
function connField(label, value, title) {
  return el('div', { class: 'conn-field', title: title || undefined },
    el('div', { class: 'conn-label', text: label }),
    typeof value === 'string' ? el('div', { class: 'conn-value', text: value }) : value);
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

/**
 * The encoder address: type it, or go and find it.
 *
 * An encoder whose address nobody wrote down is otherwise a dead end — POSITAL
 * documents no discovery mechanism at all, and the factory default only helps
 * if the unit has never been programmed. The Search button probes TCP 6000
 * across the chosen interface's subnet and offers what answers.
 *
 * A `datalist` rather than a `select`, so the field stays typeable: the
 * encoder you want may be on a subnet this machine cannot see, and being made
 * to pick from a list that cannot contain it would be worse than no list. It
 * also behaves natively in all three engines, which an invented dropdown would
 * have to reimplement.
 */
function encoderAddressField(c, nicOf) {
  const info = store.info;
  const listId = `enc-found-${Math.random().toString(36).slice(2, 9)}`;
  const options = el('datalist', { id: listId });
  const box = input({
    class: 'mono-input', value: c.encoder.host, list: listId,
    oninput: (e) => { c.encoder.host = e.target.value.trim(); }
  });
  const status = el('div', { class: 'hint' });
  const search = el('button', {
    class: 'btn sm', type: 'button', text: 'Search',
    onclick: async () => {
      const nic = nicOf();
      if (!nic) {
        // The scan needs a subnet, and "Any" does not name one.
        setText(status, 'Choose an encoder interface below first — the search needs a subnet to look in.');
        status.className = 'hint warn-text';
        return;
      }
      search.disabled = true;
      status.className = 'hint';
      setText(status, 'searching…');
      try {
        const res = await window.d3d.net.discoverEncoders(nic, Number(c.encoder.port) || undefined);
        clear(options);
        for (const hit of res.found) {
          options.appendChild(el('option', {
            value: hit.host,
            label: hit.totalScaledRes
              ? `${hit.host} — ${hit.totalScaledRes.toLocaleString('en-US')} steps`
              : `${hit.host} — ${hit.evidence}`
          }));
        }
        const kin = res.silentKin || [];
        if (res.found.length) {
          setText(status, `${res.found.length} found of ${res.scanned} addresses on ` +
            `${res.interface.name} — ${res.found.map((h) => h.host).join(', ')}`);
        } else if (kin.length) {
          // Seen on the wire but not answering: almost always an encoder
          // holding an address on another subnet.
          status.className = 'hint warn-text';
          setText(status, `Nothing answered, but ${kin.length} device(s) with an encoder's ` +
            `manufacturer prefix are on this segment (${kin.map((k) => k.mac).join(', ')}). ` +
            'They are probably set to an address outside this subnet — ' +
            `switch 2 in the connection cap forces ${info.constants.DEFAULT_ENCODER_IP} after a power cycle.`);
        } else {
          status.className = 'hint';
          setText(status, `Nothing answering on ${res.scanned} addresses on ${res.interface.name}. ` +
            'If the encoder is on another subnet, switch 2 in the connection cap forces ' +
            `${info.constants.DEFAULT_ENCODER_IP} after a power cycle.`);
        }
        if (res.found.length === 1) {
          box.value = res.found[0].host;
          c.encoder.host = res.found[0].host;
        }
      } catch (err) {
        status.className = 'hint warn-text';
        setText(status, err.message);
      } finally {
        search.disabled = false;
      }
    }
  });

  return el('div', {},
    el('div', { class: 'addr-row' }, box, search),
    options,
    status);
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
        class: 'btn sm', type: 'button', text: 'Add Destination',
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
      field('Encoder address', encoderAddressField(c, () => c.encoder.localAddress)),
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
        { value: 'passthrough', label: 'From encoder', title: "Forward the encoder's own signed steps/s" }
      ], c.velocityPolicy, (v) => { c.velocityPolicy = v; }),
      'Zero reproduces the original d3driver.exe byte for byte, so existing disguise projects behave identically.'),

    field('When records arrive coalesced',
      segmented([
        { value: 'every', label: 'Forward every', title: 'Original behaviour; best for velocity derivation in disguise' },
        { value: 'latest', label: 'Newest only', title: 'Lowest latency when only current position matters' }
      ], c.udpSendPolicy, (v) => { c.udpSendPolicy = v; }),
      'TCP can deliver several samples in one read. Forward every keeps the motion continuous; newest only sends the latest and drops the rest.'),

    checkbox('Start this connection automatically when the app launches', c.autoStart, (v) => { c.autoStart = v; })
  ];

  const ok = await confirmModal({
    title: existing ? 'Edit Connection' : 'Add Connection',
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
