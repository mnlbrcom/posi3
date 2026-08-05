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
| Instance lock | `src/core/instance-lock.js` | One bridge per profile, across every entry point. Electron's own lock only stops a second *desktop* copy; this also stops a headless one running alongside it. |
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
| `desktopcheck.js` | Drives the real Electron window. Clicks at element coordinates rather than through `element.click()`, so the page's own hit-testing is exercised, and computes every interactive control's effective `-webkit-app-region` from the live window — a control that inherits `drag` is unclickable in the desktop app and fine in a browser. 12 checks, non-zero exit on the first failure. `npm run desktopcheck`. |
| `cdp.js` | Shared DevTools-protocol client for `uicheck` and `desktopcheck` — connect, send, wait for the endpoint. Node's built-in WebSocket, no dependencies. |
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

## 2026-08-03 — Velocity on the wire, and a caveat about it

The last piece of hardware evidence: the encoder's own velocity reaching disguise, captured
byte-for-byte while the user turned the shaft.

```
1:76698,-6010;
1:76539,-7600;
1:76377,-9156;
1:76064,-11674;
```

Position falling, velocity negative. **1,747 of 2,216 datagrams carried a non-zero velocity**,
spanning −18,242 .. +23,819 steps/s — a peak of 174.5 rpm — in both directions. `passthrough`
forwards the device's figure unchanged and the packet grammar never varies.

### The caveat

Cross-checking the encoder's velocity against the rate implied by consecutive positions (at
`CycleTime=8`, so ~8 ms apart) over 772 moving samples:

| | |
|---|---|
| sign agreement | **755/772 = 97.8 %** |
| derived from position | −33,375 .. +38,375 steps/s |
| encoder reported | −18,242 .. +23,819 steps/s |
| median ratio, encoder ÷ derived | **0.60** |

**Direction is confirmed. Magnitude is not.** The encoder consistently reports around 60 % of the
instantaneous rate the position deltas imply. The most likely explanation is that the device
smooths its velocity estimate over some window, so a hand-turn full of acceleration reads lower
at the peaks than raw deltas do — but a single hand-turned capture cannot distinguish smoothing
from a scaling difference, and no POSITAL document states how the figure is computed.

**Worth knowing before driving anything from it.** If velocity accuracy matters more than
provenance, `derived` may be the better choice than `passthrough`: it is computed here from the
same positions actually being transmitted, so it is self-consistent with what disguise receives.
`zero` — the default — sidesteps the question entirely by letting disguise derive velocity itself
via the axis `velocitycalcmode`.

Establishing which is right needs a constant-speed drive rather than a hand-turn. Not attempted.

## 2026-08-03 — A dead destination should be said once, not shouted forever

The user reported *"LOTS of errors — Real encoder: UDP to 127.0.0.1:6001 failed (3000x):
recvmsg ECONNREFUSED"*. The destination was a local tap added for the velocity capture and since
removed, so the underlying condition was self-inflicted and already gone. **The reporting was
not.**

A dead destination fails once per sample. The rule was `txErrors === 1 || txErrors % 500 === 0`,
which at the rig's 125 Hz is a warning **every four seconds, indefinitely**, about a situation
that has not changed. That is worse than saying nothing: a channel that cries constantly is one
nobody reads, and it buries the events that do matter.

Now:

- **Announced once, then backing off** — 15 s, 60 s, 240 s, then every 15 minutes. Time-based,
  so the cadence does not depend on the sample rate.
- **The message says what and how much**: *"Cannot reach disguise (10.10.10.5:6000):
  ECONNREFUSED. 412 packets lost so far."* rather than a bare failure count.
- **Recovery is reported too.** Without it, a destination that came back left its last warning as
  the most recent thing anyone had been told. A second outage re-arms the notice, so a flapping
  destination is not silently recovered.

The success callback is only installed once a failure has been seen, so the healthy path keeps a
bare callback with nothing extra to do per packet.

Four tests, including the case that prompted it: 1,500 consecutive failures must produce exactly
one warning while still counting every loss.

**Live rig unaffected:** 125 Hz in and out — matching `CycleTime=8` — one destination, zero
faults.

## 2026-08-03 — The titlebar, and two bugs it uncovered

Brief: make the wordmark dominant, nerdier, in anthracite and satin blacks and white; set
DISGUISE in caps; replace the arrow with an ×; drop the duplicate wordmark in the rail.

### The mark

Monospace, because this app's world is instrumentation — type labels stamped on housings,
counts, fixed-width numerics — and that is where the "geeky" register actually lives for this
audience, rather than in a generic terminal motif. The name is itself a mashup of POSITAL and
d3, so the mark shows the seam: **`posi` set as a nameplate, the `3` as an inverted die.**
Strictly white on anthracite. The die is the one bold move and nothing else in the chrome
competes with it.

`POSITAL IXARC × DISGUISE`. The **×** is a crosspoint, the patching vernacular this audience
already reads, and it says junction where an arrow said one-way pipe — which is wrong for a
bridge. Dimmed names, brighter ×, so the join reads as the product without becoming an accent
colour.

Also fixed: the titlebar reserved 78 px for macOS traffic lights unconditionally, so in a
browser tab the wordmark was pushed off the left edge by dead space. Reserved now only in the
Electron window on macOS.

### Two bugs found while checking it in the desktop app

1. **The port fallback never worked.** `const port = opts.port || 8710` turns the `0` that means
   "any free port" into the default, so the fall-back path retried the very port it had just
   found busy. A documented feature that had never once run. The reported URL was wrong too — it
   used the requested port, printing `http://127.0.0.1:0`.
2. **`fatal()` died silently.** It only tried a dialog, so when the dialog was unavailable the
   process exited with an empty log and nothing to diagnose — the worst failure mode for an app
   with no console. It now writes the stack to stderr and to `posi3.log` first.

### One bridge per profile

The user asked whether the desktop app and the web UI are separate instances. **They are not** —
the window loads the app's own HTTP server, so there is one bridge, one set of sockets, one
config, and a browser on the LAN sees exactly what the window sees.

But the question exposed a real hazard. Electron's single-instance lock only stops a second
*desktop* copy; a headless `bin/posi3.js` could run alongside one, which is what had been
happening all session. The visible symptom is a port clash. **The real risk is two bridges
opening rival TCP sockets to the same encoder — which accepts only a handful of clients — and
both driving one disguise axis**, which looks fine on screen.

So the lock now lives with the profile rather than the window, and covers every entry point.
A live holder is refused with its interface named; a stale lock from a dead process is taken
over; `--force` overrides; the desktop app offers to open the running instance rather than
appearing to fail to launch. The same process may re-claim its own lock, because the port
fallback calls `startService` twice.

Eight tests, plus five on the port binding. **142 pass.** Verified on the rig: the desktop app
holds the lock and streams to disguise at 120 pkt/s with zero faults.

## 2026-08-03 — The narrow-width nav (first attempt, superseded below)

The user reported a scrollbar on the navigation once the window narrows, and asked for a
dropdown — *"as it should be for proper framework adaptation / adaptive design"*. Correct on both
counts: a horizontally scrolling nav hides its own contents behind a gesture and gives no sign
that anything is off-screen. It is a workaround, not an adaptation.

Below the rail breakpoint the six buttons now give way to a **native `<select>`**, labelled
`SCREEN`, spanning the bar. Native rather than a bespoke menu, deliberately: the platform then
supplies the right affordance for the device — a proper picker on a phone rather than a tap
target the size of a line of text — and it is keyboard- and screen-reader-correct without any of
that being re-implemented. It also needs no positioning logic, which matters given the project
rule against CSS anchor positioning and the `popover` attribute.

The rail and the picker are the same six routes; only one is ever visible, and `renderView` keeps
both showing the same thing. `detail` is reached from the connections list rather than the nav,
so it displays as Connections in both — previously that was special-cased for the rail only.

Verified with real device-metrics emulation rather than by resizing an element (media queries
answer to the viewport, so the latter proves nothing): at 1440 px the rail is `flex` and the
picker `none`; at 720 and 390 px the reverse; **the sidebar scrolls sideways at no width**.
Choosing Settings in the picker navigates there, and routing to Log from elsewhere moves the
picker — the sync runs both ways.

Also fixed in `tools/uicheck.js`: `--eval` did not set `awaitPromise`, so an async expression
serialised as the empty object a pending Promise becomes, and an exception was reported as no
output at all. Both now surface.

`test/layout-invariants.test.js` gained a guard so the scrolling strip cannot come back.

## 2026-08-03 — One nav, two placements

The select-bar was rejected: *"i dont like the design for the narrow menu, also dont like the
second rail."* Correct — it fixed the scrolling but kept the mistake underneath it. Both attempts
put a **second strip of chrome** below the titlebar, and a bar that exists only to hold one
control is worse than the control being somewhere it already belongs.

**The rail is now the menu.** Below the breakpoint it becomes a panel hanging from a toggle in
the titlebar's top-right corner, keeping exactly the layout it has when there is room for it —
same rows, same dots, same active mark with its accent bar. One nav to style, one to maintain,
and nothing new to learn: the wide layout *is* the narrow one, relocated.

- **Three bars**, the one nav affordance nobody has to be taught. Open, they become a cross, so
  the control says how to undo itself — one element and its two pseudo-elements, no icon assets.
- Dismissed by choosing something, by Escape (which returns focus to the toggle), by a pointer
  anywhere outside, and by widening past the breakpoint — a panel left open would otherwise be an
  orphaned overlay on top of the returning rail.
- `aria-expanded` and `aria-controls` on the toggle; the panel is out of flow, so the content
  pane keeps the full width.
- The panel's right edge is flush with the toggle's, both inside the titlebar's 14 px padding.
  Verified rather than eyeballed: 376 px at both 390 and 720, exactly aligned.

The layout invariant test now asserts the select approach is **gone rather than merely hidden** —
and immediately caught a leftover `.nav-picker select` rule that had survived the rewrite.

**143 tests pass.** Layout clean across six views and six widths; the rail is untouched at 1440.

### The menu was dead in the desktop window

Reported straight after: the toggle did nothing in a narrow Electron window, while working in a
browser.

The titlebar carries `-webkit-app-region: drag` so the desktop window can be moved by it, and
**a drag region swallows mouse events on everything inside it**. A browser ignores the property
entirely, so the button worked there and was inert in the app. Any control placed in the titlebar
needs `-webkit-app-region: no-drag`.

What made this slip through is worth recording: every test of the menu so far used
`element.click()`, which dispatches straight at the node and never goes through hit-testing — so
it passes whether or not the region is swallowing input.

The fix was confirmed by hand in the app: the menu opens, `aria-expanded` flips, the browser is
unaffected. A layout invariant also asserts that a titlebar control opts out of the drag region.

*(A synthetic mouse event over CDP was used at the time as corroboration. It was later shown not
to prove anything here — see the next entry.)*

## 2026-08-03 — A test that actually catches the dead-button bug

> "make sure testing adds this, so we dont run into it again"

The drag-region fix was already in, guarded by a stylesheet assertion. The ask was for the
failure itself to be caught, not just the one line that happened to fix it — so this adds
**`tools/desktopcheck.js`** (`npm run desktopcheck`), which launches the real Electron app under
its own temporary profile and drives the real window. The DevTools client both tools were growing
independently moved to **`tools/cdp.js`**.

### The first attempt did not work, and finding that out is the point

It sent real mouse events at element coordinates — the same technique used to corroborate the
original fix — and passed 11 checks. Then the fix was deleted from the stylesheet to confirm the
new check would fail without it.

**It still passed.** All 11.

A drag region is enforced in the browser process, above the renderer, as part of deciding what
counts as window caption. CDP's `Input.dispatchMouseEvent` is delivered **into the renderer**, so
it arrives below where the region is applied and lands whether or not a real click would. A
synthetic click is structurally incapable of seeing this bug. That also retires the corroboration
claimed in the previous entry: that click would have succeeded either way.

### What does work

`-webkit-app-region` is readable through `getComputedStyle` in Electron and **is not inherited**,
so a control's effective region is the nearest ancestor-or-self that sets one. The check walks
every interactive element on the page at both a narrow and a wide viewport — with the menu open,
so its items are in the tree — resolves each one's effective region, and fails on any that
resolves to `drag`, naming the element.

Read from the running window, not matched against a stylesheet, so it catches a control that
inherits a drag region from somewhere the regex in `test/layout-invariants.test.js` never looks.
The two are a deliberate pair: the stylesheet test is fast, needs no Electron and runs in
`npm test`; this one is thorough and runs in its own CI job.

**Verified both ways.** With the fix: 12 of 12 pass. With `.nav-toggle { -webkit-app-region:
no-drag; }` deleted: `no interactive control sits inside a drag region — nav-toggle @420px`.

### Also in this change

- The coordinate-clicking half is kept and still earns its place — it catches overlays, stacking
  and zero-size targets that `element.click()` cannot. Its documentation no longer claims it
  catches drag regions.
- One check asserted header buttons on the Log view, which has none. It navigates to the
  dashboard first.
- A `desktop` CI job runs it under `xvfb-run`, with a full `npm ci` because electron's
  postinstall fetches the binary. `--no-sandbox` is passed only when `CI` is set — the runners
  have no user namespaces for it, a developer's machine does.

**144 tests pass; 12 desktop checks pass.**

## 2026-08-03 — A stray test window, and why the lock did not stop it

> "there is an instance open that is not seeing our connection, how is this possible, i thought
> all instances now look at the same server?"

A second desktop window was on screen with an empty connection list. The instance lock was
working correctly; the window was left behind by the desktop check.

**Why the lock let it through, by design.** The lock is *per profile*, because what it exists to
prevent is two bridges opening rival TCP sockets to the same encoder from the same configuration.
`tools/desktopcheck.js` deliberately runs under its own throwaway `--user-data-dir` so it cannot
disturb a running bridge — different profile, so no contention, so no lock, and its own port. The
isolation did exactly what it was written to do.

**Why the window survived anyway — a real bug in the tool.** It spawned
`node_modules/.bin/electron`, which is a Node *shim* that launches Electron as its own child.
`child.kill()` therefore killed the shim and left the app running. It now resolves the binary
through `require('electron')`, which returns the executable path directly, so the signal reaches
Electron itself. Added with it: a `SIGKILL` follow-up if it does not exit within two seconds, and
reapers on `exit` and `SIGINT` so Ctrl-C takes the window too.

**Verified:** run the check with the real app open — 12 checks pass, and afterwards only the real
app's process group remains.

The confusing part is that the two windows are indistinguishable on screen. Worth considering
later: show the profile path or port somewhere in the window when it is not the default.

## 2026-08-03 — A window stuck at a test width

> "the desktop window is see now is still half shrinked where the outline is big but the content
> is squeezed."

Same cause as the stray window, different mechanism. Reproducing the narrow-window menu bug meant
attaching to the *running* desktop app over its debug port and calling
`Emulation.setDeviceMetricsOverride` to force a 420px viewport. That was never released.

**The override outlives the client that set it, and only that session can clear it.** Measured on
the live window: viewport `420x760` inside a real frame of `1180x780` — the frame is genuine, the
page inside it is pinned. Connecting fresh and calling `clearDeviceMetricsOverride` does nothing,
because the new session never owned an override. What works is re-asserting one in the new session
at the window's real size and then clearing it, which is what was done: back to `1180x780`, rail
`static`, toggle hidden. No restart, so the live connection was never dropped.

`tools/desktopcheck.js` now clears its own override in the `finally` block rather than relying on
disconnection to do it.

**Worth remembering when debugging the running app**: a viewport override, a CPU or network
throttle, and a forced colour scheme all survive the debugging session that set them. Anything set
on the app the user is actually using has to be unset explicitly.

## 2026-08-03 — Cmd+R now rescues a stuck viewport

> "can this be coded, so it resets with reload cmd+r ?"

Yes, and it is — but not the way it first looked, so the failed attempts are worth recording.

`Cmd+R` was already a plain `role: 'reload'`; the earlier collision with "start all connections"
was resolved to `Cmd+Shift+R` when the menu was built, so there was nothing to untangle. The work
was making a reload actually release the override.

**Two obvious approaches do not work, both measured rather than reasoned about:**

| Attempt | Result |
|---|---|
| `webContents.disableDeviceEmulation()` on `did-start-loading` | reload → still 420px. Different mechanism; the override is re-applied when the document commits. |
| the same call on `did-finish-load` | reload → still 420px. Not a race — it simply does not reach a CDP-set override. |
| a later client sending `clearDeviceMetricsOverride` | no-op. A session cannot clear an override it does not own. |

**What works is taking ownership first.** `releaseStuckEmulation()` in `src/desktop/main.js`
attaches the app's own debugger, sets an override at the window's real content size, clears it in
that same session, and detaches. It runs after every load, so `Cmd+R` is the cure.

It only acts when something is actually wrong: it compares `innerWidth` against the content size
**divided by the zoom factor**, because zoom legitimately divorces the two and must not look like
a fault, and it stands down entirely if a debugger is already attached — that override belongs to
whoever is using it.

### Reproducing it honestly

The first regression attempt did not reproduce the bug. Closing a DevTools client *cleanly*
releases its override, so a test that connects, overrides and disconnects proves nothing. The real
case is a client that **dies without detaching**, which is what happened here. The check therefore
spawns a real child process to set the override and `SIGKILL`s it, and asserts the reproduction
before asserting the fix — an override that quietly stopped surviving would otherwise turn the
whole check green for the wrong reason.

**Verified both ways.** With the fix: 14 of 14 desktop checks pass, `420px -> 1180px`. With the
`did-finish-load` hook removed: `a reload releases a viewport left emulated — 420px -> 420px`.

**144 tests pass.**

## 2026-08-03 — Cmd+R reloads the UI and nothing else, now proven

> "lets restart it, and make sure that cmd+r only reloads UI not server or connections or anything
> running in operations."

**It does, and the architecture always intended it to** — the bridge lives in the main process and
the page is an ordinary HTTP client of it. Two things were checked before trusting that: auto-start
runs in `startService()` at app start, not on page load (the plan's M1 moved it off
`did-finish-load` for exactly this reason), and the only load-time hook now is
`releaseStuckEmulation`. Nothing in the UI's init stops or starts anything.

Restarted on the rig: the stale lock from the previous process was correctly taken over, auto-start
reconnected, and the Revolve link came back streaming with 0 errors and 0 reconnects.

### The check that proved it was wrong twice first

This is the part worth keeping. A check that reloads and then asserts the connection survived is
easy to write and easy to get wrong, and both wrong versions were green.

**First version — measured the wrong page.** It called `location.reload()`, slept 3.5 s, then read
the counters. But `location.reload()` returns immediately and the load can outlast any guessed
delay, so the snapshot was sometimes taken before the reload had even happened. Replaced with
`reloadAndWait()`, which marks the current document and waits for the mark to disappear — proof the
swap actually occurred.

**Second version — asserted the wrong property.** It required uptime and `rxTotal` to have *gone
up*. They always do. A link that is torn down and rebuilt also has bigger numbers a few seconds
later than a link that was half a second old at the baseline. The assertion was satisfied by both
outcomes.

The fix is to assert **continuity rather than magnitude**: a link that ran straight through has an
uptime that advanced by exactly the wall time that elapsed. So the check now lets the link build
more than 5 s of history first, records wall time across the reload, and requires
`|Δuptime − elapsed| < 1500 ms`. A restart makes Δuptime go *negative*, which no amount of waiting
disguises.

**Both wrong versions were caught by a negative control** — patching `did-finish-load` to call
`stopAll(); startAll()` and requiring the check to fail. It passed both times, which is the only
reason the flaws were found. Instrumenting the manager settled it: the control was working exactly
as intended (`streaming → idle → connecting`, `rx` reset to 0) and the check simply could not see
it. A test that cannot fail is not evidence.

**Verified both ways.** Normal: `uptime advanced 1.5s over 1.3s wall, rx 2387 -> 2690`. With the
negative control: `uptime advanced -10.3s over 1.3s wall — the clock restarted, so the link did,
rx 2366 -> 311`, failing 2 checks.

**144 tests pass; 18 desktop checks pass.**

## 2026-08-03 — One dashboard, not two

> "i feel like we have two dashboards, one real dashboard and one when you cklick on the
> connection… move the ring, the Livevalues to the dashboard and make it one with the streaming
> information for each encoder."

Correct, and the split was worse than redundant: neither screen could answer a question on its own.
The dashboard had position, rates and faults but no dial and no raw/sent velocity; the detail page
had the dial and the full readouts but no fault summary and no view of the other encoders.

**The dashboard is now one card per encoder, one per row, always expanded** — dial, live values and
stream health side by side, nothing behind a click. Chosen over an expand-on-click card because
this is a screen left open all show; a value you have to open a disclosure to see is a value you do
not check.

The old two-up card grid is why the dial lived elsewhere in the first place: at ~370px there is no
room for a dial *and* a column of figures, so the figures had to go to another screen. One card per
row removes that constraint.

### Kept separate inside one envelope

First attempt merged the three groups into a single flat area. Corrected on the spot — the dial and
the readouts had been distinct panels and reading them as one block is worse. Each group is now its
own recessed pane (`.encoder-pane`) inside the card: **recessed** rather than raised because the
card is already a raised surface, so an inset panel reads as "inside this encoder" instead of
competing with the card's own edge.

The dial also came back at the size it had on its own page — the 340px column from `.grid-2`,
not the 260px the first pass gave it.

### The detail page is now a controls page

What is left there is what you *do* to a connection: Zero/Preset, Run!, velocity policy, coalesce
policy, and the links onward to encoder config, mapping and log. Keeping it separate keeps a
flash-write button off the screen that is open all show. Its Back button now goes to the dashboard,
and its Start/Stop button finally tracks the link state instead of showing whatever it was when the
page opened.

### Two CSS faults worth recording

**Source order beat the media queries.** The responsive rules for `.encoder-cols` were written
*above* the base rule, so at every width the base won and the card stayed three columns — measured
as `grid-template-columns: 260px 22px 22px` at 390px. Same-specificity rules are decided by source
order; the media queries now sit after the rule they override.

**A fixed label column will not shrink.** `.readouts` used `132px 1fr`, and `1fr` still refuses to
go below its content, so wide figures pushed the list out of its pane at 860px and below. Now
`minmax(0, 1fr)` throughout, with a narrower label column inside cards.

Also fixed: `.spacer` was only defined under `.view-head` and `.panel-head`, so the Controls button
sat against the pill instead of the card's right edge.

**Verified:** layout audit clean across 6 widths × 7 views against the live rig; 144 tests and 18
desktop checks pass.

## 2026-08-03 — Breaking earlier, and the trace where it belongs

> "there is a breakpoint for the adaptive jump, right before text overflows into the wrong areas,
> the point needs to be earlier and the min width of live values and stream needs to be wider. Also
> move the position graph last 12s into the steam card." / "and size all cards to content"

**Breakpoints moved earlier: 1080px → 1280px for three columns to two, 720px → 900px for two to
one.** The previous values were derived from where the layout *breaks*, which is the wrong test: a
layout that changes shape at the exact moment its text starts crowding reads as a fault rather than
as adapting. Both now change while there is still slack.

**The figure columns carry a real minimum**, `minmax(300px, 1fr)` rather than `minmax(0, 1fr)` —
below roughly 300px the right-aligned values start closing on their labels. The minimum is a
guard, not the mechanism: the breakpoints are set so it is never actually reached.

**The position trace moved into the Stream pane.** It answers the same question as the figures
above it — is data still arriving — drawn instead of counted, so a separate full-width strip for it
was a third answer to a question already asked. Separated by a rule inside the pane rather than by
a pane of its own.

**Panes size to their content** (`align-items: start`, not `stretch`). Stretching gave every pane
the dial's height, so the figure lists carried a block of dead space under them.

**Verified:** layout audit clean at 1440, 1360, 1300, 1280, 1024, 940, 900, 860, 720, 480 and 390
against the live rig, and across all seven views at the standard widths. 144 tests and 18 desktop
checks pass.

## 2026-08-03 — The dashboard header as one object

> "give the dashboard top items packets out, steaming 1 of 1, smaples per second, faults one tile
> with same sized cards all similar size text and cleaner look with dashboard headline, include the
> Start all and stop all."

The top of the screen was three stacked bands: a bare heading with two buttons, a hero panel, and a
row of tiles. **All of it is now one panel** — title, Start all / Stop all, and four equal tiles.

The hero is gone. Its 46px figure made "packets out" look like a different *class* of fact from the
other three, and it is not: all four are totals across every encoder, so they are now the same size
(28px) in the same tile, in four equal columns rather than `auto-fit`. Unequal tiles would imply a
ranking that does not exist.

The tiles use the same recessed treatment as the panes inside an encoder card — inset on a raised
panel — so the two objects on the screen are built from the same parts.

`view-head` is kept as the class on the header row so it behaves like every other screen's header
and stays covered by the desktop check; only its spacing differs inside the panel.

### A third source-order collision, same shape as the last

`@media (max-width: 480px)` still carried `.summary-stats { grid-template-columns: repeat(2, …) }`
from the old layout, and it sits *after* the new `@media (max-width: 460px)` single-column rule, so
it won at 390px and the tiles stayed two-up. Removed. Cleaned out with it: `.hero`, `.hero-value`,
`.hero-note`, `.hero-label`, `.card-pos` and `.dash-grid`, all orphaned by this and the previous
change, plus a `.readouts { 110px 1fr }` narrow-width override that would have undone the
`minmax(0, 1fr)` shrink fix below 560px.

**Verified:** layout audit clean at 1440, 1300, 1024, 900, 720, 480 and 390, and across all seven
views. 144 tests and 18 desktop checks pass.

## 2026-08-03 — A type scale, and a rule about when to reach for one

> "we need to fix fonts, there are no good guidlines… Make sure its the same font everywhere, only
> change font when it makes sense… If thinks need to be more or less dominant, change the colour or
> use bold, not nessesary size changes… let's try to stick to roughly 3-4 sizes."

The audit found **66 `font-size` declarations across 15 distinct sizes**: 9.5, 10, 10.5, 11, 11.5,
12, 12.5, 13, 13.5, 14, 15, 16, 17, 19 and 28px. Most of them half a pixel apart. That is not a
scale, it is the absence of one — each size was chosen at the point of use and never compared with
its neighbours.

### The scale

Four text sizes and one figure size, as tokens in `:root`:

| token | size | for |
|---|---|---|
| `--fs-title` | 17px | one per screen: the view headline |
| `--fs-head` | 14px | panel heads, card names, and the figures they exist to show |
| `--fs-body` | 12.5px | default — prose, buttons, inputs, table cells |
| `--fs-label` | 11px | uppercase labels, captions, hints, status meta |
| `--fs-figure` | 28px | the dashboard totals only |

**Emphasis is carried by weight and colour, not by size.** The clearest case was the Position
readout, which was 19px purely so it would stand out among 14px figures. It is now `--fs-head` at
weight 600 — still the loudest thing in its list, without inventing a size for it. `.panel-head`
and `.card-name` moved the other way: they were written at body size but are subheadings, so they
take `--fs-head`.

The responsive step-down at 480px used to be `.view-head h1 { font-size: 16px }`. It now redefines
`--fs-title` inside the media query, so it applies to the whole top of the scale rather than to one
selector that happened to be remembered.

**Two families, each with a job**, which is the only font change that makes sense here: `--sans`
for anything read as language, `--mono` for anything read as data — figures, addresses, variable
names, log lines.

### Kept out of the scale, deliberately

`dial.js` sets font sizes in **viewBox units, not CSS pixels** — they scale with the dial as its
column resizes, so tying them to a pixel scale would be wrong. Noted in the file so it does not
look like an oversight.

### Two guards

`npm test` now fails if a font size is written directly as a number anywhere in the stylesheet, if
the scale grows beyond five tokens, or if any `font-family` names a family outside `--sans` and
`--mono`. Four inline `font-size` values set from JS were replaced with classes, so there is one
place where type is decided.

Also fixed while sweeping: the log's direction column carried `padding-top: 2px` to optically
centre 9.5px text against 11.5px text. Both are `--fs-label` now, so the nudge was making it sit
low; removed.

**Verified:** layout audit clean across all seven views at six widths against the live rig; 146
tests and 18 desktop checks pass.

## 2026-08-03 — Away from mono, and the menu nobody had ever measured

> "the numbers in the ring or Live Values still show a different font, right?" / "can we go away
> from mono ?" / "also did you rund this againt the menu ?"

Measured first rather than answered from the stylesheet. The ring and the Live values **agreed** —
both mono, and `var()` does resolve inside SVG presentation attributes, which had been an open
question. The odd one out was the four dashboard totals, still set in the prose face.

### Mono is now only for machine language

`font-variant-numeric: tabular-nums` gives the prose face fixed-width digits, and that is the only
thing mono was really providing for a readout that repaints thirty times a second. So **every
figure moved to `--sans`**: the totals, the live values, the dial, the throughput line, the route
and target addresses.

`--mono` is now reserved for text that *is* machine language and would be misread without it: log
lines, raw commands, encoder variable names and the literal values read back from the device, and
the disguise field keys meant to be copied. Plus the wordmark, which is a logo.

**The digit separator had to change with it.** It was U+2009 THIN SPACE, which in a monospaced font
hardly mattered — the glyph still occupied a full cell. In the proportional face the grouping all
but vanished and `94 952` read as one blob. It is now **U+2007 FIGURE SPACE**, the width of a digit
in a tabular face, and non-breaking so a figure never wraps mid-number.

### Two guards, because a stylesheet test cannot see this

`.nav-toggle` computed to **Arial 13.33px**. Every rule in the file looked right; the button simply
set no family, and a form control does not inherit the page's font — it falls back to the user
agent's. Invisible on a button with no text, obvious the moment someone adds a select. Fixed at the
class level with `button, input, select, textarea { font-family: inherit }`, which also cleared
**42 checkbox instances** flagged across the views.

That fault is undetectable by reading the CSS, so `uicheck` now resolves the **computed** family of
every visible element and fails on anything outside the two stacks. `npm test` gained a companion
assertion that the figure selectors all declare `tabular-nums`, since moving them off mono removed
what was keeping their digits from jittering.

### The menu had never been audited

Correct, and worse than not run: below the rail breakpoint the nav is `display: none` until opened,
and an element with no box is invisible to the audit — so it had been silently skipped at every
width in every run to date, while appearing to pass. `uicheck` now opens it when the toggle is
present and labels those runs `+ menu`. Clean at 720, 480 and 390 across all seven views.

**Verified:** 147 tests, 18 desktop checks, layout and font audit clean across seven views at six
widths with the menu open.

## 2026-08-03 — Four sizes, no exception

> "whats the font size of the Dashbaord Headline and whats the font size of the Packets out
> number?" / "yes lets drop it."

Measured on the live page rather than read off the stylesheet: the headline was **17px** and the
totals **28px**, so a live value was 11px larger than the title above it.

`--fs-figure` existed for one claim — that the four totals should be readable from across a room —
and it was the scale's only exception. It is gone. **The totals sit at `--fs-title` with weight
600**, which leaves the scale at four sizes and nothing outside it:

| token | size |
|---|---|
| `--fs-title` | 17px — the view headline, and the dashboard totals |
| `--fs-head` | 14px — panel heads, card names, and the figures they exist for |
| `--fs-body` | 12.5px — prose, buttons, inputs, table cells |
| `--fs-label` | 11px — labels, captions, hints, status meta |

The header reads as one object now instead of a title with four louder numbers under it. The guard
in `npm test` was tightened from "3 to 5 sizes" to **3 to 4**, so the fifth cannot come back
without the test saying so.

**Verified:** 147 tests, 18 desktop checks, layout and font audit clean across seven views at six
widths with the menu open.

## 2026-08-03 — The dial key, and a travel bar that was being lied to

> "under the 360° dial, there is text … whats that size? and can we make this more clear, hard to
> understand what it explains." / "the bar doesn't work, right?" / "all the reflective values need
> to know that input and range has varible dependencies from user input how the encode is set"

### The key

11px, `--fs-label`. Size was not the problem: it read
`outer: angle · inner: revolutions used · bar: mapped range` — three things named, none of them
pointed at, so the reader had to work out which ring was which.

Each row now carries a chip shaped and coloured like the thing it describes: concentric rings for
the two arcs, accent for the outer and muted for the inner exactly as they are drawn, a short bar
for the bar. Wording in plain terms — "Angle within this turn", "Revolutions used of the total",
"Position in the range sent to disguise".

### The bar was not broken; it was given the wrong range

Measured before touching anything: the fill was **2px of a 314px track, 0.62%**, at a position
that is about 70% of the encoder's travel.

`inputSpan()` in `src/shared/mapping.js` **ignores** the stored `minInput`/`maxInput` when the mode
is `full` and derives `0 … totalCounts-1` from the device's own scaling, so the mapping helper had
been right all along. The dashboard read `conn.mapping.maxInput` directly instead, and that field
still held **33 554 431** — the nameplate default written when the connection was created, before
the encoder had ever been read. The device is commissioned to **300 000**.

Rather than write the rule a second time, `src/web/js/mapping-span.js` now carries `inputSpan` for
the browser — which cannot import the shared module, since it is CommonJS and is not served — and
**`test/mapping-span.test.js` runs identical cases through both copies** and fails if they ever
disagree. Two copies of one rule is exactly what caused this; the test is what makes the second
copy safe.

### The readings say what they are derived from

Angle, revolution and speed are not properties of the encoder. They are computed from its scaling,
which the user sets through `UsedScopeOfPhysRes` and `TotalScaledRes`; the travel bar depends on a
second, independent choice, the mapping mode. The machinery for following those already worked —
a broadcast recomputes `countsPerRev`/`totalCounts` and every frame derives from them — but nothing
on screen said so, which invites reading the numbers as absolute.

Two lines under the key now state the basis and repaint with everything else:

    Encoder scaling: 8 192/turn · 300 000 total · 36.62 turns
    Range to disguise: full travel · 0 – 299 999

with hover text naming the variables each comes from. Change the scaling on the device and both
follow within a frame.

**Verified:** on the rig, the bar tracks at ~70% for position 208 843 of 299 999. 149 tests, 18
desktop checks, layout and font audit clean across seven views at six widths.

## 2026-08-03 — Controls becomes a dialog, and the card gets Edit

> "the controls button looks diffrent then the Start all and stop all buttons, Change the controls
> button to look the same and also add a edit button that goes to the edit pop up. Also the controls
> page should be a similar popup as edits and add connection."

**Controls now uses `btn`, the same class as Start all and Stop all.** It was `btn sm ghost`, which
read as a link rather than an action — and it is the same kind of thing as the buttons beside it.
**Edit** sits next to it and opens `openEditor(conn)`, the same dialog the connections list uses;
there is now one editor, reachable from either screen.

**The controls page is a dialog.** It was a destination, which was always slightly wrong: nothing
on it is worth navigating to and staying at, and returning from it needed a Back button that had to
guess where you came from. As a dialog it matches Add and Edit, opens over whatever you were
looking at, and its "go to" buttons close it before navigating rather than leaving a dialog
stranded over a screen you just asked for.

`detail` is no longer a view. The router entry is gone, along with the special case that mapped it
onto the Connections nav item, and the Back buttons on Encoder config and disguise mapping now go
to the Dashboard.

`ui.js` grew `openModal` for this: a dialog whose controls act as they are used, so its footer only
closes. Both it and `confirmModal` are built on one `modalShell`, which also fixed something latent
— `confirmModal` resolved only through its buttons, so a promise left by a backdrop click or
Escape was never settled. The shell now reports dismissal explicitly.

Two smaller things: `.modal-wide` for dialogs holding controls rather than a form, because the
segmented pickers wrap two-to-a-line at 560px; and `.modal-actions`, since `.row-inline` grows its
children to equal widths, which suits form fields and makes a row of buttons look like a segmented
control.

### A flaky desktop check, hardened rather than shrugged at

One run in five failed while a full test suite and a Chrome instance were running alongside it, and
four subsequent runs were clean. Rather than leave it, the most plausible cause was removed: the
step that pins the viewport spawns a child that must start Node and connect over CDP before it can
apply anything, and it had a hard 10s budget. Under load that startup can overrun, and killing it
early made the **setup** fail while looking like the fix had regressed. It now waits on the
override actually landing, up to 30s, and reports a setup failure in its own words if it never
does.

**Verified:** Edit opens "Edit connection" from the card; the controls dialog opens from the card,
the connection name and the connections list. 149 tests, 18 desktop checks, layout and font audit
clean.

## 2026-08-03 — Connections becomes cards, and duplicate is removed

> "Wirst we dont want the horizontal slider, les make a conection a bigger card. The stop button
> shoudl get some friends. Start, Ctrl (Control) and Edit. The … buttone can then be deleted, also
> its funtion to dublicated is nothing i ever asked for. Delete duplicate function and UI elements
> too."

**The table is gone.** It had eight fixed-width columns and a horizontal scrollbar, which put the
routing — the thing you check before a show — off the right-hand edge on anything but a wide
window. One card per connection now, full width, stacked, with the fields in a
`repeat(auto-fit, minmax(150px, 1fr))` grid: four across a wide window, two on a phone, no sideways
scroll at any width between.

**Four buttons: Start, Stop, Controls, Edit.** Start and Stop are two buttons rather than one that
changes label — a toggle means the control under your finger is whichever state the link was in
when the card was drawn, which is worth avoiding on a show. The inactive one is disabled, and both
are updated only when the state actually changes, since this repaints every frame.

Labelled **Controls**, not Ctrl, to match the dashboard card — two words for one dialog invites the
question of whether they are the same thing.

**The `⋯` menu is gone**, and with it duplicate: `configDuplicateConnection` (route),
`duplicateConnection` (store), `CONFIG_DUPLICATE_CONNECTION` (channel name), the browser shim
method, its test, and `nextFreeDevid`, which existed only to serve it.

**Delete moved into the controls dialog**, since the row menu that held it is gone. It is set apart
below a rule rather than sitting beside the controls, so it is not next to anything you would press
in a hurry. It was the one thing in that menu that had to survive — the alternative was a screen
with no way to remove a connection.

**Verified:** no horizontal scroll at 1440, 1024, 860, 720, 480 or 390; the card wraps to two
button rows and two field columns at 390. 147 tests, 18 desktop checks, layout and font audit clean.

## 2026-08-03 — The connection fields hold five columns longer

> "i like the even spacing … but it jumps to early when narrowing the window. each item doest need
> as muche fix space" / "does the encoder card still takes in account for fanning to multiple
> disguise?"

Measured rather than guessed at: the widest thing a field holds is an encoder address at **109px**
and the widest label is 60px, so the 150px minimum was reserving about 40px per column that nothing
used. `auto-fit` drops a column the moment the row cannot afford its minimum, so that spare space
made the layout break to two rows while there was still plenty of room.

Now `minmax(116px, 1fr)` with a 14px column gap. **Five columns hold down to a 950px window**,
where they used to give up at about 1096. Swept 1440 → 390 checking every value for truncation:
none at any width.

(The count goes back up to five at 720 and below, because that is where the sidebar becomes a menu
and hands its width to the content. Non-monotonic, and correct — there genuinely is more room.)

### Fan-out, confirmed on a rendered card

Checked by building a real three-destination connection on a throwaway headless instance rather
than by reading the code, and rendering it:

| field | shows |
|---|---|
| disguise | `10.10.10.5:6000  +1` |
| hover | all three, including `10.10.10.7:6000 · id 3 (disabled)` |
| Device ID | `1, 2` |
| Rate | **403 Hz** — 200 samples/s across two enabled destinations |

The `+N` and the device-id list count **enabled** destinations only, while the hover shows every
one and marks the disabled. The dashboard card does the same through `targetLine`/`targetTitle`:
`127.0.0.1:17000 → 10.10.10.5:6000 · id 1  +1 more`. The rate is the proof it is real routing and
not just a summary string.

## 2026-08-03 — Card buttons stay right; every screen gets the same header

> "keep all buttons to the right even if they jump into a second row" / "i mean the buttons start,
> stop, controls, edit in the encoder card" / "similar to the Dashboard, bring the conecctions
> headline and the Start All, Stop All and Add Connection in its own card. Also +Add is double just
> just Add use Cap on the all first letters of these buttons." / "use in Headlines and menu items
> always first letter Cap, like Encoder Config also stay with Config and not Configuration" / "On
> the Encoder Config page, remove the ‹Dashbard button. Same style header with as the other sides."

**A spacer only aligns the row it sits on.** With `flex-wrap`, the filler element pushed the
buttons right on the first line and then wrapped ones started again from the left. They are now a
`.card-actions` group with `margin-left: auto` — which positions it on whatever line it lands on —
and `justify-content: flex-end` inside, so the group stays right-aligned even when it wraps
internally. Measured at 300px: the group splits `Start+Stop+Controls` / `Edit` and **both rows are
flush right, 0px gap each**.

**Every screen's header is now a panel**, the same object on all six: Dashboard, Connections,
Encoder Config, Disguise Mapping, Log and Settings. `.dash-summary` became the shared `.page-head`.

**The back buttons are gone** with it. The nav is always reachable, so a per-screen "‹ Dashboard"
was a second and weaker way to navigate — one that had to guess where you came from, and guessed
wrong as soon as the controls dialog could open those screens from anywhere.

**Labels.** `+ Add connection` said "add" twice, so it is `Add Connection`. Title case on headlines
and menu items, with the menu and the headline matching word for word — `Encoder Config` in both,
`Disguise Mapping` in both. Two dialog titles were rewritten rather than title-cased, because
articles read badly that way: `Zero Encoder?` and `Preset Already Zero`.

`Add Destination` got the same treatment as `Add Connection`, since it had the same doubling.

### The desktop check now names what failed

A failing run printed `1 of 18 checks failed` and nothing more in a `tail`, which cost a re-run to
find out what. The summary lists the failures by name and detail now.

## 2026-08-03 — Encoder Config: one card per encoder, groups that fold away

> "Give each encoder its on card with a nice header as we already have it, Then tile the configs as
> they are in Output and Timing and network, make both retractable." / "each encoder config gets its
> own button for read from encoder. But have one in the header for Read configs from all encoders" /
> "remove the text Reads and writes this encoder directly over its TCP command channel…"

**Every encoder is on the page now.** The screen used to show one, chosen by a picker, which meant
the target was implied by whatever was last clicked elsewhere — on a screen that writes flash and
can change an IP address. Each card names the device it writes to, shows its address and NIC, and
carries its live position, because POSITAL encoders expose no serial number or firmware version
over the wire: the address is the only handle there is, and turning the shaft is the only way to be
certain of the unit.

**Groups are `<details>`**: Output and Timing, Scaling and Zero Point, Diagnostics open; Network
shut and marked, since changing an IP drops the connection. `details` rather than a hand-rolled
toggle because it opens without JavaScript, is keyboard-operable for free, and behaves identically
in Blink, WebKit and Gecko — which `popover` or an anchored panel would not. The caret is drawn in
CSS, so it needs no font and no asset.

**Read is now two things.** Each card has its own `Read`; the page header has `Read Configs From
All Encoders`, which walks the cards **sequentially** — every read is a burst of commands down a
TCP session that is also carrying the data stream, and firing several encoders at once turns a
config read into a visible gap in the position feed.

The standing blurb about Java and Internet Explorer is gone.

**Verified with two encoders** on a simulated rig: two cards, two independent Read buttons, both
reporting `read 13 of 14 variables`. 147 tests, 18 desktop checks, layout and font audit clean.

## 2026-08-03 — The manual's words, the manual's limits, and a validation gap

> "use manual-ixarc-ocd-em.pdf text only to add text to the config, clean up the texts, to much and
> not important stuff. Und each text filed should havea min max information below it… Also check
> that these text fields are save only except the values possible and cant be used for injections."
> / "don't say this shows that here and there just use the text."

No PDF tooling on this machine, so the manual was read by inflating its streams and pulling the
text operators directly — §5.6.2 *Variables*, pages 18–19. Every help string is now that text,
trimmed to what an operator needs at the control, with the citations dropped: the text states the
fact rather than pointing at where the fact came from.

**Every field that takes a typed value now prints what the encoder will accept**, under the box:
`1 – 999,999 ms`, `1 – 1,073,741,824 steps`, `0 – 1,073,741,823`, `a.b.c.d, each part 0 – 255`.
Dropdowns get none, because a `select` cannot be out of range. A number input's own `min`/`max`
only nudges the spinner — it never says what the limits are, and finding out by being rejected
costs a round trip to the device.

### The gap

`checkValue` refused a line break and a value over 256 characters, and nothing else. **The line
break is the dangerous one** — the command channel *is* the data channel, so a value containing
CR or LF becomes a second command — and that was already covered. But nothing checked a value
against the variable it was being written to. `set CycleTime=abc`, a negative resolution, an
address of `localhost`, or `CW; Run!` all travelled to the encoder to be rejected there.

`checkVarWrite(name, value)` now enforces everything the variable table knows, **on the server**,
where a hand-made HTTP request meets it too and the UI's own constraints are only a convenience:

| type | rule |
|---|---|
| int | whole number, within the documented range |
| enum | resolved case- and separator-insensitively, so the device's `CYCLIC` and the applet's `COS` are both accepted and normalised |
| flags | built only from the declared tokens; empty is legitimate |
| ip | four octets, 0–255, leading zeros normalised |

`encoderRaw` is deliberately left with only the line-break check: it exists to send what the table
does not cover, so validating it against the table would defeat it. It is the one route that
reaches the device with an arbitrary command, and it is unreachable without the token when bound
off localhost.

**16 new assertions across 7 tests**, including that every injection shape is refused:
`0\nset IP=1.2.3.4`, `CW; Run!`, `255.255.255.0 ; Run!`, `IP; rm -rf /`.

**154 tests pass.** Screen verified on a simulated rig, since the running app serves `ENCODER_VARS`
from the process it started with — a constants change needs a restart, unlike the JS and CSS, which
are read from disk.

## 2026-08-03 — Three ranges that were wrong or invented

> "which input field is unclear about its range or input it can get? all values should be documented
> in the folder tools-ixarc-ocd-em-java_client"

**That folder does not document them.** Its `Modbus Encoder Parametrization via Command Lines.pdf`
says only: *"You can find the list of Variables and Values in our online manual, 5.6.2 Variables,
page 18"* — the section already used. `tcpcl.java` and `udpcl.java` are a plain TCP/UDP terminal
with no variable table and no validation. The datasheet and the type-label scan are image-only and
yield no text. So the question had to be answered against what the app was claiming, and three of
those claims were mine rather than the manual's.

| field | was | now | why |
|---|---|---|---|
| UsedScopeOfPhysRes | `1 – 1,073,741,824 steps` | `1 – 33,554,432 steps on this model` | the old figure is the **product family's** 30-bit ceiling (65,536 steps/rev × 16,384 revs). This is a 13-bit singleturn × 12-bit multiturn unit — the family maximum is **32× more than it can hold** |
| TotalScaledRes | same | same | same |
| Preset / Offset | `0 – 1,073,741,823` | `0 – 299,999  (one less than TotalScaledRes)` | **the manual states no bound at all.** Preset is "the position value the encoder will show", so it is bounded by the scaled resolution in force — a value on the device, not a constant |

The Preset and Offset limits are therefore **read from the encoder**, not hardcoded: the field names
its dependency (`0 – one less than TotalScaledRes`) until a read fills in the number. That matters
because a commissioned unit is nothing like its type label — the reference encoder is scaled to
300 000 where the label implies 33 million, so any fixed number under those two fields would have
been wrong on it.

`MAX_RESOLUTION` stays as the **server-side** bound, because the server cannot know which model is
on the other end of a socket. The UI states the model's own limit; the server refuses only what no
device in the family could accept.

**Verified on the rig** after a restart: `UsedScopeOfPhysRes 300000`, `TotalScaledRes 300000`,
`Offset 43156`, and the two dependent fields reading `0 – 299,999`. 154 tests pass; layout audit
clean on Encoder Config.

## 2026-08-03 — The resolution stated the way the type label reads it

> "i think this is important 4096 resolutions x 8192 steps per revolution = 33,554,432" / "since
> this is the TotalScaledRes, that should also be the preset / offset range"

It is important, and a bare total loses it. **`33,554,432` cannot be checked against anything;
`4,096 turns × 8,192 steps/turn` can be read straight off the label of whatever unit is on the
rig.** That is also how the manual gives it, and it is the stated default for both scaling
variables — which is what an operator wants when they have scaled an encoder into a corner and need
to know what to put back. So the field now reads:

    1 – 33,554,432 (4,096 turns × 8,192 steps/turn) · default 33,554,432

Both numbers come from `REVOLUTIONS` and `COUNTS_PER_REV`, so a build for a different model states
that model's figure without anyone editing prose.

**Preset and Offset take the same ceiling.** They are position values, so they live inside whatever
`TotalScaledRes` is set to — and `TotalScaledRes` itself cannot exceed the physical resolution.
Their fallback is therefore `0 – 33,554,431 (one less than TotalScaledRes)`, not the family-wide
bound no single device can reach, and it is replaced by the real figure the moment the encoder is
read.

**Verified on the rig:** `UsedScopeOfPhysRes 300000`, `TotalScaledRes 300000`, `Offset 43156`, both
dependent fields showing `0 – 299,999`. 154 tests pass; Encoder Config audit clean.

## 2026-08-04 — Finding an encoder whose address nobody wrote down

> "if i dont know an encoders ip, can we add a encoder search under add connection and make avalibe
> endocers either a drop donw on the ip field or a manual enter of the ip?" / "there should be a 2nd
> encoder"

**POSITAL documents no discovery mechanism.** No broadcast, no announce; the manual permits UDP only
on port 5000 and only for polled reads. The encoder's one identifying behaviour is that it answers
on TCP 6000, so `src/core/discover.js` connects to every host in a subnet and asks.

Three properties mattered more than speed:

- **The subnet comes from this machine's interfaces, never from the caller.** `localAddress` picks
  a NIC; that NIC's netmask decides what is probed. A route that took a range from the caller would
  be a port scanner with an HTTP front end.
- **A hit is disconnected the instant it is identified.** TCP 6000 accepts only a handful of
  clients, and during a show those slots are the difference between a desk connecting and not.
- **Identification is positive.** An open port is not evidence; the device must either stream
  samples or answer `read TotalScaledRes`. A test points an HTTP server at the probe and requires
  it to be rejected.

A `/16` is refused rather than clipped — 65,534 probes is not a scan, it is a nuisance.

The field is an `<input list>` with a `datalist`, so it is a dropdown **and** typeable: the encoder
you want may be on a subnet this machine cannot see, and being forced to pick from a list that
cannot contain it would be worse than no list at all.

### The second encoder

It is not on the wire. Established rather than assumed:

- a full ICMP sweep of `10.10.10.0/24` answers from **two** hosts — `.5` (disguise) and `.10`
- the neighbour table for `en3` holds exactly three MACs: this Mac, disguise, and one device with
  the encoder's manufacturer prefix `00:0e:cf`
- the link-local addresses that had appeared on that segment answer nothing on 6000
- the other interface, `192.168.100.0/24`, yields nothing

So it is powered down, unplugged, or holding an address on a subnet nobody here has an address in —
and **no IP scan can reach that last case**, which is the honest limit of this feature.

Two things came out of chasing it:

**Neighbours outside the subnet are probed too.** A device that has spoken is in the ARP table even
if its address is foreign, so those get a probe as well — 283 addresses instead of 253 on the rig.
Best effort: a missing `arp`, an unparsable format or a different platform all end with an empty
list and a scan that carries on.

**When nothing answers, the screen names the actual remedy.** More scanning is not it — switch 2 in
the connection cap forces the encoder back to the factory address after a power cycle, regardless
of what is programmed. If a device with the encoder's manufacturer prefix is on the segment but
silent, it says so and gives the MAC, because that is a much stronger hint than "nothing found".

**Verified on the rig:** finds `10.10.10.10` with its real 300,000 scaling in 2.8 s, does not flag
the disguise server, and the running link came through it at `reconnects 0, errors 0`. 166 tests.

## 2026-08-04 — A status line that repeated itself, and one that only sometimes appeared

> "in the dashbard the 2nd encoder says \"receiving from 10.10.10.20\" the first one doesn't" / "its
> kind of reduntand, ip is right above" / "in Encoder config there is no gap between each encoder
> card, also by default all configs should be folded away."

Two faults behind one observation.

**The redundancy.** While streaming, the state detail is `receiving from <host>` — and the host is
already on the line above it. The card now shows the detail only for states where it says something
the card does not: which interface is being tried, how long until the next retry, why a connection
failed.

**The inconsistency, which was the more interesting half.** Link state arrives as a *transition*
event, so a client that connects to an already-running bridge never hears one. Telemetry is
reconciled every frame to cover that — but telemetry carried `state` and **not** `detail`, and the
reconciler filled in an empty string. So a link that was already streaming when the page loaded
showed nothing, while one that started later had heard the real event and showed the text. Identical
state, different display, decided entirely by when the page happened to load.

`detail` now rides along with every telemetry frame, and the store adopts it. It also refreshes when
the detail changes but the state name does not — a retry countdown was previously frozen at whatever
it said when the state last changed — **without** triggering a re-render, since detail text is
painted by the animation loop and re-rendering for it would undo the two-clock model.

**Encoder Config:** the cards had no gap (they were appended straight into the view); they are in a
`.cfg-list` grid now. And every group starts folded — with more than one encoder on the page an
expanded card is most of a screen, and what the list is for is seeing the encoders.

### The second encoder

It is real: `10.10.10.20`, MAC `00:0e:cf:07:17:77` — the same manufacturer prefix as the first —
scaled to 100,000 counts. **It was not on the network when the earlier sweep ran**: a full ICMP
sweep of all 254 addresses answered from `.5` and `.10` only, and there was no ARP entry for `.20`.
So the scan had no false negative; the device arrived afterwards. Re-run with both powered:

    scanned 260 on en3
      10.10.10.10  300000 counts  (answered read TotalScaledRes)
      10.10.10.20  100000 counts  (answered read TotalScaledRes)

**166 tests pass; Dashboard and Encoder Config audits clean.**

## 2026-08-04 — Timestamp mode: not tested to disguise, and a real leak when it was

> "if we add the timestap to the string, did we ever tested if everything still works?" / "towards
> disguise also"

**Partly, and one of the tests was passing for the wrong reason.**

`protocol.test.js` covered the parse, and `encoder-link.test.js` had a test named *"the field
layout is read from the encoder, not guessed"* — which passed `outputmode: 'Position_Timestamp_'`
to the simulator. **The simulator has no such option.** `parseArgs` ignored it, the mock ran in its
default three-field mode, and the assertion (`inferred === false`) holds in every mode. The
ambiguous two-field layout it existed to cover had never been exercised. `--output-mode` is now a
real flag, and the test uses it.

Nothing asserted the datagram either. So a suite written to prevent "a timestamp reaching disguise
as a velocity" never looked at the velocity in a packet.

### With the simulator actually in Position_Timestamp_, it leaked

    packets: 600
    carrying a timestamp as velocity: 3
    first velocities: 803311, 808311, 813311, 0, 0, 0 …

`INFERRED_MAPS` claimed a two-number line was position + velocity. On a `Position_Timestamp_`
encoder that is a microsecond counter, so **every connect put three packets carrying ~800,000
steps/s into disguise** before the `OutputMode` read came back and corrected the layout. Only
`passthrough` and `derived` were exposed; the default `zero` policy sends 0 regardless.

**Two numbers are now left unclaimed.** Three can only be position, velocity, timestamp, so that
inference stays. For two, the position still flows immediately and the second number waits until
the device is asked — which means a `Position_Velocity_` encoder sends **one** packet with velocity
0 before its real value arrives. That is the value the original driver sent for every packet, so it
is the one direction this can be wrong in safely.

Verified both ways on the simulator: `Position_Timestamp_` now leaks nothing; `Position_Velocity_`
reads `0, 8192, 8192, 8192 …`.

`test/timestamp-to-disguise.test.js` adds four tests that look at the packet: the extra field is
dropped rather than shifted, the velocity slot never counts like a clock, position still advances
with three fields, and the timestamp still reaches the operator's readout.

**Neither encoder on the rig is in a timestamp mode** — both report `POSITION_VELOCITY` — and
changing that writes flash, so this is simulator work by necessity. After restarting on the new
parser: Revolve streaming, `errors 0`, `unknown 0`. Bench: `rx 3000 tx 3000 unparsed 0`.

Also: the CycleTime description is now just *"States the time in ms for the cyclic time mode."*

**170 tests pass.**

## 2026-08-04 — A remembered write dialect that disabled writing

> "changing the CycleTime did not work for me. But it workded earlier." / "i changed the Timestamp
> check and it gave a error?" / "it said 1 setting(s) rejected: OutputMode (unknown command)"

Not the second encoder, and not the parser. The log named it:

    tx  CycleTime=10          ← bare, where "set CycleTime=10" had worked earlier
    tx  read CycleTime        ← no reply, no confirmation

This firmware answers `set Var=Value` and ignores the bare `Var=Value` form. The link tries the
documented form first and falls back to bare once, then **remembers** the winner — but it
remembered it as the *only* form, so `forms` became a one-element list. A single wrong guess
therefore disabled writing for the rest of the connection: every later `set` went out in a dialect
the device silently ignores, with no fallback and nothing in the log to explain it. Writes worked
earlier in the session and stopped without anything visibly changing.

**The remembered dialect is now a preference, not a restriction.** It is tried first and the other
form stays behind it. If both are refused, the remembered one is discarded, since it has just been
disproved. And the decision is logged — `write dialect for this encoder: "set Var=Value"` — so the
next person can see it in the log rather than infer it from a silence.

Confirmed on the rig immediately afterwards:

    tx  set CycleTime=10
    rx  cycle time changed on the encoder: 10 ms
    rx  Parameters successfully written!

with the stream's arrival gap moving from 8.11 ms to 10.11 ms, `errors 0`, `unknown 0`.

### The banner that warned about a write that never happened

Two more, both reported here. The encoder had refused the command outright, so nothing was being
committed — yet the flash banner and its 30-second timer ran anyway, telling the operator not to
power off a device that was doing nothing, then resolving to "write status unknown". An explicit
rejection now clears both at once.

That banner also says to press Read, and Read did not clear it. A successful read is exactly the
confirmation it asks for, so it dismisses it now; otherwise the instruction was a dead end.

**`OutputMode` remains unwritable on this firmware** — both dialects answer `ERROR: unknown
command`, and four probes with a deliberately invalid value (which cannot commit) drew no reply at
all. The encoder was verified unchanged afterwards: `OutputMode=POSITION_VELOCITY`,
`OutputType=ASCII_SHORT`, `TimeMode=CYCLIC`. POSITAL's own IP-change note uses a third form —
`set ip 198.100.100.54`, space-separated and lower-case — which is the next thing to try, and costs
a flash cycle to test.

**171 tests pass.**

## 2026-08-04 — Faults that were not faults, and a caption that did not scale

> "dashboard says Faults 5 errors from Revolve, how is it seperating the errors from the encoders
> here if we have 10 encoders?" / "yes want both"

### A refused command is not a fault in the stream

The encoder answers `ERROR:` for both a refused `set` and a genuine device complaint, and the link
counted them in one place. So a rejected configuration write sat on the show dashboard as a
permanent fault, beside figures that mean the position feed is in trouble — which is how five
errors from probing appeared as a Revolve fault while its data path was clean.

The discriminator was already there: the command queue reports whether it **consumed** a line, so
an error matching an in-flight request is an answer, not a fault. Those now increment
`commandErrors`; an error nobody asked for still increments `errors`.

`commandErrors` is excluded from every Faults figure but listed on the card's own fault row as
`1 rejected command`, so it is visible without being alarming.

One honest limit, and it is inherent: the encoder broadcasts errors to *every* client, so an
unrelated error arriving while a command is outstanding is attributed to that command. That is the
same assumption the queue already makes to resolve replies. Two of the new tests failed at first
for exactly this reason — they left the link's own connect-time reads unanswered and were measuring
the assumption rather than the counters.

### The caption

`errors from ${[...faulted].join(', ')}` reads fine with two encoders and becomes
`errors from A, B, C…` with ten — in a single ellipsised line, long enough to be useless and short
enough to look complete. It names up to two, then counts: **`cannot reach 4 destinations`**. The
per-connection breakdown moved to the tile's hover, where there is room:

    Enc 1: 567 send failures
    Enc 2: 567 send failures
    Enc 3: 566 send failures
    Enc 4: 568 send failures

    2268 send failures · 0 encoder errors · 0 unparsed lines

**Verified on the rig:** `read Preset` — write-only on this firmware, so a guaranteed rejection —
gives `errors 0, commandErrors 1`, a Faults tile reading **0**, and `1 rejected command` on the
card. Four faulting connections on a simulated rig produce the counted caption above.

**174 tests pass.**

## 2026-08-04 — OutputMode solved, and the encoder's firmware version

> "you go into listing mode and i will do the changes over the UI" / "it worked" / "can we add a
> check for each encoders version?" / "the website does it here CheckVersion" / "Convert the raw
> microsecond value into a standard Hours : Minutes : Seconds . Milliseconds string"

Watching a real attempt with the log capturing everything produced the encoder's own words for the
first time — the piece missing through the whole investigation:

    "set OutputMode=Position_Velocity_Timestamp_" refused:
      Position_Velocity_Timestamp_ is not a valid value for OutputMode. Using previous value.

**The manual's spelling is not this firmware's.** The device reports `POSITION_VELOCITY` — upper
case, no trailing underscore — and refuses anything else. It understood the command perfectly; the
`ERROR: unknown command` seen earlier was the bare-form *retry*, a red herring throughout.

### The bug that hid it: a refusal that looks like a success

The encoder answers a refusal exactly as it answers a write — `<Variable>=<Value>` — with the
**old** value. Matching on the variable name alone therefore read a rejection as a completed write:

    tx  OutputMode=Position_Velocity_Timestamp_
    tx  write dialect for this encoder: "Var=Value"     ← recorded a SUCCESS
    rx  ERROR: unknown command

That false success is what flipped the remembered dialect to bare — **the same event that silently
broke a CycleTime write earlier in the session** — and what armed a flash banner for a commit that
was never coming. A write now counts only if the echoed value matches what was sent, compared
case- and separator-insensitively so `Cyclic`/`CYCLIC` still agrees.

Two supporting changes: flag values are written in **the spelling the device itself reports**, taken
from the last read, so a unit using the manual's form still gets it; and `checkVarWrite` no longer
rewrites a flag value into the canonical spelling, which would have undone that.

**Applied on the rig, by the operator, through the UI:**

    tx  set OutputMode=POSITION_VELOCITY_TIMESTAMP
    rx  field layout changed on the encoder: POSITION_VELOCITY_TIMESTAMP
    rx  Parameters successfully written!

and the check that all the timestamp work existed for, now against real hardware:

    pos 215797   rawVel 0   outVel(sent) 0   ts 2392637065   errors 0  unknown 0

A 2.4-billion microsecond counter live on the wire, and **0** in the velocity slot going to
disguise. `rx == tx`, `reconnects 0`, gap p50 10.12 ms.

### Firmware version

Undocumented: the manual's variable table has no version entry and `read Version` is not
understood. The operator found the encoder's own web page has a **CheckVersion** button, and the
applet behind it uses the same TCP channel. The bare command `Version` answers
`Software Version 4.50` — prose, not `Var=Value`, so it was arriving as an unparsed line and
**counting as a stream fault**: asking the encoder what it was registered as the data path
misbehaving.

It is a real reply now, read once on connect (best effort — not knowing must never stop a link
streaming), and shown beside the encoder's name as `fw 4.50`. That number is worth having where the
device is named: this build's refusal of the manual's OutputMode spelling is exactly the kind of
difference a version explains.

### The timestamp as a clock

`2 938 146 297 µs` is ten digits of nothing usable. Shown as **`00:48:58.146`** — time since the
encoder powered up — with the raw counter on hover for anyone correlating against a capture. The
hours field is kept rather than dropped because the counter is 32-bit and wraps at
**01:11:34.967**, which is also why a jump backwards there is the counter and not a fault.

**177 tests pass.**

## 2026-08-04 — Three sources for CycleTime's range, and why the device does not win

> "could this be the reason ❯ CycleTime … Can have values between 5 ms and 100000 ms" / "cylcle time
> work with 1ms tho" / "could this be the reason ❯ ASCII …" / "or ASCII_SHORT …"

**The range was briefly changed to 5 – 100,000 and changed straight back.** The reasoning for
narrowing it was that the encoder's own interface is the authority on what it accepts — which is
sound until it contradicts the hardware. It does:

| source | range |
|---|---|
| manual §5.6.2 | 1 – 999,999 ms |
| the encoder's own page, firmware 4.50 | 5 – 100,000 ms |
| **this hardware** | **1 ms runs** |

Enforcing the narrower figure would have refused a value that has been used successfully on this
very encoder. So the documented range stands and the tighter claim is *shown* rather than imposed —
the field reads `1 – 999,999 ms · the encoder's own page says 5 – 100,000`. A limit that blocks
something known to work is worse than a limit nobody enforces.

Worth recording as a rule: **a documented limit narrower than observed behaviour is a note, not a
constraint.** The place to be strict is the shape of a value, where a wrong guess sends nonsense
down a shared command channel; the place to be permissive is its magnitude, where the device is
about to answer anyway.

### The two ASCII forms are not the reason for anything

Both parse, checked against the exact strings from the encoder's page:

    "215797 0 2938146297"                              → pos 215797  vel 0    ts 2938146297
    "215797 -12 2938146297"                            → pos 215797  vel -12  ts 2938146297
    "POSITION=215797 VELOCITY=0 TIMESTAMP=2938146297"  → pos 215797  vel 0    ts 2938146297

The rig is streaming ASCII_SHORT with three fields and **0 unparsed lines**. Neither form explains
the OutputMode refusal, which was the value spelling and is fixed.

**177 tests pass.**

## 2026-08-04 — Verbose ASCII, tested at last, and why it stays selectable

> "so did we checked if i can change from ascii short to ascii, should this be an option?"

**No, it had never been run.** The parser had a rule for each form and a unit test for each line,
but nothing had taken the verbose form through the link to a datagram — and the simulator could
*produce* `POSITION=… VELOCITY=… TIMESTAMP=…` while having no way to be asked for it, exactly the
gap that let the OutputMode test pass against the wrong mode. `--output-type` now exists alongside
`--output-mode`.

Run end to end, both forms, three seconds each:

    ASCII_SHORT  600 packets  sample "1:6774,8192;\n"  vel [8192]  unparsed 0  parse p50 64.5µs
    ASCII        600 packets  sample "1:6691,8192;\n"  vel [8192]  unparsed 0  parse p50 61.1µs

Same packet count, same packet shape, same velocity, no unparsed lines, and no measurable
difference in parse time — the extra bytes are absorbed by the same hot path.

### It should stay an option, for a reason worth stating

The instinct was that verbose ASCII is harmless but pointless: twice the bytes for the same
information. That is half wrong. **TCP 6000 accepts several clients**, which is the premise the
whole fan-out design rests on — a venue may have another system reading the same encoder that needs
the verbose form. Setting the encoder to ASCII_SHORT for our convenience would break it, and posi3
copes with either. The setting exists so the encoder can suit somebody else.

BINARY remains listed and unselectable: that one this app genuinely cannot stream.

Two regression tests hold it: verbose ASCII produces correct packets, and the two forms produce the
same values at disguise.

**179 tests pass.**

## 2026-08-04 — The manual's word for the unit, used everywhere

> "change the text behind: ASCII sends … BINARY not supported" / "change the text behind OutputMode
> Position … Velocity … Timestamp …" / "am i right that what you offen call count is steps in the
> software, would that be a better wording everywhere?"

Right, and the app was contradicting itself: **position in "counts", velocity in "steps/s" — the
same unit named two different ways on the same card.** The manual uses *steps* throughout: "8192
steps per revolution", "physical steps", "the encoder will count 10 steps", "steps/s". The count
across the UI was 16 "counts" and 14 "COUNTS" against 13 "steps".

Every user-visible instance is now *steps* — the dial's centre unit, the encoder-config live
position, the mapping helper's field labels and span, the discovery result, and the dashboard's
scaling line, which now reads:

    Encoder scaling: 8 192 steps/turn · 300 000 steps total · 36.62 turns

**The identifiers keep `counts`** — `countsPerRev`, `totalCounts`, `TOTAL_COUNTS`. They are
persisted in every saved profile and are part of the telemetry contract, so renaming them costs a
schema migration to change nothing an operator can see. Noted at the constant so the mismatch reads
as a decision rather than an oversight.

The two help strings were replaced with the encoder's own wording, as given:

- **OutputType** — `ASCII sends "POSITION=<POSITION> VELOCITY=<VELOCITY> TIMESTAMP=<TIME>",
  ASCII_SHORT sends "<POSITION> <VELOCITY> <TIME>", BINARY not supported`
- **OutputMode** — `Position — Encoder will send a scaled Position value. Velocity — Encoder will
  send a velocity Value (steps/s). Timestamp — Encoder will send a timestamp`

**179 tests pass;** audits clean on Dashboard, Encoder Config, Disguise Mapping and Connections.

## 2026-08-04 — The same values read over and over, and a rate that would not sit still

> "also looks like the read happend multiple times in the log reading the same values" / "in
> connections and dashboard where it shows HZ, can you show a 10 sec avarage for it and only show
> 10, 20, 30 ...etc so the closest 10th"

### Reads

Measured rather than guessed. A screen sitting idle for twelve seconds issued **13** reads — one
sweep, on mount, which is correct. Then the same test while a *second, unrelated* encoder started
and stopped:

    reads issued: 108        (one sweep is 13)

`onStoreChange` re-renders every view on any link-state change, and each config card read all
fourteen variables as it was constructed. So another encoder connecting rebuilt the screen and
re-read **every** encoder, several times over — every one a round trip on the same TCP session that
carries the position stream, all returning values the screen already had.

Values are now kept at module scope and restored on rebuild. A cached value is exactly as fresh as
the last read: the encoder announces its own changes on the same socket, so anything altered
elsewhere arrives as a broadcast rather than being discovered by polling. Writes update the cache
too, or a rebuild would show what the device held a moment ago.

### Throughput

It was an exponential moving average at 30 Hz, so it reacted within a fraction of a second and
never settled — a figure that reads as noise on a screen left open all show.

Now a flat **ten-second window**, computed from counters rather than per-tick deltas so a late or
dropped tick cannot skew it, cleared when a link restarts because `start()` resets the counters and
the average would otherwise go negative. Under a second of history reads 0 rather than extrapolating
wildly from two samples.

Displayed to the nearest ten. Measured on the rig: raw 98.87 … 98.97 over twelve seconds, shown as a
motionless **100 Hz**. A rate that rounds to zero without being zero shows `<10` — "nothing is
arriving" and "a trickle is arriving" call for opposite responses, and rounding must not merge them.

**179 tests pass;** audits clean on Dashboard, Connections and Encoder Config.

## 2026-08-04 — The raw command box is gone

> "can we remove the raw command box fully?"

Removed at every layer: the input and Send button on the Log screen, the browser shim's
`encoder.raw`, the `encoderRaw` route, and `EncoderLink.raw()`, which nothing called once the route
went. One import it orphaned went with it.

It was the only route that reached the encoder with an arbitrary command. Everything else is
checked against the variable table — a known name, a value of the right type and range — while this
took any line and forwarded it, guarded only against the CR or LF that would have split it into two
commands. On a device that writes flash and can change its own IP address, that is a large surface
for a feature whose remaining use was exploratory.

**It earned its keep on the way out**, which is worth recording: it is how `Version` was found —
`Software Version 4.50`, an undocumented command discovered from a button on the encoder's own web
page — and how the OutputMode write dialects were probed without spending a flash cycle, since an
invalid value is refused rather than written.

That capability is not lost, only moved off the show machine's UI: the same probing is a few lines
of `net.connect` against port 6000, which is what the tools in `tools/` already do. What is gone is
the ability to do it by accident, or for anyone with the web UI open to do it at all.

**179 tests pass**; audits clean on Log, Dashboard, Connections and Encoder Config.

## 2026-08-04 — A dead disguise machine should not shout

> "i stopped the connection, because the disguise was off and the conecction produced 1000errors"

The right call, and the app made it noisier than it needed to be. Measured from the log of that
outage — a disguise machine off from 10:59 to 13:57:

    send-failure log lines:      1294
    "reachable again" claims:     440

The backoff was designed to say it once, then at 15s, 60s, 240s and every 15 minutes after —
**about fifteen lines in three hours.** It never got past the first step.

**A host that is off does not fail cleanly.** The odd datagram slips through between ARP retries, so
the sink sees a stream of errors with the occasional success scattered through it. Recovery was
declared on *any* success, which reset `warnBackoffMs` to zero — so the next error warned
immediately and the backoff never grew. 440 times.

Recovery now requires the sends to have been landing for **three seconds**: long enough that a lone
datagram slipping through does not qualify, short enough that a real recovery is announced while it
still matters. Same outage, same policy, now fifteen lines rather than 1,294.

The packet count in the message stays — `827,300 packets lost so far` is the number that says how
long this has been going on, and it is the one thing in that line worth reading twice.

Three tests cover it: a lone success between failures is not recovery, the backoff survives the
flapping, and a destination that genuinely comes back is still announced. An existing test asserted
the old behaviour — recovery on the first success — and now asserts the new rule and says why.

**183 tests pass.**

## 2026-08-04 — A dead destination stops being fed, and stops nothing else

> "check the disguise api, you can ask for an alive sign off… what should we do with the connection
> then?" / "do we want to send data to thehardware even if the disguise software is not running?" /
> "if we fan out and one machine is off … we still should run the whole connection, just need to
> find a way to not shooting into a black hole but keep everyone else happy and their data going"

**disguise has no heartbeat to ask.** Its Python API is `POST http://<host>/api/session/python/execute`
on port 80, and the documentation has no status, health or version endpoint. Nor is one needed: the
*connected* UDP socket already answers the question, and answers it better than an application-level
ping would, because ICMP distinguishes two cases a heartbeat would blur —

    EHOSTUNREACH / EHOSTDOWN   the machine is not on the network at all
    ECONNREFUSED               the machine is up, nothing is bound to that port

That is the same mechanism that identified disguise's port during hardware validation without
touching the machine.

**So the signal was already there; the response was wrong.** After two seconds of unbroken failure a
destination is marked offline: sending to it stops, one probe datagram goes every five seconds
instead, and a banner says so — a banner rather than a toast, because it persists until it is fixed
and an operator who looked away should still find it. UDP is stateless, so resuming costs nothing;
there is no session to rebuild, only a send that works.

**The link is never stopped for it.** The encoder's TCP socket accepts only a handful of clients, so
dropping it risks losing the slot to a leftover one — and with fan-out, one dead machine must not
starve the others. Proved with three destinations, the middle one pointed at a closed port:

    link state: streaming · rx 1200
      stage left      tx  1200   txErrors     0   suppressed     0   offline false
      DEAD machine    tx   402   txErrors   402   suppressed   798   offline true
      stage right     tx  1200   txErrors     0   suppressed     0   offline false
      datagrams actually received: stage left 1199, stage right 1199

Two thirds of the dead machine's traffic never left, while both live machines received every packet.
The `402` is the two seconds before it gave up; after that it is one probe per five seconds.

`suppressed` is counted separately from `txErrors`, because a packet deliberately not sent is not a
failure — and the previous behaviour, 827,300 failures against one destination, buried everything
else on the dashboard.

**185 tests pass.**

## 2026-08-04 — Reading an encoder that is not connected

> "when we read an encoder those the connection need to be engaged?" / "sure lets do the one shot
> connection for read, then we also dont need the banner to tell us its in idle. If we click read but
> the device is not in the network anymore, we need a banner … auto disaappear after 5 seconds. BTW
> all banners should have an x on the right to close them."

**It did need to be engaged**, because the configuration channel *is* the data channel — one TCP
socket, and a stopped connection has none. So a stopped encoder's settings could not be looked at at
all, which is the wrong way round: reading is the one thing worth doing to an encoder that is not
streaming, since it is how you find out what it is set to before committing to it.

`readVariablesOnce` opens a socket, asks, and closes — the same thing discovery already does. The
server chooses: a running link uses its own session, a stopped one gets a socket of its own. The UI
call is unchanged.

The cost is one of the encoder's few client slots for a fraction of a second, which is why it is a
deliberate one-shot rather than a poll. Requests are serialised: the encoder broadcasts replies to
every client and they are matched by name, not by sequence.

**On the rig, with Encoder 2 stopped:**

    Revolve    streaming  read 13 of 14   CycleTime 10  IP 10.10.10.10  Gateway 10.10.10.10
    Encoder 2  idle       read 13 of 14   CycleTime 18  IP 10.10.10.20  Gateway 10.10.10.1

Its network settings had never been visible before — the connection had never been started.

The "connection is stopped" banner added an hour earlier is gone with the limitation that caused it.
In its place, the case that actually needs saying: **`Encoder 2 unreachable at 10.10.10.20:6000`**,
in red, gone after five seconds. Gone from the network is a different problem from a value being
refused, and only the first is worth the top of the window.

### Every banner closes now

`dismissible: false` is removed. Three notices used it — the startup failure, the read-only profile
warning, and the flash-write warning. **A notice nobody can clear is a notice that gets ignored**,
and the flash one had already been seen sitting on screen describing a write that had finished.
Importance belongs in the wording and the colour, not in trapping it. `ttlMs` makes a banner
self-closing, and `toast` is now just a banner with one.

**185 tests pass;** audits clean on all five screens.

## 2026-08-04 — Two facts about an encoder's address, and one field for both

> "Can me make sure the existing connections ip also gets changed after the change gets confirmed.
> Question if the ip changes would we know, since the confirm would come on a new ip/tcp socket?" /
> "how do we approach the stuctual design when we change ips and want the connection to also change,
> but we have to power cycle?" / "do both"

**The confirmation comes back on the same socket.** The manual: *"The IP-address will only be
activated after a new power-up."* The device keeps answering where it was, so the acknowledgement
and everything after it arrive on the session the write went down. Nothing is lost.

That fact is the whole design problem, and the first attempt got it backwards.

### Two facts, one field

Between programming an address and power-cycling the device there are two different truths — where
it answers **now**, and what it will answer on **later**. `encoder.host` was made to hold both: on a
verified write it was set to the new address, with the old one kept as a fallback. Measured on the
rig within a minute:

    saved host:     10.10.10.30   ← no reply
    device answers: 10.10.10.20
    Read →  EUNREACHABLE: Encoder 2 is unreachable at 10.10.10.30

The connection named a machine that would not exist until somebody walked to the rack.

**`host` now always names where the encoder answers, and is never changed by a write.**
`pendingHost` holds what has been programmed. Both are tried, pending first, so reads and writes
work on either side of the power cycle. **Promotion happens on evidence** — the pending address
answered, so the power cycle has happened — and then it becomes `host` and pending clears. Starting
a link probes the pending address first, so Start works without anyone knowing which side of the
power cycle they are on.

Shown rather than hidden, because the person who power-cycles it may not be the person who typed it:

    Connections      Encoder   10.10.10.20:6000 → 10.10.10.30
    Encoder Config   10.10.10.20:6000 · via 10.10.10.2   → 10.10.10.30 after power cycle

### The commit broadcast is not evidence

An IP write on this firmware is accepted, stored, and **never announced** — measured: no
`Parameters successfully written!` in thirty seconds, while the value read back had changed. Waiting
for it reported "write status unknown" for a write that had plainly worked.

So a one-shot write now **reads the value back** before letting go of the socket. That is stronger
evidence anyway: the broadcast says something was committed, a read-back says *this* was. A value
that does not stick is reported failed rather than successful, and the address is adopted only when
the read-back proves it.

### Also

Hardware switch 2 forces the factory address regardless of what is programmed, so a power-cycled
encoder may come back at `10.10.10.10` rather than the new address. The log says so when a pending
address is recorded. The factory address is deliberately **not** probed automatically — on this rig
it belongs to another encoder, and connecting to it would read one device's settings into another's
card.

**195 tests pass.**

---

## 2026-08-04 — The address change, proven on hardware

The power cycle happened on the rig. The promotion worked first time, unattended:

    before:  host 10.10.10.20   pending 10.10.10.30
    read  →  IP = 10.10.10.30
    after:   host 10.10.10.30   pending —

    18:22:00  Encoder2  tx  opened a one-shot session to 10.10.10.30:6000 (connection is stopped)
    18:22:00  Encoder2  tx  read IP
    18:22:00  Encoder2  rx  IP=10.10.10.30
    18:22:00  Encoder2  --  now answering at 10.10.10.30 — address change applied

The pending address is tried first, so the first read after the power cycle costs nothing extra and
the promotion needs no timer, no probe loop and no button. Encoder 2 is streaming at its new
address.

---

## 2026-08-04 — Two smaller things in the way of reading

> "longer words like error and warning have a line break in logs, can we fix that so we have more
> space for longer categories" / "in encoder config on encoder tile remove read 13 of 14 variables
> tip/text/indicator" / "if anything does not read, i can see that in the log"

**The log's level column was 26px.** Wide enough for `TX` and `RX`; `ERROR` split across two lines,
which made a fault the one entry in the log that was hard to read. Measured at the live font:
TX/RX 14px, WARN 27px, ERROR 34px. The column is 56px and never breaks — `.logline` breaks words by
design for the *message*, so the label has to opt out of it. Checked at 1440 and 390.

**The config card's status text is gone.** It said `read 13 of 14 variables` after every read, and
`unreachable` or `read failed` when one did not land. All three duplicated something already on
screen: the values themselves appear in the table, and every read, reply and failure is in the log
with a timestamp and a direction. The unreachable banner stays — that one is an interruption, not a
status.

---

## 2026-08-04 — Expanding a config group pushed the card out of the window

> "in Encoder Config, Once expanding certain setting parts, breaks the adaptive design and content
> becomes unreachable / out of bounds, Needs a fix."

Four columns need about 620px, and `.vartable` said so with `min-width: 620px`. That number did not
stay in the table. **A grid item's automatic minimum size is its content's minimum**, so the floor
under the table became a floor under `.cfg-card` — every expanded card measured ~628px wide whatever
the window was:

     860px    card overflows the content area by 12px
     480px    card 180px past the viewport, header and buttons with it
     390px    card 270px past the viewport

Only the table had been given somewhere to scroll, so the parts pushed out — the encoder's name,
Read, Revert, Apply changes, the address — were simply unreachable.

**The card may now shrink, and below 860px the table stops being a table.** Each variable becomes a
stacked block: name and variable on one line, the encoder's value, the control, the help. There is
no width to be short of. A horizontal scrollbar was the other option and is the wrong one — these
settings are the content of the screen, not an oversized figure inside it.

Two details worth keeping: each column carries its own `width`, which outranks a bare `td` rule and
kept the value boxed into 130px with the full row free beside it; and stacked, an unheaded value
under a name reads as the field's rather than the device's, so it says `on the encoder:`.

### The check could not have caught this

`uicheck` audits what is laid out, and a folded `<details>` is not laid out — so the config groups,
which are **all folded by default**, had never been measured at any width. `--expand` opens every
one before auditing. `layout-invariants` gained a test that fails if either half of the fix is
removed, verified by removing each half in turn.

**196 tests pass**, and every view is clean at 1440 / 1024 / 860 / 720 / 480 / 390, folded and
expanded.

---

## 2026-08-04 — Each name carries its own address

> "dashboard tiles changes, make the name non clickable, we dont need a link here to controls,
> already have the button. Connect the ip to each name and status indicator. Status indicator for
> disguise should be receiving not sending. remove the firmeware from the dashbaord."

**The name is a label again.** It was a button opening the controls, duplicating the Controls button
two inches to its right. `.card-name` keeps the typography; only `button.card-name` gets the pointer
and the hover underline, so a name that does nothing no longer promises a click. Connections still
has a clickable name and was left alone.

**Every name now sits with its address.** The encoder's, beside its own pill; each destination's, on
the pill that reports it. A card with two destinations reads:

    Revolve  10.10.10.10:6000  [streaming]   [10.10.10.5:6000 · id 1  receiving]

**`sending` became `receiving`,** renamed in `destinationHealth` rather than translated in the view,
so the word means the same thing from the core to the screen. It also now reads consistently with
the pill beside it: one says a device is streaming, the other that a machine is receiving.

**The firmware tag is gone from the dashboard.** It remains available per encoder in the config
screen.

### What was removed with it

The `card-target` line — `10.10.10.10:6000 → 10.10.10.5:6000 · id 1  +1 more` — said nothing the
header did not now say, except the disguise device id, which moved onto the pill. Keeping it would
have printed every address on the card twice. `targetLine`, `targetTitle` and `destsOf` had no other
callers and went with it, as did the `.fw-tag` and `.card-target` rules.

**196 tests pass**, dashboard clean at 1440 / 900 / 390.

**The pill wording needs the server restarted** — `destinationHealth` runs in the bridge process, so
a running instance keeps saying `sending` until it is restarted.

---

## 2026-08-04 — One row of devices, each labelled the same way

> "leave the ip under the name, keep the names for the sending devices" / "looks like the indicator
> now is the whole thing, keep it seperated. Name, indicator - ip & id below" / "keep them
> horizontaly at the same level dont move the servers under encoder" / "only if needed for narrow
> adaptation move them under each other"

Revises the entry above, which had put each address inline beside its name and folded the
destination's name and address into the pill itself. Two things were wrong with that: the address on
the name's line broke the column the eye scans down the page, and a pill containing a name, an
address and a device id is no longer a status light — the whole block read as one badge.

**Every device on the card is now built the same way** — name and indicator on one line, address and
device id beneath — and they sit in one row: the encoder first, then each machine it feeds.

    Revolve  [streaming]      disguise 1  [sending]
    10.10.10.10:6000          10.10.10.5:6000 · id 1

    Encoder 2  [streaming]    director  [sending]        US  [sending]
    10.10.10.30:6000          10.10.10.5:6000 · id 10    10.10.10.2:6000 · id 10

The row is the sentence — this device, feeding these machines. Stacking the destinations under the
encoder read as though they belonged to something above them.

**`flex-wrap: wrap` is the entire adaptive rule.** Side by side while there is room, under each other
only once there is not. Measured: the encoder and all its destinations share a top edge at 1440,
1100, 900 and 700; at 480 only the card with two destinations wraps, and the one with a single
destination still sits level; at 390 both wrap.

The destination names are the operator's own — "director", "US" — and lead, because that is what
they call the machine. The address below says which one that is. `refused` and `offline` keep their
explanation on hover.

**196 tests pass**, every view clean at 1440 / 1024 / 860 / 720 / 480 / 390, folded and expanded.

---

## 2026-08-04 — There is no default; there is what the encoder says

> "there is no default, there is a now and a change, we dont compare to a profile, profil is the
> state it has, we only change something if we realy change something"

The log kept reporting changes nobody made:

    19:11:23  Revolve    warn   field layout changed on the encoder: POSITION_VELOCITY_TIMESTAMP
    19:11:23  Revolve    info   scaling changed on the encoder: 300000 counts, 8192/rev
    19:13:34  Encoder 2  info   cycle time changed on the encoder: 18 ms

Nothing had changed. Every new profile was seeded with nameplate figures — `countsPerRev: 8192`,
`totalCounts: 33554432`, `cycleTimeMs: 10` — and the first read of a commissioned encoder differed
from them, so it was announced as a change. The rig's own numbers are 300,000 and 100,000 counts and
an 18 ms cycle; none of those had ever been in a profile.

Worse, the value was learned into memory only and never written back, so **every restart forgot it
and re-reported the same non-change.**

- **`encoderMeta` starts null.** Before the encoder answers we do not know these, and a guess in the
  field that is meant to hold the device's state is what created the problem.
- **The first answer is state, not a change** — adopted silently, and logged as an observation by the
  lines that already existed for that (`scaling from encoder: …`).
- **A change is a difference from something we already had**, which means somebody really changed it.
- **What the device reports is persisted**, so a restart does not relearn it. `service.js` saves on
  the `encoderMeta` event without re-syncing the link — it already holds the value, and pushing the
  config back would restart a running connection to tell it what it just told us.
- **Schema 2 → 3 clears `encoderMeta` on load.** Every value on disk today is fabricated by
  definition, because no code ever wrote what a device reported. Discarding a guess is not data loss.

Where a number is still needed before the encoder has spoken — the stall watchdog's timer, the
divisor for degrees and revolutions — the nameplate figure is used for the arithmetic and named as a
starting point, while what is *reported* stays null until the device says otherwise.

Three tests in `live-reconfig.test.js` own this: a first observation is not a change, a real change
is reported as one, and the same value twice is not an event. Verified by restoring the old
unconditional logging, which fails them.

**199 tests pass.**

---

## 2026-08-04 — The log says what actually happened

> "we need the real thing in the log, we need to know when our app is writing in the log, when cli
> encoder communication happens, we need more pure information in the log. Dont swallow thing up and
> redesign outputs in the log" / "traffic between encoder should be rx tx, we should have make sure
> that app/system log entries are marked diffrently and are recognisable" / "most events like adding
> a connection edits like ports/ ips interface picks changing Velocity from zero to From encoder, all
> this should print in log input and output" / "navigating the menu needs no log entry, But
> siginficant actions should have a log entry"

`rx` and `tx` had been handed out to anything vaguely encoder-related, and an interpretation was
logged **instead of** the line it came from:

    tx  read CycleTime
    rx  cycle time changed on the encoder: 18 ms      ← the app talking, marked as the device

The encoder's own `CycleTime=18` appeared nowhere. Now:

    tx  read CycleTime
    rx  CycleTime=18
    app cycle time from encoder: 18 ms

### Four sources, and only two of them are the wire

| | |
|---|---|
| `rx` | a line the encoder sent, verbatim, at its own severity — `ERROR: unknown command` arrives as an error, not as an info line containing the word |
| `tx` | a line written to the encoder, verbatim |
| `app` | what this app concluded, decided or did: state changes, interpretations, the watchdog |
| `user` | an operator action |

Every non-sample line the encoder sends is now logged. Samples are not, and never were: at ~100/s
per link they would bury everything else. `logRaw` — settable only by hand-editing a profile, and
with no reader left after this change — is gone.

The source and the level are separate columns. One column showed the source for info lines and the
level for the rest, so a warning **from** the encoder was indistinguishable from a warning **about**
it.

### Operator actions, with both values

    user  added connection "Encoder 2" — encoder 10.10.10.30:6000, to 10.10.10.5:6000 id 10
    user  edited "Encoder 2": velocityPolicy zero → passthrough
    user  start
    app   [connecting] connecting to 10.10.10.30:6000

Before and after, always: "what was it before" is the question asked after a show, and a log with
only the new value cannot answer it. The diff walks the whole connection, so a port, an IP, an
interface pick or a destination change is caught without anyone listing the fields. Navigation is
not logged — it never reaches this layer, and nothing happened to the show.

### The log was dropping lines

`maxPerFlush` was 25, sized for a raw-sample firehose that does not exist. Reading two encoders'
config is ~56 lines inside a few milliseconds — one tick — so 31 were dropped and the log became
incomplete exactly when it was busiest. It is 400 now.

When it does bite, it says so **as a log line** rather than as a note beside the toolbar: a gap in
the log belongs in the log, where it is read and where Export preserves it. The lines themselves
were never lost — they are in the ring buffer that Export reads.

The log's controls moved into the page header card, as on every other screen.

**199 tests pass.**

---

## 2026-08-04 — The dropped-lines note, and an ellipsis that promised a dialog

> "whats that text? 36 lines dropped (rate limited)" / "it ended up next to the button below the
> header area" / "nothing should print there, either its a banner notification or it goes in the
> log" / "also move all button into the log header and not below, following our conistent layout on
> all other pages." / "also remove the "..." from Export button. Looks stupid."

The note is gone from beside the buttons. A gap in the log is now **a line in the log** — where it is
read, and where Export preserves it, which the note never was. Verified: the log header ends at
Export with nothing after it, and the view holds no reference to `dropped` at all.

`test/log-sources.test.js` owns this now — a two-encoder config sweep arrives complete (56 of 56), a
cap that does bite is announced once as an `app` warning on the following tick and never talks about
itself again, the ring buffer keeps every line Export reads, and a link state change is marked `app`
rather than claiming to come off the wire. Verified by restoring the old cap of 25 and by removing
the notice, each of which fails it.

The log's controls sit in the page header card, matching every other screen.

**The ellipsis is gone from Export.** It is the convention for "this opens a dialog", and since these
became Blob downloads there is no dialog — the promise was false. `Export Profile` and `Import
Profile` in Settings said the same thing and were corrected with it. `Delete connection…` in
`detail.js` keeps its ellipsis: it does open a confirmation.

*(Corrected below: `detail.js` is not dead. It exports `openControls`, which both `connections.js`
and `dashboard.js` import — it is the Controls popup. The grep that said otherwise searched for
`views/detail` and the imports read `./detail.js`.)*

**204 tests pass.**

---

## 2026-08-04 — Every banner is a log entry

> "do all banner notification also write a log entry now?" / "yes we want that banner = log entry"

They did not. Three of nine did, and those three only by accident of where they originated — the
event happened to come from `encoder-link.js`, which logs. The five raised by the client left no
trace at all:

| banner | before |
|---|---|
| encoder unreachable on read | nothing |
| **FLASH WRITE IN PROGRESS — do not power off** | nothing |
| **write status unknown — the encoder did not confirm** | nothing |
| profile load warning | log *file* only, never the ring the Log screen and Export read |
| profile is read-only | nothing |

The flash pair is the serious one. It is the single moment where losing power damages the device's
configuration, and it existed only as a banner in whichever browser pressed the button — an exported
log showed the `set` going out and nothing about the risk window.

**A banner cannot log its own line.** It is drawn in one browser, and a line logged there exists only
in that browser and never reaches Export. So each is answered on the server, where the operation
actually happens:

    user  added connection "Ghost" — encoder 10.10.10.99:6000, to 127.0.0.1:6000 id 99
    app   flash write started — do not power off — CycleTime=25
    app   flash write status unknown — no answer at 10.10.10.99:6000; read the encoder
          before power-cycling it
    user  deleted connection "Ghost" — was encoder 10.10.10.99:6000

Measured against a host that does not exist, so no encoder flash was touched. A successful write logs
`flash write confirmed`, and a partial one names the variables that were not verified.

`promoteIfAnswered` also stopped pushing `dir: null` and is `app` like every other line the app writes
about itself.

### Keeping it true

`test/banner-log-parity.test.js` holds the inventory: every `banner()` call site in the web sources
mapped to where its log line is written. **Adding a banner fails the test** until its line exists and
is recorded — verified by adding one, which fails, and by rewording the flash-risk line away, which
also fails. One honest exception is written down as such: `Could not start: …` fires when the client
cannot reach the server, so there is nothing to log to.

Live testing caught a defect in this very change — `flash write started … undefined=25`, because
`checkVarWrite` returns `variable`, not `name`.

**206 tests pass.**

---

## 2026-08-04 — Auditing the rest of the profile for invented values

> "we started this whole debug session with talking about the profil, and the problem that there were
> certain default values placed, without the fact that there are default values. Is this fixed and
> values are either new/empty, real/read/actual or changed/future?"

The earlier fix was scoped to `encoderMeta`. Auditing every field a new connection is given found two
more of the same class, both fabricated facts about a device nobody had spoken to.

**`parser.outputType: 'ASCII_SHORT'`** — claimed on every new connection whatever the encoder was set
to. Its only consumer was the validator re-asserting the same default: **nothing reads it**, because
the parser recognises both ASCII and ASCII_SHORT from the line itself. Null now. The field is kept
only because removing it is a schema change; it is a candidate for deletion.

**`mapping.maxInput: 33,554,431`** — the nameplate again, on a rig whose encoders report 300,000 and
100,000. Only mode `capture` reads it, and capture means "the span the operator recorded" — nothing
had been recorded. A capture started on Revolve would have been 111 times too wide. It is `0`, and
`full` and `revolutions` derive their span from what the device reported, as before. This is the
same number that once drew the travel bar at 0.62% of its track.

### The three states, as they now stand

| | field | |
|---|---|---|
| **new / empty** | `encoderMeta.*`, `parser.outputType`, `parser.fields`, `mapping.maxInput` | `null` / `0` until the encoder answers |
| **real / read** | the same fields once read | written by the device only, and persisted, so a restart does not relearn them |
| **changed / future** | `encoder.pendingHost` | programmed and verified, inert until a power cycle, promoted on evidence |

`pendingHost` is the only future-valued field, and correctly so: an IP is the one variable whose write
does not take effect until the device is restarted. Every other setting applies at once, so there is
no future value to hold.

The remaining defaults are the operator's own settings — `velocityPolicy`, `udpSendPolicy`,
`autoStart`, reconnect delays, the factory IP a new connection form starts from. Those are choices
this app makes on the operator's behalf, not claims about hardware, and they belong in the profile.

A test states the rule, verified by restoring each fabricated value in turn.

**207 tests pass.**

---

## 2026-08-04 — The log names the connection, not its UUID

> "can we change in the log the "c9a36e2b-9167-4751-94a0-08eab3356218" to an actuall meaningful name?
> short precice" / "i dont care what it is, i dont undsertand "c9a36e2b-…" so it needs to be
> something i understand like "delted UID""

The log view resolved a line's id against the **current** connections. Delete one and every line it
ever wrote fell back to a raw UUID — precisely when the log is being read to find out what happened
to it. Export was worse: it printed the id unconditionally, so an exported log was a column of UUIDs
whatever the connection was called.

**The name is stamped when the line is written**, by whoever writes it — the link from its own
config, the API from the store. That survives deletion, and it is the more truthful record besides:
rename an encoder and yesterday's lines still say what it was called yesterday.

    user Trap Lift    added connection "Trap Lift" — encoder 10.10.10.99:6000, to 127.0.0.1:6000 id 99
    app  Trap Lift    read failed — no answer at 10.10.10.99:6000
    app  Trap Lift    [idle] stopped
    user              deleted connection "Trap Lift" — was encoder 10.10.10.99:6000

When no name is known — lines written before this existed — it says **`deleted`**, in words. A
shortened UUID was tried first and rejected, correctly: `c9a36e2b…` is no more readable than the
whole thing. What the reader needs is the fact, not the identifier. The full id is on the tooltip for
the rare case anyone wants it.

Export follows, with the direction padded into a column of its own:

    2026-08-04T20:53:15.067Z [info] rx   Revolve Software Version 4.50
    2026-08-04T20:53:15.067Z [info] app  Revolve firmware 4.50

**207 tests pass.**

---

## 2026-08-04 — Delete and stop, and a line written before the thing happened

> "we delete connections under control, thats an action that should 100% log" / "same with stoping a
> connection"

Both already logged. Two things were wrong with how.

**A deleted connection lost its name.** The line was written with no id, so the source column was
blank while every other line named its connection — and the name only survived inside the sentence.
It is named explicitly now, because by the time the line is written the connection is out of the
store and cannot be looked up. That is the one line whose name matters most: the last that connection
will ever have. It carries where it was sending, too, and is a `warn` — deleting is not routine.

    user  Trap Lift   deleted — was encoder 10.10.10.99:6000, to 127.0.0.1:6000 id 9

**`linkStop` logged before it checked.** A connection the manager had never heard of produced a
`stop` in the record and then an error to the caller — an action written down as having happened when
it could not. It is checked, then logged, then done: never a false record, and still cause before
effect, so the log reads as the operator pressing Stop and the link responding.

Four tests cover the operator's actions against a real store and manager rather than a stub: start
and stop are logged and named, a stop that cannot happen logs nothing, a delete keeps its name, and
an edit records both values.

### Correction

An earlier entry called `detail.js` dead code, twice. **It is not.** It exports `openControls`, which
`connections.js` and `dashboard.js` both import — it is the Controls popup, and the only place a
connection can be deleted from. The grep that said otherwise searched for `views/detail` while the
imports read `./detail.js`.

**211 tests pass.**

---

## 2026-08-04 — Stop All stopped things that were not running, and the log went quiet when it mattered

> "encoder 2 was never started" / "stop all still works even if all connections are stoped" / "stop
> all and start all should only stop and start encoders that arent in that state already" / "also
> logs dont auto updated only on cmd+r?" / "it gets there after a cmd+r" / "what makes more sense
> updating log whenever an entry is made or x amount per sec?"

Reported from the rig:

    23:05:34  user  stop all (2 connections)
    23:05:34  app   Revolve    [idle] stopped
    23:05:34  app   Encoder 2  [idle] stopped     ← never started
    23:06:10  user  stop all (2 connections)      ← nothing was running

**`stop()` tore down and announced regardless of state.** A link that had never been started went
from IDLE to IDLE and emitted `[idle] stopped` — a state change in the log for something whose state
had not changed. It now returns early when the link is idle *and holding nothing*, and reports
whether there was anything to stop.

The resource check is not decoration. A link can be idle with a socket or UDP sink open —
`_openUdp()` runs before `_connect()` sets CONNECTING — and a coarser `state === IDLE` guard leaked
the handle. Caught immediately: five test files stopped exiting at all, because their cleanup relied
on `stop()` to release what `_openUdp()` had opened.

**The counts describe what happened.** `stop all — stopping 1`, or `stop all — nothing was running`,
rather than counting the connections that exist.

### The log went quiet exactly when it was needed

`_tick()` drains the log to clients, and its timer **stopped whenever no link was running**. So with
everything stopped, lines were written and never sent: stopping a connection, editing one, deleting
one, a failed read — all invisible until something started again, or until a reload, which re-reads
the ring buffer directly. That is precisely when an operator is reading the log to find out what
happened.

**Batched delivery is right; tying it to links running was not.** An encoder sweep is hundreds of
lines inside a few milliseconds and a screen shows sixty frames a second, so per-line delivery costs
a message and a repaint to display nothing extra. The batching now follows the lines rather than the
links: a line arriving while idle wakes the drain, and the timer stops again once it is empty — an
idle rig holds no wakeup open.

Measured, with nothing running: 17 lines → 18 the moment Stop All was pressed, → 49 after Start All.

**214 tests pass.**

---

## 2026-08-04 — Pause froze the recording, not just the window

> "the Pause log, should stop new sending lines, resume should show all lines since stoped, but it
> doesnt, they only appear after a cmd+r for me"

`ingestLog` returned early while paused, so lines arriving during a pause were **discarded**, not
held. Resume showed nothing that had happened, and the missing lines reappeared only after a reload —
which re-reads the server's ring buffer directly, the same reason a reload appeared to fix the
auto-update problem.

Pausing to read something and losing what arrived meanwhile is the opposite of what the button is
for. Pause now freezes the *window*: the buffer keeps filling, and `refreshLive` is what stops.

Measured: 52 lines, paused, a stop-all and start-all run through — still 52 while paused, 84 the
moment Resume was pressed.

The 2,000-line render cap still applies, so a very long pause loses the oldest lines from the view.
The server's ring buffer holds 5,000 and Export reads that.

**215 tests pass.**

---

## 2026-08-05 — Pause, with another client working

> "i click stop on my client, Another client on the webinterface does stuff, I click resume on my
> client, nothing shows up. Only when i cmd+r" / "i want that every client can control der own log,
> but it needs to catch up properly after resume"

Two defects, found in that order.

**The first was mine from an hour earlier**: the running app still served the JS from before the
Pause fix, because that landed after the last restart. Restarting was half the answer.

**The second was real, and the reverse of the reported symptom.** Pause had become a boolean the live
loop consulted — but the view re-renders for reasons of its own, and a link changing state
re-renders the whole screen. Every rebuild ends in a repaint, so the moment another client started or
stopped anything, new lines appeared *through* the pause. Measured: 47 lines, paused, another client
ran stop-all and start-all — the window grew to 50 while it was supposed to be frozen.

**Pause is now a point in the stream rather than a flag.** `visible()` bounds what is shown by the
sequence number of the newest line held when Pause was pressed, so the freeze holds however the
repaint was reached. A sequence number rather than an index, because the buffer is trimmed from the
front and an index would slide onto the wrong line.

Measured again, with a separate client stopping and starting every connection during the pause:

    before 81 · while paused 81 · after resume 115

**Pause is per client and stays that way.** It is view state in one page and never leaves it, so one
operator freezing their window to read something does not freeze anyone else's.

**215 tests pass.**

---

## 2026-08-05 — A one-second average, shown as a whole number

> "lets fix HZ, we set it to 10 sec avg, change that to 1sec, Change the next 10th to the next full
> number instead." / "yes <1"

`RATE_WINDOW_MS` is 1000. At ten seconds the figure was steady but slow to admit anything had
changed — a connection that stopped delivering kept reading near its old rate for several seconds.
One second still averages about a hundred samples at a normal cycle time, so it holds still without
lying about the present.

`hz()` shows the whole number. Rounding to the nearest ten turned 98 Hz into 100 and hid the
difference between a link at 96 and one at 104. Something that rounds to zero still says `<1`,
because "nothing is arriving" and "a trickle is arriving" call for opposite responses and a bare 0
claims the first.

### Shortening the window broke the rate, and nothing failed

The guard against too little history was `if (span >= 1)` — a fixed second, written when the window
was ten. Shortening the window to one capped the span at exactly that, so it sat on the threshold and
mostly fell under: **every link read 0 Hz while delivering a hundred packets a second.** Caught by
looking at the running app, not by the suite.

Two fixes. The oldest sample is dropped only while the *next* one is still beyond the window, so the
retained span covers the window instead of falling short of it; and the minimum is a proportion of
the window rather than a fixed second, so the two cannot drift apart again.

**The test that was missing now exists**: a link fed a known 100 packets/s must report about 100 Hz.
Its cadence matters — the first version ticked at exactly 100 ms, landed the span on 1000 ms, and
passed against the broken code. At the real telemetry rate of ~33 ms it lands just under, which is
exactly why the rig showed 0 while a tidier clock saw nothing wrong.

Measured on hardware after the fix, three samples two seconds apart:

    Revolve    99.1 / 99.7 / 98.2 Hz     (10 ms cycle)
    Encoder 2  rx 55.4 Hz, tx 110.8 Hz   (18 ms cycle, two destinations)

**217 tests pass.**

---

## 2026-08-05 — The rate stops twitching

> "hz number jidders, the average over one sec should stop that but it doesnt can we smooth the value
> this?" / "yes A and B"

The one-second average is steady. Painting it thirty times a second was not: every telemetry tick
recomputes it, each recomputation slides the window by one sample, and with integer counters that
moves the result a packet or two either way. So a whole-number readout flickered 98 / 99 / 100
continuously. Rounding to the nearest ten had been hiding it.

The measurement was never wrong, so it is untouched. Two gates on the **display** only:

- **how often** the shown figure may change at all — twice a second
- **how far** the real value must move before it is worth changing — 2 Hz

A slow drift still gets through, because the comparison is against what is shown: successive small
moves accumulate until they clear the band. Verified against a fake clock:

    jitter 99 / 98 / 100 / 99 / 101 / 98     shown 99 throughout
    a real change to 55                      shown within 200 ms
    a drift 100 → 105                        tracked, within ±1
    a stop                                   shown at once

That last one is a deliberate exception: a value at or returning from zero lands immediately, because
"it stopped" is the one change nobody should wait half a second to see.

Applied to every rate in the UI — both dashboard totals, each card's RX / TX, the connection rows and
the footer. A steadied dashboard beside a twitching footer would just look broken.

Measured on the rig: the card's rate held one value, `98 / 98 Hz`, across sixty samples over six
seconds — zero changes, where before it changed on nearly every frame.

**218 tests pass.**

---

## 2026-08-05 — What Preset and Offset actually are

> "on encoder config we still have preset and offset. Both have a field to enter values. I think thats
> wrong, only preset should have a field to enter a value, off set gets calulated after the facted,
> Chech whats actually true and if we need to adjust the design and layout."

Checked against the device rather than assumed:

    read Preset   → ERROR: Preset is an unknown variable.
    read Offset   → 43156

**Preset is write-only.** You give it the value the shaft should read at this moment; the encoder
computes an internal offset and applies it to every position after that. It can never be read back.

**Offset is readable and writable.** The manual is explicit — *"Directly changes the offset that the
preset function calculated and set."* So the instinct is half right: Offset **is** the calculated
result of a Preset, and it is also a documented input.

**The input stays**, because removing it would remove a capability with no substitute: a Preset only
works when the shaft is physically at the reference position. Writing the Offset sets the same zero
without moving anything — which is what a replacement encoder, or a rig that cannot be turned by hand
to its datum, actually needs.

### What was wrong was the presentation

Preset's *current value* column showed `—`, exactly like a variable that had not been read yet, next
to an Offset showing a number. Two fields that look identical where one can never show its value.

It says **write-only** now, in the sans face rather than the monospace used for values — because it
is a property of the variable, not a reading — with the reason on hover: it cannot be read back, and
its effect is visible in Offset. In the stacked narrow layout the `on the encoder:` prefix is
suppressed for it, since there is no value on the encoder to state.

**218 tests pass.**

---

## 2026-08-05 — Reading the manual properly, and what it says about Preset

> "why is pdf rendering not availble? open the pdf in chrome and read there or find a pdf reader for
> CLI"

Fair challenge — the earlier answer gave up at "no PDF renderer". `brew install poppler` provides
`pdftotext`, and `pdftotext -layout` turns the manual into 1,021 usable lines. Worth having: this is
the reference document the whole config screen is derived from, and it had been read only second-hand
until now.

**Verbatim, §5.6.2:**

> **Preset** — "When the preset is set, an internal offset will be calculated, which will be saved and
> added to all position values afterwards. The value given for the preset denotes the position value
> the encoder will show at the point where the preset was set. Please note the FAQ for important
> information!"
>
> **Offset** — "This variable makes it possible to directly change the offset calculated and set by
> the preset function."

**FAQ 1**, which the pointer above leads to:

> "The Preset value will save in the flash of the encoder. This flash has only writing cycles of
> 100000 times… So we fix it that it is not possible to save the same preset value for more than one
> time. The next preset value must be different, but can use in the next but one. I.e. Preset value is
> 0. Then set in the first time 0, in the second 1, in the next one 0, …"

So Offset keeps its input, as established. But the manual makes Preset the odd one out: it is
write-only, it costs a flash cycle, and **the same value twice in a row is refused.**

### The rule is implemented — on one of the two paths

`EncoderLink.setPreset()` knows all of it: it reads the current value where it can, throws
`EPRESET_DUPLICATE` rather than burning cycles by surprise, and offers the documented way round —
write `value + 1`, await the commit, write `value` — at two cycles, only when asked. The Controls
popup's **Zero / Preset 0** uses it.

**The Encoder Config table does not.** Its Preset field is an ordinary row, and Apply sends it through
`encoderWriteMany` like any other variable. That path knows nothing about the alternating rule, and
its verification reads the value back — which for a write-only variable can never match, so a Preset
written there is reported unconfirmed **even when it worked**.

Recorded rather than changed: routing it correctly is a decision about flash cycles.

---

## 2026-08-05 — A ReferenceError in the send path took the whole bridge down

> "A JavaScript error occurred in the main process — Uncaught Exception: ReferenceError: dest is not
> defined at EncoderLink._forward (encoder-link.js:618) … when i installed tailscale, maybe the vpn
> part caused that."

The VPN did cause it, but only by being the first thing ever to exercise the branch.

`_forward` announced a destination's recovery as `this._announceRecovery(sink, dest)`. `dest` exists
only inside `_openUdp`'s `for (const dest of …)` loop, where the *other* call site lives — in
`_forward` the name is simply not there. It is `sink.dest`, which the same function uses ten lines
later to build the packet.

A ReferenceError rather than a wrong value means the branch had **never run**. Reaching it needs a
destination to go offline, then a probe to go unanswered for long enough to count as recovered.
Installing Tailscale changed the routes under a running link, which is exactly that sequence. Uncaught
in the main process, it takes the bridge down with the encoder still streaming.

### Why the tests missed it

Every test in `unreachable-destination.test.js` drives the sink's own error and success callbacks —
the `_openUdp` path, where `dest` is in scope and the code is correct. Nothing drove the probe path in
`_forward`. There is now a test that puts a sink in exactly that state and calls `_forward`, verified
by restoring the bug, which fails it.

### Whether there were others

A one-off `no-undef` pass over the whole codebase — `src/core`, `src/server`, `src/shared`,
`src/desktop`, `tools` and `src/web/js` — reports **nothing else**. The same pass flags this bug when
it is put back, so the result means something. `CSS.escape` in `ui.js` came up and is a genuine
browser global, supported in all three engines.

Worth considering as a permanent gate: this class of defect is invisible to tests until the branch
runs, and on a show that is the worst possible time to find out.

**219 tests pass.**

---

## 2026-08-05 — A permanent gate against names that do not exist

Following the crash above. `npm test` now runs `eslint .` first and stops if it fails, so a
ReferenceError cannot reach a build:

    npm test with the bug -> exit 1     (the suite never runs)
    npm test clean        -> exit 0     219 tests

**One rule: `no-undef`.** Deliberately not a style config. Everything else is a judgement this
codebase already makes consistently, and a gate that fails on taste gets switched off. This one only
ever fires on code that cannot work — which is exactly the class that tests cannot see until the
branch runs, and on a show that is the worst moment to find out.

It runs **before** the suite, because a name that does not exist cannot be usefully investigated
through a failing assertion further down.

`eslint.config.mjs` covers both halves of the app: CommonJS on Node for `src/core`, `src/server`,
`src/shared`, `src/desktop`, `tools`, `bin` and `test`; ES modules in a browser for `src/web`. The
globals are written out rather than pulled from the `globals` package, so this stays one dependency —
`eslint` is the only thing added. A name goes in that list when the platform genuinely provides it,
never to silence a real miss; `CSS` is there because `CSS.escape` builds the banner's `[data-key]`
selector and is supported in all three engines.

**219 tests pass, lint clean.**

---

## 2026-08-05 — "Receiving" while the cable was out

> "i unpluged the disguise but daschboard still says receiving i dont receive anything"

True, and measurable. With the machine unplugged the sink read:

    10.10.10.5:6000   health=receiving   offline=false   txErrors=404   suppressed=4148

Four hundred send errors and four thousand suppressed packets, reported as receiving.

**The probe test was too weak.** A destination that fails goes offline, then sends one probe every
five seconds. Recovery asked only *"did an error arrive in the second after this probe"* — and a
pulled cable's ICMP can take longer than that. So the probe looked clean, the sink was declared
recovered, the next samples failed, and two seconds later it went offline again. Flapping, with the
pill claiming `receiving` throughout.

Recovery now also requires `RECOVERY_QUIET_MS` with no error at all — the same bar the send-callback
path already used, and the reason that path never flapped. Verified with the cable still out:

    10.10.10.5:6000   health=offline     txErrors=203   ← unplugged
    10.10.10.2:6000   health=receiving   txErrors=0     ← still connected

**Worth stating plainly:** UDP has no delivery confirmation. `receiving` means packets are leaving
and nothing has objected — an ICMP host- or port-unreachable is the only negative evidence there is.
A switch that silently discards traffic would still read as receiving, because nothing anywhere would
say otherwise.

### Two other things in this change

**The Preset and Offset bound follows the device.** `setRange` moved the caption but not the field:
`0 – 299,999` under a box that accepted 1,073,741,823. The input's limit moves with the text now, and
`encoderWriteMany` enforces the real bound server-side from the persisted `encoderMeta.totalCounts` —
a client-side limit is advice, and this one guards a flash write. Unknown scaling is not a licence to
invent a bound: the check applies only once the device has said.

**A test fixture wrote to real hardware.** `store.upsertConnection({ name: 'Revolve' })` with no
address gets `defaultConnection()`'s `10.10.10.10` — a live encoder on this rig — and
`encoderWriteMany` falls through to `writeOffline`, which opens a socket. A test asserting that an
in-range Preset passes validation duly sent `set Preset=299999` to the encoder and moved its zero
point from Offset 43156 to 124642. Every fixture in that file now uses loopback on a closed port:
impossible to reach hardware, and ECONNREFUSED comes back at once.

**221 tests pass.**

---

## 2026-08-05 — Banners close themselves within thirty seconds

> "since banners are all loged they should disapear after max 30 secs"

They do now. A banner is an interruption, not a record: every one is written to the log, and the state
a banner describes — a destination not answering, an encoder in the wrong output mode — is on the
dashboard continuously. Nothing is left for a banner to be the only copy of, and one that sits there
all night is one that stops being read.

The timer used to be conditional on a `ttlMs` being passed, so a banner raised without one stayed
until somebody clicked it. It is unconditional, and a shorter `ttlMs` still shortens but can never
extend past the cap. Measured on the running app:

    no ttl                       → 30,000 ms
    the unreachable notice       →  5,000 ms
    a caller asking for 120,000  → 30,000 ms

Only one banner in the app sets a `ttlMs` at all — the unreachable notice, at the five seconds it was
asked for. Everything else was untimed and now gets thirty.

**222 tests pass.**

---

## 2026-08-05 — Preset routing, and a banner that outlived its own claim

> "lets fix that Preset routing — the config table's Preset still bypasses setPreset" / "the banner
> Revolve: disguise 1 (10.10.10.5:6000) is offline — sends paused, retrying every 5s does not go away
> when i click stop all connections."

### Preset goes the way Preset has to go

Two paths wrote it and behaved differently. The Controls popup used `setPreset`, which knows the
firmware refuses the same value twice in a row and offers the documented two-cycle detour — write
`value + 1`, await the commit, write `value`. The config table sent it through the generic write,
which knows none of that.

`encoderWriteMany` now splits Preset out and routes it through `setPreset`, with the rest going the
ordinary way. The detour stays something asked for rather than assumed: Apply surfaces
`EPRESET_DUPLICATE` as a confirmation naming the cost — two cycles out of about 100,000 — exactly as
Controls does.

**And a write-only variable is no longer reported unconfirmed for failing to read back.** Verification
worked by reading the value back, which for `Preset` answers *"Preset is an unknown variable"* — so
every Preset write was reported unconfirmed, including the ones that worked. Write-only variables are
excluded from the read-back and marked `verified: null`, meaning *cannot be checked*, which the
caller now distinguishes from `false`. The echo of the `set` is the confirmation this variable has,
and it was always being matched by value.

### A banner that said something the app knew was false

*"…is offline — sends paused, retrying every 5s"* stops being true the moment the link stops: nothing
is retrying, because nothing is sending. Going idle now clears that connection's destination banner.

The thirty-second cap would have cleared it eventually, but until then the app was stating something
it knew to be false — which is the same fault as the invented defaults, in a different place.

Reproduced and verified on the rig with the disguise machine unplugged:

    before Stop All   Revolve: disguise 1 (10.10.10.5:6000) is offline — sends paused…
                      Encoder 2: director (10.10.10.5:6000) is offline — sends paused…
    after Stop All    []

Two things learnt while reproducing it, both worth keeping in mind: `toast()` is a banner with a
ttl, so toasts and banners share the strip; and `destinationDown` fires on the *transition*, so a
client that connects after a destination has already failed never sees the banner at all — the
dashboard pill is what carries that state.

**226 tests pass.**

---

## 2026-08-05 — Disguise Mapping, rebuilt around the receiver

> "now we want to redo the whole Disguise Mapping thing, we want a similar layout as the other pages
> like connections and encoder config but for every disguise receiver means when fan out has multiple
> then these should live there to with name ip and id. Then we make sure we have everything for each
> disguise receiving id in each tile."

Decided with the user: **one card per receiver**, and **each receiver owns its mapping**.

### The defect underneath the request

`d3Fields` read `conn.d3.port` and `conn.d3.devid` — the legacy mirror of the *first* destination. A
fan-out to a director and an understudy produced one set of values describing the director, and the
second machine was never described at all. On a redundant rig that is precisely the machine nobody
looks at until it has to take over, and it would have been configured from the wrong device ID and
the wrong port.

`velocitycalcmode` was hardcoded to `from position` as well. That is wrong in both directions and
silently so: deriving from position while a real velocity arrives double-counts, and not deriving
while zeroes arrive leaves the axis with no velocity at all. It follows `velocityPolicy` now.

### Schema 3 → 4: the mapping moves onto the receiver

One encoder can feed several disguise machines and they need not be showing the same thing. The
mapping is a property of the axis, so it lives on the destination; the connection no longer has one.
The migration copies the old connection mapping onto every receiver — identical to what the screen
used to show, and separable from then on. Verified on the reference profile: three receivers, each
with its own mapping, and `mapping` gone from every connection.

Proven end to end through the UI: `US` set to `rotation.y` while `director`, on the same encoder,
stayed on `offset.x`.

### The screen

Structure follows Connections and Encoder Config exactly — a header card with the screen's action,
then a list of cards with retractable groups, folded by default and remembered across navigation.
Each card carries what that receiver needs and nothing about any other:

    disguise 1                                    ● receiving      [Save]
    10.10.10.5:6000 · id 1 · fed by Revolve at 10.10.10.10:6000
    Live position  26 107
    ▸ Input range and output
    ▸ Type these into disguise

The pill is the **receiver's** health, not the encoder's — this card is about the disguise machine.
The live position comes from the encoder feeding it, which is what Capture records. `Save All` writes
one call per encoder rather than one per receiver, so two receivers on the same connection cannot
overwrite each other.

Gone with it: `store.selected`. The screen used to work on whichever connection had last been clicked
elsewhere and said "Select a connection first" when that was nothing — the same implied-target
problem the Encoder Config screen was rebuilt to remove.

### Also found

`<code>` was taking the user agent's `monospace` — a third font family on the page that nobody chose.
It uses `--mono` now. Same class of miss as the form controls: correct-looking markup, wrong font,
invisible until measured. The headless audit caught it.

**230 tests pass**, every view clean at 1440 / 1024 / 860 / 720 / 480 / 390, folded and expanded.

---

## 2026-08-05 — Saying which failure it is

> "also this doest explain why it does not work, Is it possible to tell me that the port is wrong?
> port in connection is 6000, i set it to 8000 in disguise." / "banner can show a little longer, i can
> barly make it out, whats the disapearence time for it?" / "200 packets lost so far. (ECONNREFUSED)
> that part i dont care about"

The message was:

    Cannot reach disguise 1 (10.10.10.4:6000): recvmsg ECONNREFUSED. 263 packets lost so far.

Wrong as well as unhelpful. The machine **was** reached — it answered, saying nothing is listening on
that port. `ECONNREFUSED` on a connected UDP socket is the one failure here with an exact cause and
an exact fix, and it was buried under a word meaning the opposite.

    disguise 1 (10.10.10.4:6000): 10.10.10.4 answered, but nothing is listening on UDP 6000.
    Either disguise is not running, its Navigator driver has not been started, or its port is
    not 6000 — that field defaults to 8000.

    director (10.10.10.5:6000): no answer from 10.10.10.5 at all — switched off, unplugged,
    or not on this subnet.

Four codes are translated — refused, host unreachable, no route, and refused-by-the-OS — and they
stay distinguishable, because they call for different people. Anything unrecognised keeps its raw
message, which is the only place it can be seen.

**Neither the packet count nor the errno survives.** A destination that is not receiving is losing
packets by definition, and the code is the app's own vocabulary, already spent on producing the
sentence in front of it. The running total is on the dashboard, where a figure belongs.

These errors exist at all only because the UDP socket is *connected* — an unconnected `sendto`
discards them, as the 2016 driver did.

### How long a toast stays

4.5 seconds, which is why it could barely be read. That suited "Preset written"; it does not suit
three sentences naming an address, a port and three candidate causes. Toasts now last by kind:

    info   4.5s     read at a glance or not at all
    warn    15s
    error   20s

The thirty-second banner cap still applies above these.

### A test that failed for the message getting better

`destination-health` asserted `/Cannot reach gone/` — the phrasing, not the fact. It checks that the
destination is named and that a cause is given, which is what it was for.

**232 tests pass.**

---

## 2026-08-05 — Asking disguise what it is listening on

> "can you change the port via disguise api of the navigator driver?" / "agree" (to reading first)

**Yes — the port is a writable property.** From the reference, rendered rather than guessed at:

    UdpReceiverDriver
      Base class: ScreenPositionDriver
      Subclasses: … NavigatorDriver …
      Properties:  Port : int
                   ipFromFilter : str       Filter by sender IP. Leave blank for any IP.
                   multicastAddress : str   Multicast Address. Leave blank for broadcast.

`NavigatorDriver` inherits all of it and defines nothing of its own, so `Port` is a documented, typed
property of exactly the object being configured.

Reading first, by agreement. ICMP tells us a machine is there and nothing is bound to the port we
send to; it cannot say which port *is* bound. Designer can, and that turns *"nothing is listening on
6000"* into *"disguise is listening on 8000"* — the whole answer.

    POST http://<host>/api/session/python/execute   { "script": "…" }

The script filters `state.devices` by `UdpReceiverDriver` and returns each one's kind, name, port,
multicast address and IP filter. Its `return` value comes back as JSON.

### On demand, and only on demand

disguise's own documentation is explicit: *"this endpoint MUST NOT be polled"* and *"calling this
endpoint too frequently or during a show is not a supported workflow — this is intended for show
programming tasks, not during production."*

So it is wired to a button on the receiver's card and to nothing else — not the send-error path, not
a timer, not a screen that happens to be open. The first instinct was to answer the ECONNREFUSED
automatically, which would have broken that contract on every failure. **A diagnosis that
destabilises the machine being diagnosed is not worth having.**

The failure modes are kept apart, because they send you to different places: no Designer session on
that machine, an error from Designer itself, a session with no receiver in it, and a session whose
receiver simply sits on another port. Six tests cover them against a stub HTTP server — never a real
machine, for the reason above.

### What it found on the rig

    disguise 1 → 10.10.10.4:  answered 404 — Route not found

Which is itself the answer. `10.10.10.4` serves a web page on port 80 and returns JSON 404s for every
`/api/*` path, so **whatever is at that address, it is not a Designer session** — while UDP 6000 is
refused by the same host. `10.10.10.5` does not answer HTTP at all.

**240 tests pass.**

---

## 2026-08-05 — A 404 that means "your Designer is older"

> "just realsing that api calls on older disguise software dont work, so let me isntall a current
> version of disguise"

Which is what the rig was showing, and the message did not say it:

    10.10.10.4 answered 404 — Route not found

A 404 from a machine plainly serving HTTP means the *route* is absent, not the machine — the Python
API was added to Designer later. Left as a bare status code it invites the reading that the address
is wrong, when the address is fine and the software is old. It now says so, and names the other
possibility in the same breath:

    10.10.10.4 is serving HTTP but has no /api/session/python/execute — this Designer is older
    than the Python API, or what is answering on that address is not Designer at all.

Its own code, `EDISGUISE_NO_API`, so a caller can tell "too old" from "broken".

Nothing else needs to change for a current Designer: the endpoint, the payload and the script are
what the reference documents, and the response unwrapping already tries several shapes rather than
insisting on one.

**241 tests pass.**

---

## 2026-08-05 — Reading a live Designer, and what it turned out to expose

> "new disguise software is installed, Ask disguise gives: Cannot read properties of undefined
> (reading 'inspect')" / "We never want to send any changes from posi3 to disguise through the api,
> only read information" / "if our app sends to an ID that doesnt exist in disguise, It should also
> state that there is no device/Axes with this id in your disguise show"

**The button threw because `inspect` was added to the wrong namespace** — under `mapping`, while the
view called `window.d3d.disguise.inspect`. It has its own namespace now, which is also where the
read-only rule is written down. A test walks every `window.d3d.x.y()` in the view and fails if the
shim has no such namespace, so the next one cannot ship unnoticed.

### Read-only, enforced rather than promised

posi3 never changes anything in a Designer session. The Python API sets `Port` as readily as it reads
it, and that is deliberately unused: a show machine's configuration belongs to whoever is running the
show, and a bridge that quietly reconfigures the thing it feeds is a bridge nobody can trust.

The script is a string, so nothing else would notice it changing. A test forbids assignment to any
device attribute, `setattr`, `del`, collection mutation and resource creation, and asserts the only
names assigned are the script's own locals.

### The object model, read off the running session

The first attempt failed against real Designer — `TypeError: 'DeviceManager' object is not iterable`:

    state.devices                  a DeviceManager, not a list
      .devices                     the devices
        ScreenPositionReceiver     name, path, uid, started, engaged, receiving
          .drivers[]               NavigatorDriver … each with a Port
          .axes[]                  ScreenPositionAxis … each with an id

Which answers how to tell several of anything apart. A **receiver** has a `name` and `path` the
operator chose, and a `uid` that survives a rename. A **driver** has no name of its own, so it is
identified by its port within its named receiver. An **axis** is identified by its `id` — which is
exactly what this bridge puts in every packet.

So a destination joins to disguise as: *on that host, the receiver with a driver on that port,
holding an axis with that id.* Each half can match without the other, and they are different faults —
a missing axis is a whole object nobody created, a wrong port is one field. Both are now reported,
independently, rather than folded into one "nothing matches":

    no axis with id 1 exists in this show — it has id 10; and nothing listens on 6000 — its
    driver is on 8000.

Also decoded: **Designer returns the script's value as a JSON *string*** inside `returnValue`, and a
script error comes back as **HTTP 200** with a status code set — which reads as an empty session
unless you look.

### What it found on the rig

    posi3   engaged=false  receiving=false   NavigatorDriver:8000   axes: id 10, id 1
    → nothing listens on 6000 — its driver is on 8000.

Two problems, not one: the port disagrees, and the receiver is not engaged, so nothing would move
even once it agrees. The axes are already there for both device IDs.

**245 tests pass.**

---

## 2026-08-05 — Naming what to go and look at

> "nothing listens on 6000 — its driver is on 8000. undefined — posi3 on port undefined … It should
> say that no port match and there is a driver on a diffrent port: name driver port number. IF that is
> given and the ID is wrong it should say ID mismatch Driver name port number has axes ids : id1 id2
> id3"

The `undefined` line was the detail list still reading the **old flat shape**. A receiver holds
drivers and axes, so both are listed under its name:

    No port match — this connection sends to 6000, and posi3's NavigatorDriver on port 8000.
    posi3: NavigatorDriver on 8000 · axis ids 10, 1 · not engaged, not receiving

Both problems now name the object to open, not a bare number:

    No port match — this connection sends to <port>, and <receiver>'s <DriverType> on port <n>
    ID mismatch  — this connection sends id <n>, and <receiver>'s <DriverType> on port <n>
                   has axis ids <a, b, c>

The id mismatch is deliberately named against the **driver** rather than the receiver: that is the
object whose axes these are, and the one that has to be opened to add another.

**245 tests pass.**

---

## 2026-08-05 — One problem at a time

> "only show ID part when port is correct, since aslong as i have no port, i dont need to think about
> id … And before all this check if disguise can do API calls if not , just say no api call possible
> with this disguise version. Also your msg says … not engaged, not receiving - not receiving is
> obvious since mismatch … And the axes state is set to engaged, so i dont know where you found that
> they are not."

The checks now run in the order they have to be fixed, and stop at the first:

1. can Designer answer at all — *"No API call possible with the disguise version on 10.10.10.4"*
2. is there a position receiver
3. **does the port match** — if not, that is the whole message
4. **only then, does the device id match**
5. only once both agree, is the receiver engaged

While the port is wrong nothing arrives at all, so the device id cannot be anyone's next question.
Reporting both gave an operator two things to hold when one was actionable.

    No port match — this connection sends to 6000, and posi3's NavigatorDriver on port 8000.
    posi3: NavigatorDriver on 8000 · axis ids 10, 1

`not receiving` is gone from the detail line: while anything mismatches it restates the mismatch.
Where it is the only thing left, the verdict says so instead.

### On `engaged`

Asked of the live session, and worth recording because it contradicted an expectation:

    ScreenPositionAxis   attributes: input, output          — no engaged, no enabled
    ScreenPositionReceiver   started=True  engaged=False  receiving=False

**The axes have no engaged state of their own.** `engaged` exists only on the receiver, and Designer
reported it as `False` while `started` was `True`. Whether that property means what the Engage button
in the UI means is not something this end can settle, so it is now reported as *"Designer reports the
receiver as not engaged"* — what was said, attributed — rather than asserted as a fault, and only
when the port and id already agree so it is the one remaining explanation.

**247 tests pass.**

---

## 2026-08-05 — Three drivers, and what they exposed

> "i added two more drivers. This still shows some some optimization potentials" / "after and, we have
> the first driver? but that one is listed again" / "also i want device name not device typ"

    No port match — this connection sends to 6000. posi3 has Navigator drivers
    nav on 8000 and testdr on 7999.

Three faults, all invisible with one driver.

**It named the first and hid the rest.** `describeDriver` read `drivers[0]`, so "posi3's
NavigatorDriver on port 8000" read as though that were the only one — the wrong impression exactly
when the port you want is on another. Every Navigator driver is named now.

**The port match ignored the driver type.** The session also holds a `PosiStageNetDriver` on 56565,
and matching on port alone would have called that a match if a connection were pointed at it. This
bridge sends `<devid>:<pos>,<vel>;` — the Navigator format — so only a `NavigatorDriver` can do
anything with it. The type is part of the join, and non-Navigator drivers are no longer offered as
candidates.

**The detail line repeated the verdict.** With one driver it looked like context; with three it was
the same list twice. The verdict already names the receiver, its Navigator drivers and their ports,
so the per-receiver line underneath is gone. One statement, and it is the one that goes into the log.

### Drivers are named by `description`

Asked of the live session: a driver has **no `name` attribute**. It has `description` — which is what
the operator typed and what Designer shows — plus `path` carrying the same leaf, and a `uid`:

    NavigatorDriver      description "nav"      objects/navigatordriver/nav.apx
    NavigatorDriver      description "testdr"   objects/navigatordriver/testdr.apx
    PosiStageNetDriver   description "testpsn"  objects/posistagenetdriver/testpsn.apx

So the message says `nav on 8000`, not `NavigatorDriver on 8000`. The type is the same for all of
them and says nothing about which one to open.

**247 tests pass.**

---

## 2026-08-05 — The message, laid out

> "so msg should be layed out as follows: Port mismatch: this connection sends to port 6000, disguise
> ScreenReciever "name" has these drivers: "name" on 8000, "name"r on 7999," / "dont show other
> drivers besides NavigatorDriver type for now" / "what i ment with name is the discription"

    Port mismatch: this connection sends to port 6000, disguise ScreenPositionReceiver "posi3"
    has these drivers: "nav" on 8000, "testdr" on 7999.

    ID mismatch: this connection sends id 3, disguise ScreenPositionReceiver "posi3" driver
    "nav" on 8000 has these axis ids: 10, 1.

Each states what posi3 does, then what disguise has, with every name quoted so it reads as a name and
not as prose. The other branches follow the same shape — `Split across receivers:`, `Not engaged:`,
`Everything matches:`.

**Only Navigator drivers appear.** The session also holds a `PosiStageNetDriver` on 56565, which this
bridge could never feed — listing it invites setting a port that can never work.

**`description` is the name, everywhere.** A driver has no `name` attribute at all; `description` is
what the operator typed and what Designer shows. A receiver has both, and they agreed on the session
measured — but `description` leads there too, because if they ever diverge the typed one is the one
meant.

**247 tests pass.**

---

## 2026-08-05 — Dropping a status that could not be read

> "the whole engaged thing we can drop if it does not work. The axis is engaged, if you cant read
> that drop the whole engeged status reports"

`ScreenPositionReceiver` carries `started`, `engaged` and `receiving`; the axes carry none of them.
On the reference rig `engaged` read `False` for a receiver whose axes the operator had engaged — so
whatever that property tracks, it is not the thing an operator is looking at.

All three are gone: not read by the script, not carried in the payload, not mentioned in any verdict.
**A status nobody can act on, reported confidently, is worse than no status at all** — the same fault
as the fabricated defaults and the destination that called itself `receiving` while a cable was out.

What is read is now only what can be matched against: the receiver's name, its Navigator drivers and
their ports, and the axis ids.

    Everything matches: disguise ScreenPositionReceiver "posi3" has a driver on port 8000
    and an axis for id 1.

Measured with the connection's port set to 8000, which it now is.

**248 tests pass**, one of which fails if `engaged`, `receiving` or `started` reappears in the query
or in a verdict.

---

## 2026-08-05 — Several receivers, and none of them assumed unique

> "there is a second ScreenPositionReceiver "posi5" that has an axis with id 2, but its not stated." /
> "so we can have multiple screenpostionreceiver with same and different drivers and same and
> different axis/ids" / "also rename ScreenPositionReceiver to just PositionReceiver in our msgs"

    ID mismatch: this connection sends id 1, disguise PositionReceiver "posi3" driver "testdr"
    on 7999 has these axis ids: 5, 10; disguise PositionReceiver "posi5" driver "testdr" on
    7999 has these axis ids: 2.

**The id branch described `portOnly[0]`** — the first receiver carrying the port — and ignored the
rest of the session. The same fault as `drivers[0]` a change earlier, one level up: naming one read
as though it were the only place an axis could be, and an id that exists *nowhere* can only be shown
by looking at all of them. Every receiver is described now, those carrying the port first, since that
is where the axis has to be added.

**And a match need not be unique.** Ports and axis ids may both repeat across receivers — the session
above has `"testdr"` on 7999 in two of them — so a packet on a port with an id is taken by *every*
receiver holding both. That is how a redundant rig is built, and also how one encoder ends up driving
something nobody meant. `receivers.find(…)` would have reported one and hidden the others; it is a
list, and several matches are stated as such:

    Matches 2 receivers: port 8000 with axis id 1 is in "posi3", "posi5" — this connection
    drives all of them.

**`ScreenPositionReceiver` → `PositionReceiver` in every message.** The first is the class name in
the Python API; the second is what Designer presents and what an operator goes looking for. A message
is read by the person, not by the API. A test fails if the class name reappears in a verdict.

**250 tests pass.**

---

## 2026-08-05 — One shared driver, and a pill that stops claiming delivery

> "its one shared driver object" / "also if there is an port mismatch or id mismatch, and no match at
> all the disguise card should not state receiving"

**A driver can be referenced by several receivers.** Confirmed on the rig — `"testdr"` carries the
same `uid`, `1784006771968554994`, in both `posi3` and `posi5`. Naming it once per receiver read as
two drivers that happened to share a name and a port, which is a different rig entirely. Identity now
comes from the object's own `uid`, and a shared driver is described as shared:

    ID mismatch: this connection sends id 1, driver "testdr" on 7999 feeds disguise
    PositionReceiver "posi3" (axis ids 5, 10) and disguise PositionReceiver "posi5" (axis id 2).

**And the pill stops saying `receiving` once we know better.** `receiving` there meant only that
packets were leaving and the network had not objected — UDP offers nothing stronger, which is why a
pulled cable once read as `receiving` for four thousand suppressed packets. But when disguise itself
has said there is no driver on that port, or no axis with that device id, the packets are arriving
nowhere useful and the app knows it. The pill reads `mismatch`:

    pill before asking:  receiving
    pill after asking:   mismatch

Only from an answer. A question disguise could not answer is forgotten rather than treated as bad
news — an unreachable Designer says nothing about whether the destination is receiving, so the
network's own verdict stands.

**251 tests pass.**

---

## 2026-08-05 — Silence is not evidence

> "the log started going crazy after the changes … director is reachable again after 805 lost packets"
> / "being offline and no answer is the same thing right?" / "it should only show one, the right one,
> that fits the situtation"

Two faults, and the first took three attempts because each fix moved the same flawed proof somewhere
else.

### The false recovery

A switched-off machine announced itself reachable three times in ninety seconds. Measured at the full
send rate:

    17:56:11  no answer from 10.10.10.5 at all
    17:56:20  is reachable again after 115 lost packets     <- nine quiet seconds
    17:56:21  no answer from 10.10.10.5 at all

**Nine seconds without a single error, from a host that was off.** The kernel stops reporting once
the ARP entry expires during the pause between probes, and says nothing again until re-resolution
fails — so any window shorter than that failure latency reads as recovery.

Three attempts, all defeated by the same fact:

1. a quiet probe → the probe is one packet every five seconds; the quiet was ours
2. a quiet probe *plus* a quiet period → the quiet period was ours too
3. a three-second trial at the full rate → three seconds is inside the host's failure latency

The window is thirty seconds now, longer than any gap observed, and the announcement is left to
ordinary traffic rather than to a trial. The cost is that a genuine recovery is announced half a
minute late, while the dashboard pill turns green immediately — a pill reflects state, a log line
makes a claim, and only the claim has to be certain.

**Result over two minutes against the same switched-off machine: seven lines, zero false claims.**
Before: fourteen lines, three false claims in ninety seconds.

### One line, the right one

    director (10.10.10.5:6000): no answer from 10.10.10.5 at all — switched off, unplugged, or
    not on this subnet. Sends paused, retrying every 5s — the encoder connection stays up.

`is not answering` and `no answer from the host` were the same fact two seconds apart — going offline
**is** the diagnosis. The cause and what follows from it are one sentence, and the periodic warning no
longer repeats it immediately.

**253 tests pass.**

---

## 2026-08-05 — The indicator has to be true

> "when i click Ask disguise … switch the pages … its back on receiving" / "the director connection is
> showing offline, but switches to receiving everynow and then" / "the indicators need to be real
> stats and need to be instant and accurate. Otherwise it defeats the purpose of an indicator."

**The mismatch was forgotten on navigation.** `lastAsked` was a local in the card, and a card is
rebuilt every time the screen is drawn — so what disguise had said was thrown away and the pill went
back to claiming `receiving`. It is keyed by destination at module scope now: what disguise said does
not stop being true because a view re-rendered.

    before asking            receiving
    after asking             mismatch
    away and back again      mismatch

**And the pill was making the claim the log had just stopped making.** `destinationHealth` read
straight off `sink.offline`, so it flipped green for the second or two between a trial resuming sends
and the next error arriving. `receiving` now clears the same bar as the log claim: recent errors, or
suppressed sends, mean not receiving.

Sampled against the switched-off machine, twenty times over forty seconds: **twenty `offline`, no
flicker.** Before, it alternated.

### What "instant and accurate" can mean here

Failure is instant: the first ICMP error takes the pill out of `receiving` immediately, and it is
accurate because the kernel is telling us the packets did not arrive.

Success cannot be instant, and this is a property of UDP rather than a decision — there is no
delivery confirmation, so the only evidence available is the absence of an objection. That absence is
worthless on its own: a machine that was off produced **nine consecutive quiet seconds** at full send
rate. So `receiving` needs the silence to have lasted, and a genuine recovery is shown late rather
than a false one shown early.

The exception is a destination that has never failed: with no errors at all there is nothing to
prove, and it reads `receiving` from the first packet.

**254 tests pass.**

---

## 2026-08-05 — `connected` is not `receiving`

> "i would turn that logic around, and say receiving is only when there is a port match and an id
> match, other wise it needs a state that is saying connected" / "for axemple US is connected but not
> receiving, since its not even a disguise server but this laptop."

The right way round, and the example settles it: `US` points at a laptop. The packets leave, the
network raises no objection, and nothing whatsoever is receiving them.

| state | what it means | evidence |
|---|---|---|
| `idle` | the link is not running | — |
| `offline` / `refused` | the network says the packets did not arrive | ICMP, instant |
| `connected` | packets are leaving and nothing has objected | the most UDP can ever say |
| `receiving` | a disguise session has a Navigator driver on this port holding an axis with this device id | Designer, on being asked |
| `mismatch` | it was asked, and it has not | Designer, on being asked |

`receiving` used to mean what `connected` means now, which is how a switched-off machine wore the
word for four thousand suppressed packets. It is a claim about the far end, and only the far end can
support it.

**Held on the server**, keyed by destination — it began as a local in a card, which a re-render threw
away, then as a map in one view, which the dashboard could not see. The answer is about the
destination, not about a screen. `connected` stands wherever there is no answer.

Applied through one method, because `linkSnapshot` returns telemetry as well as the event stream
does: filtering in the tick alone gave the two endpoints different answers about the same
destination. That is how the first live check appeared to fail.

On the rig, after asking about one of the three:

    disguise 1  10.10.10.4:7999  mismatch     asked, and its axis ids are 5, 10 and 2
    director    10.10.10.5:6000  offline      switched off
    US          10.10.10.2:6000  connected    a laptop: reachable, receiving nothing

**255 tests pass.**

---

## 2026-08-05 — One outage, one message, and it never gets younger

> "the banner: Encoder 2: director (…) is offline — sends paused, retrying every 5s never wrote a log
> entry … is partilly redudant to it … It says retrying every 5s but the log entry gets written 27s or
> so? If you stop and start Encoder 2 you get both banners." / "the encoder name in connections should
> not be a link to controls."

**The banner and the log line were built in different places, with different words.** The banner said
*"is offline — sends paused, retrying every 5s"* and no log line ever carried that sentence — so the
one message an operator was interrupted by left no trace in the record, against the rule that anything
worth a banner is worth a log line. They are one sentence now, written once and used for both.

**A blip says nothing.** Before giving up, a failure might still clear inside two seconds; announcing
it puts a banner in front of somebody for something already over. That is where the second banner came
from.

**An outage is announced once, however many times sending is retried.** Sending resumes every few
seconds to test whether the host is back, so going offline again is the same outage continuing — and
it was announced identically each time, twelve seconds apart, for a machine that had never come back.

**And it does not get younger.** The elapsed time came from `failingSince`, which restarts with every
resumed attempt, so a follow-up read *"still not answering after 17s"* and then, a minute later,
*"after 7s"*. It is measured from when the outage began. The cause is not repeated either — only a
cause that has actually changed, such as a host that starts refusing the port instead of not
answering at all.

Stop, start, and 110 seconds against the switched-off machine:

    19:31:13  director (10.10.10.5:6000): no answer from 10.10.10.5 at all — switched off,
              unplugged, or not on this subnet. Sends paused, retrying every 5s — the encoder
              connection stays up.
    19:31:29  director (10.10.10.5:6000): still not answering after 17s.
    19:32:33  director (10.10.10.5:6000): still not answering after 81s.

Three lines. It was fourteen.

**The connection name is a label.** Said before and scoped to the Dashboard at the time; Connections
had it too, with a Controls button two inches to its right. No card name is a button now, so the
pointer and hover underline that went with it are gone as well.

**259 tests pass.**

---

## 2026-08-05 — One message, and the address in it once

> "i dont need muliple status msg. One is enough that gives the state. And will log." / "also max
> mention of the ip once per msg"

    director (10.10.10.5:6000): no answer at all — switched off, unplugged, or not on this
    subnet. Sends paused, retrying every 5s — the encoder connection stays up.

That is the whole of it. **One message per state**, and nothing further while the state holds — the
periodic *"still not answering after 17s"*, then *"after 81s"*, added a line every time without
adding a fact. How long it has been down is a figure, and figures belong on the dashboard rather than
in a stream. The backoff machinery that spaced those repeats is gone with them.

The one exception is a **cause that changes**: a host that stops answering entirely and later starts
refusing the port is in a different state, and that is worth a line.

**And the address appears once.** `explainSendError` named the host as well as the caller, so
"director (10.10.10.5:6000): no answer from 10.10.10.5 at all" said it twice in one sentence. It
describes the condition now — *"no answer at all"*, *"the machine answered, but nothing is listening
on that port"* — and the caller says whose condition it is.

Measured across two minutes with the destination switched off, after a stop and a start:

    lines about director: 1

It was fourteen when this began.

**258 tests pass.**

---

## 2026-08-05 — Why fixes kept breaking things elsewhere

> "it also feels like we are fixing things at one end, and it breaks things somewhere else, how can we
> avoid that?"

True, and the escapes in this session fall into four kinds rather than being random.

**1. One fact computed in two places.** Every time, the two drifted.

- the banner text and the log line for the same outage, built separately — the banner said something
  no log line ever carried
- `linkSnapshot` and the telemetry stream, filtered in one and not the other, so two endpoints gave
  different answers about the same destination
- `drivers[0]` and then `portOnly[0]`: describing the first of a list as though it were the only one,
  the same fault twice, one level apart

*The measure:* where two things must agree, compute once and call it from both — `applyDisguiseChecks`
is now a method precisely because it was two copies.

**2. A constant that was secretly a function of another.** `RATE_WINDOW_MS` went from ten seconds to
one, and the guard `span >= 1` — written when the window was ten — silently made every link report
0 Hz while sending a hundred packets a second. Nothing failed; the readout just lied.

*The measure:* derive the dependent value (`RATE_WINDOW_MS / 2`), never restate it.

**3. Tests pinned to phrasing rather than to the fact.** Several failed because a message got
*better*: `/Cannot reach gone/`, `/defaults to 8000/`, `/these axis ids:/`. That trains a reflex of
fixing the test to match, which is exactly how a real regression gets waved through.

*The measure:* assert the fact — the destination is named, a cause is given — not the sentence.

**4. A seam nobody checked.** `web-api-surface` verified **shim → server**, so `disguiseInspect` was
known to exist. Nothing verified **views → shim**, and `inspect` sat under `mapping` while the card
called `window.d3d.disguise.inspect`. It threw the first time a current Designer was there to answer
it — which is to say at a venue, after the thing it diagnoses had gone wrong.

*The measure, added here:* every `window.d3d.<namespace>.<method>()` in every view must exist in the
shim, namespace **and** method. Verified by putting `inspect` back under `mapping`, which fails it.

### The one that was not a code problem

The false recoveries took three attempts because each fix moved the same flawed evidence somewhere
else — a quiet probe, then a quiet probe plus a quiet period, then a quiet trial. All three were
reasoning about ICMP rather than measuring it. What settled it was watching a switched-off machine
for ninety seconds and finding nine consecutive silent seconds at full send rate.

*The measure:* when the far end is someone else's system, measure it before designing against it. The
same applies to the Designer object model, which was three wrong guesses (`state.devices` iterable, a
driver `name`, one driver per receiver) until it was read off a live session.

**259 tests pass.**

---

## 2026-08-05 — The position trace, and a test for the class of bug that keeps escaping

> "add that snapshot/telemetry health test too and check the position last 12 s dashboard graph, it
> behaves weirdly, it kind of is bount to something that makes it squeeze and studder"

### The graph

Two faults, both horizontal — the vertical autoscale was fine.

**The axis was elastic.** `x` was scaled to `now - pts[0].t`: the age of the *oldest point held*. So
the whole trace stretched while the buffer filled, and jumped sideways every time a point aged out.
The data was never wrong; the axis was. It is a fixed window now — `now - 12s` at the left edge,
`now` at the right, always.

**And the buffer was a third of the window.** `TRACE_POINTS` was 120 while telemetry arrives at
30 Hz, so a moving encoder produced 360 points in twelve seconds and the oldest 240 were discarded: a
graph labelled "last 12 s" held about four, stretched across the full width by the elastic axis. It
trims by **age** now, sized for the fastest telemetry the settings allow.

One point older than the cutoff is kept deliberately — it is the one the leftmost segment is drawn
from, and without it the line began wherever the oldest sample happened to be.

Measured on the running app, eight samples 1.2s apart:

    right edge   600, 600, 600, 600, 600, 600, 600, 600     pinned at "now"
    left edge    559 → 499 → 439 → 379 → 318 → 258 → 198 → 138

50 units a second across a 600-unit width over twelve seconds: exactly real time, and no rescaling.

### The agreement test

`linkSnapshot` and the telemetry stream return the same telemetry, and the disguise answer was
applied to one and not the other — so a screen reading one saw `connected` while a screen reading the
other saw `mismatch`. That is the shape of half the escapes here: **one fact computed in two places.**

The test asserts both report identical health and `confirmed` for the same destination, and that the
filter lives in one method both go through. Verified by removing the snapshot's call, which fails
with *"snapshot said connected, the stream said receiving — for the same destination"*.

**260 tests pass.**

---

## 2026-08-05 — A yellow line that duplicated a tile

> "In the Stream tile on Encoder 2 we already have Faults, it shows the same number. I never asked for
> a yellow sub text below. That shows details there, in these dashboard cards everything goes in the
> tiles we have. The yellow text should never have made it there."

Gone. `card-faults` sat under the three columns and restated the Stream tile's Faults figure in
words — *"1606 send failures"* against a tile already reading 1606 — in warning yellow, at the bottom
of a card whose whole design is that every figure lives in a tile.

The card is now `card-head`, `card-detail`, `encoder-cols`, and nothing else. The number stays where
it belongs:

    Stream tile · Faults   113

Its CSS went with it.

It is the same class as the duplicate-connection feature, the raw command box, the "Go to" row and
the "Derived" velocity policy: something added without being asked for, that then had to be found and
removed. The count of those in this codebase is the argument for not adding them.

**260 tests pass**, every view clean at 1440 / 1024 / 860 / 720 / 480 / 390, folded and expanded.

---

## 2026-08-05 — An indicator establishes its own state

> "D - when full restart of the server or the app, each indicator runs a routine that checks for its
> state rather then taking it from a default or past instance. Indicators are indicators and should
> always be aware of their actual state."

The disguise answer lived in memory, so restarting the app forgot it and every destination fell back
to `connected` — true of the network, and not what the operator had established a minute earlier. Not
a bug so much as an indicator inheriting a state instead of knowing one.

**Each destination now checks itself when its link starts** — pressing Start, pressing Start All, or
being auto-started at launch, which nobody clicks. A fresh process, one Start All, and no interaction
at all:

    disguise 1  10.10.10.4:7999  mismatch    confirmed=false
    director    10.10.10.5:6000  offline     confirmed=undefined
    US          10.10.10.2:6000  connected   confirmed=undefined

And in the log, unprompted:

    Revolve: ID mismatch: this connection sends id 1, driver "testdr" on 7999 feeds disguise
    PositionReceiver "posi3" (axis ids 5, 10) and disguise PositionReceiver "posi5" (axis id 2).

### The constraints it respects

**Once per destination per process, and never again.** disguise's documentation forbids polling this
endpoint; this is a single call at the moment a connection comes up, staggered so a fan-out to one
machine does not arrive as a burst.

**A destination that cannot answer records nothing.** `director` is switched off and `US` is a laptop:
neither has a Designer session, so neither has a check, and the network's own verdict stands. The
attempt is silent — an operator who has not asked anything should not be told their laptop is not
running Designer.

The verdict logic is one function now, shared by the button and the automatic check, because the
alternative was the same reasoning written twice — the fault this codebase has produced more often
than any other.

**261 tests pass.**

---

## 2026-08-05 — An indicator that keeps up with the world

> "i know changed the id in disguise to 1 but the disguise 1 still says mismatch … This is a structual
> desgin flaw we need to tackle." / "if we dont pull from disguise, thats fine, but the live update
> atleast once every sec, should check for offline, once offline becomes true we then also check for
> connected and mismatch, if all is back up running and receiving, we then go back to just check for
> offline / disconnect."

A structural flaw, correctly named: the disguise answer was taken **once** and then presented as live
state, so a rig that had been fixed in Designer went on reading `mismatch` while the shaft plainly
drove the screen.

**The hard constraint, stated plainly:** posi3 cannot know live what disguise is doing. UDP says
nothing back, and the Python API is the only other channel — and disguise's documentation forbids
polling it. So the answer is not "ask more often"; it is "ask when something has changed".

### The state machine

**The network side is evaluated on every tick,** because it costs nothing — ICMP and a clock. Going
offline, and coming back, are noticed at once.

**A change of network state is what asks disguise.** Something that has just come back may have come
back different. Debounced, so a flapping destination cannot turn a state machine into a poller.

**A wrong answer is asked again on a backoff** — 8s, 15s, 30s, then a minute — and **a right one
stops asking.** A destination sitting at `receiving` is never queried again, which is exactly the
case the documentation protects: a show that is working is left alone. A destination that cannot
answer at all keeps trying on the same backoff, because a Designer that was not up when the
connection started is the ordinary case at a get-in.

**An edit in posi3 invalidates the answer too.** A changed port, device id or address is the thing
the answer was about, so the check is forgotten and the destination establishes itself again.

Proven end to end, with no clicking and without touching Designer — the device id changed in posi3
to one disguise does not have, then back:

    start                    receiving
    device id → 77           mismatch
    device id → 1            receiving

And the verdict is logged only when it changes, because this now runs on a timer and a state that has
not moved is not news.

**263 tests pass.**

---

## 2026-08-05 — The routine has to be able to stop

> "make sure if we are running againt an older software there still might not be an api request
> possible and that should be taken into account" / "so the routine doest get stuck"

It would have. As written, a destination that could not answer was rescheduled on the backoff for
ever — a poller with extra steps, aimed at a machine with nothing to say.

Two ways not to answer, and they end differently:

**No API at all** — a Designer that predates the Python endpoint, or something that is not Designer.
That is final: software does not grow an API while it is running. Said once, then never asked again
by anything automatic, including a change of network state, which does not give software an API.

    disguise 1: No API call possible with the disguise version on 10.10.10.4 — it is serving
    HTTP but has no /api/session/python/execute. … This destination will show the network
    state only.

**No answer** — Designer not started, machine down, or not disguise at all. Worth a few more tries,
because a Designer that was not up when the connection started is the ordinary case at a get-in — but
bounded at four, and then it stops.

Stopping is safe because it is not permanent: **a change of network state asks again**, and a
Designer starting up is exactly such a change — its port stops refusing the moment the driver binds.
A changed address clears the no-API mark too, since a different machine may have one.

Ninety seconds with `director` switched off and `US` a laptop, neither able to answer:

    verdict lines logged     1        (the one destination that could answer)
    final state              disguise 1 receiving · director offline · US connected

No repetition, no accumulating traffic, and nothing stuck.

**264 tests pass.**

---

## 2026-08-05 — Decision: a healthy destination is not re-checked

> "it takes roughly 4 sec from mismatch to receiving when i change the id in disguise, Why does it
> takes so long?" / "we leave it as it is, Thats why we have the ask button."

**Why the four seconds.** It was not a fixed delay: it was the remainder of the interval already
running. While a destination reads `mismatch`, re-checks go at 8s, 15s, 30s, then a minute — so the
same change made just after a check would have waited the full interval, and a mismatch left standing
for a couple of minutes is on the sixty-second step. The round trip and the repaint are noise beside
that.

It cannot be immediate. Changing an axis id inside Designer produces **no network-observable event** —
the packets keep flowing, no ICMP, nothing for the state watcher to see. Without polling, a timer is
the only thing left.

**The accepted cost, recorded so it is not "fixed" later.** Once a destination reads `receiving`,
nothing is scheduled at all. Breaking the rig in Designer from that point — moving the axis id,
changing the driver's port — is invisible to posi3, which will go on saying `receiving`. So
`receiving` means *matched when last looked at*, and that may be hours ago.

The alternative is a heartbeat while healthy: polling an endpoint whose documentation forbids
polling, against a machine that is working, during a show. **Ask disguise** exists for the moment
somebody wants the claim re-established, and that is the trade the user chose. There is a comment at
the line that clears the timer saying so, because it is exactly the kind of thing a later reader
would replace with a `setInterval`.

**264 tests pass.**

## 2026-08-05 — A verdict must not outlive the state it described

**Asked:** while receiving, keep checking the network every second; reset the
"Ask disguise" answer when the state changes, because it is then out of date —
going offline left *Everything matches: disguise PositionReceiver "posi3" has a
driver on port 7999 and an axis for id 1* on screen. Then: why did receiving →
offline take so long, if health is recomputed 30×/s. Then: drop the *Live
position* row from the disguise tile — it is not a disguise value, and it is
already on the dashboard and the encoder page.

**Built:**

- The network check was already there and needed nothing. `health` is computed
  from the sink on every telemetry frame, and a disguise answer only ever
  rewrites `connected`, so a sink that starts failing reports `offline` on the
  next frame and the confirmation stops applying by itself. Pinned by a test
  rather than left as an assertion in a commit message.
- The answer is now discarded on any destination state change
  (`disguiseChecks.delete` in `src/server/api.js`), before the debounce and
  before the no-API check — whether a *new* answer can be obtained has no
  bearing on whether the old one is still true. Dropping it first means the
  indicator falls back to what the network says while a replacement is fetched,
  or stays there if none can be. The card clears the sentence with it
  (`src/web/js/views/mapping.js`), so the text cannot outlive its pill.
- Removed the *Live position* row from the mapping card. Its styles stay: they
  are shared with the encoder-config card, where the value does belong.

**The delay is not the tick.** 30 Hz is how often health is re-read; it says
nothing about how fast the input to it changes, and two things sit in front of
it. A connected UDP socket only learns a send failed when ICMP comes back, and a
host that is switched off sends none — measured at nine silent seconds at full
send rate. Once errors do arrive, `SEND_GIVE_UP_MS = 2000` requires two seconds
of continuous failure before the sink is declared offline, so a single lost
packet cannot blank a card mid-show. `ECONNREFUSED` from a live machine with
nothing bound is near-instant; a dark machine is slow because the network says
nothing at all.

## 2026-08-05 — Getting back from offline, in seconds rather than half a minute

**Asked:** what moves a destination from offline back to connected when the
cable goes back in, and check it more often — the link was stable and disguise
was visibly receiving for several seconds before the indicator moved.

**What was actually in the way.** Four gates in series, not one slow check:

| | |
|---|---|
| up to 5 s | `OFFLINE_RETRY_MS` — while offline, sending is suppressed and one probe datagram goes out every five seconds. Nothing was even attempted until the next one came due. |
| 1 s | `PROBE_GRACE_MS` — waiting to see whether ICMP objects to that probe. |
| 3 s | `TRIAL_MS` — full-rate sending, error-free throughout, before `offline` clears. |
| **30 s** | `RECOVERY_QUIET_MS`, inside `destinationHealth`. `txErrors` is cumulative and never reset, so after a sink's first error this reads "thirty seconds since the last one" for the rest of the run. |

The last one dominates and hid the other three: the first nine seconds fit
inside it, so the pill could not go green until half a minute after the final
error, whatever the ladder did. A comment above the constant claimed the pill
"turns green immediately" — it had not been true since the quiet gate moved
into the health function.

**Built:**

- `OFFLINE_RETRY_MS` 5 s → **1 s**. The probe is one datagram; the wider gap
  bought nothing and cost up to five seconds of an outage that was already over.
- **`_probeHostAlive`** — proof a host is up, instead of absence of proof that
  it is down. UDP can only report failure, and silence is what a switched-off
  machine produces too (measured: nine consecutive seconds at full send rate),
  which is why believing it needed thirty seconds. TCP answers in one round
  trip: a completed handshake proves the machine is up, and **so does a
  refusal**, because only a live machine sends RST. It connects to the
  destination's own port, so nothing new is configured and nothing need be
  listening. Not the Designer Python API and no script — a connect and an
  immediate close, the reachability test `ping` would give without needing root.
  Runs only while a destination is already offline, one attempt at a time,
  unref'd, and closed in `_closeUdp`.
- **`hostProvenBack(sink)`** — one rule, three ways, in descending order of what
  they prove: never failed; TCP proved it alive after the last error; or it has
  been quiet for thirty seconds. Used by both the pill and the "reachable again"
  line, which previously carried separate copies of the thirty-second test.
- A firewall that drops everything gets no TCP answer and falls through to the
  silence rule, so the worst case degrades to the old behaviour rather than to a
  wrong answer.

**Result:** a replugged cable is back at roughly 1 s probe + 1 s grace + 3 s
trial ≈ **5 s**, down from ~30 s, and the trial still stands between a clean
probe and a green pill — the flapping protection is untouched.

Two tests asserted `/retrying every 5s/` and failed because the message had
become more accurate. Rewritten to `/every \d+s/`: the message must state the
interval, not a particular number.

## 2026-08-05 — Names that claim things the code does not do

**Asked:** explain the unused `checkbox` import in the log view and suggest what
to do; option 2 — remove every dead name and gate against the class — was
chosen.

**The explanation.** `src/web/js/ui.js` is the shared toolbox of small builders
(`el`, `toast`, `checkbox`, …) and each view imports the ones it uses. The log
view's import line listed `checkbox` without a single call to it — inherited
verbatim from the d3driver migration, dead for the whole life of posi3. Harmless
at runtime; the damage is that a dead name is a false claim about the code. This
one advertised a control the screen does not have, and it misled in practice:
when a checkbox came up in a discussion of the log controls, the operator
reasonably asked "what checkbox?".

**Why no gate caught it:** the lint gate had exactly one rule, `no-undef` — a
name used but never defined (the `dest` crash). This is the mirror image, a name
defined but never used, which is `no-unused-vars`, and it was off.

**Built:** `no-unused-vars` is now on in both config blocks, and the sweep it
gates from removed nine dead names — four in `src/`, five in tests:

- `checkbox` from the log view's import.
- The `dt` chain in `link-manager.js` — `dt` was computed every tick and never
  read, and `_lastTickMs` existed only to feed it, so the honest removal took
  the whole chain (`dt`, the outer `now`, `_lastTickMs` and both its
  assignments). The rate block's own `Date.now()` shadowed the outer `now`, so
  nothing else was touched.
- In `api.js`: `checkValue` from the validate import (the function itself stays
  in `validate.js`, used by `checkVarWrite` and tested directly) and an unused
  `label` helper superseded by `q`.
- In tests: three `async (t)` callbacks that never used `t`, one destructured
  `logger`, one trailing `state` parameter on a fake-encoder callback.

The config's header comment — "One rule, and a reason for it" — moved with the
fact: two rules, and the bar unchanged. Not a style config; these fire only on
code that cannot work or words that are not true.

## 2026-08-05 — Full-code audit, and the fixes it ordered

**Asked:** "check overall code from this project and tell me if we need other
fixes?" — three parallel reviews (bridge core, server and security, web UI)
plus a cross-cutting pass, every finding verified against the code before being
reported. Then: "start with the first but do all." The entries that follow are
those fixes, in the reported order.

### The log console froze at exactly 2000 lines

`ingestLog` caps the client buffer at MAX_RENDERED (2000), so once it fills,
its *length* is pinned there for good — and the repaint guard compared lengths.
From that moment the console silently stopped showing new lines until the page
was left and re-entered; during an incident that reads as "nothing is being
logged". The signal is now the newest line's sequence number, which advances
even when the length cannot. Pinned by `test/log-view.test.js` at source level,
since the view needs a browser to run.

### The start shortcut sat on the hard-reload key, and the stop shortcut was dead

Cmd/Ctrl+Shift+R — bound to Start All — is the browser's *hard* reload in
Chrome and Firefox, so refreshing a misbehaving page engaged every encoder:
the exact collision the original Cmd+R remap was made to escape, one key over.
And Stop All tested `ev.key === '.'` while requiring Shift, which is
unreachable — Shift turns that key into `>` on a US layout and `:` on a German
one before the value arrives. The dangerous shortcut fired; the emergency one
never could.

Both now sit on Cmd/Ctrl+Shift+Comma (start) and Cmd/Ctrl+Shift+Period (stop),
matched by `ev.code` — the physical key, immune to layout and Shift — and the
desktop menu carries the same accelerators, so the window and a browser answer
to the same keys. No browser engine owns either combination.

### A link state change no longer throws away what the operator was typing

Any link changing state — including an encoder quietly reconnecting on its own
— triggered a full rebuild of the active view. The staged values on an encoder
card, a half-edited mapping with its Save armed, and the "Ask disguise" answer
all live in per-card closures, so the rebuild erased them; `openGroups` proves
surviving rebuilds was considered, but only fold state ever got the treatment.

The rebuild was not needed at all. Every view seeds its state pill at build
time and keeps it live in `refreshLive`, so `onStoreChange` now treats
`linkState` like `linkDetail`: the animation loop's job, no structure touched.
Structure rebuilds on *config* change; state is not config.

With rebuilds legitimate again (navigation, config edits), `lastAsked` finally
does what it was added for: the stored disguise answer is rendered when a card
is rebuilt, and forgotten when the destination's state changes — so an answer
survives looking at another screen, but never outlives the state it described.

### A destination that could never receive read `connected`

If UDP setup failed — an unresolvable hostname, a local address or port that
could not be bound — the sink never became ready, so nothing was ever sent.
One setup error, then silence; and silence is what the health rule reads as
recovery, so thirty seconds later the pill said `connected` for a destination
no packet could physically reach. The synchronous bind failure was even
gentler: a log warning, health clean from the first frame.

A setup failure now marks the sink offline immediately and announces it once —
"could not open the sender socket … restart the connection to retry" — through
both the log and the banner path. No retry loop was added: re-running
bind/connect is exactly what restarting the connection does, so the message
names that instead. Behavioural test: a bind to TEST-NET-1 fails on this
machine without a packet leaving it, and the sink must read offline.

### A refused Preset no longer costs the rest of the batch its flash twice

Apply-changes wrote every other variable to flash first, then called
`setPreset` — whose duplicate refusal threw the whole call away. The writes
that had already spent their cycles were reported in results the throw
discarded, and the natural retry with force wrote them all a second time:
double flash spend against the ~100,000-cycle budget, for a batch the encoder
had refused nothing in.

The duplicate rule is now askable on its own — `assertPresetWritable`, the
same read-and-compare `setPreset` uses — and the server asks it before the
first write of the batch. A refused batch now costs nothing. The write order
itself is unchanged (configuration first, then Preset), because Preset's
meaning depends on the scaling written next to it.

### Bound to the LAN, the desktop window locked itself out

A non-loopback `webBindHost` always generates an access token, and the guard
checks it on every request — static files included. The desktop window loaded
the bare URL, so widening the bind made the app render its own
"401 Missing or invalid access token"; the second-instance dialog's "Open it"
button had the same fault, because the lock file stored the bare URL.

The window now loads `webUrlWithToken()` — the same form the tray's "Copy web
UI address" already produced — and the lock stores the tokened URL, since its
whole purpose is to be opened. The lock lives in the profile directory, which
is the user's own; the token guards the LAN, not the machine's owner.
Behavioural test: with a token set, the bare URL answers 401, the tokened one
200, and the lock's URL carries the token.

### Imports are validated, and nothing concluded outlives its destination

`configImport` went straight into the store: no field validation, no
destination cap, and `JSON.parse`'s own-property `__proto__` merged through
`Object.assign`'s [[Set]] — values readable from the live config yet invisible
to `JSON.stringify`. An import now strips prototype keys at every depth, runs
every connection through the same migration and `sanitiseConnection` the
editing routes use *before* anything is replaced (a bad profile is refused
whole, not discovered halfway through), refuses profiles from a newer build
outright, and clears the stale "written by a newer build" load warning that
`replaceProfile` used to leave in `appInfo`.

And the server now forgets. `checkedOnce`, `noApi`, `lastAutoAsk`, pending
re-check timers, the manager's verdicts and health history, and the flash
budget are all *about* a destination or connection — deleting one, or
replacing the profile, releases all of it through one `forgetDestination`
helper (`link-manager` gained the matching `forgetDestination` /
`forgetAllDestinations` for its own maps). Re-importing an exported profile —
which keeps its ids — previously left every destination marked
already-checked, so none ever established disguise state again. A successful
inspect also clears `noApi` now: an answer proves the API exists, so a
Designer upgraded mid-run is no longer muted until restart.

### Four correctness fixes: the hang, the misattributed death, the reverted edit, the wrong banner

- **A stalling Designer hung the inspect forever.** The abort timer was cleared
  the moment HTTP headers arrived, so a half-dead Designer or a proxy that
  answered 200 and trickled the body wedged the Ask button and that
  destination's automatic establish chain. The timeout now covers the body.
- **Another client's mistake could kill a healthy link.** The encoder
  broadcasts every client's replies down the shared socket, and the command
  queue settles the in-flight request on any `ERROR:` line — so a second
  client fumbling a command while our stall probe was in flight rejected the
  probe, and the catch tore the link down. An `EENCODER` rejection now counts
  as proof of life (a machine that sends an error is talking); only silence —
  the timeout — means dead. Full attribution is impossible on a broadcast
  channel, so the destructive consequence is what got fixed.
- **A slow encoder read silently reverted concurrent edits.** Address
  promotion upserted the connection object captured before a multi-second
  exchange, wholesale. It now re-finds the live record and touches exactly the
  two fields it owns, synchronously.
- **Encoder A's flash confirmation dismissed encoder B's warning.** The
  "FLASH WRITE IN PROGRESS — do not power off" banner used one global key for
  every encoder. Keys are per-connection now, and `onFlashConfirmed` dismisses
  only the banners of the encoder that confirmed.

### Reconnects catch up, ids cannot collide, the lock cannot split, the tray leaves a record

- **A stream drop no longer loses history.** The EventSource reconnects by
  itself, but the gap's log lines and config edits were never re-sent: the log
  showed a hole until reload, and config stayed stale indefinitely. The shim
  now announces every reconnect (the first open is not one), and the app
  re-fetches config and merges the log tail by sequence number — nothing
  doubles, and a tail whose newest line is older than ours means the bridge
  restarted, so the buffer and any freeze point start over instead of letting
  restarted sequence numbers slip past the pause filter.
- **Destination ids are random, never positional.** `dest-${i}` collided
  across connections created through the raw API, and verdicts, re-check
  timers and health history are keyed by that id alone — one connection's
  answer displayed for another's destination.
- **The instance lock claims by exclusive create.** Check-then-write let two
  processes starting in the same instant both pass the liveness check and both
  run — rival sockets to an encoder that accepts only a handful of clients.
  `wx` makes the filesystem the referee; the loser re-reads and defers.
- **Tray and menu Start/Stop go through the api layer**, so they write the
  same operator log line as every other actor and their destinations establish
  disguise state. A tray start used to do neither.

### Small core: honest counts, clean windows, unpoisoned gaps

- **Start All clears the rate windows** as `start(id)` always did, so
  Stop All → Start All no longer reads a large negative Hz for the first
  second. The single-start path even carried a comment naming this failure.
- **"Reachable again after N lost packets" counts this outage.** `txErrors`
  is cumulative for the run and was reported raw — the rig once announced
  1265 for an outage that had lost a fraction of them. The outage's own count
  is now snapshotted at its first error; the cumulative counter still holds
  the run total for the dashboard.
- **Gap statistics survive a reconnect.** The previous-sample markers lived
  through disconnects, so a new connection's first sample recorded the whole
  outage as an inter-sample gap — poisoning p99/max for the next 256 samples —
  and could count a spurious wrap. Cleared on disconnect.
- **`summary()` no longer reads a field that never existed** (`rate.tx`,
  `NaN` from the day it was written; latent, since nothing calls it yet). It
  now derives packets/s from the same sample window the telemetry rate uses.

### Small server: settings refused when typed, wildcard binds usable, two desktop guards

- **`configSetSettings` validates** (new `checkSettings` in validate.js): port
  0–65535, bind host a real address or a wildcard, telemetry 1–120 Hz,
  booleans coerced, unknown keys refused. `webPort: "abc"` used to be saved
  and discovered only at the next launch, where it killed the desktop app.
- **Mapping numbers must be finite, ratios positive.** `Number(x) || 1` let
  `Infinity` through (truthy) and accepted negative ratios — NaN and garbage
  in the axis values sent to disguise.
- **`--bind ::` is usable.** The Host-header check accepted only loopback or
  the literal `::`, so every real LAN request got 421. An IPv6 wildcard now
  accepts literal IPs the way `0.0.0.0` always has.
- **Two desktop guards:** a dock click during the async start no longer
  reaches `createWindow` with the service still null, and `will-navigate`
  compares parsed origins instead of a string prefix, which
  `http://127.0.0.1:8710@evil.com/` satisfied.
