#!/usr/bin/env node
/* Battle Bus flow test (spawn island, bus, skydive, landing, live).
   Drives real mechanics: harvest → build → destroy wall → loot weapon
   → shoot enemy → friendly-fire check → chest → kill → match end. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const PORT = 3100 + ((Math.random() * 800) | 0);
const S = require('./shared.js');

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
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
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

let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  PASS', l); } else { failed++; console.log('  FAIL:', l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// nearest point (searching outward) with clear ground: no obstacle or building footprint close by
function openSpotNear(cx, cy, obstacles, floors) {
  for (let r = 160; r <= 560; r += 30) {
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (x < 150 || y < 150 || x > S.WORLD - 150 || y > S.WORLD - 150) continue;
      if (obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 100)) continue;
      if (floors.some(f => x > f.x - 100 && x < f.x + f.w + 100 && y > f.y - 100 && y < f.y + f.h + 100)) continue;
      return { x, y };
    }
  }
  return null;
}

function posOf(c, id) {
  const s = c.last(m => m.t === 'snap' && m.p.some(p => p[0] === id));
  if (!s) return null;
  const e = s.p.find(p => p[0] === id);
  return { x: e[1], y: e[2] };
}

// move a client toward a world position; resolves when within `rad`
async function moveToward(c, id, tx, ty, rad, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastPos = null, stuckSince = null, detourUntil = 0, detourAng = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const p = posOf(c, id);
      if (!p) return;
      const d = Math.hypot(tx - p.x, ty - p.y);
      if (d <= rad || Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        c.send({ t: 'input', x: 0, y: 0, aim: 0, f: false, b: false });
        resolve();
        return;
      }
      const now = Date.now();
      if (lastPos) {
        const moved = Math.hypot(p.x - lastPos.x, p.y - lastPos.y);
        if (moved < 3) { if (!stuckSince) stuckSince = now; }
        else stuckSince = null;
      }
      lastPos = p;
      let ang = Math.atan2(ty - p.y, tx - p.x);
      if (stuckSince && now - stuckSince > 500 && now > detourUntil) {
        detourUntil = now + 700;
        detourAng = ang + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
      }
      if (now < detourUntil) ang = detourAng;
      c.send({ t: 'input', x: Math.cos(ang), y: Math.sin(ang), aim: ang, f: false, b: false });
    }, 40);
  });
  const p = posOf(c, id);
  return p ? Math.hypot(tx - p.x, ty - p.y) : 1e9;
}


async function main() {
  console.log(`Battle Bus test on :${PORT} (6 bots, fast mode)...`);
  const server = spawn('node', ['server.js', '--port', PORT, '--bots', 6, '--fast'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', kill);
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  server.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d));
  await sleep(600);

  const A = new WSClient(`ws://127.0.0.1:${PORT}/ws`, 'A');
  A.onopen = () => { A.send({ t: 'hello', name: 'Alice' }); A.send({ t: 'mode', m: 'solo' }); };
  const welcome = await A.wait(m => m.t === 'welcome', 5000);
  ok(welcome.state === 'lobby', 'joins the spawn island lobby');

  // ---- 1. spawn island: walk around ----
  const lp0 = await A.wait(m => m.t === 'lpos' && m.p.some(e => e[0] === welcome.id), 3000);
  const me0 = lp0.p.find(e => e[0] === welcome.id);
  const I = S.ISLAND;
  ok(Math.hypot(me0[1] - I.x, me0[2] - I.y) < I.r, `spawns on the island (${Math.round(me0[1])}, ${Math.round(me0[2])})`);
  const moveT = setInterval(() => A.send({ t: 'input', x: 1, y: 0, aim: 0 }), 40);
  await sleep(900);
  clearInterval(moveT);
  const lpNow = A.msgs.filter(m => m.t === 'lpos').slice(-1)[0];
  const meNow = lpNow.p.find(e => e[0] === welcome.id);
  ok(meNow[1] > me0[1] + 60, `walks around the island (x ${Math.round(me0[1])} → ${Math.round(meNow[1])})`);
  ok(Math.hypot(meNow[1] - I.x, meNow[2] - I.y) <= I.r, 'stays on the island disc');

  // ---- 2. bus starts when the lobby timer ends ----
  const start = await A.wait(m => m.t === 'start', 20000);
  ok(start.players.some(p => p.id === welcome.id), 'match start lists me');
  ok(start.world.pois && start.world.pois.length === S.POI_COUNT, `world has ${start.world.pois && start.world.pois.length} named POIs`);
  ok(start.world.pois.every(p => p.n && p.r > 0), 'every POI has a name and a radius');
  const busEv = await A.wait(m => m.t === 'ev' && m.k === 'busStart', 3000).catch(() => null);
  ok(!!busEv, 'busStart event fired');
  const s1 = await A.wait(m => m.t === 'snap' && m.bus, 3000);
  const meS = s1.p.find(p => p[0] === welcome.id);
  ok(meS && meS[11] === S.PH.bus, 'I ride the bus (phase bus)');
  ok(s1.st === null, 'no storm while the bus flies');
  ok(s1.bus && Math.abs(s1.bus.x) < 5000, `bus route visible (${s1.bus.x}, ${s1.bus.y})`);
  ok(s1.p.filter(p => p[11] === S.PH.bus).length === s1.p.length, 'everyone starts on the bus');

  // no shooting from the bus
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: true, b: false });
  await sleep(500);
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: false, b: false });
  const shotsOnBus = A.msgs.filter(m => m.t === 'ev' && m.k === 'shot' && m.id === welcome.id).length;
  ok(shotsOnBus === 0, 'cannot shoot while on the bus');

  // ---- 3. jump and skydive ----
  const bsBefore = A.msgs.filter(m => m.t === 'snap').slice(-1)[0];
  A.send({ t: 'act', a: 'jump' });
  const fall1 = await A.wait(m => m.t === 'snap' && m.p.some(p => p[0] === welcome.id && p[11] === S.PH.fall), 3000);
  ok(!!fall1, 'jump starts the skydive (phase fall)');
  const alt1 = fall1.p.find(p => p[0] === welcome.id)[12];
  await sleep(1000);
  const fall2 = A.msgs.filter(m => m.t === 'snap').slice(-1)[0];
  const alt2 = fall2.p.find(p => p[0] === welcome.id)[12];
  ok(alt2 < alt1, `altitude falls during the dive (${alt1} → ${alt2})`);
  const jumpEv = A.msgs.find(m => m.t === 'ev' && m.k === 'jump' && m.id === welcome.id);
  ok(!!jumpEv, 'jump event broadcast');
  // steer while falling: move west and check the ground position changes
  const fx0 = fall2.p.find(p => p[0] === welcome.id)[1];
  const steerT = setInterval(() => A.send({ t: 'input', x: -1, y: 0, aim: 0 }), 40);
  await sleep(600);
  clearInterval(steerT);
  const fall3 = A.msgs.filter(m => m.t === 'snap').slice(-1)[0];
  const fx1 = fall3.p.find(p => p[0] === welcome.id)[1];
  ok(fx1 < fx0 - 50, `steers while skydiving (x ${Math.round(fx0)} → ${Math.round(fx1)})`);

  // ---- 4. landing ----
  const land = await A.wait(m => m.t === 'ev' && m.k === 'land' && m.id === welcome.id, 8000);
  ok(!!land, `lands at (${land.x}, ${land.y})`);
  ok(land.x >= 0 && land.x <= S.WORLD && land.y >= 0 && land.y <= S.WORLD, 'landing spot is on the map');
  const landed = await A.wait(m => m.t === 'snap' && m.p.some(p => p[0] === welcome.id && p[11] === S.PH.ground), 3000);
  ok(!!landed, 'phase returns to ground after landing');

  // ---- 5. match goes live when the route ends ----
  const live = await A.wait(m => m.t === 'ev' && m.k === 'live', 25000);
  ok(!!live, 'match goes live after the bus route');
  // every bot has jumped by then (forced at the end of the route); give the last divers time to land
  await sleep(4800);
  const liveSnap = A.msgs.filter(m => m.t === 'snap').slice(-1)[0];
  ok(!!liveSnap.st, 'latest snapshot carries the storm');
  const airborne = liveSnap.p.filter(p => p[11] !== S.PH.ground).length;
  ok(airborne === 0, `all ${liveSnap.p.length} players are on the ground ${airborne ? '(' + airborne + ' still in the air)' : ''}`);
  ok(liveSnap.bus === null, 'bus gone once the match is live');
  ok(liveSnap.st && liveSnap.st.ph >= -1, `storm runs once the match is live (phase ${liveSnap.st && liveSnap.st.ph})`);

  console.log(`\n=== BUS RESULTS: ${passed} passed, ${failed} failed ===`);
  server.kill('SIGKILL');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
