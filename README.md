# posi3

Bridges **POSITAL IXARC rotary encoders** to **disguise (d3)** media servers.

A rotary encoder on a piece of set — a revolve, a tracking portal, a winch — reports its angle
over TCP. posi3 reads that stream and forwards the position to disguise as UDP, so a screen or
projection can follow the physical movement live.

It replaces two things:

- **`d3driver.exe` (2016)**, which needed **one `cmd.exe` window per encoder**, left open for the
  whole show. posi3 runs every encoder from one place.
- **The encoder's Java configuration applet**, which needs JRE 7 and Internet Explorer and is
  effectively dead on current Windows. posi3 configures the encoder over plain TCP.

**The packet format sent to disguise is byte-for-byte identical to the old driver**
(`<devid>:<pos>,<vel>;\n`), so existing disguise projects keep working with no changes at all.
That contract is pinned by a test.

---

## Two ways to run it

**As a desktop app.** A window plus a tray icon. The window is a view onto the app's own web UI,
so it is the same interface either way.

**Headless.** No Electron, no window — for a show server administered from a laptop's browser:

```bash
node bin/posi3.js --port 8710
```

Either way the UI is at `http://127.0.0.1:8710`. It is **loopback-only by default**. Binding
wider turns on token authentication, because these screens can write the encoder's flash memory
and change a device's IP address:

```bash
node bin/posi3.js --bind 0.0.0.0 --port 8710   # prints an access token
```

---

## Screens

| | |
|---|---|
| **Dashboard** | Every encoder at a glance: packets/s to disguise, position, angle, revolutions, rate in/out, latency p50/p99, faults, and a 12-second position trace. The one to leave open during a show. |
| **Connections** | One row per encoder. Start/stop, per-socket network interface, duplicate device-ID warnings. |
| **Detail** | Dial, live readouts, app latency, **Zero / Preset**, velocity and coalescing policy. |
| **Encoder config** | Every encoder variable over TCP, with flash-write guards. Replaces the Java applet. |
| **disguise mapping** | Computes `min_input` / `max_input`; *Capture current* records live endpoints. |
| **Log** | Filterable console with a raw-command entry. |
| **Settings** | Refresh rate, auto-start, launch at login, profile import/export, venue notes. |

---

## Try it without hardware

Four terminals:

```bash
npm run mock  -- --port 6000 --cycle 10 --motion sine --span 400000
npm run sink  -- --port 6001
npm run headless -- --port 8710
open http://127.0.0.1:8710
```

Add a connection pointing at `127.0.0.1:6000` with disguise at `127.0.0.1:6001`.

The simulator reproduces the failures that broke the old driver:

```bash
npm run mock -- --cycle 2 --coalesce 4 --split   # 4 records per write, split mid-number
npm run mock -- --drop-after 500                 # kills the connection
npm run mock -- --stall-after 200                # holds the socket open, stops sending
npm run mock -- --wrap-soon --rpm 60             # rolls over 33 554 432 within seconds
```

---

## The encoder

POSITAL IXARC **OCD-EM00B-1213-C100-PRM** — 13-bit singleturn (8192 steps/rev) × 12-bit
multiturn (4096 revolutions) = **25 bit, 33 554 432 counts**.

Four things account for most of the trouble on site:

- Factory IP is **10.10.10.10**, and **hardware switch 2 in the connection cap forces that
  address** regardless of what is programmed. This is the most common reason a changed IP
  "does nothing".
- A new IP only takes effect after a **power cycle**.
- **TCP port 6000 carries the data stream *and* the command channel on one socket.** Replies
  arrive interleaved with position samples, which is why the parser classifies every line.
- The encoder accepts only **a handful of simultaneous TCP clients**. A leftover Java tool, a
  browser applet, or an old `d3driver.exe` still running somewhere can be holding the slot.

**Every parameter write goes to flash**, rated ~100,000 cycles, and the encoder must not lose
power mid-write. posi3 rate-limits writes, confirms them, and holds a banner until the device
reports `Parameters successfully written!`. It also knows that the firmware **refuses to store
the same `Preset` value twice in a row** — re-zeroing to a value already set is silently ignored
unless you take the two-cycle path, and posi3 offers that explicitly rather than appearing to
work.

---

## The disguise side

1. Create the object to drive (e.g. `surface 1`).
2. Create a **Position Receiver**.
3. Inside it create a driver → **Navigator driver**.
4. Set its **port** to this connection's destination port. *disguise defaults this to 8000; the
   reference project uses 6000.*
5. Create an **Axis**: `id` = the device ID, `object` = the target, `property` = an expression
   such as `offset.x`.
6. **Engage** the position receiver.

**One encoder can feed several disguise servers.** A redundant rig — director, understudy,
actors — needs the same tracking data on every machine that might take over. Add destinations to
the connection rather than duplicating it: the fan-out happens on the UDP side of a single link,
so the encoder still sees one TCP client.

### Why velocity is sent as 0

The original driver did `vel = 0; // ignore velocity`, leaving disguise to derive velocity from
position via the axis `velocitycalcmode`. That remains the default so existing shows are
unchanged. *From encoder* and *Derived* are available per connection.

---

## Bring-up at a venue

1. Put the server's NIC in the encoder's subnet, then `ping 10.10.10.10`.
2. Add the connection and press **Start**. Expect **STREAMING** and a moving dial.
3. **Aim at the UDP sink first**, not at disguise. If packets arrive there, the bridge is proven
   and anything still wrong is on the disguise side.
4. Point it at disguise, match the Navigator driver port and the Axis id, engage the receiver.

---

## Development

| Command | What it does |
|---|---|
| `npm start` | Run the desktop app |
| `npm run headless` | Run the bridge and web UI with no Electron |
| `npm test` | Unit and integration tests (`node --test`, no dependencies) |
| `npm run mock` | POSITAL encoder simulator, with fault injection |
| `npm run sink` | disguise stand-in; validates and measures the packet stream |
| `npm run bench` | End-to-end latency benchmark; non-zero exit on any loss |
| `npm run uicheck` | Headless layout audit across six viewport widths |
| `npm run icon` | Regenerate the app icon |
| `npm run dist:mac` / `dist:win` | Build installers into `release/` |

### Architecture, and why

- **All sockets live in the main process.** A renderer GC pause must never delay a packet.
- **The forward is synchronous inside the TCP data handler** — parse, then send, in the same
  tick. No queue in between.
- `setNoDelay(true)` on the encoder socket; the **UDP socket is *connected***, which skips a
  per-send address resolution and surfaces `ECONNREFUSED` / `EHOSTUNREACH` instead of dropping
  silently as the old unconnected `sendto` did.
- **Nothing is allocated per sample.** Digits go straight into pooled buffers.
- **Telemetry is coalesced.** Five encoders at 500 Hz is 2500 samples/s; one message per sample
  would swamp any UI. A single 30 Hz timer emits one frame describing every link.
- **One interface codebase.** The desktop window loads the same HTTP UI a browser does, so there
  is no second transport to drift.

Measured: **parse→send p50 ≈ 10–30 µs, p99 ≈ 110–260 µs**, against a 2 ms encoder cycle.

---

## Packaging

```bash
npm run dist:mac     # dmg + zip, arm64 and x64
npm run dist:win     # portable exe + NSIS installer, x64
```

Both platforms build from macOS — the Windows target does not need wine.

**The builds are unsigned.** On first run:

- **Windows** — SmartScreen shows *"Windows protected your PC"* → *More info* → *Run anyway*.
  The Defender firewall prompt appears too; **tick both Private and Public**, because a show LAN
  is usually classified as Public and that box is easy to miss.
- **macOS** — a *downloaded* copy is quarantined and reports *"posi3 is damaged and can't be
  opened"*, which is misleading. Either System Settings → Privacy & Security → **Open Anyway**,
  or `xattr -dr com.apple.quarantine /Applications/posi3.app`. Copying over the LAN or a USB
  stick avoids quarantine entirely, since it is applied by the downloader.
- **macOS 15+** prompts for **Local Network** access on the first connection attempt. If it is
  declined, every connection fails instantly with no obvious cause.

Pre-stage the app on the show server before the venue so someone who understands these warnings
clears them once.

---

## Reference material

`input/` holds the manuals, the datasheet, the original `d3driver.c`, the old `d3driver.exe`, and
screenshots of the Java applet it replaces. `docs/FEATURES.md` is the traceability record: what
was asked for, what was built, and why each decision went the way it did.
