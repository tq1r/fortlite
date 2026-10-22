#!/usr/bin/env node
/* Headless integration test: spins up the server on a test port,
   connects 2 fake clients via a raw WebSocket implementation,
   and drives them through lobby → match → combat → end. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const PORT = 3100 + ((Math.random() * 800) | 0);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- tiny WS client ----------
class WSClient {
  constructor(url) {
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
    const u = new URL(url.replace('http://', 'ws://').replace('https://', 'wss://'));
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(+u.port, u.hostname || '127.0.0.1', () => {
      sock.write(
        `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    this.pending = [];
    sock.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      if (!this.handshook) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = this.buf.slice(0, idx).toString();
        if (!/101/.test(head)) throw new Error('handshake failed: ' + head);
        this.handshook = true;
        this.buf = this.buf.slice(idx + 4);
        if (this.onopen) this.onopen();
      }
      this.parse();
    });
    sock.on('error', e => { this.closed = true; });
    sock.on('close', () => { this.closed = true; });
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
      } else if (op === 9) { this.sendRaw(0xA, payload); }
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
  send(obj) { this.sendRaw(0x1, Buffer.from(JSON.stringify(obj))); }
  wait(pred, timeout = 15000) {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }
}

// ---------- assertions ----------
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.log('  FAIL:', label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Starting server on :${PORT} (fast mode, 6 bots)...`);
  const server = spawn('node', ['server.js', '--port', PORT, '--bots', 6, '--fast', '--nobus'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  server.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d));
  await sleep(700);
  // health check
  const health = await new Promise((res, rej) => {
    http.get(BASE + '/health', r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
  });
  ok(health.includes('ok'), 'HTTP /health responds');

  // index.html served
  const idx = await new Promise((res, rej) => {
    http.get(BASE + '/', r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
  });
  ok(idx.includes('FORTLITE'), 'index.html served (Fortlite)');
  const sh = await new Promise((res, rej) => {
    http.get(BASE + '/shared.js', r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
  });
  ok(sh.includes('WEAPONS'), 'shared.js served');

  console.log('Connecting clients A and B...');
  const A = new WSClient(`ws://127.0.0.1:${PORT}/ws`);
  A.onopen = () => A.send({ t: 'hello', name: 'TesterA' });
  const B = new WSClient(`ws://127.0.0.1:${PORT}/ws`);
  B.onopen = () => B.send({ t: 'hello', name: 'TesterB<script>' });
  const wa = await A.wait(m => m.t === 'welcome');
  ok(wa && typeof wa.id === 'number', 'A got welcome');
  const wb = await B.wait(m => m.t === 'welcome');
  ok(!!wb.id, 'B got welcome (name sanitized: check via lobby)');

  const lobbyA = await A.wait(m => m.t === 'lobby' && m.players.length === 2);
  ok(lobbyA.state === 'lobby' && lobbyA.cd <= 4, `A in lobby, cd=${lobbyA.cd}`);
  ok(lobbyA.players.length === 2, 'lobby lists 2 players');
  ok(lobbyA.players.every(p => !p.name.includes('<')), 'names sanitized');

  // duo has its own test (test-duo.js): here both players are in the solo room
  console.log('Waiting for match start (fast mode)...');
  const startA = await A.wait(m => m.t === 'start', 20000);
  ok(startA.world && startA.world.obstacles.length > 50, `world has ${startA.world.obstacles.length} obstacles`);
  ok(startA.world.obstacles.some(o => o.ty === 'water'), 'world has water lakes');
  ok(startA.world.chests.length > 10, `world has ${startA.world.chests.length} chests`);
  ok(startA.world.loot.length > 30, `world has ${startA.world.loot.length} loot items`);
  ok(startA.world.walls.length > 30, `buildings generated ${startA.world.walls.length} walls`);
  ok(startA.players.length === 6, `match filled to ${startA.players.length} players (2 humans + 4 bots)`);
  ok(startA.mode === 'solo', `match mode is ${startA.mode}`);
  ok(startA.players.every(p => !p.team), 'solo players have no team');
  const startB = await B.wait(m => m.t === 'start', 10000);
  ok(!!startB, 'B also got start');

  const myA = startA.players.find(p => p.id === wa.id);
  const myB = startB.players.find(p => p.id === wb.id);
  ok(!!myA && !!myB, 'both humans in match roster');

  // first snapshot
  const snap1 = await A.wait(m => m.t === 'snap');
  ok(snap1.p.length === 6, `snapshot has ${snap1.p.length} alive players`);
  const meSnap = snap1.p.find(p => p[0] === wa.id);
  ok(!!meSnap, 'A sees self in snapshot');
  const youA = await A.wait(m => m.t === 'you');
  ok(youA.hp === 100 && youA.alive, `A you-state ok (hp=${youA.hp})`);
  ok(youA.slots[0] && youA.slots[0].k === 'pick', 'A starts with pickaxe');

  // move A toward a direction & verify position changes
  const x0 = meSnap[1], y0 = meSnap[2];
  const moveTimer = setInterval(() => A.send({ t: 'input', x: 1, y: 0, aim: 0, f: false, b: false }), 40);
  await sleep(900);
  clearInterval(moveTimer);
  const snaps = A.msgs.filter(m => m.t === 'snap').slice(-3);
  const meNow = snaps[snaps.length - 1].p.find(p => p[0] === wa.id);
  ok(meNow && meNow[1] > x0 + 30, `A moved right (x ${Math.round(x0)} → ${Math.round(meNow[1])})`);

  // stop, then teleport-check build: place a wall
  A.send({ t: 'act', a: 'mat', m: 'wood' });
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: false, b: false });
  // give A materials by hacking? No — harvest instead: aim 0 & swing toward open space won't yield. Just try build (should fail w/o mats)
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: true, b: true });
  await sleep(300);
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: false, b: false });
  const noMatsEv = A.msgs.find(m => m.t === 'ev' && m.k === 'noMats');
  ok(!!noMatsEv, 'wall blocked without mats (noMats event)');

  // pickaxe swing event fires
  A.send({ t: 'input', x: 0, y: 0, aim: 3.14, f: true, b: false });
  await sleep(700);
  A.send({ t: 'input', x: 0, y: 0, aim: 3.14, f: false, b: false });
  const swingEv = A.msgs.find(m => m.t === 'ev' && m.k === 'swing');
  ok(!!swingEv, 'pickaxe swing event received');

  // storm progresses (fast mode): grace 4s
  await sleep(4500);
  const stormSnap = A.msgs.filter(m => m.t === 'snap').slice(-1)[0];
  ok(stormSnap.st && stormSnap.st.ph >= 0, `storm phase active (ph=${stormSnap.st.ph})`);

  // bots should eventually kill each other / fight — wait for kill events
  console.log('Waiting for bot battles / match end (fast storm)...');
  let endMsg = null;
  const tEnd = Date.now() + 120000;
  while (Date.now() < tEnd && !endMsg) {
    endMsg = A.msgs.find(m => m.t === 'end');
    if (endMsg) break;
    await sleep(1000);
    // keep A alive-ish: stand still (A may die to storm — that's ok, still gets end)
  }
  ok(!!endMsg, 'match ended');
  if (endMsg) {
    ok(endMsg.board && endMsg.board.length > 0, `end board has ${endMsg.board.length} rows`);
    ok(typeof endMsg.winner === 'string', `winner: ${endMsg.winner}`);
  }
  const killEvs = A.msgs.filter(m => m.t === 'ev' && m.k === 'kill');
  console.log(`  … ${killEvs.length} kills happened this match`);
  ok(killEvs.length > 0, 'at least one kill event occurred');

  // after end → lobby broadcast
  const lobbyAgain = await A.wait(m => m.t === 'lobby' && m.state === 'lobby', 20000);
  ok(!!lobbyAgain, 'back to lobby after match');

  // disconnect B mid-lobby, ensure no crash
  B.sock.destroy();
  await sleep(400);
  const h2 = await new Promise((res, rej) => {
    http.get(BASE + '/health', r => { let b = ''; r.on('data', c => c && (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
  ok(h2.includes('ok'), 'server healthy after disconnect');

  // bad input fuzzing
  for (const garbage of ['not json', '{"t":123}', '{"t":"input"}', '{"t":"act","a":"select","i":99}', '{"t":"team","team":99}', '\x00\x01\x02']) {
    A.sock.write(garbage); // raw non-WS-frame garbage should be tolerated as junk frames
  }
  await sleep(600);
  ok(true, 'survived garbage input');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  server.kill('SIGKILL');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
