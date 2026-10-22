// Cloudflare entry point.
//   /ws        -> the game room (GameRoom Durable Object runs the match)
//   /api/*     -> accounts, friends, leaderboard (Accounts Durable Object, SQLite)
//   everything else is the page in public/
import { createGame } from '../core.js';
import S from '../shared.js';   // S.OUTFITS: the cosmetic table (unlock rules live there)

const ACCOUNTS_ID = 'main';          // one accounts store for everyone
const PBKDF2_ITERATIONS = 100000;    // the most Workers' Web Crypto allows
const TICKET_MS = 2 * 60 * 1000;     // a game-connect ticket is good for two minutes

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
      // two rooms: solo matches and duo matches (duo rooms only take players in a party of two)
      const mode = url.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
      return env.ROOM.get(env.ROOM.idFromName(mode)).fetch(request);
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
      mode: state.id && state.id.name === 'duo' ? 'duo' : 'solo',
    });
  }

  async fetch(request) {
    // ?k=<ticket> comes from /api/ticket (a signed-in browser asks for one just before connecting)
    const ticket = new URL(request.url).searchParams.get('k') || '';
    const account = ticket ? await this.redeemTicket(ticket) : null;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const conn = this.wrap(server);
    this.game.acceptSocket(conn, account);
    this.game.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ticket -> { token, name, outfit } from the accounts store, or null if it is not valid
  async redeemTicket(ticket) {
    const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(ACCOUNTS_ID));
    const res = await stub.fetch('https://accounts.internal/internal/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
    });
    return res.ok ? res.json() : null;
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
      // one-time tickets that let a socket claim a signed-in account (short-lived)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
        ticket TEXT PRIMARY KEY, token TEXT NOT NULL, created INTEGER NOT NULL)`);
      // parties: two signed-in friends who queue for Duo together
      this.sql.exec(`CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, created INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS party_members (user_id INTEGER PRIMARY KEY, party_id TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS party_invites (
        id TEXT PRIMARY KEY, party_id TEXT NOT NULL, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, created INTEGER NOT NULL)`);
      // cosmetics: the chosen outfit index (added after launch, so check the columns first)
      const cols = this.sql.exec('PRAGMA table_info(users)').toArray().map(c => c.name);
      if (!cols.includes('outfit')) this.sql.exec('ALTER TABLE users ADD COLUMN outfit INTEGER NOT NULL DEFAULT 0');
    });
  }

  async fetch(incoming) {
    // Read any POST body up front, so routes that ignore the body (like /api/ticket) never leave
    // a request stream unread after the response (the Workers runtime rejects that).
    const method = incoming.method;
    const request = method === 'POST'
      ? new Request(incoming.url, { method, headers: incoming.headers, body: await incoming.text() })
      : incoming;
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/internal/match' && method === 'POST') return this.recordMatch(await request.json());
      if (path === '/internal/ticket' && method === 'POST') return this.redeemTicket(await request.json());
      if (path === '/api/ticket' && method === 'POST') return this.makeTicket(request);
      if (path === '/api/register' && method === 'POST') return this.register(await request.json());
      if (path === '/api/login' && method === 'POST') return this.login(await request.json());
      if (path === '/api/logout' && method === 'POST') return this.logout(request);
      if (path === '/api/me' && method === 'GET') return this.me(request);
      if (path === '/api/leaderboard' && method === 'GET') return this.leaderboard();
      if (path === '/api/outfit' && method === 'POST') return this.setOutfit(request, await request.json());
      if (path === '/api/friends' && method === 'GET') return this.friends(request);
      if (path === '/api/friends/add' && method === 'POST') return this.friendChange(request, await request.json(), true);
      if (path === '/api/friends/remove' && method === 'POST') return this.friendChange(request, await request.json(), false);
      if (path === '/api/party' && method === 'GET') return this.partyState(request);
      if (path === '/api/party/invite' && method === 'POST') return this.partyInvite(request, await request.json());
      if (path === '/api/party/accept' && method === 'POST') return this.partyAccept(request, await request.json());
      if (path === '/api/party/decline' && method === 'POST') return this.partyDecline(request, await request.json());
      if (path === '/api/party/leave' && method === 'POST') return this.partyLeave(request, await request.json());
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

  makeTicket(request) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !this.one('SELECT token FROM sessions WHERE token = ?', token)) return json({ error: 'Not signed in' }, 401);
    const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(24)));
    const now = Date.now();
    this.sql.exec('DELETE FROM tickets WHERE created < ?', now - TICKET_MS);
    this.sql.exec('INSERT INTO tickets (ticket, token, created) VALUES (?, ?, ?)', ticket, token, now);
    return json({ ticket });
  }

  // single use: the ticket is deleted whether or not it is still valid
  redeemTicket(body) {
    const ticket = String(body.ticket || '');
    const row = this.one('SELECT * FROM tickets WHERE ticket = ?', ticket);
    this.sql.exec('DELETE FROM tickets WHERE ticket = ?', ticket);
    if (!row || Date.now() - row.created > TICKET_MS) return json({ error: 'Ticket expired' }, 401);
    const u = this.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', row.token);
    if (!u) return json({ error: 'Signed out' }, 401);
    return json({ token: row.token, name: u.name, outfit: u.outfit || 0, party: this.partyForTicket(u) });
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

  // ---- parties ----
  partyOf(userId) {
    const row = this.one('SELECT party_id FROM party_members WHERE user_id = ?', userId);
    return row ? row.party_id : null;
  }
  membersOf(partyId) {
    return this.sql.exec(
      'SELECT u.id, u.name FROM party_members m JOIN users u ON u.id = m.user_id WHERE m.party_id = ? ORDER BY u.id', partyId
    ).toArray();
  }
  // a socket gets a party only when it is a full party of two
  partyForTicket(u) {
    const pid = this.partyOf(u.id);
    if (!pid) return null;
    const mem = this.membersOf(pid);
    if (mem.length !== 2) return null;
    const other = mem.find(m => m.id !== u.id);
    return { id: pid, partnerId: other.id, partnerName: other.name };
  }
  partyView(u) {
    const pid = this.partyOf(u.id);
    const party = pid ? { id: pid, members: this.membersOf(pid).map(m => ({ id: m.id, name: m.name })) } : null;
    const invites = this.sql.exec(
      'SELECT i.id, x.name AS from_name FROM party_invites i JOIN users x ON x.id = i.from_id WHERE i.to_id = ? ORDER BY i.created', u.id
    ).toArray().map(r => ({ id: r.id, from: r.from_name }));
    return json({ party, invites });
  }
  partyState(request) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    return this.partyView(u);
  }
  partyInvite(request, body) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const other = this.one('SELECT id, name FROM users WHERE name = ?', String(body.name || '').trim());
    if (!other) return json({ error: 'No player with that name' }, 404);
    if (other.id === u.id) return json({ error: 'That is you' }, 400);
    if (!this.one('SELECT 1 AS ok FROM friends WHERE user_id = ? AND friend_id = ?', u.id, other.id)) {
      return json({ error: 'You can only invite friends. Add them first.' }, 403);
    }
    if (this.partyOf(other.id)) return json({ error: other.name + ' is already in a party' }, 409);
    let pid = this.partyOf(u.id);
    if (!pid) {
      pid = crypto.randomUUID();
      this.sql.exec('INSERT INTO parties (id, created) VALUES (?, ?)', pid, Date.now());
      this.sql.exec('INSERT INTO party_members (user_id, party_id) VALUES (?, ?)', u.id, pid);
    }
    if (this.membersOf(pid).length >= 2) return json({ error: 'Your party is full (2 of 2)' }, 409);
    this.sql.exec('DELETE FROM party_invites WHERE party_id = ? AND to_id = ?', pid, other.id);
    this.sql.exec('INSERT INTO party_invites (id, party_id, from_id, to_id, created) VALUES (?, ?, ?, ?, ?)',
      crypto.randomUUID(), pid, u.id, other.id, Date.now());
    return this.partyView(u);
  }
  partyAccept(request, body) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const inv = this.one('SELECT * FROM party_invites WHERE id = ? AND to_id = ?', String(body.id || ''), u.id);
    if (!inv) return json({ error: 'That invite is gone' }, 404);
    const pidOwn = this.partyOf(u.id);
    if (pidOwn === inv.party_id) { this.sql.exec('DELETE FROM party_invites WHERE id = ?', inv.id); return this.partyView(u); }
    if (pidOwn) return json({ error: 'Leave your party first' }, 409);
    if (!this.one('SELECT id FROM parties WHERE id = ?', inv.party_id)) {
      this.sql.exec('DELETE FROM party_invites WHERE id = ?', inv.id);
      return json({ error: 'That party no longer exists' }, 404);
    }
    if (this.membersOf(inv.party_id).length >= 2) {
      this.sql.exec('DELETE FROM party_invites WHERE id = ?', inv.id);
      return json({ error: 'That party is full' }, 409);
    }
    this.sql.exec('INSERT INTO party_members (user_id, party_id) VALUES (?, ?)', u.id, inv.party_id);
    this.sql.exec('DELETE FROM party_invites WHERE to_id = ?', u.id);
    return this.partyView(u);
  }
  partyDecline(request, body) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    this.sql.exec('DELETE FROM party_invites WHERE id = ? AND to_id = ?', String(body.id || ''), u.id);
    return this.partyView(u);
  }
  partyLeave(request, body) {
    const u = this.userFromRequest(request);
    if (!u) return json({ error: 'Not signed in' }, 401);
    const pid = this.partyOf(u.id);
    if (pid) {
      this.sql.exec('DELETE FROM party_members WHERE user_id = ?', u.id);
      this.sql.exec('DELETE FROM party_invites WHERE from_id = ? AND party_id = ?', u.id, pid);
      if (!this.membersOf(pid).length) {
        this.sql.exec('DELETE FROM parties WHERE id = ?', pid);
        this.sql.exec('DELETE FROM party_invites WHERE party_id = ?', pid);
      }
    }
    return this.partyView(u);
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
