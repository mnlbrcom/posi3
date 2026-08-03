# FEATURES

Traceability record for the posi3 project: what exists, and what was asked for.

> **Renamed.** This app began as **d3driver** in the repository `mnlbrcom/d3driver`. It is now
> **posi3**, living in the `posi3` repository alongside the reference documents in `input/`.
> The d3driver repository is archived. Paths in entries dated 2026-07-31 refer to the old
> layout: `7 - Code/d3driver-app/src/main/` is now `src/core/`, and `src/renderer/` is now
> `src/web/`.

---

# Part 1 — Inventory (what was built, where it lives, status)

## posi3 — encoder-to-disguise bridge with a web interface

Bridges POSITAL IXARC rotary encoders to disguise (d3). Replaces the 2016 console driver, and
the encoder's JRE 7 + Internet Explorer Java applet. Runs as a desktop app or headless.
**Status: bridge core shipped and simulator-verified. Web interface in progress. Not yet
validated against physical hardware.**

**Hard compatibility constraint:** the UDP payload to disguise is byte-for-byte identical to the
old driver (`<devid>:<pos>,<vel>;\n`), so existing d3 projects need no changes. Pinned by
`test/protocol.test.js`.

### Bridge core — `src/core/`, no Electron imports

| Component | File | What it does |
|---|---|---|
| Line reassembly | `src/core/line-assembler.js` | Buffers the TCP stream, splits on newline, keeps the partial remainder, resynchronises after an overflow. Fixes the old driver's worst bug. |
| Wire protocol | `src/core/protocol.js` | Classifies each line (sample / reply / ERROR / flash-commit event), parses ASCII_SHORT and ASCII, writes the disguise packet, wrap-aware position maths. Allocation-free on the data path. |
| Per-connection link | `src/core/encoder-link.js` | TCP to encoder + one connected UDP socket **per destination**, state machine, stall watchdog, exponential-backoff reconnect, velocity policy, latency histogram, **encoder variable cache and flash-write policy**. |
| Command channel | `src/core/command-queue.js` | Serialised `read` / `set` / `Run!` over the socket shared with the data stream; replies matched by variable name, every request deadlined. |
| Link registry | `src/core/link-manager.js` | Owns all links; one 30 Hz timer emits a single telemetry message for all of them. |
| Config | `src/core/config-store.js` | Atomic profile persistence (tmp → fsync → rename), rotated backup, corruption quarantine. |
| Log | `src/core/logger.js` | Bounded ring buffer, batched delivery, explicit dropped-line count. |
| Log file | `src/core/log-file.js` | Warnings and errors **always**; every line when `logToFile` is on. Size-capped with one rotation. A packaged app has no console, so without this a failure before the UI is up leaves no trace. |

### Transport — `src/server/`

| Component | File | What it does |
|---|---|---|
| Operation surface | `src/server/api.js` | Every operation the UI can perform, as plain functions. Transport-free, so the desktop window and a browser reach identical code and cannot drift. |
| Validation | `src/server/validate.js` | Rejects CR/LF in encoder values (a command-injection vector, since data and commands share one socket), checks variable names against the known table, normalises connection objects. |
| HTTP + static | `src/server/http.js` | `node:http` only, no dependencies. `POST /api/<operation>`, GET downloads for profile and log, static web UI. |
| Event stream | `src/server/sse.js` | Fans the existing coalesced telemetry out to any number of clients. SSE rather than WebSocket: one direction, and `EventSource` reconnects unattended. |
| Guards | `src/server/security.js` | Loopback by default; Host-header allowlist (DNS rebinding), JSON-only mutations (form CSRF), bearer token beyond loopback. |
| Assembly | `src/server/service.js` | Builds store + manager + api + server. Shared by the headless and desktop entry points. |

### Entry points

| Entry | File | Notes |
|---|---|---|
| Headless | `bin/posi3.js` | `node bin/posi3.js --port 8710`. No Electron, no window. Serves the web UI. |
| Desktop | `src/desktop/main.js` | Electron. The window **loads the same web UI over HTTP**; tray icon, launch at login, power-save blocker, single instance. No IPC layer and no preload. |
| Browser transport | `src/web/js/api.js` | Installs `window.d3d` over fetch + EventSource. The only transport there is. |

### User interface — `src/web/js/views/`

Vanilla ES modules, no framework and no build step. Served over HTTP by `src/server/http.js`;
still reached through the Electron IPC bridge until the desktop window switches over.

| Screen | File | What it does |
|---|---|---|
| Dashboard | `views/dashboard.js` | Every encoder at a glance: one hero figure (packets/s to disguise), summary tiles, and a card per encoder with position, derived angle and revolutions, velocity, in/out rate, latency p50/p99, uptime, faults, and a 12-second position sparkline. The screen to leave open during a show. |
| Connections | `views/connections.js` | One row per encoder, all running from one window. Status pills, live position and rate, start/stop, duplicate device-ID warnings. **Replaces "one cmd window per encoder".** |
| Detail | `views/detail.js` | SVG dial (angle, revolutions, mapped travel), live readouts, app-latency stats, **Zero / Preset 0**, velocity and coalescing policy. |
| Encoder config | `views/encoder-config.js` | Read/write every encoder variable over TCP 6000, batched writes, flash-write confirmation and banner. **Replaces the JRE 7 + Internet Explorer Java applet.** |
| disguise mapping | `views/mapping.js` | Computes `min_input`/`max_input`; *Capture current* records live endpoints; warns when a span crosses the count rollover and offers a one-click Preset. |
| Log | `views/log.js` | Filterable console with a raw-command entry. |
| Settings | `views/settings.js` | Refresh rate, auto-start, launch at login, NIC, profile import/export, venue troubleshooting notes. |

### Test and diagnostic tools — `tools/`

| Tool | Purpose |
|---|---|
| `mock-encoder.js` | POSITAL simulator with fault injection (`--coalesce`, `--split`, `--drop-after`, `--stall-after`, `--wrap-soon`, `--garbage`, `--no-crlf`, `--latency-jitter`, `--max-clients`). |
| `udp-sink.js` | disguise stand-in; validates packets, reports rate, gaps and jitter. **Also the on-site diagnostic** — prove the bridge before blaming d3. |
| `latency-bench.js` | Single-process end-to-end latency measurement. |
| `link-harness.js` | Drives the bridge headless, no Electron. |
| `shaft-check.js` | Confirms an encoder's scaling by turning it. Waits for motion, accumulates wrap-aware displacement, reports measured counts/rev against what the device claims. Hand accuracy is enough — the failure modes worth catching are off by whole multiples, not percent. `npm run shaft`. |
| `uicheck.js` | Headless layout audit. Drives Chrome over the DevTools protocol at a range of viewport widths, reports anything overflowing its container and any console error, optionally writes screenshots. Zero dependencies — Node's built-in WebSocket speaks CDP. `npm run uicheck`. |
| `make-app-icon.js` | Generates `build/icon.png` and, on macOS, `build/icon.icns` via Apple's `iconutil` — each size rendered at its true size, the two smallest without the needle. |
| `make-tray-icon.js` | Generates the tray icon into `src/desktop/tray-icon.js` as base64. |

### Installers — `electron-builder.yml`

macOS dmg + zip (arm64 and x64) and Windows portable exe + NSIS installer, all built from macOS;
the Windows target does **not** require wine. **Verified: all four artifacts build from a clean
tree, and the packaged macOS app runs.** ~114 MB dmg, ~85 MB Windows exe. The icons are
committed, so a clean checkout can package without running a generator first.

### CI — `.github/workflows/`

`ci.yml`: tests on Linux, macOS and Windows; the end-to-end latency bench (non-zero exit on a
single lost or malformed packet); and a headless layout audit that renders every screen at six
widths and uploads screenshots. `release.yml`: builds and attaches all four artifacts plus
`SHA256SUMS.txt` on a `v*` tag.

---

# Part 2 — Request log

## 2026-07-31 — Create the C source file
Asked to save the existing `d3driver.c` source into the code folder.
→ Created `7 - Code/d3driver.c`. Flagged an off-by-one: the code checks `argc < 5` but
dereferences `argv[5]`. Left as-is, since the request was to store the file verbatim.

## 2026-07-31 — GUI version of the driver for macOS and Windows
Asked for a standalone GUI (not a Bitfocus Companion plugin) resembling Companion, showing live
rotary encoder values alongside the input/output IP settings, plus any additional
recommendations.

Confirmed scope with the user: Electron + Node; multiple encoders in one app; encoder
configuration panel; Zero/Preset button; dial and disguise mapping helper; installers for both
platforms.

→ Built the full application described in Part 1.

**Recommendations raised and acted on:**
- Four latent defects in `d3driver.c` — chiefly that one `recv()` was treated as exactly one
  sample, so coalesced TCP records were silently dropped. All fixed and covered by tests.
- Auto-start plus launch-at-login so a show server reboot recovers without a keyboard.
- The encoder config panel makes `6 - Posital Web Controller Guide/` (and its bundled 29 MB
  JRE 7 installer) obsolete.
- Velocity is still sent as `0` by default to preserve existing behaviour, but is now a
  per-connection toggle so the encoder's own value can be A/B tested on real hardware.

**Recommendations raised, not acted on** (noted for the user's decision):
- This is not a git repository; the C source has no history.
- `3 - For server/d3driver.exe` is an older, *quieter* build than `7 - Code/d3driver.c` —
  recompiling from the current source would add a `printf` per sample and reduce throughput.
- `1 - How_to/Manual_Drehwertgeber_rotary_encoder.docx` names the same folder three different
  ways and ends on a dangling empty `Info:` line.
- The encoder nameplate PDF has no text layer and the photos do not show it legibly, so the
  programmed IP and serial are not recorded anywhere in this project.

## 2026-07-31 — Optimise for data network latency
Asked mid-build to make sure the code is optimised for network latency.
→ Made latency a first-class design constraint: all sockets in the main process, synchronous
forward inside the TCP data handler, `TCP_NODELAY`, a *connected* UDP socket (removes a per-send
address lookup and surfaces ICMP errors the old driver swallowed), zero allocation per sample,
no logging on the hot path, telemetry coalesced to 30 Hz. Added a latency histogram surfaced in
the UI and `tools/latency-bench.js` so regressions are visible.
Measured: parse→send p50 ≈ 10–27 µs, p99 ≈ 110–210 µs against a 2 ms encoder cycle.

## 2026-07-31 — GUI shivering from column size adjustments
Reported that the interface shivered as live values updated.
→ Root causes: auto-sized table columns re-measuring every frame; the detail view rebuilding the
status pill's DOM on every animation frame; text written unconditionally at 60 fps. Fixed with a
fixed table layout and explicit column widths, reserved-width value boxes, a `setText` helper
that only writes on change, and pill/label width reservations.
Added `D3D_PROBE`, which samples the geometry of every live element and reports anything that
moved — the regression test for this class of bug. All views report **LAYOUT STABLE**.

While fixing this, found that the app's Content-Security-Policy (`style-src 'self'`) was silently
dropping every inline `style` attribute in the app. Routed styling through the CSSOM instead,
which CSP permits, so the policy stays strict.

## 2026-07-31 — Brand the app with the Pixway logo and colours
Asked to use the logo in `8 - Branding/` and follow a dark theme in the logo's colours; later
noted the Pixway font is Chalkduster.
→ Sampled the exact brand magenta **`#e6007e`** from the logo artwork. Retheméd the whole app
around it, with neutrals carrying a slight magenta cast and a lighter tint (`#ff5cae`) for text,
where the brand colour alone falls short of the 4.5:1 contrast threshold.
Added `tools/make-assets.js` to crop the logo and separate the wordmark from the strapline, which
is illegible at rail width. Placed the wordmark in the sidebar; the product name is set in
Chalkduster with a Segoe Script fallback for Windows, and is used for the wordmark only, never
for data. Generated a matching app icon.

## 2026-07-31 — App icon looked wrong at small sizes
Reported that the icon looked weird in Spotlight and in Finder under Applications.

Two separate causes:

1. **electron-builder produced a corrupt `.icns`.** Extracting the generated file showed the
   16 px and 32 px entries contained no magenta tile and no transparency at all — just noise —
   while 128 px and above were correct. Those two sizes are exactly what Finder, Spotlight and
   the menu bar display. Fixed by building the `.icns` with Apple's own `iconutil` from a full
   iconset, each entry rendered from the vector at its true size rather than downsampled, and
   pointing `mac.icon` at that prebuilt `.icns` instead of a PNG.
2. **The artwork was only designed for 1024 px.** It was full-bleed (macOS icons need roughly a
   10 % inset, so it rendered visibly larger and blunter than neighbouring apps), used a dark
   plate that greyed out against dark backgrounds, and carried 24 thin tick marks that averaged
   into mud when downscaled. Redesigned around brand magenta as the tile itself, with few heavy
   shapes and a simplified needle-less variant for the 16/32 px entries.

`ICON_PREVIEW=<path> npm run icon` writes a contact sheet so the small sizes get judged rather
than assumed.

> macOS caches app icons aggressively. After installing a rebuilt version the old icon can
> persist in Finder and Spotlight; `killall Dock Finder` refreshes it, or move the app to the
> Trash and back.

## 2026-08-02 — A web interface, and macOS + Windows portability

Asked for a portable app that bridges the encoder to disguise's Navigator driver, with a GUI
for connections and network interfaces, plus a **web interface** for configuration, an encoder
dashboard, network status and a log — styled like Bitfocus Companion in a black/grey dark
theme. Asked mid-planning to optimise for minimum encoder→disguise delay, then to check the
existing `mnlbrcom/d3driver` work for reuse given the macOS + Windows requirement.

**Recommendation raised and accepted: extend rather than rewrite.** The plan had been a
from-scratch Go implementation. Reviewing the existing app changed that:

- The bridge core has no Electron imports at all, and `tools/link-harness.js` already ran it
  under plain `node` with zero stubbing.
- The renderer has no Node APIs, no `require` and no framework — it is already a web app that
  simply was not being served. Nothing in it needs a polyfill for Gecko or WebKit.
- Latency was already measured at p50 10–27 µs against a 2 ms encoder cycle, so a rewrite had
  nothing to gain there.

A Go port would have discarded all of that to save disk space. It stays on the table as a
separate decision; `test/protocol.test.js` is its ready-made conformance spec.

**Accepted cost:** Electron carries its own Chromium, so the portable Windows exe stays ~95 MB
and the macOS dmg ~110 MB against ~12–15 MB for Go.

**Decisions:** posi3 becomes the app and d3driver is archived; the desktop window will load the
local web UI so there is exactly one UI codebase; the theme goes fully neutral and the Pixway
magenta is dropped.

### Shipped in this change

→ Migrated the app into the `posi3` repository and renamed it. `src/main/` → `src/core/`,
`src/renderer/` → `src/web/`. All 47 existing tests pass unmodified after the move.

→ Added `src/server/`: the transport-free operation surface, an HTTP + SSE server on
`node:http` with no dependencies, and `bin/posi3.js` to run the whole bridge headless.
Verified end-to-end against the simulator with `--coalesce 3 --split`: 405 samples received,
405 forwarded, zero loss, ~100 pkt/s at a 10 ms cycle.

→ **Auto-start no longer hangs off the renderer loading.** It was attached to the window's
`did-finish-load`, so a headless process — or later, a desktop launch straight to the tray —
would never have connected anything.

### Defects found while reviewing the existing code, and fixed

1. **The flash-write rate limit lived in the IPC layer** and mutated `link._lastWriteBatchMs`,
   a property never declared on `EncoderLink`. Adding HTTP as a second transport would have
   given it its own uncoordinated limit, or none. Moved into `EncoderLink`, so all transports
   share one budget for the device's ~100,000 write cycles. Regression-tested.
2. **Preset writes bypassed the limit entirely** — the handler *assigned* the timestamp without
   ever checking it, so hammering "Zero / Preset 0" burned one flash cycle per click.
3. **The duplicate-Preset rule was not implemented.** The firmware refuses to store the same
   `Preset` value twice in a row, so re-zeroing to a value already set looked like it worked
   and silently did nothing. Now an explicit `EPRESET_DUPLICATE` error, with an opt-in
   two-cycle path (write `value+1`, await the commit, write `value`) when it is really wanted.
4. **`TIMEOUTS.FLASH_COMMIT_MS` was declared and never used**, so the UI's "waiting for the
   encoder to confirm" state had nothing behind it and could wait forever. There is now a real
   commit window that opens on write and closes on the broadcast, on a 30 s deadline, or when
   the link drops — a pending write cannot be confirmed once we are no longer connected to
   hear the broadcast.
5. **Encoder replies are now cached** whether or not one of our commands was waiting for one.
   The encoder broadcasts every reply to every connected client, so this is how a change made
   in another browser tab, or by a leftover Java tool, becomes visible.
6. **Network interfaces are re-enumerated on demand** rather than snapshotted once at startup.
   A USB-Ethernet adapter plugged in at a venue used to need an app restart to appear.

### Known, still open

- The desktop app still uses the old IPC transport; it switches to the web UI in the next step,
  along with the tray icon. Until then **`startMinimized` remains a trap** — it hides the window
  and there is no tray icon to bring it back.
- `Cmd/Ctrl+R` is bound to "start all connections" in the native menu. In a browser that
  reloads the page, so it needs an in-page handler before the web UI ships.
- Three settings remain dead: `defaultLocalAddress`, `defaultVelocityPolicy`, and `logToFile`
  (there is no file logging at all, which matters because a packaged app has no console).
  *(All three resolved 2026-08-03: the first two deleted, `logToFile` implemented.)*
- `tools/udp-sink.js` does not really verify the trailing `;` — it splits on `;` and re-appends
  one, so a payload missing its terminator still parses. disguise drops the final axis when
  that `;` is absent, so this deserves a real check.
- `encoder-link.js`, `link-manager.js` and `config-store.js` still have no unit tests beyond
  the new flash-policy suite.

## 2026-08-02 — The web interface

→ **`src/web/js/api.js`**: installs `window.d3d` over `fetch` and `EventSource` with exactly
the surface the Electron preload exposes. Every view calls the same method names and gets the
same shapes back, so **not one view needed changing to run in a browser** — the sandboxed IPC
boundary had already forced a JSON-only interface. The module is inert when a preload has
already installed `window.d3d`, so both transports coexist while the desktop window catches up.

Guarded by `test/web-api-surface.test.js`, which reads the shim's source and checks that every
operation name it calls exists on the server, and that the preload's surface is a subset of the
shim's. Operation names are strings in the shim, so a typo would otherwise only appear when
somebody clicked the button.

### Browser-only work

- **CSP `connect-src` `'none'` → `'self'`.** The shipped policy was correct for a `file://`
  renderer talking over IPC and fatal for one that must reach its own API. Served over HTTP the
  real policy is a response header, which additionally sets `frame-ancestors 'none'` — a `<meta>`
  tag cannot express that.
- **The three native file dialogs are gone.** `dialog.showSaveDialog` would have opened a file
  picker on the show server rather than on the operator's machine. Profile and log export are
  now ordinary downloads with `Content-Disposition`; import is a file input.
- **`Cmd/Ctrl+R` no longer means "start all connections".** It came from the native Electron
  menu; in a browser it reloads the page, which on a show is the difference between engaging
  the encoders and dropping every link. The bindings moved to `Cmd/Ctrl+Shift+R` and
  `Cmd/Ctrl+Shift+.`, handled in-page.
- **Repaint on `visibilitychange`.** The whole UI paints from one `requestAnimationFrame` loop,
  which a browser throttles to a standstill in a background tab, freezing every value
  mid-update. The store keeps the newest frame, so returning to the tab needs one repaint.
- **The access token never stays in the address bar.** It arrives once as `?token=…`, moves to
  sessionStorage, and the URL is rewritten — a token in a URL gets pasted into tickets and chat.

### Defects fixed

- **`configChanged` is emitted at last.** The channel was declared and never fired, which was
  harmless with a single window and means stale config in every browser but the editing one now
  that several can be open. All six mutating operations announce it.
- **The log backfills on connect.** `log.tail()` was implemented and exposed but never called,
  so a browser opened *after* something went wrong showed an empty console — exactly when the
  history matters. It now loads the last 500 lines before following the stream.
- **The duplicate-Preset refusal is now actionable in the UI**, not just an error string. "Zero
  here" on an already-zeroed encoder offers the two-cycle path behind a confirmation that states
  the cost.
- **The Pixway wordmark `<img>` is now text.** The PNG was produced by a build step and never
  committed, so it 404'd from a clean checkout. The branding is being dropped anyway.

### Not verified

The browser UI has **not been opened in a browser** — no browser automation was available in
this session. What is verified: all 11 web modules parse as ES modules, every operation the shim
calls exists, static assets and the CSP header serve correctly, `configChanged` fires, `logTail`
returns history, and both downloads carry the right `Content-Disposition`. Rendering, layout and
cross-engine behaviour in Chrome, Safari and Firefox are still unchecked.

## 2026-08-03 — Dashboard, neutral theme, and knowing which encoder you are about to write to

Asked to fold the encoder-picker fixes into this step and leave multi-destination fan-out for
after. Also asked, architecturally, whether one encoder can feed several disguise servers —
answered no, see below.

### Neutral theme

The Pixway magenta is gone; the palette is neutral greys with a single blue accent. Every ink
was **measured against every surface it can sit on** rather than picked by eye, and the ratios
are recorded in the token block. Two findings that shaped it:

- A colour legible as a *fill* is not necessarily legible as *text*. Critical red reaches only
  3.6:1 on the panel surface — fine for a pill or a rule, below AA for words. So status colours
  ship in pairs (`--err` / `--err-text`) and the comment says not to collapse them.
- The status palette (good / warning / critical) is reserved. It means state, never "series 4",
  and is always paired with a word, never carrying meaning by hue alone.

25 stray hex literals scattered through the stylesheet were promoted into tokens, so the theme
is now genuinely centralised — previously a retheme would have missed banners, pills, the log
and the danger zone.

### Dashboard

New landing screen. One hero figure per the usual rule — total packets/s reaching disguise,
because that is the number meaning "the show is being driven".

Numbers use `font-variant-numeric: tabular-nums` **against** the usual advice for large
standalone figures. That advice assumes a value that sits still; these repaint continuously, and
proportional digits change width as the value changes, which is what caused the documented "UI
shivering" bug. The local constraint wins, and the code says why.

The sparkline scales to the range actually visited rather than the encoder's full 33,554,432
counts — otherwise real movement renders as a flat line — with a floor on the span so sensor
noise is not amplified into a mountain range.

### Knowing which encoder you are configuring

The config screen took its target from `store.selected`, which is whatever was last clicked
elsewhere, defaulting to the first connection. For a screen whose buttons write flash and can
change the device's IP, that was too quiet. It now has a target bar that names the device, lets
you switch device without leaving the screen, and **shows its live position**.

That last part is the important one, and it is a consequence of the hardware: the encoder
exposes **no serial number, no firmware version, no MAC** — nothing identifying at all over the
wire. Its address is the only handle. So the only reliable way to confirm you have the right
physical unit is to turn the shaft and watch the position move, and the UI now makes that
possible without navigating away.

### Per-socket network interface

The bridge has always bound the encoder socket and the disguise socket independently; the form
tied them to one control, so there was no way to receive on an isolated encoder network and send
to disguise on the production one — a normal show topology. Now two pickers.

The list is also **re-enumerated when the form opens** rather than read from the startup
snapshot, so an adapter plugged in at the venue appears without an app restart. A saved address
that is no longer present stays selectable and is labelled "not present on this machine",
instead of silently resetting to Any and quietly changing the routing.

### Architecture question answered: one encoder → several disguise servers

**Not currently possible.** The schema has one destination and one UDP socket per link. The
workaround — two connections pointing at the same encoder — is the wrong one, because each opens
its own TCP socket and the encoder accepts only a handful of clients; on site a leftover Java
applet or an old `d3driver.exe` may already hold one.

The right design is to fan out at the UDP layer: one TCP socket in, N destinations out, since
an extra `sendto` in the same tick costs microseconds and adds no latency to the first
destination. It needs a per-destination device ID, per-destination error counters (one dead
server must not look like a general fault), and a schema migration from `d3` to `destinations`.
**Deferred to its own step**, at the user's direction.

### Not verified

Still no browser automation in this session, so the new dashboard and target bar have **not been
looked at**. Verified: all 12 web modules parse, 63 tests pass, two simultaneous encoders stream
to distinct device IDs, and the telemetry the dashboard consumes is present and correct.
Rendering, layout and cross-engine behaviour remain unchecked.

## 2026-08-03 — One encoder, several disguise servers

Implements the fan-out identified in the architecture question above.

**Schema 2.** A connection's single `d3` object becomes `destinations[]`. A schema-1 profile is
upgraded on load by promoting `d3` to the first destination, so a profile written by the
previous build keeps working with nothing to do. `d3` survives as a **derived mirror of
`destinations[0]`**, because several screens legitimately mean "the primary destination" — the
mapping helper computes one axis. It is read-only by convention; writes go to the array.

**The fan-out is on the UDP side of one link, not a second connection.** That is the whole
point: the scarce resource is the TCP socket to the encoder, which accepts only a handful of
clients, and on site a leftover Java applet or an old `d3driver.exe` may already hold one. An
extra UDP destination is one more `send` in the same tick.

Each destination gets its own connected socket, its own optional source interface, its own
device ID, an enable toggle, and **its own error counters** — so one unreachable disguise
machine reads as that machine being down rather than as a general fault on the link. The packet
is built once per sample and reused across destinations, rebuilt only when a destination
overrides the device ID.

**Verified:** a v1 profile upgraded in place, a second destination added live, and both stand-ins
received 100 pkt/s of the same axis (356 samples in → 356 to each, 712 total). Latency is
unchanged: 6000/6000 with zero loss, internal parse→send p50 31.8 µs, p99 141.3 µs.

Ten new tests, of which the load-bearing one is that a **single destination still emits exactly
`1:12345,0;\n`** — the contract with every existing disguise project. Also covered: identical
delivery to several destinations, per-destination device-ID override, disabled destinations
opening no socket at all, per-destination counters, socket cleanup on stop, schema-1 promotion,
duplicate rejection, same host/port with different device IDs being legal, and the 16-destination
bound.

**UI.** The connection editor now has a destination list with add, remove, label, enable and
per-destination interface. The connections table and dashboard card show the first destination
plus "+N", with the full list on hover — a row that silently showed only the first would hide
half the routing. Duplicate-device-ID detection now checks **every** destination, not just the
first: two encoders whose *second* destinations collide would fight over one axis in disguise
just as surely as if their first ones did.

**Still not verified:** no browser automation in this session, so the destination editor has not
been looked at.

## 2026-08-03 — Layout overflow and mobile

Reported that a div escapes its frame on the Connections screen, that text pops out of its frame
in Encoder config when the window is narrowed, and asked for the layout to survive a mobile
viewport.

Four distinct causes, all found by reading the stylesheet rather than the rendering — see the
caveat at the end.

1. **The flexbox `min-width: auto` trap.** `.row-inline` is a flex row whose children were
   `flex: 1` with no `min-width`. A flex item defaults to `min-width: auto`, meaning it refuses
   to shrink below its own content — so the form rows pushed straight out of their panel instead
   of shrinking. Now `flex-wrap: wrap` with `min-width: 0` on the children.
2. **`table-layout: fixed` plus a `<colgroup>` summing to ~760px.** The connections table
   honours those widths regardless of viewport, so it silently overflowed. The table now declares
   its real minimum and `.panel` carries `overflow-x: auto`, so wide content scrolls inside its
   own box and the page body never scrolls sideways.
3. **The variable table's help column had no bound**, so the longest sentence in it stretched the
   whole table past the panel edge. Bounded.
4. **`height: calc(100vh - 260px)` on the log box.** On iOS Safari `100vh` is the *large*
   viewport, so the box sat under the collapsing URL bar. Now paired with a `dvh` declaration,
   the `vh` line kept first as the fallback for engines that do not know `dvh`.

Also: literal command previews scroll rather than re-wrap (they are meant to be copied exactly),
and the disguise field values wrap rather than clip — those get typed into disguise by hand, and
a value cut off by `overflow: hidden` would be silently wrong.

**Responsive pass.** Three breakpoints, same markup re-flowed rather than a separate mobile
design: at 860px the target bar and card metrics reflow; at 720px the fixed 208px rail stops
being a rail and becomes a horizontally scrolling nav strip; at 480px form fields go one per
line and the hero figure shrinks. Coarse pointers get larger hit targets. Grid and flexbox only —
no container queries and no `:has()`, so it behaves the same in Blink, WebKit and Gecko.

**`test/layout-invariants.test.js`** guards each of the four bugs plus the browser-support rule:
no Chromium-only CSS, no `vh` without a `dvh` companion, no unexpected vendor prefixes (there is
no build step, so Autoprefixer is not in play), breakpoints present, and the stylesheet balanced
with no undefined custom properties. These assert the stylesheet, not the rendering — they are a
regression guard, not a substitute for looking.

**Caveat, and it is the important one.** These fixes were reasoned from the CSS. Nothing here has
been seen rendered, because browser automation is not connected in this session. Four milestones
of UI have now been built without once looking at it, which is why these bugs reached the user
instead of being caught in the making.

## 2026-08-03 — Looking at the page instead of reasoning about it

Reported that Chrome should be connected. It is not reaching this session — the browser skill
and its tools are both absent — so rather than keep guessing, the audit was built directly:
**`tools/uicheck.js`** drives a local Chrome over the DevTools protocol with no dependencies
(Node's built-in `WebSocket` speaks CDP), loads the UI at six viewport widths across all six
screens, and reports anything that overflows its container plus any console error. `--shots`
writes a PNG per width; `--eval` runs an expression in the page. It exits non-zero, so it can
gate CI.

`test/layout-invariants.test.js` asserts the stylesheet; this asserts the rendering. Both are
needed — and the second immediately found things the first could not.

### What it caught that reasoning had not

- **`.sidebar-foot` sat 105px past the viewport at 720px.** In the new horizontal nav strip,
  `margin-left: auto` inside an `overflow-x: auto` row pushes the footer past the edge, where it
  is reachable only by scrolling the nav. Hidden at that width — throughput is on the dashboard
  and the version is in Settings.
- **The danger-zone table escaped by up to 253px at 390px.** It is the one `.vartable` *not*
  inside a `.panel`, so nothing gave it a scroll container. Its body has one now.

Two of the first findings were false positives in the audit itself, worth recording because the
rule is not obvious: an element's `getBoundingClientRect()` reports full layout width even inside
a scrollable box, so content that is properly scrollable looks like an overflow. Excluding
elements whose *nearest* ancestor scrolls was still not enough — a table cell is `overflow:
hidden` for its ellipsis and sits inside the panel that does the scrolling, so the check has to
walk the whole ancestor chain.

### What the screenshots caught that no audit would

- **Every status pill read IDLE while the links were streaming**, and Encoder config refused to
  read because it believed the connection was stopped. Link state arrives as a *transition*
  event, so a browser connecting to an already-running bridge never hears one. Telemetry carries
  the current state, so the store now reconciles from it on every frame — which also heals the
  same gap after an `EventSource` reconnect, when transitions were missed.
- **The latency pair was ellipsised to "49 µs / 19…"** — four metric columns in a ~370px card,
  and latency is the one figure that screen exists to show. Two columns now.
- **"399 967   296.67°" read as a single number.** Now separated with units.

The first of those is a functional bug that would have met anyone opening the web UI against a
running bridge, and no amount of stylesheet analysis would have surfaced it.

## 2026-08-03 — The desktop shell, and the first look at the UI in a real browser

Chrome connected part-way through this step (the native messaging host is only written the first
time Claude Code launches with `--chrome`, and Chrome must then be restarted to read it), so this
is the first work verified by clicking through the actual interface.

### Desktop shell

The window now loads `http://127.0.0.1:<port>` — the same URL a browser on the show LAN opens.
**`src/desktop/ipc.js` and `src/desktop/preload.js` are deleted**: with one interface codebase
there is no second transport to keep in step. What remains in the desktop layer is only what a
desktop app can do — window, tray, launch at login, staying awake while streaming, and refusing
to run twice.

- **Tray icon**, generated by `tools/make-tray-icon.js` and emitted as base64 into
  `src/desktop/tray-icon.js`. A source file rather than a binary asset because the previous build
  referenced generated images that were never committed, so a clean checkout could not package.
- **Closing the window hides it** rather than stopping the bridge; quitting is explicit, from the
  tray or the menu. This is what finally makes **`startMinimized` safe** — it used to hide the
  window with no way to get it back on Windows, since `activate` is macOS-only.
- **Port fallback.** If the configured port is taken — including by a headless posi3 someone left
  running — it binds an ephemeral one and reports the real URL in the tray, rather than refusing
  to start. A tool whose job is to be running when the show starts should not fail on a port
  clash.
- The native menu's accelerators now match the web UI (`Cmd/Ctrl+Shift+R`), so the same keystroke
  does the same thing on both surfaces and plain `Cmd+R` stays "reload the page".
- `defaultLocalAddress` and `defaultVelocityPolicy` are deleted — both were dead. `webPort` and
  `webBindHost` are new.

### Found by clicking through it

The flash-write path was exercised end to end in a browser for the first time, and both stages
behave: the confirmation states the flash cost and shows the literal `set Preset=0`, and the
`EPRESET_DUPLICATE` follow-up offers the two-cycle path with its price stated. The forced write
completed and reported "Preset written using 2 flash cycles."

That run exposed a bug no audit had caught: **the banners were absolutely positioned over the
shell**, so two stacked banners covered the top of the nav rail. During a flash write — exactly
when "do not power off the encoder" is on screen — the navigation was hidden behind it. Banners
are now in the flow and displace the shell instead. Also fixed: the hero tile stretched to
whatever height the stat tiles wrapped to, leaving a tall empty box under one number.

`test/web-api-surface.test.js` lost its preload-comparison test, which had nothing left to
compare, and gained one asserting the preload and IPC layer stay deleted — if either returns, the
single-codebase guarantee is gone and the comparison has to come back with it.

### Not verified

**The Electron app itself has not been run.** npm is configured to block postinstall scripts, so
Electron's binary was never downloaded. Everything the window depends on — the service, the API,
the web UI — is verified; the window, tray and close-to-tray behaviour are not.

## 2026-08-03 — Packaging, CI, and the tests the big files never had

Worked through unattended, at the user's direction, with Electron's install script approved.

### The desktop app, actually run

Electron's binary had never been downloaded (npm blocks postinstall scripts here), so the window
had only ever been reasoned about. With it approved: **the app runs**, the window opens titled
`posi3` at 1180×780 loaded from `http://127.0.0.1:8710/`, all six nav items render, no error
banner. Verified by attaching to Electron over its own DevTools protocol, since AppleScript has
no accessibility permission on this machine.

One real finding: **launch at login silently failed.** macOS refuses it for an unsigned build
running outside `/Applications`, and the `catch` swallowed it — so the checkbox appeared to work
and did nothing, which on a show server is the difference between coming back after a reboot and
not. It now reads the setting back and reports the discrepancy in the log.

### Security, exercised rather than asserted

The token path had never been used. Bound to `0.0.0.0`, all eight checks behave: no token, wrong
token, correct token by header, correct token by query, the static page, the SSE stream, the
downloads, and loopback (which is *also* gated once a token exists). Fixed alongside: bound wide,
the server reported `127.0.0.1` as its address — useless, since the whole point of binding wide
is to reach it from another machine. It now reports a routable address.

### Tests for the three biggest untested files

`config-store.js` (10 tests) — defaults, round-trip, **schema-1 upgrade from disk**, corrupt-file
quarantine, **recovery from the rotated backup**, read-only for a newer schema, device-id
allocation across all destinations, clone hygiene, no stray temp file.

`encoder-link.js` (8 tests) — the largest file in the project, previously covered only at the
wire-format level. Now driven against the **real simulator over a real socket**, spawned as its
own process so the tests exercise the same program `npm run mock` runs: streaming, coalesced and
split records with `rx === tx`, reconnect after a drop, **a socket that goes quiet without
closing** (the nastiest venue failure — the session looks healthy while disguise sees a frozen
position), retry-with-reason on a refused connection, field layout read rather than inferred,
velocity passthrough, and clean teardown.

**100 tests pass** on the full suite.

### Packaging and CI

`electron-builder.yml` carried across and updated: neutral icon, `portable` added to the Windows
targets (its options were configured but it was never listed, so it silently never built), macOS
`NSLocalNetworkUsageDescription`, and a whitelist that keeps `tools/` and `test/` out of the
bundle — verified, zero dev files in the asar.

`tools/make-app-icon.js` generates the icon with no dependencies and assembles the `.icns` with
Apple's `iconutil`, each size rendered at its true size rather than downsampled, and the 16/32 px
entries drawn without the needle. This is the same defect the previous build hit: given only a
PNG, electron-builder generates an `.icns` whose 16 and 32 px entries come out corrupt — exactly
the sizes Finder, Spotlight and the Dock show.

The Pixway branding tools (`make-assets.js`, `make-icon.js`) are deleted; the branding they
served is gone and `make-assets.js` read from a path outside the repository.

A README exists for the first time.

### Corrections to the record

- **This Mac is Intel x64, not Apple Silicon.** The inherited README claimed builds came from an
  Apple Silicon Mac; that was written elsewhere. The arm64 dmg builds here but cannot be run
  here — only the x64 one was launched and verified.
- **`FileDescription` is not being stamped** into the Windows exe. Neither `package.json`
  `description` nor `extraMetadata` took, so Windows falls back to the product name in Task
  Manager. Cosmetic, unresolved, noted in `electron-builder.yml`.

### Still open

- **No hardware.** Everything is verified against the simulator. The A/B byte-diff against the
  real `d3driver.exe`, the 8192-counts-per-revolution check, and the line terminator the manuals
  never document all still need an encoder on a bench.
- The tray icon and close-to-tray were not visually confirmed — screenshotting the macOS menu bar
  needs a screen-recording permission this session does not have. Tray *construction* is proven,
  since a failure would have hit the fatal-error path and exited.
- The Windows artifacts have not been run; they were built on macOS.

### Log file (same session)

`logToFile` was the last of the three dead settings. It is implemented, and deliberately not a
simple on/off: **warnings and errors are always written**, because a packaged app has no console
and a failure before the UI is up would otherwise leave no trace anywhere — the operator just
sees an app that did nothing. The setting widens it to every line for a session someone is
actively debugging. Size-capped at 10 MB with one rotation; a read-only directory disables it
rather than stopping the bridge.

### Clean-checkout check

`git clone` → `npm ci` → `npm test`: **100 tests pass**, with `build/icon.png`, `build/icon.icns`
and `src/desktop/tray-icon.js` all present without running any generator. That was the specific
failure of the previous build and it is now verified rather than assumed.

## 2026-08-03 — POSITAL's own Java client, read

The user added `input/4 - Posital Web Controller Guide/tools-ixarc-ocd-em-java_client` — the
vendor's reference client, referenced in the manual but never available until now. It settles
several things that were assumptions, and turns up one real risk.

### Confirmed

- **The command terminator we send is right.** `tcpcl.java:201` is `to_server.println(line)`, and
  `PrintWriter.println` emits the *platform* separator. The client shipped with Windows batch
  files, so the encoder has always been fed **CRLF** — which is what we send. Previously
  inferred; now evidenced.
- **Being permissive about what the encoder sends is the reference behaviour, not a guess.** The
  vendor reads with `BufferedReader.readLine()` (`tcpcl.java:87`), which accepts CR, LF or CRLF
  indifferently. They did not depend on a specific terminator either, and neither do we. *(This
  still does not tell us what the encoder actually emits — only that nobody has needed to know.)*
- **Refusing BINARY mode is correct.** Their own comment at `tcpcl.java:84-86` admits the client
  "will lead to a wrong value, if encoder sends in binary mode and binary contains \n or \a" —
  binary framed through `readLine()` is broken by construction. We detect it and say so instead.
- **No handshake.** Connect and read; no greeting, no login. Matches our implementation.
- Over **UDP** (`udpcl.java`) commands are sent with **no terminator at all** — the datagram is
  the frame. Not a path we use, but it explains why the encoder's parser is lenient.
- `TIME`, `NOTIME`, `BINARY`, `ASCII`, `NEW`, `EXIT` are **client-side words**, intercepted
  locally and never sent to the encoder. Worth knowing before someone types one into our raw
  command box and wonders why nothing happens.

### The real find: two command dialects

POSITAL document the same operation two different ways.

| Source | Syntax |
|---|---|
| Manual UME-OCD-EM §5.6.1 | `set <Variable>=<Value>` |
| *Modbus Encoder Parametrization via Command Lines*, p.7 | `Variable=Value` — e.g. `CountingDir=CCW` |

Which one a given firmware accepts is not knowable from here, and picking wrong means **every
write silently fails on site**. `EncoderLink.write()` now tries the documented `set` form, and on
an explicit refusal retries once with the bare form, then remembers which dialect answered.

The retry is safe *specifically* because a refusal proves nothing reached flash — the encoder
answers `ERROR` instead of writing. It keys off the queue's `EENCODER` code rather than the
message text, and a **timeout is never retried**: there we do not know whether the write landed,
and repeating it could spend a second of the ~100,000 cycles. Four tests cover it.

### Out-of-band IP recovery: TCP port 4000

`Modification_IP-Address/` contains `hymon.exe` — `strings` identifies it as **"HyNetOS monitor,
version 2.2.1"**, the system monitor of the embedded OS the encoder runs on (Smart Network
Devices, whose copyright is on the Java client). It is invoked as
`hymon.exe 10.10.10.10 4000 log.txt`, and the IP is changed with **`set ip 198.100.100.54`** —
a *different* syntax on a *different* port from the application protocol on 6000.

So there are two command surfaces: the encoder application on **6000**, and the OS monitor on
**4000**. The latter is a plausible way to recover an encoder whose address has been lost without
the applet. **Unverified** — the document is dated 10/06 against a 2016 manual, so the monitor
may not be present on current firmware. Recorded as something to try, not something to build on.

### Also worth noting

POSITAL themselves present the command line as the remedy for the applet: *"This is particularly
useful in case of Java related issues, e.g. when the message 'Exception while opening stream with
IP…' is displayed."* That is the same failure the screenshots in this folder show, and the reason
this project exists.

## 2026-08-03 — Hardware validation, against a real encoder and a real disguise server

Test rig: encoder at **10.10.10.10**, disguise at **10.10.10.5**, this machine on `en3` at
10.10.10.2/24. The user confirmed the old `d3driver.exe` works on the same rig.

### The line terminator, settled at last

The one thing no manual, datasheet or vendor document states. Captured raw off the socket:

```
32 34 33 20 30 20 0a    "243 0 \n"
```

**Bare LF (0x0a). 111 lines in 2 s, zero CR anywhere** — and note the *trailing space* before the
terminator. Not CRLF, which is what the vendor's own Java client sends in the other direction.
The line assembler handled it with zero unparsed lines, as did the parser's handling of the
trailing space. The permissiveness was right, and is now evidenced rather than assumed.

### It works

`streaming`, **rx = tx, zero unparsed, zero errors**, 55 Hz, arrival gap p50 **18.11 ms** against
the encoder's reported `CycleTime=18`. Bridge latency p50 118 µs, p99 298 µs. The datagrams
reaching a disguise stand-in are `1:298575,0;\n` — asserted **byte-identical** to what
`d3driver.c`'s `snprintf` would have produced from the same sample.

### The per-destination error counters earned their keep

disguise's port was unknown. Rather than guess, both candidates were added as destinations:

| destination | result |
|---|---|
| 10.10.10.5:**6000** | clean |
| 10.10.10.5:8000 | `ECONNREFUSED` ×7 |

The connected UDP socket surfaces ICMP unreachable, so the right port was identified without
touching the disguise machine. This is exactly why the socket is connected rather than using
`sendto`, and why the counters are per destination rather than per link.

### Three things the hardware contradicted

1. **`OutputMode` returns `POSITION_VELOCITY`** — uppercase, single underscore — not the
   manual's `Position_Velocity_`. `parseOutputMode` already tokenised case-insensitively on
   non-alphabetic boundaries, so it happened to cope. Luck, but confirmed luck. `TimeMode`
   likewise answers `CYCLIC`, not `Cyclic`.

2. **`read Preset` answers `ERROR: Preset is an unknown variable.`** Preset is **write-only** on
   this firmware; the value it produces appears in `Offset`, which reads fine (43156). This made
   the duplicate-Preset guard inoperative, and put a spurious error in front of the operator on
   every "Read all". Preset is now marked `writeOnly`: it is skipped when reading everything, and
   `setPreset` detects the unreadable case and surfaces the encoder's own refusal rather than
   guessing.

3. **The encoder is scaled to 300 000 counts, not 33 554 432.** `TotalScaledRes` and
   `UsedScopeOfPhysRes` both read 300 000 — a commissioned unit is nothing like its nameplate.
   Every derived figure in the UI was computed from the type label, so the dial's "revolutions
   used of 4 096" was wrong by two orders of magnitude. The link now reads both on connect and
   derives `countsPerRev = physical/rev x (scaled / physical scope)`; telemetry carries the
   device's own values and the UI uses them. It now reads **36.62 revolutions of travel**, which
   is correct.

### Not yet done

- ~~Counts per revolution is unverified.~~ **Confirmed** — see below.
- **The disguise end is unconfirmed.** Packets arrive at 10.10.10.5:6000 with no ICMP errors, so
  something is listening, but whether a Navigator driver is bound to it and an axis is moving has
  not been seen.
- **No flash write has been attempted.** Nothing has been written to the encoder — every
  interaction so far has been read-only.

### Counts per revolution: confirmed

One hand-turned revolution, measured by `tools/shaft-check.js`:

```
travelled          8812 counts (clockwise)
that is            387.2deg at the claimed scaling
counts per turn    8812
encoder claims     8192
difference         +7.6% (620 counts)
direction changes  1 — the shaft was rocked, not turned cleanly
```

**8192 counts/rev confirmed.** The 7.6% is a 27° overshoot on a hand turn, and the ratio is the
evidence: 1.076. A genuine scaling fault — wrong resolution, an unmentioned gearbox, a mis-set
`UsedScopeOfPhysRes` — shows up as a whole multiple or a gear ratio, never a few percent. The
tool also caught the small rock-back at the end (8813 → 8812) as a direction change, which is
what makes the reading trustworthy rather than merely plausible.

This also exercised, on real hardware, the wrap-aware displacement maths and live position
tracking at 30 Hz.

## 2026-08-03 — Correction: the ~2 ms figure was overstated

The user challenged the claim that the encoder's internal cycle is 2 ms and that a lower
`CycleTime` buys nothing. They were right to. POSITAL give **three mutually inconsistent timing
figures** for this device:

| Source | Claim |
|---|---|
| manual §1.2, p.5 | *"If you directly connect the absolute encoder to a computer via a 100 Mbit network card, you will get a cycle time of **less than 2 ms**."* |
| manual FAQ 4, p.21 | *"Minimum sensor update time — The **internal sensor update time amounts ~2 ms**."* |
| datasheet | `Schnittstellen Zykluszeit: **>= 10 ms**` |

The ~2 ms came from FAQ 4, which is the **sensor sampling rate** — not a floor on `CycleTime`,
which is what it had been turned into. The two manual figures are reconcilable (you may transmit
faster than the sensor samples and simply resend a value), but *"a CycleTime below 2 ms buys
nothing"* was an inference presented as fact, and §1.2 advertises sub-2 ms operation outright.
The datasheet's >= 10 ms agrees with neither.

**Measured instead**, read-only, on the reference encoder: a `Run!` command round-trips in
**0.42 ms at best** (p50 2.88 ms, p90 3.09, max 3.62 over 200 samples). So the transport is
nowhere near the constraint, and the rig's `CycleTime=18` is entirely a configured choice.

The spread from 0.42 to 3.6 ms is *consistent with* a request waiting for the next internal
sample, which would put the internal period in the low single-digit milliseconds — but that is
an interpretation of 200 samples taken while a cyclic stream was also running, not a
measurement of the sensor. Establishing what a low `CycleTime` really delivers requires setting
one, which costs a flash cycle. Not done.

Corrected in three places, one of which mattered: the encoder-config screen showed the operator
*"the sensor itself only updates every ~2 ms — lower values add no new data"* as a warning. It
now flags the figure and its source without ruling on it.

**Flash writes remain off the table** at the user's direction — these chips have a finite write
budget and it is not ours to spend.

## 2026-08-03 — The variable table, against the manual and against the device

The user pointed at manual pages 4, 12, 13 and 19 and asked that the interface offer values the
encoder can actually take. Reading them carefully found four things, one of which was a live bug.

### The applet screenshot on page 13 is the most useful page in the manual

Rendered and read at last. POSITAL's own *Main Controller Site*, with a "Set" button per
parameter and the current value beside it — the same shape as our config screen. Two things it
settles outright:

- **`Preset/Offset` is a single row.** You write a Preset; the field beside it reads back the
  **Offset**. That is exactly what the hardware told us when `read Preset` answered "Preset is an
  unknown variable", and it confirms the `writeOnly` marking is right rather than a firmware
  quirk.
- **`CycleTime` is shown set to 1**, with the log beneath it reading *"Setting Cycle Time to
  1 ms" → "CycleTime=1" → "Parameters successfully written!"*. POSITAL's own documentation shows
  1 ms in use, which retires the last of my "~2 ms floor" claim.

The applet also labels the modes `COS` and `A_SHORT` — a third spelling, differing from both the
manual and the wire.

### The bug: TimeMode showed the wrong mode

The device answers `CYCLIC`; the dropdown offered `Cyclic`. Assigning an unmatched value to a
`<select>` silently leaves it blank, so the operator saw either nothing or the first option —
**wrong rather than absent**, on the screen that writes flash. `OutputType` and `CountingDir`
happened to match exactly, and the `OutputMode` checkboxes already lowercased both sides, so this
was the only one that bit.

Enum controls now resolve what they are given — case-insensitively, ignoring spaces and
underscores, with an alias table for `COS`. A value that resolves to nothing is flagged amber
with a tooltip naming what the encoder said, rather than being quietly rendered as something
plausible. The dirty-check compares normalised values, so `CYCLIC` against `Cyclic` is not an
edit.

### Ranges were 32-bit integer limits, not hardware limits

Manual §1.1 p.4: *"a maximum resolution of 65,536 steps per revolution (16 Bit) […] up to 16,384
revolutions (14 Bit). Therefore the largest resulting resolution is 30 Bit = 1,073,741,824
steps."*

The scaling variables were bounded at 4,294,967,295 — four times what any encoder in the family
can do. Now `MAX_RESOLUTION = 2^30`, with `Preset` and `Offset` one less as positions.
`CycleTime` was already correct at 1–999,999 ms (p.19).

### Counters outlived the configuration they described

Spotted while cleaning up: after removing a dead destination the link still reported 3,188 send
failures against a setup that had none, because `start()` reset uptime but nothing else. Three
thousand errors on a healthy link is exactly the sort of thing that gets chased at a venue
instead of the real fault. Counters now describe the current run.

### Verified on the encoder

`Read all` against 10.10.10.10 now shows OutputType `ASCII_SHORT`, OutputMode with Position and
Velocity ticked and Timestamp clear, **TimeMode resolving `CYCLIC` to Cyclic**, CycleTime 18 with
an "≈ 56 Hz" hint, scaling 300000/300000, CountingDir CW, Preset blank and skipped
("read 13 of 14 variables"), Offset 43156.

Eight new tests pin the table to the exact strings the device returned.

## 2026-08-03 — Following the encoder when somebody else changes it

While checking whether velocity was still hardcoded, the reference encoder began reporting
`rawVel: null` where it had reported `0`. The user had changed `OutputMode` from
`POSITION_VELOCITY` to `POSITION` and `CycleTime` from 18 to 8 **mid-session, from the applet** —
an unplanned test worth more than a designed one.

### What we got right, and what we did not

The encoder broadcasts to *every* connected TCP client, and not merely the reply: our log
contained the literal `set OutputMode=Position_` and `set CycleTime=8` the applet sent, and the
variable cache updated correctly. **And then nothing happened.** The parser kept the field map it
had read at connect time.

That time it was benign — the field that vanished was the last one, so position stayed in slot 0
and velocity became honestly "not sent". The general case is not. Lose `Position` from the front
of `OutputMode` and the next field is promoted into its place, so disguise is driven by a
timestamp while every screen still reads plausibly.

### Acted on now

| Variable | Effect when it changes |
|---|---|
| `OutputMode` | re-derives the parser's field map and announces it |
| `OutputType` | raises the BINARY warning if switched |
| `CycleTime` | moves the stall watchdog with it — at 8 ms a gap unremarkable at 18 looks like a stall, and at 18 a real stall goes unnoticed too long |
| `TotalScaledRes` / `UsedScopeOfPhysRes` | re-derives counts per revolution and the travel range |

Unchanged values are not announced; unparseable ones are ignored rather than applied. Seven tests
cover it, including the dangerous direction (`POSITION_VELOCITY` → `VELOCITY_TIMESTAMP`) where a
stale map silently reinterprets which number is the position.

**Verified on the encoder:** field map `[0]` against `OutputMode=POSITION`, arrival gap 8.12 ms
against `CycleTime=8`, `rawVel` reported as *not sent* rather than as a number, zero unparsed.

### Two faults in the test suite, found by the same change

The full suite hung. Both faults were mine, not the app's:

1. **Cleanup only ran on the happy path.** `encoder-link.test.js` tore down its spawned simulator
   at the end of each test, so a failing assertion orphaned the child process and the runner
   waited on it forever. Cleanup is now registered with `t.after()` the moment a resource exists.
2. **A race in the "nothing is sent after stop" assertion.** It sampled immediately after
   `stop()`, so a datagram already in flight counted as a leak. It now lets the queue drain first.

Node runs test files in parallel by default. These bind real sockets and spawn processes, so the
suite now runs with `--test-concurrency=1` — contention between files was what turned a latent
race into a failure.

### The answer to the question that started this

**Velocity is not hardcoded.** It is a per-connection policy: `zero` (the default, byte-identical
to `d3driver.c`), `passthrough` (the encoder's own signed steps/s), or `derived` (computed here
from position deltas, wrap-aware, smoothed over ~200 ms). The raw value is parsed and displayed
whatever the policy; only what is transmitted changes. The reference connection is on `zero`.

`passthrough` currently has nothing to pass through: with `OutputMode=POSITION` the encoder no
longer sends a velocity field. Comparing the encoder's own velocity against our derived one needs
Velocity switched back on.

## 2026-08-03 — Velocity should follow the encoder

Requirement, in the user's words: *"if i turn velocity off, the string to disguise should not
change, but should send 0. If i turn velocity on from the encoder i want that the string to
disguise also includes the velocity value."*

Both halves already held; neither was discoverable.

- **The string never changes shape.** `writePacket` always emits `id:pos,vel;` — the velocity
  field is never omitted, whatever occupies it. That is structural, not a policy decision.
- **`passthrough` already follows the encoder**: `r.vel === null ? 0 : r.vel`. When `OutputMode`
  omits Velocity the parser yields null and we send 0; when it includes Velocity we send the
  device's own signed steps/s.

What was missing was any way to know that. The control read "From encoder" with the tooltip
"Forward the encoder's signed steps/s", which reasonably suggests it might send *nothing* when
the encoder is not reporting velocity. It now explains itself in terms of what reaches disguise,
and the hint changes with the selection rather than describing only the default.

The reference connection is switched to `passthrough`. **`zero` remains the default** for new
connections: existing disguise projects derive velocity themselves via the axis
`velocitycalcmode`, and changing that silently would alter shows that currently work.

### Verified

On hardware, with the encoder on `OutputMode=POSITION` (velocity off), the datagrams reaching a
disguise stand-in are `1:52515,0;` — the shape unchanged, zero in the slot. The other half, the
encoder's own value being forwarded, is covered by tests but **not yet seen on hardware**: it
needs Velocity switched back on at the encoder, which is a flash write.

Six tests pin both halves, including the packet grammar under extreme values and the encoder
gaining or losing its velocity field mid-run — which needs no reconfiguration here, since the
live-reconfiguration handling added earlier re-derives the field map on the broadcast.

## 2026-08-03 — Stats tied to the connection that produced them

The user asked what "Faults 9 · errors + drops" on the dashboard meant. Every one of those faults
came from a local UDP sink used during hardware testing, which had been killed and restarted
repeatedly; the disguise destination had 46,729 packets and zero errors. But **they should not
have had to ask.**

A tile reading "Faults 9 · errors + drops" is an anonymous aggregate. With one connection it is
merely unhelpful; with five encoders it says nothing about which link is failing or why — the
same class of problem as the stale counters fixed earlier today, where 3,188 send errors were
attributed to a configuration that no longer existed.

### Faults now name what and where

The tile counts three unrelated things and used to sum them silently. They are tracked apart now,
because they call for opposite responses:

| Cause | Caption |
|---|---|
| UDP send failed | `cannot reach Real encoder → disguise` |
| errors from the encoder | `errors from <connection>` |
| unparsed lines | `unparsed lines from <connection>` |
| none | `none` |

Named by **connection and destination**, since with several encoders "cannot reach
10.10.10.5:6000" does not identify whose link is failing. A tooltip carries the full breakdown.

### Every summary figure has a per-connection counterpart

At the user's direction — *"all stats should be tied to each connection"* — the card gained
**Sent** (total packets out) and **Faults** (its own count, red when non-zero), taking it to six
metrics in three columns, folding to two at phone width. Nothing in the summary strip is now
unattributable: packets out, samples in, streaming and faults each have a per-card figure behind
them.

Verified on the rig: with the test sink removed the dashboard reads Faults 0 / "none", one link
streaming to disguise at 123 pkt/s — matching `CycleTime=8` — with 21,734 packets sent and no
faults. Layout clean at 1440, 860, 560 and 390 px.
