'use strict';
/**
 * Server-Sent Events fan-out.
 *
 * The bridge already coalesces telemetry: one timer in LinkManager emits a
 * single message describing every link, at the configured rate, rather than one
 * message per sample. That decision is what makes a web UI viable at all — five
 * encoders at 500 Hz is 2500 samples/s, and none of that reaches the network.
 * This class only fans the existing stream out to however many clients are
 * watching.
 *
 * SSE rather than WebSocket because the traffic is one-directional (commands go
 * over REST) and `EventSource` reconnects on its own. That matters more than it
 * sounds: a browser left open on a show server has to survive the bridge being
 * restarted without anyone touching the keyboard.
 */

/** Keeps intermediaries from closing an idle stream. */
const HEARTBEAT_MS = 15000;

class SseHub {
  constructor() {
    this._clients = new Set();
    this._seq = 0;
    this._heartbeat = setInterval(() => this._writeAll(': ping\n\n'), HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  get clientCount() {
    return this._clients.size;
  }

  /**
   * Take over an HTTP response as an event stream.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  attach(req, res) {
    // Flush each telemetry frame the moment it is written. Without this, Nagle's
    // algorithm coalesces these small 30 Hz frames on a real network (it has no
    // effect on loopback), so a remote browser receives them in clumps and the
    // dashboard animation stutters. Loopback is unaffected; the LAN is smoothed.
    if (res.socket) res.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this an nginx in front would buffer the stream into uselessness.
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    this._clients.add(res);

    const drop = () => {
      this._clients.delete(res);
      res.destroy();
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
  }

  broadcast(event, data) {
    if (!this._clients.size) return;
    this._seq++;
    this._writeAll(`id: ${this._seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _writeAll(chunk) {
    for (const res of this._clients) {
      // A stalled reader must never back-pressure the bridge, so we ignore the
      // write-buffer signal and let the socket's own timeout deal with it.
      try {
        res.write(chunk);
      } catch {
        this._clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this._heartbeat);
    for (const res of this._clients) {
      try { res.end(); } catch { /* already gone */ }
    }
    this._clients.clear();
  }
}

/**
 * Wire a LinkManager's events onto a hub.
 *
 * `configChanged` is new. With a single window it was unnecessary — the editor
 * and the viewer were the same process. With several browsers open, every
 * client except the one that made the edit would otherwise show stale config
 * indefinitely.
 */
function bridgeEvents(manager, hub) {
  manager.on('telemetry', (p) => hub.broadcast('telemetry', p));
  manager.on('state', (p) => hub.broadcast('linkState', p));
  manager.on('encoderEvent', (p) => hub.broadcast('encoderEvent', p));
  manager.on('fieldLayout', (p) => hub.broadcast('encoderEvent', {
    id: p.id,
    kind: p.inferred ? 'fieldLayoutInferred' : 'fieldLayout',
    text: p.inferred
      ? `Field layout inferred${p.why ? ` (${p.why})` : ''}`
      : 'Field layout read from encoder',
    fields: p.fields
  }));
  manager.on('encoderMeta', (p) => hub.broadcast('encoderEvent', Object.assign({ kind: 'encoderMeta' }, p)));
  manager.on('log', (p) => hub.broadcast('log', p));
}

module.exports = { SseHub, bridgeEvents };
