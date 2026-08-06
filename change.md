# change.md — Core-path integrity + open-item triage

Each point: where it came from in your input, how I understood it, and the
execution plan. Nothing here is executed yet.

---

## Part 1 — Core-path integrity

### 1.1 Measure the ping cost honestly, then decide

**Origin (your input):** "make sure the core application, from encoder to
disguise and the string conversion, with handshake to encoder und udp fanout
to disguise stay clean and its integrety is given at all times." — and, asked
how to handle the one risk the audit found, you chose **"Measure first, then
decide."**

**How I understood it:** the audit confirmed the wire format, parse path and
command queue are clean (golden bytes pinned six ways; today's work added one
integer store per sample). The one new risk: liveness pings spawn a `ping`
process per destination per second on the same thread that forwards samples —
~6 forks/s on your rig — and the latency bench now measures itself with those
probes running, so no honest number exists. You want evidence before any
rebuild.

**Execution plan:** give `tools/latency-bench.js` a `--probes off|real` flag
(off = no-op `EncoderLink.pingRunner`, the pure path; real = today's spawn
engine). Add `--destinations N` so the bench covers real fanout instead of the
legacy single-destination shape. Run both modes at `--samples 20000 --cycle 2
--coalesce 2`, record p50/p99/p99.9/max dated in `docs/FEATURES.md`.
**Decision gate:** if the real-probes tail grows by more than ~1 ms or max
exceeds one encoder cycle, I propose the persistent-ping engine (one
long-running `ping <host>` per destination, replies from stdout, zero
recurring spawns) as a follow-up for your go. Otherwise the spawn engine
stays, with the numbers on record.

### 1.2 Low-risk hardening now, regardless of the gate

**Origin:** same integrity instruction.

**How I understood it:** four small findings from the audit that are safe in
any outcome: ping children are not `unref()`d (up to ~1.4 s event-loop hold
on shutdown — the old TCP probes were unref'd); `stop()`'s early-return guard
does not check `_destWatch`/`_idleProbeTimer`; `sink.recovered` is used but
never declared in the sink literal; an orphaned doc comment sits at
`encoder-link.js:44`.

**Execution plan:** `child.unref()` in `_ping`; extend the `stop()` guard;
declare `recovered: false` in the sink literal and the matrix-test fixture;
delete the orphan comment.

### 1.3 Put the hot path back in the foreground

**Origin:** "stay clean" — cleanliness of the code carrying the data, not
only its behaviour.

**How I understood it:** `_forward` is 93 lines of which actual forwarding is
~15; the rest is the offline/probe/trial state machine that grew around it.
`encoder-link.js` is now 31% liveness machinery. The hot path should be
readable at a glance.

**Execution plan:** extract the offline block (`encoder-link.js:887-940`)
into `_maintainSinkOutage(sink, nowMs)` beside the rest of the outage
machinery. Pure refactor; the suite (311 tests), the golden-bytes tests and
the health matrix must pass unchanged.

### 1.4 Guards so it stays clean

**Origin:** "its integrety is given at all times" — at all times means
guarded, not inspected once.

**How I understood it:** two known gaps: `tools/udp-sink.js` re-appends the
`;` it splits on, so a terminatorless payload still parses (disguise drops
the final axis without it — old note, still open); and nothing fails the
suite if someone adds a per-sample allocation to `_forward`.

**Execution plan:** tighten `udp-sink.js` to verify the trailing `;` for real
plus a test; add a source-shape test that `_forward`'s send loop contains no
allocation constructs (no `new`, no template literals, no `.map(`). Correct
the false record at `docs/FEATURES.md:2927` (claims `logRaw` was removed;
three writers remain) alongside Part 2.

---

## Part 2 — Schema 5: the profile stops carrying dead keys

**Origin (your input):** todo item **A7** — "STALE KEYS IN YOUR SAVED
PROFILE - what even is this, prop remove completely" — and your answer
**"Drop notes too (Recommended)."**

**How I understood it:** the live profile still carries `logRaw` (×2),
`defaultLocalAddress`, `defaultVelocityPolicy`; nothing strips unknown keys
on load. `notes` and `parser.outputType` are validated and saved but read by
nothing. You want them gone completely.

**Execution plan:** `SCHEMA_VERSION = 5` in `config-store.js`; migration
whitelist-copies known fields only (the shape `sanitiseConnection` already
defines), stripping `logRaw`, `notes`, `parser.outputType`,
`defaultLocalAddress`, `defaultVelocityPolicy`. Remove the writers
(`config-store.js:111-112`, `validate.js:158-159`, `encoder-link.js:2013-2015`).
Migration test loads a schema-4 fixture shaped like your live profile and
asserts the keys are gone, connections intact.

---

## Part 3 — Open items from todo.txt and posi3-inherited-features.txt

**Origin (your input):** "Also check todo.txt and posi3-inherited-features.txt
if we have open items and what should be done about it. Collect alle and
present suggestions."

Per your standing rule, none of these start without your explicit go.

### Ready to build on your go

| # | Your words (origin) | How I understood it → suggestion | Size |
|---|---|---|---|
| A6 | "CONNECTION REORDERING - delete" | Dead capability, three layers, zero callers. Delete `reorder()` in config-store, `configReorder` route, `CONFIG_REORDER` constant, web shim entry. | S |
| A4 | "CONFIG EXPORT / IMPORT needs testing" | Import got 5 tests already; **export has zero**. Add a round-trip test: export → import → identical profile. | S |
| A5 | "LOG EXPORT - needs testing" | Untested route and download path. Add tests for `logExport` and the download endpoint. | S |
| A3 | "RUN! (SINGLE SAMPLE) show only when Polled mode active. Where??" | It's the `Run!` button in the Controls dialog (`views/detail.js:26`), currently always visible. Show it only when the last-read `TimeMode` is a polled value. | S |
| #10 | "Settings - About tile, state the encoder string to the navigator driver string short" | Add one line per connection to Settings→About: the wire template `<devid>:<pos>,<vel>;` with a live example. New visible element — built only on this approval. | S |
| #6 + A8 | "Web Interface reachable from other systems. Multi Ip reach." + "LOG-TO-FILE SETTING - WHAT? Where?" | Backend for both exists with no UI. One Settings bundle: `webBindHost`/`webPort` controls (validation exists in `checkSettings`), a `logToFile` checkbox, and the "Web UI" address line listing **all** non-internal IPv4s instead of only the first (`http.js:66`). | M |
| #1 | "Adding the disguise model to the dashboard and connection" | The last Ask-disguise answer (receiver name, driver port) is held server-side; surface it as a small sub-line on the dashboard destination tile and connections card. **Mock-up first for your sign-off** — new GUI elements. | M |
| A2 | "ZERO / PRESET 0 needs fix same thing." | Evidence says the button now routes through `setPreset` (the alternating-value rule) since the batch fix. Verify, then close without code — or fix if verification disagrees. | XS |

### Needs your definition before anything is planned

| # | Your words | What I need from you |
|---|---|---|
| #3 | "IP/Nic Picker in add connection optimieren" | Picker exists and re-enumerates on demand. What does optimal look like? |
| #4 | "Pop Layouts optimieren" | Concrete offer: extend `uicheck` to open every modal/popover at each sweep width and assert no overflow. Beyond that, which layouts offend? |
| #5 | "Dashboard stats rethink" | The four tiles today: Packets out / Streaming / Samples in / Faults. Awaiting your spec. |
| A1 | "DISGUISE MAPPING SCREEN still optimising" | Awaiting specifics. |
| #7 | "App and Web have different min width" | Recommendation if wanted: raise desktop `minWidth` 380→420 (the rail breakpoint). Browsers have no floor either way. Your pick. |

### Blocked, or bundled for the right machine

| # | Your words | How I understood it |
|---|---|---|
| #2 | "Adding the Encoder Model to the dashboard and Encoder Config" | **Not possible from the device**: the protocol carries no model, serial or identity (14-variable catalogue, none identity — `encoder-config.js:101` documents this). Options: a manual "model" label in the connection editor, or close the item. |
| #8 | "App name MacOs and Windows conistent, also in the OS Menus." | macOS is consistent; the Windows `FileDescription` stamping is the unresolved part (`electron-builder.yml:20` note). Goes in the **Windows pass**. |
| — | Windows pass (bundle) | Next time a Windows machine is available: FileDescription stamping, log-file rotation over an open handle, tray visual check, portable exe run. |
| — | Hardware pass (bundle) | Next bench session: A/B byte-diff against the 2016 `d3driver.exe`, 8192-counts-per-rev shaft check. |

### Accepted / closed — on the record, no action

- Log pause beyond 2000 lines loses the oldest lines from the *view* (server ring keeps 5000; Export reads that). Accepted in FEATURES.
- Stealth-firewall hosts ("US" laptop) read offline while idle — the accepted ping trade, your call: "stay with the most easy ping … then move on."
- Electron bundle size; healthy destinations never re-polled ("we leave it as it is, Thats why we have the ask button") — recorded decisions.
- Done since the lists were written: encoder indicator states (#9/#11), unused `checkbox` import (A9), tray/login/minimise (B1–B3), token auth backend (B4), instance lock (B5), config import UI + tests (A4 import half).
- `input/todo.txt` is modified locally and uncommitted — committed alongside this work unless you prefer it stays local.

---

## Execution order

1. Part 1.2 hardening + 1.1 bench honesty → run both baselines → record numbers (the gate).
2. Part 1.3 `_forward` split + 1.4 guards.
3. Part 2 schema 5.
4. Part 3 rows you green-light, in the order you pick.

## Verification

- Full suite green after every part (`npm test`, currently 311 tests).
- Bench: both modes recorded dated in FEATURES; CI bench job still exits 0.
- `_forward` refactor: golden-bytes tests, `destinations` fanout tests and the health matrix pass unchanged — they are the contract.
- Schema 5: a fixture shaped like the live profile migrates clean; dead keys absent, connections intact.
- On the rig: restart, indicators unchanged (streaming/receiving), one stop/start cycle traces cleanly in the log.
