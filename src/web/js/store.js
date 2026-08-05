/**
 * Renderer state.
 *
 * Telemetry arrives at ~30 Hz for every running link and is written straight
 * into `telemetry` without notifying anyone — live numbers are read by the
 * requestAnimationFrame loop in app.js, so a fast stream never triggers a
 * re-render. Only structural changes (profile, state, selection) publish.
 */

class Store {
  constructor() {
    this.info = null;
    this.profile = { version: 1, settings: {}, connections: [] };
    this.states = new Map(); // id -> {state, detail, attempt, nextRetryMs, lastError}
    this.telemetry = new Map(); // id -> latest telemetry frame (hot, not observed)
    this.fieldLayouts = new Map(); // id -> {fields, inferred}
    this.selectedId = null;
    this.view = 'dashboard';
    this._subs = new Set();
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  /** Publish a structural change. Never call this from the telemetry path. */
  emit(reason) {
    for (const fn of this._subs) fn(reason);
  }

  get connections() { return this.profile.connections; }

  find(id) { return this.profile.connections.find((c) => c.id === id) || null; }

  get selected() { return this.find(this.selectedId); }

  stateOf(id) {
    const s = this.states.get(id);
    return s ? s.state : 'idle';
  }

  telemetryOf(id) { return this.telemetry.get(id) || null; }

  setProfile(profile) {
    this.profile = profile;
    // Everything keyed by connection id follows the profile. A connection
    // deleted while running kept its last telemetry frame here forever — the
    // only eviction was an `idle` event no deleted link ever sends.
    const ids = new Set(profile.connections.map((c) => c.id));
    for (const map of [this.states, this.telemetry, this.fieldLayouts]) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    }
    if (this.selectedId && !this.find(this.selectedId)) this.selectedId = null;
    if (!this.selectedId && profile.connections.length) this.selectedId = profile.connections[0].id;
    this.emit('profile');
  }

  setView(view, id) {
    this.view = view;
    if (id) this.selectedId = id;
    this.emit('view');
  }

  select(id) {
    this.selectedId = id;
    this.emit('select');
  }

  applyLinkState(payload) {
    const prev = this.states.get(payload.id);
    this.states.set(payload.id, payload);
    // Only re-render when the state name itself changed; detail text alone
    // (retry countdowns and the like) is picked up by the animation loop.
    if (!prev || prev.state !== payload.state) this.emit('linkState');
    else this.emit('linkDetail');
  }

  applyTelemetry(frame) {
    let discovered = false;
    for (const t of frame.links) {
      this.telemetry.set(t.id, t);

      // Link state arrives as a *transition* event, so a client that connects
      // to an already-running bridge never hears one and would show every link
      // as idle — pills reading IDLE beside a live position, and the encoder
      // config screen refusing to read because it believed nothing was
      // connected. Telemetry carries the current state, so adopt it for any
      // link we have not been told about.
      // Reconciled on every frame rather than seeded once, so the same gap
      // after an EventSource reconnect — during which transitions were missed —
      // heals itself within one telemetry tick.
      const known = this.states.get(t.id);
      if (!t.state) continue;
      const detail = t.detail || '';
      if (!known || known.state !== t.state || known.detail !== detail) {
        this.states.set(t.id, Object.assign({}, known, { id: t.id, state: t.state, detail }));
        // Only a change of state *name* rebuilds anything. Detail text alone —
        // a retry countdown, say — is painted from this map by the animation
        // loop, so re-rendering for it would undo the two-clock model and make
        // the cards flicker once a second.
        if (!known || known.state !== t.state) discovered = true;
      }
    }
    if (discovered) this.emit('linkState');
  }

  clearTelemetry(id) { this.telemetry.delete(id); }
}

export const store = new Store();
