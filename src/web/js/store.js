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
    for (const t of frame.links) this.telemetry.set(t.id, t);
  }

  clearTelemetry(id) { this.telemetry.delete(id); }
}

export const store = new Store();
