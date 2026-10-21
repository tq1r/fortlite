// Cloudflare entry point: routes /ws to the game room and serves the page from public/.
import { createGame } from '../core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      // one room for everyone for now (same as the single Node server)
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// The game room: one Durable Object holds the whole match in memory.
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.game = createGame({});
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const conn = this.wrap(server);
    this.game.acceptSocket(conn);
    this.game.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  // Adapts a Cloudflare WebSocket to the interface core.js expects (same as the Node WSConn).
  wrap(ws) {
    const room = this;
    const conn = {
      closed: false,
      onmessage: null,
      onclose: null,
      send(str) {
        if (conn.closed) return;
        try { ws.send(str); } catch (_) { /* socket already gone */ }
      },
      ping() { /* Cloudflare handles keepalive */ },
      slow() { return false; },
      _close() {
        if (conn.closed) return;
        conn.closed = true;
        try { ws.close(1000, 'closed'); } catch (_) { /* ignore */ }
        if (conn.onclose) conn.onclose();
        room.afterClose(conn);
      },
    };
    ws.addEventListener('message', (e) => {
      if (conn.onmessage && typeof e.data === 'string') conn.onmessage(e.data);
    });
    const gone = () => {
      if (conn.closed) return;
      conn.closed = true;
      if (conn.onclose) conn.onclose();
      room.afterClose(conn);
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return conn;
  }

  // stop the timers once the room is empty so the free-plan duration is not used up while idle
  afterClose() {
    if (this.game.clientCount() === 0) this.game.stop();
  }
}
