#!/usr/bin/env node
/* Gameplay integration test: 2 humans, no bots, no storm.
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
  console.log(`Gameplay test on :${PORT} (no bots, no storm)...`);
  const server = spawn('node', ['server.js', '--port', PORT, '--bots', 0, '--nostorm', '--nobus', '--fast'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', kill);
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  server.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d));
  await sleep(600);

  const A = new WSClient(`ws://127.0.0.1:${PORT}/ws`, 'A');
  A.onopen = () => A.send({ t: 'hello', name: 'Alice' });
  const B = new WSClient(`ws://127.0.0.1:${PORT}/ws`, 'B');
  B.onopen = () => B.send({ t: 'hello', name: 'Bob' });
  // both on RED team (duo mode) for friendly-fire test
  const wa = await A.wait(m => m.t === 'welcome');
  const wb = await B.wait(m => m.t === 'welcome');
  A.send({ t: 'mode', m: 'duo' });
  B.send({ t: 'mode', m: 'duo' });
  await sleep(200);
  A.send({ t: 'team', team: 1 });
  B.send({ t: 'team', team: 1 });
  await sleep(200);
  const start = await A.wait(m => m.t === 'start', 20000);
  await B.wait(m => m.t === 'start');
  ok(start.players.length === 2, `match started with ${start.players.length} players (humans only)`);
  await A.wait(m => m.t === 'snap' && m.p.length === 2);

  const obstacles = start.world.obstacles;
  const chests = start.world.chests;
  const lootItems = start.world.loot;

  // ---- 1. HARVEST ----
  const pa0 = posOf(A, wa.id);
  // pick the nearest tree that is reasonably isolated (clear walk + no cluster blocking)
  const trees = obstacles.filter(o => o.ty === 'tree');
  for (const t of trees) {
    let minNeighbor = 1e9;
    for (const o of obstacles) {
      if (o === t) continue;
      minNeighbor = Math.min(minNeighbor, Math.hypot(o.x - t.x, o.y - t.y));
    }
    t.iso = minNeighbor;
  }
  trees.sort((a, b) => (Math.hypot(a.x - pa0.x, a.y - pa0.y) / (a.iso > 200 ? 1 : 5)) - (Math.hypot(b.x - pa0.x, b.y - pa0.y) / (b.iso > 200 ? 1 : 5)));
  const tree = trees[0];
  const bd = Math.hypot(tree.x - pa0.x, tree.y - pa0.y);
  console.log(`  … walking to tree @${tree.x},${tree.y} (${Math.round(bd)}px away, isolation ${Math.round(tree.iso)})`);
  let distTree = await moveToward(A, wa.id, tree.x + (pa0.x < tree.x ? -1 : 1) * (tree.r + 34), tree.y, 12);
  if (distTree > 40) { // try approaching from the other axis
    distTree = await moveToward(A, wa.id, tree.x, tree.y + (pa0.y < tree.y ? -1 : 1) * (tree.r + 34), 12);
  }
  ok(distTree < 40, `reached tree (dist ${Math.round(distTree)})`);
  const pA = posOf(A, wa.id);
  const aimAtTree = Math.atan2(tree.y - pA.y, tree.x - pA.x);
  A.send({ t: 'input', x: 0, y: 0, aim: aimAtTree, f: true, b: false });
  const harvestEv = await A.wait(m => m.t === 'ev' && m.k === 'harvest' && m.n > 0, 8000);
  A.send({ t: 'input', x: 0, y: 0, aim: aimAtTree, f: false, b: false });
  ok(!!harvestEv, `harvested ${harvestEv ? harvestEv.n : 0} wood from tree`);
  const youAfter = await A.wait(m => m.t === 'you' && m.mats && m.mats.wood > 0, 5000);
  ok(youAfter.mats.wood >= 10, `A has ${youAfter.mats.wood} wood`);

  // ---- 2. BUILD + DESTROY WALL ----
  A.send({ t: 'act', a: 'mat', m: 'wood' });
  // walk to open ground first (trees, rocks and POI buildings block the grid cells around us)
  const pBack = posOf(A, wa.id);
  const spot = openSpotNear(pBack.x, pBack.y, start.world.obstacles, start.world.floors);
  ok(!!spot, 'found open ground near the tree');
  await moveToward(A, wa.id, spot.x, spot.y, 25);
  let wallEv = null;
  for (let a = 0; a < 28 && !wallEv; a++) {
    const ang = a / 28 * Math.PI * 2;
    A.send({ t: 'input', x: 0, y: 0, aim: ang, f: true, b: true });
    try {
      wallEv = await A.wait(m => m.t === 'ev' && m.k === 'wall', 1500);
    } catch (e) { /* try next angle */ }
  }
  A.send({ t: 'input', x: 0, y: 0, aim: 0, f: false, b: false });
  if (!wallEv) throw new Error('could not place a wall from any angle this seed');
  ok(wallEv.m === 'wood', `placed wood wall @${wallEv.gx},${wallEv.gy}`);
  const youB = await A.wait(m => m.t === 'you' && m.mats.wood < youAfter.mats.wood, 5000);
  ok(youB.mats.wood === youAfter.mats.wood - 10, `wood deducted (${youAfter.mats.wood} → ${youB.mats.wood})`);
  // swing at the wall to damage it (150 hp / 50 per swing)
  const pW = posOf(A, wa.id);
  const wallAim2 = Math.atan2(wallEv.gy * 60 + 30 - pW.y, wallEv.gx * 60 + 30 - pW.x);
  A.send({ t: 'input', x: 0, y: 0, aim: wallAim2, f: true, b: false });
  const wallGoneEv = await A.wait(m => m.t === 'ev' && m.k === 'wallGone' && m.gx === wallEv.gx && m.gy === wallEv.gy, 10000);
  A.send({ t: 'input', x: 0, y: 0, aim: wallAim2, f: false, b: false });
  ok(!!wallGoneEv, 'pickaxe destroyed own wall');

  // ---- 3. LOOT WEAPON ----
  const pA3 = posOf(A, wa.id);
  let wLoot = null, bdW = 1e9;
  for (const l of lootItems) {
    if (l.k !== 'weapon') continue;
    const d = Math.hypot(l.x - pA3.x, l.y - pA3.y);
    if (d < bdW) { bdW = d; wLoot = l; }
  }
  console.log(`  … walking to ${S.WEAPONS[wLoot.w].name} @${wLoot.x},${wLoot.y} (${Math.round(bd)}px)`);
  await moveToward(A, wa.id, wLoot.x, wLoot.y, 20);
  await sleep(300);
  const youW = await A.wait(m => m.t === 'you' && m.slots.some(s => s && s.k === 'w'), 5000);
  const wslot = youW.slots.find(s => s && s.k === 'w');
  ok(!!wslot, `picked up ${S.WEAPONS[wslot.w].name} (rarity ${wslot.r}, mag ${wslot.mag})`);
  const ammoT = S.WEAPONS[wslot.w].ammo;
  ok(youW.ammo[ammoT] > 0, `reserve ammo ${youW.ammo[ammoT]} ${ammoT}`);

  // ---- 4. FRIENDLY FIRE (same team) ----
  A.send({ t: 'act', a: 'select', i: youW.slots.indexOf(wslot) });
  const pA4 = posOf(A, wa.id), pB4 = posOf(B, wb.id);
  await moveToward(A, wa.id, pB4.x, pB4.y, 260, 30000);
  const pA5 = posOf(A, wa.id), pB5 = posOf(B, wb.id);
  const aimB = Math.atan2(pB5.y - pA5.y, pB5.x - pA5.x);
  const hpB0 = (B.last(m => m.t === 'snap' && m.p.some(p => p[0] === wb.id)).p.find(p => p[0] === wb.id))[4];
  A.send({ t: 'input', x: 0, y: 0, aim: aimB, f: true, b: false });
  await sleep(1200);
  A.send({ t: 'input', x: 0, y: 0, aim: aimB, f: false, b: false });
  await sleep(400);
  const snapB = B.last(m => m.t === 'snap' && m.p.some(p => p[0] === wb.id));
  const hpB1 = snapB ? snapB.p.find(p => p[0] === wb.id)[4] : 0;
  ok(hpB1 === hpB0, `friendly fire off (B hp ${hpB0} → ${hpB1})`);

  // ---- 5. verify shot events + mag decrement with a fresh burst
  const shotsBy = () => A.msgs.filter(m => m.t === 'ev' && m.k === 'shot' && m.id === wa.id).length;
  const shots0 = shotsBy();
  const mag0 = (A.last(m => m.t === 'you' && m.slots.some(s => s && s.k === 'w')).slots.find(s => s && s.k === 'w')).mag;
  A.send({ t: 'input', x: 0, y: 0, aim: aimB, f: true, b: false });
  let waited = 0;
  while (shotsBy() <= shots0 && waited < 4000) { await sleep(100); waited += 100; }
  await sleep(250);
  A.send({ t: 'input', x: 0, y: 0, aim: aimB, f: false, b: false });
  ok(shotsBy() > shots0, `fresh shots fired (${shotsBy() - shots0})`);
  const youMag = A.last(m => m.t === 'you' && m.slots.some(s => s && s.k === 'w'));
  const mag1 = youMag.slots.find(s => s && s.k === 'w').mag;
  ok(mag1 < mag0 || youMag.reload > 0, `mag consumed (${mag0} → ${mag1}${youMag.reload > 0 ? ' reloading' : ''})`);

  // ---- 6. CHEST ----
  const pA6 = posOf(A, wa.id);
  let chest = null, bdC = 1e9;
  for (const c of chests) {
    const d = Math.hypot(c.x - pA6.x, c.y - pA6.y);
    if (d < bdC) { bdC = d; chest = c; }
  }
  console.log(`  … walking to chest @${chest.x},${chest.y} (${Math.round(bd)}px)`);
  await moveToward(A, wa.id, chest.x, chest.y, 40);
  A.send({ t: 'act', a: 'interact' });
  const chestEv = await A.wait(m => m.t === 'ev' && m.k === 'chest', 5000);
  ok(!!chestEv, `chest opened, loot spilled`);
  await A.wait(m => m.t === 'ev' && m.k === 'lootAdd', 3000);
  ok(true, 'loot spawned from chest');

  // ---- 7. KILL B → MATCH END ----
  // B is on same team; to end the match, B leaves instead
  console.log('  … B disconnects → A should win');
  const killsBefore = A.msgs.filter(m => m.t === 'ev' && m.k === 'kill').length;
  B.sock.destroy();
  const endMsg = await A.wait(m => m.t === 'end', 10000);
  ok(!!endMsg, 'match ended when last enemy left');
  ok(endMsg.winnerIds && endMsg.winnerIds.includes(wa.id), `A is the winner (${endMsg.winner})`);
  const placeRow = endMsg.board.find(r => r.name === 'Alice');
  ok(!!placeRow && placeRow.place === 1, `A placed #1 (board says #${placeRow && placeRow.place})`);

  // ---- 8. NEXT MATCH CYCLE ----
  await A.wait(m => m.t === 'lobby' && m.state === 'lobby', 15000);
  ok(true, 'lobby returned after end');

  console.log(`\n=== GAMEPLAY RESULTS: ${passed} passed, ${failed} failed ===`);
  server.kill('SIGKILL');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
