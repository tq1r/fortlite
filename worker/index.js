// Cloudflare entry point.
//   /ws        -> the game room (GameRoom Durable Object runs the match)
//   /api/*     -> accounts, friends, leaderboard (Accounts Durable Object, SQLite)
//   everything else is the page in public/
import { createGame } from '../core.js';
import S from '../shared.js';   // S.OUTFITS: the cosmetic table (unlock rules live there)

const ACCOUNTS_ID = 'main';          // one accounts store for everyone
const PBKDF2_ITERATIONS = 100000;    // the most Workers' Web Crypto allows

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

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
    if (url.pathname.startsWith('/api/')) {
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(ACCOUNTS_ID)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// The game room: one Durable Object holds the whole match in memory.
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // FAST_MATCHES=1 (local tests only, set with wrangler dev --var): short matches with no bots, bus or storm
    const fast = env.FAST_MATCHES === '1';
    this.game = createGame({
      onMatchEnd: (rows) => this.recordMatch(rows),
      fast, nobus: fast, nostorm: fast, bots: fast ? 0 : undefined,
    });
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

  // send the human results of a finished match to the accounts store (stats only)
  recordMatch(rows) {
    const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(ACCOUNTS_ID));
    return stub.fetch('https://accounts.internal/internal/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rows),
    });
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

// Accounts store: users (name + salted PBKDF2 hash), sessions, friends and match stats.
export class Accounts {
  constructor(state) {
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL,
        matches INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER NOT NULL, friend_id INTEGER NOT NULL, PRIMARY KEY (user_id, friend_id))`);
      // cosmetics: the chosen outfit index (added after launch, so check the columns first)
      const cols = this.sql.exec('PRAGMA table_info(users)').toArray().map(c => c.name);
      if (!cols.includes('outfit')) this.sql.exec('ALTER TABLE users ADD COLUMN outfit INTEGER NOT NULL DEFAULT 0');
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/internal/match' && method === 'POST') return this.recordMatch(await request.json());
      if (path === '/api/register' && method === 'POST') return this.register(await request.json());
      if (path === '/api/login' && method === 'POST') return this.login(await request.json());
      if (path === '/api/logout' && method === 'POST') return this.logout(request);
      if (path === '/api/me' && method === 'GET') return this.me(request);
      if (path === '/api/leaderboard' && method === 'GET') return this.leaderboard();
      if (path === '/api/outfit' && method === 'POST') return this.setOutfit(request, await request.json());
      if (path === '/api/friends' && method === 'GET') return this.friends(request);
      if (path === '/api/friends/add' && method === 'POST') return this.friendChange(request, await request.json(), true);
      if (path === '/api/friends/remove' && method === 'POST') return this.friendChange(request, await request.json(), false);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'bad request' }, 400);
    }
  }

  // ---- helpers ----
  one(query, ...args) {
    const rows = this.sql.exec(query, ...args).toArray();
    return rows.length ? rows[0] : null;
  }

  async hash(password, saltHex) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const salt = hexToBytes(saltHex);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
    return bytesToHex(new Uint8Array(bits));
  }

  newSession(userId) {
    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)', token, userId, Date.now());
    return token;
  }

  userFromRequest(request) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    return this.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
  }

  // an outfit is unlocked when the account's stat reaches the table's minimum (index 0 is always free)
  outfitUnlocked(u, idx) {
    const o = S.OUTFITS[idx];
    if (!o) return false;
    if (!o.unlock) return true;
    return (u[o.unlock.stat] || 0) >= o.unlock.min;
  }

  statsOf(u) {
    const unlocked = S.OUTFITS.map((_, i) => i).filter(i => this.outfitUnlocked(u, i));
    return { name: u.name, matches: u.matches, wins: u.wins, kills: u.kills, best: u.best, outfit: u.outfit || 0, unlocked };
  }

  // ---- routes ----
  async register(body) {
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return json({ error: 'Name: 3 to 16 letters, numbers or _' }, 400);
    if (password.length < 6 || password.length > 100) return json({ error: 'Password: 6 to 100 characters' }, 400);
    if (this.one('SELECT id FROM users WHERE name = ?', name)) return json({ error: 'That name is taken' }, 409);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await this.hash(password, salt);
    this.sql.exec('INSERT INTO users (name, salt, hash, created) VALUES (?, ?, ?, ?)', name, salt, hash, Date.now());
    const u = this.one('SELECT * FROM users WHERE name = ?', name);
    return json({ token: this.newSession(u.id), ...this.statsOf(u) });
  }

  async login(body) {
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const u = this.one('SELECT * FROM users WHERE name = ?', name);
    // same message for unknown name and wrong password
    if (!u || (await this.hash(password, u.salt)) !== u.hash) return json({ error: 'Wrong name or password' }, 401);
    return json({ token: this.newSession(u.id), ...this.statsOf(u) });
  }

  setOutfit(request, body) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const idx = Number(body.outfit);
    if (!Number.isInteger(idx) || !S.OUTFITS[idx]) return json({ error: 'Unknown outfit' }, 400);
    if (!this.outfitUnlocked(u, idx)) return json({ error: 'That outfit is locked' }, 403);
    this.sql.exec('UPDATE users SET outfit = ? WHERE id = ?', idx, u.id);
    return json(this.statsOf({ ...u, outfit: idx }));
  }

  logout(request) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token) this.sql.exec('DELETE FROM sessions WHERE token = ?', token);
    return json({ ok: true });
  }

  me(request) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    return json(this.statsOf(u));
  }

  leaderboard() {
    const rows = this.sql.exec('SELECT name, wins, kills, matches, best FROM users ORDER BY wins DESC, kills DESC, name LIMIT 20').toArray();
    return json({ rows });
  }

  friends(request) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const rows = this.sql.exec(
      'SELECT x.name, x.wins, x.kills FROM friends f JOIN users x ON x.id = f.friend_id WHERE f.user_id = ? ORDER BY x.name', u.id
    ).toArray();
    return json({ rows });
  }

  friendChange(request, body, add) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const other = this.one('SELECT id, name FROM users WHERE name = ?', String(body.name || '').trim());
    if (!other) return json({ error: 'No player with that name' }, 404);
    if (other.id === u.id) return json({ error: 'That is you' }, 400);
    if (add) {
      // friendships are mutual
      this.sql.exec('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', u.id, other.id);
      this.sql.exec('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', other.id, u.id);
    } else {
      this.sql.exec('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', u.id, other.id);
      this.sql.exec('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', other.id, u.id);
    }
    return this.friends(request);
  }

  // called by the game room when a match ends (never reachable from the public routes)
  recordMatch(rows) {
    if (!Array.isArray(rows)) return json({ ok: false }, 400);
    for (const r of rows.slice(0, 40)) {
      const u = this.one('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', String(r.token || ''));
      if (!u) continue;
      const place = Math.max(0, Math.floor(Number(r.place) || 0));
      const kills = Math.max(0, Math.floor(Number(r.kills) || 0));
      const won = r.won ? 1 : 0;
      this.sql.exec(
        `UPDATE users SET matches = matches + 1, wins = wins + ?, kills = kills + ?,
           best = CASE WHEN best = 0 OR (? > 0 AND ? < best) THEN ? ELSE best END WHERE id = ?`,
        won, kills, place, place, place, u.id
      );
    }
    return json({ ok: true });
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
