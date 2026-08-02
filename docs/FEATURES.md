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
| Desktop | `src/desktop/main.js` | Electron. **Still on the old IPC transport; the window moves onto HTTP with the tray work.** |
| Browser transport | `src/web/js/api.js` | Installs `window.d3d` over fetch + EventSource with the preload's exact surface, so no view needed changing. Inert if a preload already provided it. |

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
| `make-assets.js`, `make-icon.js` | Brand asset and app icon generation. |

### Installers

macOS dmg (arm64, x64) and Windows portable exe + NSIS installer. Both platforms build from an
Apple Silicon Mac; the Windows target does **not** require wine. Not yet re-established after
the rename — `electron-builder.yml`, the icon and the brand assets are still to be carried
across, and the generated assets were never committed, so a clean checkout cannot package yet.

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
