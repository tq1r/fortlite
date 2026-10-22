#!/usr/bin/env node
/* Duo rules: a duo room takes only a party of two, a party is one team, every duo team has two
   players (bots fill the rest), and solo matches stay team-free. Runs its own server with --dev-party. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const path = require('path');

class WSClient {
  constructor(url, name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(+u.port, u.hostname, () => {
      this.sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    this.onopen = null;
    this.sock.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      if (!this.handshook) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        this.handshook = true;
        this.buf = this.buf.slice(idx + 4);
        if (this.onopen) this.onopen();
      }
      this.parse();
    });
    this.sock.on('close', () => this.closed = true);
    this.sock.on('error', () => this.closed = true);
  }
  parse() {
    while (true) {
      const buf = this.buf;
      if (buf.length < 2) break;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len);
      this.buf = buf.slice(off + len);
      if (op === 1) {
        const m = JSON.parse(payload.toString());
        this.msgs.push(m);
        this.waiters = this.waiters.filter(w => {
          if (w.pred(m)) { w.resolve(m); return false; }
          return true;
        });
      } else if (op === 9) this.sendRaw(0xA, payload);
    }
  }
  sendRaw(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = 0x80 | len; }
    else { header = Buffer.allocUnsafe(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    header[0] = 0x80 | op;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  send(o) { this.sendRaw(0x1, Buffer.from(JSON.stringify(o))); }
  wait(pred, timeout = 15000) {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.name}] timeout waiting`)), timeout);
      this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }
  last(pred) { const arr = this.msgs.filter(pred); return arr[arr.length - 1]; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
// a test client that says hello as soon as its socket opens (the server only makes a client after hello)
const mkClient = (url, name, list) => { const c = new WSClient(url, name); c.onopen = () => c.send({ t: 'hello', name }); list.push(c); return c; };
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

async function main() {
  const port = 3700 + Math.floor(Math.random() * 300);
  console.log(`Duo rules test on :${port} (fast, dev parties)...`);
  const srv = spawn('node', ['server.js', '--port', String(port), '--fast', '--dev-party'], { cwd: path.join(__dirname), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  const base = `ws://127.0.0.1:${port}/ws`;
  const clients = [];
  try {
    for (let i = 0; i < 50; i++) {
      const up = await new Promise(res => { const r = http.get(`http://127.0.0.1:${port}/health`, x => { x.resume(); res(true); }); r.on('error', () => res(false)); });
      if (up) break;
      await sleep(150);
    }
    console.log('[1] access');
    const guestDuo = mkClient(base + '?mode=duo', 'GuestDuo', clients);
    const err = await guestDuo.wait(m => m.t === 'err', 5000).catch(() => null);
    ok(!!err && /party/i.test(err.msg), `a guest is turned away from duo${err ? ': ' + err.msg : ''}`);
    await sleep(300);
    ok(guestDuo.closed, 'and the socket is closed');

    const soloGuest = mkClient(base + '?mode=solo&name=Solo', 'Solo', clients);
    const sw = await soloGuest.wait(m => m.t === 'welcome', 5000).catch(() => null);
    ok(!!sw, 'a guest is let into solo');

    console.log('[2] a party of two in duo');
    const d1 = mkClient(base + '?mode=duo&party=P-ONE&partner=Dee2&name=Dee1', 'Dee1', clients);
    const d2 = mkClient(base + '?mode=duo&party=P-ONE&partner=Dee1&name=Dee2', 'Dee2', clients);
    const w1 = await d1.wait(m => m.t === 'welcome', 5000).catch(() => null);
    const w2 = await d2.wait(m => m.t === 'welcome', 5000).catch(() => null);
    ok(!!w1 && !!w2, 'both party members are let into duo');
    const lobby = await d1.wait(m => m.t === 'lobby' && m.mode === 'duo', 5000).catch(() => null);
    ok(!!lobby, 'the duo room reports duo mode');

    console.log('[3] match start: teams');
    const dStart = await d1.wait(m => m.t === 'start', 60000).catch(() => null);
    ok(!!dStart, 'the duo match starts');
    if (dStart) {
      const ps = dStart.players;
      const byTeam = new Map();
      for (const p of ps) { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); }
      const teams = [...byTeam.keys()].filter(t => t > 0);
      ok(ps.length === 100, `${ps.length} players`);
      ok(teams.length === 50, `${teams.length} teams`);
      ok(teams.length && Math.min(...teams) === 1 && Math.max(...teams) === 50, 'teams are numbered 1 to 50');
      ok(teams.every(t => byTeam.get(t).length === 2), 'every team has exactly two players');
      const me1 = ps.find(p => p.id === w1.id), me2 = ps.find(p => p.id === w2.id);
      ok(!!me1 && !!me2 && me1.team > 0 && me1.team === me2.team, `the party shares one team (team ${me1 && me1.team})`);
      const partnerBot = me1 && byTeam.get(me1.team).some(p => p.bot);
      ok(!partnerBot, 'the party team has no bot in it');
    }

    console.log('[4] solo match: no teams');
    const sStart = await soloGuest.wait(m => m.t === 'start', 60000).catch(() => null);
    ok(!!sStart, 'the solo match starts');
    if (sStart) ok(sStart.players.every(p => !p.team), 'solo players have no team');
  } catch (e) {
    fail++; console.log('  CRASH ' + e.message);
  } finally {
    for (const c of clients) { try { c.sock.destroy(); } catch (_) { /* ignore */ } }
    srv.kill();
  }
  console.log(`\n=== DUO RESULTS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main();
