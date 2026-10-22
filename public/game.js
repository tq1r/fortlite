/* ============================================================
   FORTLITE — client
   Rendering • input • prediction • interpolation • FX • audio
   ============================================================ */
(() => {
'use strict';
const S = window.S;
const $ = id => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const mmCanvas = $('minimap'), mmCtx = mmCanvas.getContext('2d');
const TAU = Math.PI * 2;

// ============================================================
//  Audio (WebAudio synth — no assets)
// ============================================================
let AC = null, master = null, muted = false;
function audio() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = 0.35; master.connect(AC.destination);
    } catch (e) { /* no audio */ }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function envGain(vol, dur) {
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
  g.connect(master);
  return g;
}
function beep(f1, f2, dur, type, vol) {
  if (!audio() || muted) return;
  const o = AC.createOscillator();
  o.type = type || 'square';
  o.frequency.setValueAtTime(f1, AC.currentTime);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), AC.currentTime + dur);
  o.connect(envGain(vol || 0.2, dur));
  o.start(); o.stop(AC.currentTime + dur + 0.02);
}
let noiseBuf = null;
function noise(dur, vol, freq) {
  if (!audio() || muted) return;
  if (!noiseBuf) {
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 0.5, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = AC.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq || 1200;
  const g = envGain(vol || 0.25, dur);
  src.connect(f); f.connect(g);
  src.start(); src.stop(AC.currentTime + dur + 0.02);
}
// positional volume (0..1) based on distance from camera focus
function pvol(x, y) {
  if (cam == null) return 1;
  const d = Math.hypot(x - cam.x, y - cam.y);
  return Math.max(0, 1 - d / 1100);
}
const sfx = {
  shot(w, x, y) {
    const v = pvol(x, y); if (v <= 0.02) return;
    switch (w) {
      case 0: noise(0.05, 0.22 * v, 2400); beep(620, 180, 0.09, 'square', 0.14 * v); break;
      case 1: noise(0.04, 0.16 * v, 3000); beep(700, 260, 0.06, 'square', 0.1 * v); break;
      case 2: noise(0.22, 0.4 * v, 700); beep(160, 55, 0.22, 'sawtooth', 0.22 * v); noise(0.1, 0.2 * v, 1800); break;
      case 3: noise(0.06, 0.24 * v, 1800); beep(420, 130, 0.09, 'square', 0.16 * v); break;
      case 4: noise(0.3, 0.45 * v, 1200); beep(240, 40, 0.3, 'sawtooth', 0.26 * v); noise(0.12, 0.25 * v, 3500); break;
    }
  },
  swing(x, y) { const v = pvol(x, y); if (v > 0.02) beep(300, 90, 0.08, 'triangle', 0.12 * v); },
  chop(x, y, m) {
    const v = pvol(x, y); if (v <= 0.02) return;
    if (m === 'stone' || m === 'metal') { noise(0.08, 0.2 * v, 3000); beep(700, 400, 0.05, 'square', 0.1 * v); }
    else { beep(200, 90, 0.07, 'triangle', 0.22 * v); noise(0.05, 0.1 * v, 800); }
  },
  place(x, y) { const v = pvol(x, y); if (v > 0.02) { beep(240, 160, 0.1, 'square', 0.18 * v); setTimeout(() => beep(190, 130, 0.08, 'triangle', 0.12 * v), 60); } },
  breakWall(x, y) { const v = pvol(x, y); if (v > 0.02) { noise(0.25, 0.25 * v, 700); beep(140, 60, 0.2, 'triangle', 0.15 * v); } },
  hit(x, y) { const v = pvol(x, y); if (v > 0.02) beep(1000, 600, 0.04, 'square', 0.1 * v); },
  hitmark() { beep(1650, 1250, 0.04, 'square', 0.14); },
  hurt() { noise(0.09, 0.22, 900); beep(160, 70, 0.18, 'sawtooth', 0.3); },
  pickup() { beep(520, 900, 0.08, 'square', 0.15); },
  chest(x, y) { const v = pvol(x, y); if (v > 0.02) { beep(520, 520, 0.1, 'triangle', 0.2 * v); setTimeout(() => beep(780, 780, 0.14, 'triangle', 0.2 * v), 90); } },
  kill() { beep(660, 660, 0.09, 'triangle', 0.26); setTimeout(() => beep(880, 880, 0.09, 'triangle', 0.26), 80); setTimeout(() => beep(1320, 1320, 0.16, 'triangle', 0.28), 160); },
  death() { beep(400, 60, 0.5, 'sawtooth', 0.3); noise(0.4, 0.2, 600); },
  storm() { beep(90, 55, 0.8, 'sawtooth', 0.24); noise(0.8, 0.12, 300); setTimeout(() => beep(75, 48, 0.7, 'sawtooth', 0.2), 350); },
  use() { beep(400, 700, 0.15, 'sine', 0.2); },
  win() { [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => beep(f, f, 0.28, 'triangle', 0.3), i * 130)); },
  noAmmo() { beep(200, 150, 0.1, 'square', 0.2); },
  ui() { beep(900, 700, 0.045, 'sine', 0.12); },
  horn() { beep(196, 196, 0.5, 'sawtooth', 0.14); setTimeout(() => beep(247, 247, 0.6, 'sawtooth', 0.12), 260); },
  whoosh() { noise(0.7, 0.14, 1100); },
  land() { noise(0.12, 0.28, 420); beep(120, 55, 0.18, 'triangle', 0.22); },
};

// ============================================================
//  State
// ============================================================
let mode = 'menu';         // menu | lobby | play | dead | spec | end
let ws = null, wsReady = false;
let myId = null;
let lme = null;                  // my avatar on the spawn island {x,y,aim}
const lpos = new Map();          // lobby positions: id -> {x,y,a}
let lobbyInfo = new Map();       // lobby roster: id -> {id,name,team}
const busBuf = [];               // Battle Bus snapshots [{t,x,y,a}] for interpolation
let lastPh = -1;
// gun sprites: Kay Lousberg "2D Guns" (CC0), see public/assets/guns/CREDITS.txt
const GUN_W = { pistol: 34, smg: 46, shotgun: 56, ar: 60, sniper: 66 };   // on-screen width (world px)
const GUN_IMG = {};
for (const id of Object.keys(GUN_W)) { const im = new Image(); im.src = 'assets/guns/' + id + '.png'; GUN_IMG[id] = im; }
let connectedName = '';

const world = {
  size: S.WORLD, grid: S.GRID,
  obstacles: [], obstacleById: new Map(),
  walls: new Map(),
  chests: new Map(),
  loot: new Map(),
  floors: [],
  stormCfg: null,
  obstaclesNear(x, y, r) {
    const out = [];
    for (const o of world.obstacles) {
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < (r + o.r + 4) * (r + o.r + 4)) out.push(o);
    }
    return out;
  },
  wallAt(gx, gy) { return world.walls.get(S.wallKey(gx, gy)) || null; },
};

const players = new Map();  // id -> {id,name,team,bot,buf[],hp,shield,wv,kills,swingT,hitT}
let me = null;              // predicted self {x,y,aim,serverX,serverY}
let you = null;             // private state from server
let storm = null;           // {x,y,r,nx,ny,nr,ph,sh,dps,t}
let aliveCount = 0;
let snapAlive = new Set();  // ids alive in the latest snapshot (squad list)
let rosterNow = [];        // match roster from the start message (id, name, team, bot)
let matchTime = 0;

const cam = { x: S.WORLD / 2, y: S.WORLD / 2 };
let camFocus = null;        // player object or me
// read-only hook for browser tests
window.__fl = { get me() { return me; }, get lme() { return lme; }, get cam() { return cam; }, get mouse() { return mouse; }, get you() { return you; }, get mode() { return mode; }, get tracers() { return tracers; }, get live() { return matchLive; }, get renderMs() { return renderMs; } };
let specId = null;

// fx
const tracers = [];   // {x,y,a,wi,sp,t,life}
const dmgNums = [];   // {x,y,n,t,color}
const parts = [];     // particles {x,y,vx,vy,t,life,color,size}
const swings = new Map(); // id -> t
const kicks = new Map();  // id -> t (gun recoil)
let vignette = 0, stormVig = 0;
let shakeMag = 0, hitmark = 0, kickT = 0;
function shake(m) { shakeMag = Math.min(12, shakeMag + m); }

// input
const keys = new Set();
const mouse = { x: innerWidth / 2, y: innerHeight / 2, fire: false };
let buildMode = false, buildMat = 'wood';
let lastInputSend = 0;
let dpr = 1, vw = innerWidth, vh = innerHeight, scale = 1;
let baseScale = 1, camZoom = 1;   // camZoom widens the view while the bus flies

// ============================================================
//  Canvas sizing
// ============================================================
function resize() {
  // pixel density costs GPU time on every frame: cap it (Low quality uses 1)
  const lowQ = localStorage.getItem('fl_low') === '1';
  dpr = Math.min(lowQ ? 1 : 1.5, window.devicePixelRatio || 1);
  vw = innerWidth; vh = innerHeight;
  canvas.width = vw * dpr; canvas.height = vh * dpr;
  canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
  baseScale = Math.max(vw / 1500, vh / 860);
  baseScale = Math.min(baseScale, 1.6);
  scale = baseScale * camZoom;
}
addEventListener('resize', resize);
resize();

// grass pattern (olive Fortlite palette)
const grassPat = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#698e41'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    g.fillStyle = ['#5e8339', '#74994a', '#628a3c', '#6f9446', '#5a7d35'][(Math.random() * 5) | 0];
    g.globalAlpha = 0.25 + Math.random() * 0.3;
    g.fillRect(x, y, 3 + Math.random() * 8, 3 + Math.random() * 8);
  }
  g.globalAlpha = 0.5;
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    g.strokeStyle = Math.random() < 0.5 ? '#527631' : '#7ca452';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 3, y - 3 - Math.random() * 3); g.stroke();
  }
  return ctx.createPattern(c, 'repeat');
})();

// ============================================================
//  Networking
// ============================================================
// a one-time ticket that lets this socket claim the signed-in account (the server checks it)
async function fetchTicket() {
  if (!acct) return '';
  const r = await api('/api/ticket', {});
  return r.ok ? (r.data.ticket || '') : '';
}
async function connect() {
  // FORTLITE_SERVER (set in config.js) points the page at a separate game server, e.g. "https://my-server.example.com"
  const base = (window.FORTLITE_SERVER || '').replace(/\/+$/, '');
  setStatus('Connecting…');
  const ticket = acct ? await fetchTicket() : '';   // guests connect at once (no await)
  const url = (base
    ? base.replace(/^http/, 'ws') + '/ws'
    : (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws')
    + (ticket ? '?k=' + encodeURIComponent(ticket) : '');
  try { ws = new WebSocket(url); } catch (e) { setStatus('WebSocket unavailable'); return; }
  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ t: 'hello', name: connectedName }));
    send({ t: 'mode', m: myModeChoice });
    setStatus('Connected! Waiting for server…');
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    try { handle(m); } catch (err) { console.error('handler', m.t, err); }
  };
  ws.onclose = () => {
    wsReady = false;
    if (mode !== 'menu') show('disc');
  };
  ws.onerror = () => { if (mode === 'menu') setStatus('Could not reach the server.'); };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function handle(m) {
  switch (m.t) {
    case 'welcome': {
      myId = m.id;
      if (m.state === 'lobby') { mode = 'lobby'; show('lobby'); }
      else { mode = 'spec'; show(null); hudVisible(true); toast('Match in progress — spectating. Next match soon!'); }
      break;
    }
    case 'lobby': matchLive = false; updateLobby(m); break;
    case 'start': matchLive = false; onStart(m); break;
    case 'snap': onSnap(m); break;
    case 'you': onYou(m); break;
    case 'ev': onEv(m); break;
    case 'end': matchLive = false; onEnd(m); break;
    case 'lpos': onLpos(m); break;
  }
}

function onStart(m) {
  rosterNow = m.players || [];
  const w = m.world;
  world.size = w.size; world.grid = w.grid;
  world.obstacles = w.obstacles.map(o => ({ id: o.i, type: o.ty, x: o.x, y: o.y, r: o.r, hp: o.hp, maxHp: o.mhp }));
  world.obstacleById = new Map(world.obstacles.map(o => [o.id, o]));
  world.walls = new Map(w.walls.map(v => [S.wallKey(v.gx, v.gy), { gx: v.gx, gy: v.gy, mat: v.m, hp: v.hp, maxHp: v.mhp }]));
  world.chests = new Map(w.chests.map(c => [c.i, { id: c.i, x: c.x, y: c.y, open: c.open }]));
  world.loot = new Map(w.loot.map(l => [l.i, deserializeLoot(l)]));
  world.floors = w.floors;
  world.stormCfg = w.storm;
  world.pois = w.pois || [];
  FLArt.reset(world);
  storm = null; aliveCount = m.players.length; matchTime = 0;
  players.clear(); tracers.length = 0; dmgNums.length = 0; parts.length = 0; swings.clear();
  buildMode = false; specId = null;
  for (const r of m.players) {
    players.set(r.id, { id: r.id, name: r.name, team: r.team, bot: r.bot, buf: [], hp: 100, shield: 0, wv: -1, kills: 0, swingT: 0, hitT: 0, x: S.WORLD / 2, y: S.WORLD / 2 });
  }
  const mine = players.get(myId);
  if (mine) {
    me = { x: mine.x, y: mine.y, aim: 0, serverX: mine.x, serverY: mine.y, ph: S.PH.bus, alt: 0 };
    busBuf.length = 0; lme = null; lastPh = -1;
    you = { hp: 100, sh: 0, mats: { wood: 0, stone: 0, metal: 0 }, ammo: { light: 0, medium: 0, heavy: 0, shell: 0 }, slots: [{ k: 'pick' }, null, null, null, null], sel: 0, reload: 0, use: 0, build: false, bmat: 'wood', alive: true, kills: 0, place: 0 };
    mode = 'play';
    show(null);
    hudVisible(true);
  } else {
    me = null; you = null;
    mode = 'spec';
    show(null);
    hudVisible(true);
  }
  buildMinimapStatic();
  buildSlotsUI();
}

function deserializeLoot(l) {
  return { id: l.i, x: l.x, y: l.y, kind: l.k, w: l.w, r: l.r, c: l.c, count: l.n, m: l.m, amount: l.a, at: l.at, ammo: l.am };
}

// snapshot: p: [id,x,y,aim,hp,shield,team,wv,moving,using,kills]
function onSnap(m) {
  matchTime = m.tm;
  aliveCount = m.alive;
  storm = m.st;
  const now = performance.now();
  const seen = new Set();
  for (const a of m.p) {
    const id = a[0];
    let p = players.get(id);
    if (!p) continue; // unknown (shouldn't happen)
    seen.add(id);
    p.buf.push({ t: now, x: a[1], y: a[2], a: a[3] });
    if (p.buf.length > 30) p.buf.shift();
    p.hp = a[4]; p.shield = a[5]; p.team = a[6]; p.wv = a[7]; p.kills = a[10];
    p.ph = a[11] || 0; p.alt = (a[12] || 0) / 100; p.outfit = a[13] || 0;
    if (id === myId && me) { me.serverX = a[1]; me.serverY = a[2]; me.ph = p.ph; me.alt = p.alt; }
  }
  if (m.bus) {
    busBuf.push({ t: now, x: m.bus.x, y: m.bus.y, a: m.bus.a });
    if (busBuf.length > 30) busBuf.shift();
  } else busBuf.length = 0;
  // dead players: drop their interpolation buffers so they stop rendering
  for (const [id, p] of players) if (!seen.has(id) && id !== myId) p.buf.length = 0;
  snapAlive = seen;
}

function onYou(m) {
  you = Object.assign(you || {}, m);
  updateHUD();
}

// ============================================================
//  Events → effects
// ============================================================
function addParts(x, y, n, color, spd, life, size) {
  if (lowFx) n = Math.ceil(n / 2);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = spd * (0.3 + Math.random() * 0.7);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + Math.random() * 0.6), color, size: size * (0.6 + Math.random() * 0.8) });
  }
  if (parts.length > 600) parts.splice(0, parts.length - 600);
}
function dmgNum(x, y, n, color) {
  dmgNums.push({ x: x + (Math.random() - 0.5) * 20, y: y - 30, n, t: 0, color });
  if (dmgNums.length > 40) dmgNums.shift();
}

function onEv(e) {
  switch (e.k) {
    case 'shot': {
      if (e.id === myId) break;   // our own shot was already drawn by predictShot
      const w = S.WEAPONS[e.w];
      tracers.push({ x: e.x, y: e.y, a: e.a, wi: e.w, sp: w.speed, t: 0, life: w.range / w.speed });
      sfx.shot(e.w, e.x, e.y);
      // muzzle flash + recoil kick
      addParts(e.x, e.y, 5, '#ffe37a', 170, 0.12, 3.5);
      addParts(e.x, e.y, 2, '#fff3c0', 60, 0.08, 5);
      kicks.set(e.id, 0.12);
      if (e.id === myId) { shake(e.w === 4 ? 3.2 : e.w === 2 ? 2.4 : 1.1); kickT = 0.16; }
      break;
    }
    case 'swing': {
      const p = players.get(e.id); if (p) p.swingT = 0.3;
      swings.set(e.id, 0.3);
      sfx.swing(e.x, e.y);
      break;
    }
    case 'harvest': {
      const o = world.obstacleById.get(e.oid);
      if (o) o.hp = e.hp;
      if (e.n > 0) {
        const col = e.m === 'wood' ? '#c98d4b' : e.m === 'stone' ? '#d0d2c6' : '#8f9bab';
        addParts(e.x, e.y, 8, col, 150, 0.5, 4);
        if (e.id === myId) { dmgNum(e.x, e.y, '+' + e.n, col); sfx.chop(e.x, e.y, e.m); }
        else sfx.chop(e.x, e.y, e.m);
      } else { sfx.chop(e.x, e.y, e.m); addParts(e.x, e.y, 4, '#8a7355', 100, 0.4, 3); }
      break;
    }
    case 'obsGone': {
      const o = world.obstacleById.get(e.oid);
      if (o) {
        const col = o.type === 'tree' ? '#4c6e2e' : o.type === 'rock' ? '#a8aaa0' : o.type === 'crate' ? '#5f6d7e' : '#4f7a36';
        addParts(o.x, o.y, 16, col, 220, 0.7, 5);
        world.obstacles.splice(world.obstacles.indexOf(o), 1);
        world.obstacleById.delete(e.oid);
      }
      break;
    }
    case 'wall': {
      world.walls.set(S.wallKey(e.gx, e.gy), { gx: e.gx, gy: e.gy, mat: e.m, hp: e.hp, maxHp: e.mhp });
      sfx.place(e.gx * S.GRID, e.gy * S.GRID);
      break;
    }
    case 'wallHp': {
      const w = world.walls.get(S.wallKey(e.gx, e.gy));
      if (w) w.hp = e.hp;
      break;
    }
    case 'wallGone': {
      const w = world.walls.get(S.wallKey(e.gx, e.gy));
      if (w) {
        addParts(w.gx * S.GRID + 30, w.gy * S.GRID + 30, 14, S.MAT_COLOR[w.mat], 200, 0.6, 5);
        world.walls.delete(S.wallKey(e.gx, e.gy));
      }
      sfx.breakWall(e.gx * S.GRID, e.gy * S.GRID);
      break;
    }
    case 'rubble': break;
    case 'hit': {
      addParts(e.x, e.y, 5, '#ffd9a0', 140, 0.3, 3);
      sfx.hit(e.x, e.y);
      break;
    }
    case 'dmg': {
      const mineHit = e.kid === myId;
      const onMe = e.vid === myId;
      dmgNum(e.x, e.y, Math.round(e.n), onMe ? '#ff5566' : (mineHit ? '#ffd23a' : '#ffffff'));
      if (onMe) { vignette = 1; sfx.hurt(); shake(2.2); const p = players.get(myId); if (p) p.hitT = 0.25; }
      if (mineHit && !onMe) { hitmark = 0.18; sfx.hitmark(); shake(0.4); }
      const p = players.get(e.vid); if (p) p.hitT = 0.25;
      break;
    }
    case 'kill': {
      killfeed(e);
      const p = players.get(e.vid); if (p) { p.buf.length = 0; }
      if (e.kid === myId && e.vid !== myId) {
        banner('ELIMINATED ' + e.vname, '#ffd76e', 2.2);
        sfx.kill();
        shake(2.6);
        if (you) you.kills = (you.kills || 0) + 1;
      }
      if (e.vid === myId) onDeath(e);
      break;
    }
    case 'chest': {
      const c = world.chests.get(e.i);
      if (c) { c.open = true; sfx.chest(c.x, c.y); addParts(c.x, c.y, 12, '#ffd23a', 180, 0.6, 4); }
      break;
    }
    case 'lootAdd': world.loot.set(e.l.i, deserializeLoot(e.l)); break;
    case 'lootGone': world.loot.delete(e.i); break;
    case 'pickup': {
      if (e.id === myId) sfx.pickup();
      break;
    }
    case 'used': {
      if (e.id === myId) { sfx.use(); }
      addParts(e.x, e.y, 8, '#7fd8ff', 100, 0.5, 3);
      break;
    }
    case 'noMats': toast('Not enough ' + e.m + '!'); sfx.noAmmo(); break;
    case 'noAmmo': toast('Out of ammo!'); sfx.noAmmo(); break;
    case 'full': toast(e.sh ? 'Shield already full!' : 'Health already full!'); break;
    case 'stormMsg': banner(e.msg, '#c39cff', 2.5); sfx.storm(); break;
    case 'busStart': sfx.horn(); banner('BATTLE BUS INCOMING', '#7fb8ff', 2.4); break;
    case 'jump': if (e.id === myId) sfx.whoosh(); break;
    case 'land': if (e.id === myId) onLand(e); break;
    case 'live': matchLive = true; banner('MATCH LIVE', '#ffd76e', 1.8); break;
  }
}

function onLand() {
  sfx.land();
  shake(2);
  banner('Landed', '#ffffff', 1.2);
}
function onLpos(m) {
  const seen = new Set();
  for (const [id, x, y, a] of m.p) {
    seen.add(id);
    lpos.set(id, { x, y, a });
    if (id === myId) {
      if (!lme) lme = { x, y, aim: a };
      else {
        const d = Math.hypot(x - lme.x, y - lme.y);
        if (d > 80) { lme.x = x; lme.y = y; }
        else { lme.x += (x - lme.x) * 0.08; lme.y += (y - lme.y) * 0.08; }
      }
    }
  }
  for (const id of [...lpos.keys()]) if (!seen.has(id)) lpos.delete(id);
}
function onDeath(e) {
  mode = 'dead';
  sfx.death();
  $('deathBy').innerHTML = '';
  const b = document.createElement('span');
  b.textContent = e.kname;
  $('deathBy').append('by ', b, ' • #' + e.vplace + ' of ' + aliveCount);
  $('deathPlace').textContent = '#' + e.vplace;
  $('deathKills').textContent = (you && you.kills) || 0;
  show('death');
  hudVisible(false);
  specId = null;
}

function onEnd(m) {
  mode = 'end';
  const inMatch = !!you;
  const isWin = inMatch && m.winnerIds && m.winnerIds.includes(myId);
  const t = $('endTitle');
  if (isWin) { t.textContent = 'VICTORY ROYALE'; t.className = 'win'; sfx.win(); confetti(); }
  else { t.textContent = 'MATCH OVER'; t.className = 'lose'; }
  $('endWinner').textContent = (m.winner || 'Nobody') + ' wins!  •  ' + m.time + 's';
  const board = $('endBoard');
  board.innerHTML = '';
  const meP = players.get(myId);
  m.board.forEach(r => {
    const tr = document.createElement('tr');
    if (meP && r.name === meP.name && !r.bot) tr.className = 'me';
    const td1 = document.createElement('td'); td1.textContent = '#' + r.place;
    const td2 = document.createElement('td'); td2.textContent = r.name + (r.bot ? ' [BOT]' : '');
    const td3 = document.createElement('td'); td3.textContent = r.kills + ' elims';
    tr.append(td1, td2, td3);
    board.append(tr);
  });
  show('end');
  hudVisible(false);
}

function confetti() {
  for (let i = 0; i < 120; i++) {
    addParts(cam.x + (Math.random() - 0.5) * 900, cam.y - 400 + (Math.random() - 0.5) * 200, 1,
      ['#ffd23a', '#ff5566', '#3aa0ff', '#54d43a', '#b45bf2'][(Math.random() * 5) | 0],
      80, 3, 5);
  }
}

// ============================================================
//  UI helpers
// ============================================================
function show(id) {
  for (const o of ['menu', 'lobby', 'death', 'end', 'disc', 'acctPanel']) $(o).classList.add('hidden');
  $('pauseMenu').classList.add('hidden'); pauseOpen = false;
  if (id) $(id).classList.remove('hidden');
}
function hudVisible(v) {
  $('hud').classList.toggle('hidden', !v);
  $('minimap').classList.toggle('hidden', !v);
  const playing = v && (mode === 'play');
  $('bottomCenter').style.display = playing ? '' : 'none';
  $('bottomRight').style.display = playing ? '' : 'none';
  $('specBar').classList.toggle('hidden', !specId);
}
function setStatus(s) { $('menuStatus').textContent = s; }

// Esc side menu (in a match or the lobby)
let pauseOpen = false;
function togglePause(force) {
  if (mode === 'menu') return;
  pauseOpen = (typeof force === 'boolean') ? force : !pauseOpen;
  $('pauseMenu').classList.toggle('hidden', !pauseOpen);
  $('pauseMute').textContent = muted ? 'Sound on' : 'Mute sound';
  if (pauseOpen) renderPause();
  keys.clear(); mouse.fire = false;
}
// Esc side menu: squad (duo partner), account line, and match actions
function renderPause() {
  const box = $('pmSquad');
  box.innerHTML = '';
  const addRow = (name, state, color, out) => {
    const row = document.createElement('div');
    row.style.borderLeftColor = color;
    const n = document.createElement('span'); n.textContent = name;
    const st = document.createElement('span'); st.textContent = state;
    if (out) n.className = st.className = 'out';
    row.append(n, st); box.append(row);
  };
  const myTeam = (players.get(myId) || {}).team || 0;
  const alive = (id) => (!matchLive && !snapAlive.size) || snapAlive.has(id);
  const mates = myTeam > 0 ? rosterNow.filter(p => p.id !== myId && p.team === myTeam) : [];
  addRow((acct ? acct.name : (connectedName || 'You')) + ' (you)', alive(myId) ? 'alive' : 'out', S.TEAMS[myTeam] ? S.TEAMS[myTeam].color : '#888', !alive(myId));
  if (!mates.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = myTeam > 0 ? 'Squad mate not in this match' : 'Solo: no squad mates';
    box.append(e);
  }
  for (const m of mates) addRow(m.name, alive(m.id) ? 'alive' : 'out', S.TEAMS[myTeam].color, !alive(m.id));
  $('pmAcct').textContent = acct ? 'Signed in as ' + acct.name : 'Playing as guest. Sign in to keep stats and unlock outfits.';
}
$('pmInvite').onclick = () => $('inviteBtn').click();
$('pmAccount').onclick = () => { togglePause(false); openAcct('account'); };
function leaveMatch() {
  pauseOpen = false;
  $('pauseMenu').classList.add('hidden');
  const old = ws;
  ws = null; wsReady = false;
  if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch (_) { /* already closed */ } }
  mode = 'menu';
  show('menu');
  setStatus('Left the match. Pick a mode to play again.');
}
$('pauseResume').onclick = () => togglePause(false);
$('pauseMute').onclick = () => { muted = !muted; $('pauseMute').textContent = muted ? 'Sound on' : 'Mute sound'; };
$('pauseLeave').onclick = () => leaveMatch();
function banner(text, color, secs) {
  const b = $('banner');
  b.textContent = text;
  b.style.color = color || '#fff';
  b.classList.remove('hidden');
  clearTimeout(b._t);
  b._t = setTimeout(() => b.classList.add('hidden'), (secs || 2) * 1000);
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 2200);
}
const KF_WEAPON = { pick: 'Pickaxe', storm: 'The Fade', left: 'Disconnected' };
function killfeed(e) {
  const kf = $('killfeed');
  const div = document.createElement('div');
  div.className = 'kf';
  const kc = e.kteam > 0 ? S.TEAMS[e.kteam].color : '#c39cff';
  const vc = e.vteam > 0 ? S.TEAMS[e.vteam].color : '#eee';
  const wname = KF_WEAPON[e.w] || (S.WEAPONS[e.w] ? S.WEAPONS[e.w].name : 'Eliminated');
  const s1 = document.createElement('span'); s1.textContent = e.kname; s1.style.color = kc;
  const s2 = document.createElement('span'); s2.className = 'kfW'; s2.textContent = wname;
  const s3 = document.createElement('span'); s3.textContent = e.vname; s3.style.color = vc;
  div.append(s1, s2, s3);
  div.style.borderLeftColor = kc;
  kf.prepend(div);
  while (kf.children.length > 6) kf.lastChild.remove();
  setTimeout(() => div.remove(), 7000);
}

// ============================================================
//  Lobby UI
// ============================================================
function updateLobby(m) {
  if (mode === 'menu' || mode === 'play') return;
  if (m.state === 'lobby' || m.waiting) {
    mode = 'lobby';
    show('lobby');
    hudVisible(false);
    $('lobbyCountdown').textContent = m.waiting ? '--' : m.cd;
    $('lobbyTip').textContent = m.waiting
      ? 'A match is in progress. You drop in with the next one.'
      : m.mode === 'duo'
        ? 'Duos: pick a team color with a friend (2 per team), or hit Auto to get paired up!'
        : 'Walk the spawn island while the bus loads. Press SPACE over the map to jump, then steer onto a POI!';
  } else if (mode === 'lobby') {
    // a match is running while we wait — spectate it
    mode = 'spec';
    show(null);
    hudVisible(true);
  }
  // mode tag
  const md = m.mode || 'solo';
  const tag = $('lobbyMode');
  tag.textContent = md.toUpperCase() + ' MODE';
  lobbyInfo = new Map(m.players.map(p => [p.id, p]));
  // sync my team selection
  const mine = m.players.find(p => p.id === myId);
  if (mine) myTeamSel = mine.team || 0;
  // player chips
  const lp = $('lobbyPlayers');
  lp.innerHTML = '';
  for (const p of m.players) {
    const chip = document.createElement('div');
    chip.className = 'lobbyP';
    chip.textContent = p.name;
    chip.style.borderLeftColor = p.team > 0 ? S.TEAMS[p.team].color : '#888';
    lp.append(chip);
  }
  // team buttons (duo only)
  const tr = $('teamRow');
  if (md === 'duo' && m.state === 'lobby') {
    tr.style.display = '';
    tr.innerHTML = '';
    const counts = {};
    for (const p of m.players) if (p.team > 0) counts[p.team] = (counts[p.team] || 0) + 1;
    const mk = (label, i, color) => {
      const b = document.createElement('button');
      b.className = 'teamBtn' + (myTeamSel === i ? ' sel' : '');
      b.textContent = label;
      b.style.borderColor = color;
      if (i > 0) b.style.background = color + '33';
      b.onclick = () => { myTeamSel = i; send({ t: 'team', team: i }); sfx.ui(); };
      tr.append(b);
    };
    mk('AUTO', 0, '#aaa');
    for (let i = 1; i <= 6; i++) mk(S.TEAMS[i].name + ' ' + (counts[i] || 0) + '/2', i, S.TEAMS[i].color);
  } else {
    tr.style.display = 'none';
  }
}
let myTeamSel = 0;

// ============================================================
//  Slots / HUD
// ============================================================
const slotEls = [];
function buildSlotsUI() {
  const box = $('slots');
  box.innerHTML = ''; slotEls.length = 0;
  for (let i = 0; i < 5; i++) {
    const d = document.createElement('div');
    d.className = 'slot';
    d.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="rar"></span><span class="icon"></span><span class="cnt"></span><span class="nm"></span>';
    d.onclick = () => { selectSlot(i); };
    box.append(d);
    slotEls.push(d);
  }
}
function selectSlot(i) {
  if (mode !== 'play') return;
  if (i === 0 || (you && you.slots && you.slots[i])) {
    if (you) you.sel = i;
    send({ t: 'act', a: 'select', i });
    updateHUD();
  }
}
// original SVG slot icons (no emoji)
const SVGI = {
  pick: '<svg viewBox="0 0 32 32"><path d="M6 26 L20 10" stroke="#cfd6c9" stroke-width="3.4" stroke-linecap="round" fill="none"/><path d="M13 4 C19 2 25 5 28 11 L24 13 C21 8 17 6 14 8 Z" fill="#b5834a" stroke="#8a5f33" stroke-width="1.4"/></svg>',
  gun: '<svg viewBox="0 0 32 32"><rect x="3" y="13" width="24" height="5" rx="1.6" fill="#3d4530"/><rect x="5" y="18" width="5" height="7" rx="1.4" fill="#2c3323"/><rect x="21" y="18" width="4" height="5" rx="1.2" fill="#2c3323"/><rect x="27" y="14" width="2.4" height="3" fill="#20261a"/></svg>',
  mini: '<svg viewBox="0 0 32 32"><rect x="13" y="3" width="6" height="6" rx="1.5" fill="#9ad54c"/><path d="M9 10 h14 a3 3 0 0 1 3 3 v11 a4 4 0 0 1 -4 4 h-12 a4 4 0 0 1 -4 -4 v-11 a3 3 0 0 1 3 -3z" fill="#57b34c" stroke="#2f6b2c" stroke-width="1.6"/></svg>',
  shield: '<svg viewBox="0 0 32 32"><path d="M16 3 L27 7 v8 c0 7 -5 12 -11 14 C10 27 5 22 5 15 V7 Z" fill="#4aa7e8" stroke="#1f6ea8" stroke-width="1.8"/><path d="M16 8 v10" stroke="#e8f6ff" stroke-width="3" stroke-linecap="round"/></svg>',
  medkit: '<svg viewBox="0 0 32 32"><rect x="4" y="7" width="24" height="20" rx="4" fill="#e8ecdf" stroke="#9aa48f" stroke-width="1.8"/><rect x="14" y="11" width="4" height="12" fill="#e04444"/><rect x="10" y="15" width="12" height="4" fill="#e04444"/></svg>',
};
const CON_ICON = { mini: SVGI.mini, shield: SVGI.shield, medkit: SVGI.medkit };
function updateHUD() {
  if (!you) return;
  // bars
  $('hpFill').style.width = Math.max(0, you.hp) + '%';
  $('hpTxt').textContent = Math.max(0, Math.round(you.hp));
  $('shieldFill').style.width = Math.max(0, you.sh) + '%';
  $('shieldTxt').textContent = Math.round(you.sh);
  $('killsNum').textContent = you.kills || 0;
  $('aliveNum').textContent = aliveCount;
  // slots
  if (you.slots) {
    for (let i = 0; i < 5; i++) {
      const el = slotEls[i], s = you.slots[i];
      const icon = el.querySelector('.icon'), cnt = el.querySelector('.cnt'),
        nm = el.querySelector('.nm'), rar = el.querySelector('.rar');
      el.classList.toggle('sel', you.sel === i);
      if (!s) { icon.textContent = ''; icon.dataset.k = ''; cnt.textContent = ''; nm.textContent = ''; rar.style.background = 'transparent'; continue; }
      if (s.k === 'pick') { icon.innerHTML = SVGI.pick; icon.dataset.k = 'pick'; cnt.textContent = ''; nm.textContent = 'Pickaxe'; rar.style.background = 'transparent'; }
      else if (s.k === 'w') {
        if (icon.dataset.k !== 'w' + s.w) { icon.innerHTML = '<img class="gunImg" alt="" src="assets/guns/' + S.WEAPONS[s.w].id + '.png">'; icon.dataset.k = 'w' + s.w; }
        cnt.textContent = s.mag;
        nm.textContent = S.RARITY[s.r].name + ' ' + S.WEAPONS[s.w].name;
        rar.style.background = S.RARITY[s.r].color;
      } else {
        icon.innerHTML = CON_ICON[s.c] || SVGI.mini; icon.dataset.k = 'c' + s.c; cnt.textContent = s.n;
        nm.textContent = S.CONSUM[s.c].name; rar.style.background = S.CONSUM[s.c].color;
      }
    }
  }
  // ammo
  const s = you.slots && you.slots[you.sel];
  if (s && s.k === 'w') {
    $('ammoBox').classList.remove('hidden');
    $('ammoMag').textContent = s.mag;
    $('ammoRes').textContent = you.ammo ? (you.ammo[S.WEAPONS[s.w].ammo] || 0) : 0;
    $('ammoType').textContent = S.AMMO_NAME[S.WEAPONS[s.w].ammo].toUpperCase();
    $('ammoMag').style.color = you.reload > 0 ? '#ffd23a' : '#fff';
  } else $('ammoBox').classList.add('hidden');
  // mats
  for (const m of S.MATS) {
    $('matN-' + m).textContent = you.mats ? you.mats[m] : 0;
    $('mat-' + m).classList.toggle('active', you.bmat === m);
  }
  // build hint
  $('buildHint').classList.toggle('hidden', !you.build);
  $('buildMatTxt').textContent = you.bmat.toUpperCase();
  // reload / use bar
  const bar = $('useBar');
  if (you.reload > 0 && !you.use) { bar.classList.remove('hidden'); $('useFill').style.width = (you.reload * 100) + '%'; $('useTxt').textContent = 'RELOADING'; }
  else if (you.use > 0) {
    bar.classList.remove('hidden'); $('useFill').style.width = (you.use * 100) + '%';
    const cs = you.slots && you.slots[you.sel];
    $('useTxt').textContent = cs && cs.k === 'c' ? 'Using ' + S.CONSUM[cs.c].name + '…' : 'Using…';
  } else bar.classList.add('hidden');
  // storm text
  updateStormTxt();
}
function updateStormTxt() {
  const el = $('stormTxt');
  if (!storm) { el.textContent = '—'; return; }
  const t = storm.t;
  if (storm.ph === -1) el.textContent = 'forms in ' + t + 's';
  else if (storm.sh) el.textContent = 'CLOSING IN';
  else el.textContent = 'closes in ' + t + 's';
  el.style.color = storm.sh ? '#ff8adf' : '#c39cff';
}

// ============================================================
//  Input
// ============================================================
addEventListener('keydown', e => {
  if (e.repeat) return;
  const c = e.code;
  if (mode === 'menu' && c === 'Enter') { $('soloBtn').click(); return; }
  if (c === 'Escape') { togglePause(); return; }
  if (pauseOpen) return;
  keys.add(c);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(c)) e.preventDefault();
  audio();
  if (mode === 'spec' || mode === 'dead') {
    if (c === 'ArrowRight') cycleSpec(1);
    if (c === 'ArrowLeft') cycleSpec(-1);
  }
  if (c === 'Space' && mode === 'play' && me && me.ph === S.PH.bus) send({ t: 'act', a: 'jump' });
  if (mode !== 'play') return;
  switch (c) {
    case 'Digit1': selectSlot(0); break;
    case 'Digit2': selectSlot(1); break;
    case 'Digit3': selectSlot(2); break;
    case 'Digit4': selectSlot(3); break;
    case 'Digit5': selectSlot(4); break;
    case 'KeyQ':
      buildMode = !buildMode;
      send({ t: 'act', a: 'mat', m: buildMat });
      sendInput(true);
      break;
    case 'KeyR': send({ t: 'act', a: 'reload' }); break;
    case 'KeyE': send({ t: 'act', a: 'interact' }); break;
    case 'KeyG': send({ t: 'act', a: 'drop' }); break;
    case 'KeyZ': setMat('wood'); break;
    case 'KeyX': setMat('stone'); break;
    case 'KeyC': setMat('metal'); break;
    case 'KeyM': muted = !muted; toast(muted ? 'Muted' : 'Sound on'); break;
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.fire = false; });

canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => {
  audio();
  if (e.button === 0 && mode === 'play') { mouse.fire = true; tapPending = true; sendInput(true); }
});
addEventListener('mouseup', e => { if (e.button === 0) { mouse.fire = false; sendInput(true); } });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (mode !== 'play' || !you || !you.slots) return;
  if (you.build) {
    const idx = S.MATS.indexOf(buildMat);
    setMat(S.MATS[(idx + (e.deltaY > 0 ? 1 : S.MATS.length - 1)) % S.MATS.length]);
  } else {
    // cycle through filled slots
    const dir = e.deltaY > 0 ? 1 : -1;
    let i = you.sel;
    for (let n = 0; n < 5; n++) {
      i = (i + dir + 5) % 5;
      if (i === 0 || you.slots[i]) { selectSlot(i); break; }
    }
  }
}, { passive: false });

function setMat(m) {
  buildMat = m;
  if (you) you.bmat = m;
  send({ t: 'act', a: 'mat', m });
  updateHUD();
}

function inputAxes() {
  let mx = 0, my = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  return [mx, my];
}
function sendInput(force) {
  const onIsland = mode === 'lobby' && !!lme;
  if (!onIsland && !(mode === 'play' && me)) return;
  if (!ws || ws.readyState !== 1) return;
  const now = performance.now();
  if (!force && now - lastInputSend < 25) return;
  lastInputSend = now;
  const [mx, my] = inputAxes();
  if (onIsland) { send({ t: 'input', x: mx, y: my, aim: lme.aim }); return; }
  // no shooting or building while on the bus or in the air
  send({ t: 'input', x: mx, y: my, aim: me.aim, f: mouse.fire && me.ph === S.PH.ground, b: buildMode && me.ph === S.PH.ground });
}

// ============================================================
//  Prediction & spectate
// ============================================================
// Local shot preview: draw our own shot the moment we fire, instead of
// waiting a full round trip for the server's shot event.
let localFireCd = 0;
let matchLive = false;
let tapPending = false;  // a click that started and ended between two frames still counts   // the server only accepts fire once the match is live
function predictShot(dt) {
  if (localFireCd > 0) localFireCd -= dt;
  const want = mouse.fire || tapPending;
  tapPending = false;
  if (!matchLive || !want || !you || !you.slots || you.reload > 0) return;
  const s = you.slots[you.sel];
  if (!s || s.k !== 'w' || s.mag <= 0 || localFireCd > 0) return;
  const w = S.WEAPONS[s.w];
  localFireCd = w.rof;
  s.mag--;   // server snapshot corrects this on its next update
  const x = me.x + Math.cos(me.aim) * 30, y = me.y + Math.sin(me.aim) * 30;
  tracers.push({ x, y, a: me.aim, wi: s.w, sp: w.speed, t: 0, life: w.range / w.speed });
  sfx.shot(s.w, x, y);
  addParts(x, y, 5, '#ffe37a', 170, 0.12, 3.5);
  addParts(x, y, 2, '#fff3c0', 60, 0.08, 5);
  kicks.set(myId, 0.12);
  shake(s.w === 4 ? 3.2 : s.w === 2 ? 2.4 : 1.1); kickT = 0.16;
}
function predictSelf(dt) {
  if (!me) return;
  // aim from mouse
  const sp = worldToScreen(me.x, me.y);
  me.aim = Math.atan2(mouse.y - sp[1], mouse.x - sp[0]);
  if (me.ph !== S.PH.ground) return;   // bus / skydive: follow the server
  const [mx, my] = inputAxes();
  const speed = S.SPEED * (you && you.use > 0 ? S.SPEED_USE : 1);
  // same acceleration model as the server (shared.js stepVel)
  const [vx, vy] = S.stepVel(me.vx || 0, me.vy || 0, mx * speed, my * speed, dt);
  me.vx = vx; me.vy = vy;
  if (vx || vy) {
    const [nx, ny] = S.moveCircle(me.x, me.y, S.PLAYER_R, vx * dt, vy * dt, world);
    me.x = nx; me.y = ny;
  }
  predictShot(dt);
  // reconcile
  const dx = me.serverX - me.x, dy = me.serverY - me.y;
  const d = Math.hypot(dx, dy);
  // The server is always a little behind (network delay), so small gaps are normal.
  // Ignore them so standing still stays still; only fix real desyncs, gently.
  if (d > 160) { me.x = me.serverX; me.y = me.serverY; }
  else if (d > 40) { const k = (d - 40) / d * 0.15; me.x += dx * k; me.y += dy * k; }
}
function predictLobby(dt) {
  if (!lme) return;
  const [mx, my] = inputAxes();
  if (mx || my) {
    lme.aim = Math.atan2(my, mx);
    const [nx, ny] = S.clampIsland(lme.x + mx * S.ISLAND_SPEED * dt, lme.y + my * S.ISLAND_SPEED * dt);
    lme.x = nx; lme.y = ny;
  }
}
function interpBus(rt) { return busBuf.length ? interpPlayer({ buf: busBuf }, rt) : null; }
function worldToScreen(x, y) {
  return [(x - cam.x) * scale + vw / 2, (y - cam.y) * scale + vh / 2];
}
function screenToWorld(x, y) {
  return { x: (x - vw / 2) / scale + cam.x, y: (y - vh / 2) / scale + cam.y };
}
function aliveIds() {
  const out = [];
  for (const [id, p] of players) if (p.buf.length && p.hp > 0) out.push(id);
  return out;
}
function cycleSpec(dir) {
  const ids = aliveIds();
  if (!ids.length) { specId = null; return; }
  let i = ids.indexOf(specId);
  i = (i + dir + ids.length) % ids.length;
  specId = ids[i];
  $('specName').textContent = players.get(specId).name;
}
$('specPrev').onclick = () => cycleSpec(-1);
$('specNext').onclick = () => cycleSpec(1);
$('specBtn').onclick = () => {
  mode = 'dead';
  specId = null;
  cycleSpec(1);
  show(null);
  hudVisible(true);
};

// interpolation of other players
function interpPlayer(p, rt) {
  const buf = p.buf;
  if (!buf.length) return null;
  if (buf.length === 1) return buf[0];
  let a = buf[0], b = buf[buf.length - 1];
  for (let i = buf.length - 1; i > 0; i--) {
    if (buf[i - 1].t <= rt) { a = buf[i - 1]; b = buf[i]; break; }
  }
  if (rt >= b.t) return b;
  if (rt <= a.t) return a;
  const k = (rt - a.t) / Math.max(1, b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, a: a.a + S.angDiff(a.a, b.a) * k };
}

// ============================================================
//  Rendering
// ============================================================
// draws the CC0 gun sprite with its grip at x=0, barrel toward +x (flip mirrors it for aim to the left)
function drawGunSprite(g, wi, flip, wOverride, center) {
  const id = S.WEAPONS[wi].id;
  const im = GUN_IMG[id];
  const gw = wOverride || GUN_W[id];
  if (!im || !im.complete || !im.naturalWidth) { drawGun(g, wi, gw * 0.4); return; }
  const h = gw * im.naturalHeight / im.naturalWidth;
  g.save();
  if (center) g.translate(-gw / 2, 0);
  if (flip) g.scale(1, -1);
  g.drawImage(im, 0, -h / 2, gw, h);
  g.restore();
}
function rrPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function drawGun(g, wi, len) {
  // simple gun silhouette pointing +x
  const w = S.WEAPONS[wi];
  g.fillStyle = '#3d4530';
  if (w.id === 'sniper') { g.fillRect(-6, -2, len + 14, 4); g.fillRect(2, -6, 10, 4); }
  else if (w.id === 'shotgun') { g.fillRect(-6, -3, len + 6, 6); }
  else if (w.id === 'smg') { g.fillRect(-6, -2, len, 4); g.fillRect(-2, 2, 4, 7); }
  else if (w.id === 'ar') { g.fillRect(-6, -2, len + 4, 4); g.fillRect(0, 2, 4, 8); g.fillRect(-6, -6, 8, 4); }
  else { g.fillRect(-6, -2, len, 4); g.fillRect(-2, 2, 4, 7); }
}
function drawPickaxe(g) {
  g.strokeStyle = '#8a6a44'; g.lineWidth = 3.5;
  g.beginPath(); g.moveTo(6, 0); g.lineTo(26, 0); g.stroke();
  g.strokeStyle = '#cfd6e2'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(24, -8); g.quadraticCurveTo(32, 0, 24, 8); g.stroke();
}
function drawHand(g, hx, hy) {
  g.fillStyle = '#f2c078';
  g.beginPath(); g.arc(hx, hy, 6.5, 0, TAU); g.fill();
  g.strokeStyle = '#b5834a'; g.lineWidth = 2.5;
  g.beginPath(); g.arc(hx, hy, 6.5, 0, TAU); g.stroke();
}

let bushList = [];
let renderMs = 0;   // smoothed time spent drawing one frame (shown by the browser test)
function render(now, rt) {
  const g = ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.save();
  g.scale(dpr, dpr);
  g.translate(vw / 2, vh / 2);
  g.scale(scale, scale);
  const shx = (Math.random() - 0.5) * shakeMag * 2, shy = (Math.random() - 0.5) * shakeMag * 2;
  g.translate(-cam.x + shx, -cam.y + shy);

  const halfW = vw / 2 / scale, halfH = vh / 2 / scale;
  const viewL = cam.x - halfW, viewR = cam.x + halfW, viewT = cam.y - halfH, viewB = cam.y + halfH;
  const inView = (x, y, r) => x + r > viewL && x - r < viewR && y + r > viewT && y - r < viewB;
  bushList = world.obstacles.filter(o => o.type === 'bush' && inView(o.x, o.y, o.r + 40));

  if (mode === 'lobby') {
    drawSpawnIsland(g, now, viewL, viewR, viewT, viewB);
    g.restore();
    return;
  }

  // ground
  FLArt.drawGround(g, Math.max(0, viewL), Math.max(0, viewT), Math.min(world.size, viewR), Math.min(world.size, viewB));
  // out-of-map darkness
  g.fillStyle = '#12190f';
  if (viewL < 0) g.fillRect(viewL, viewT, -viewL, viewB - viewT);
  if (viewR > world.size) g.fillRect(world.size, viewT, viewR - world.size, viewB - viewT);
  if (viewT < 0) g.fillRect(Math.max(0, viewL), viewT, Math.min(world.size, viewR) - Math.max(0, viewL), -viewT);
  if (viewB > world.size) g.fillRect(Math.max(0, viewL), world.size, Math.min(world.size, viewR) - Math.max(0, viewL), viewB - world.size);

  // floors
  FLArt.floors(g, world.floors);


  // next storm circle (white)
  if (storm && storm.nr < storm.r - 5) {
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 3; g.setLineDash([14, 10]);
    g.beginPath(); g.arc(storm.nx, storm.ny, storm.nr, 0, TAU); g.stroke();
    g.setLineDash([]);
  }

  // loot
  const bob = Math.sin(now / 300) * 3;
  for (const l of world.loot.values()) {
    if (!inView(l.x, l.y, 30)) continue;
    drawLoot(g, l, bob);
  }
  // chests
  for (const c of world.chests.values()) {
    if (!inView(c.x, c.y, 40)) continue;
    drawChest(g, c, now);
  }

  // rocks and supply crates
  for (const o of world.obstacles) {
    if (o.type !== 'rock' && o.type !== 'crate') continue;
    if (!inView(o.x, o.y, o.r + 10)) continue;
    if (o.type === 'rock') FLArt.rock(g, o); else FLArt.crate(g, o);
    if (o.hp < o.maxHp) {
      g.fillStyle = 'rgba(0,0,0,' + (0.35 * (1 - o.hp / o.maxHp)) + ')';
      g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fill();
    }
  }
  // tree shadows (canopies are drawn over the players)
  for (const o of world.obstacles) {
    if (o.type !== 'tree') continue;
    if (!inView(o.x, o.y, o.r + 10)) continue;
    FLArt.treeShadow(g, o);
  }

  // walls: shadows first, then the blocks, so they read as raised above the floors
  const wallsInView = [];
  for (const w of world.walls.values()) {
    const x = w.gx * S.GRID, y = w.gy * S.GRID;
    if (!inView(x + 30, y + 30, 60)) continue;
    const hpf = w.hp / w.maxHp;
    const stage = hpf < 0.25 ? 3 : hpf < 0.5 ? 2 : hpf < 0.75 ? 1 : 0;
    wallsInView.push({ x, y, mat: w.mat, stage });
  }
  FLArt.wallShadows(g, wallsInView);
  for (const w of wallsInView) FLArt.wall(g, w.x, w.y, w.mat, w.stage);

  // players
  const focus = camFocus;
  for (const p of players.values()) {
    if (p.ph === S.PH.bus) continue;   // riding the bus: hidden inside it
    if (p.id === myId && me && you && you.alive && me.ph === S.PH.ground) continue; // drawn from prediction
    const ip = interpPlayer(p, rt);
    if (!ip) continue;
    drawPlayer(g, p, ip.x, ip.y, ip.a, now, focus, p.alt || 0);
  }
  if (me && you && you.alive && me.ph === S.PH.ground) drawPlayer(g, players.get(myId), me.x, me.y, me.aim, now, focus, 0);

  // tree canopies
  for (const o of world.obstacles) {
    if (o.type !== 'tree') continue;
    if (!inView(o.x, o.y, o.r + 40)) continue;
    let alpha = 0.92;
    if (focus) {
      const fd = Math.hypot(focus.x - o.x, focus.y - o.y);
      if (fd < o.r + 26) alpha = 0.34;
    }
    FLArt.treeCanopy(g, o, alpha);
  }
  // bushes (over players)
  for (const o of bushList) FLArt.bush(g, o);

  drawBus(g, rt);

  // tracers
  for (const t of tracers) {
    const k = t.t / t.life;
    const x = t.x + Math.cos(t.a) * t.sp * t.t;
    const y = t.y + Math.sin(t.a) * t.sp * t.t;
    const tail = Math.min(46, t.sp * 0.05);
    g.strokeStyle = 'rgba(255, 235, 150,' + (0.9 * (1 - k)) + ')';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x - Math.cos(t.a) * tail, y - Math.sin(t.a) * tail);
    g.lineTo(x, y);
    g.stroke();
  }
  // particles
  for (const p of parts) {
    g.globalAlpha = Math.max(0, 1 - p.t / p.life);
    g.fillStyle = p.color;
    g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  g.globalAlpha = 1;
  // damage numbers
  g.textAlign = 'center';
  for (const d of dmgNums) {
    g.globalAlpha = Math.max(0, 1 - d.t / 1.1);
    g.font = '900 17px "Segoe UI", sans-serif';
    g.fillStyle = '#000';
    g.fillText(d.n, d.x + 1.5, d.y - d.t * 46 + 1.5);
    g.fillStyle = d.color;
    g.fillText(d.n, d.x, d.y - d.t * 46);
  }
  g.globalAlpha = 1;

  // storm overlay
  if (storm) {
    g.fillStyle = FLArt.stormPattern(g);
    g.beginPath();
    g.rect(viewL - 50, viewT - 50, (viewR - viewL) + 100, (viewB - viewT) + 100);
    g.arc(storm.x, storm.y, storm.r, 0, TAU, true);
    g.fill('evenodd');
    g.strokeStyle = 'rgba(200, 130, 255, 0.9)';
    g.lineWidth = 5;
    g.beginPath(); g.arc(storm.x, storm.y, storm.r, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(storm.x, storm.y, storm.r - 6, 0, TAU); g.stroke();
  }

  // build ghost
  if (mode === 'play' && me && you && you.build && me.ph === S.PH.ground) {
    const px = me.x + Math.cos(me.aim) * 55, py = me.y + Math.sin(me.aim) * 55;
    const cgx = Math.floor(px / S.GRID), cgy = Math.floor(py / S.GRID);
    const x = cgx * S.GRID, y = cgy * S.GRID;
    const ok = !world.walls.has(S.wallKey(cgx, cgy))
      && you.mats[buildMat] >= S.WALL_COST
      && !(cgx < 0 || cgy < 0 || (cgx + 1) * S.GRID > world.size || (cgy + 1) * S.GRID > world.size);
    // grid around player
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1;
    const g0x = Math.floor((me.x - 200) / S.GRID), g1x = Math.floor((me.x + 200) / S.GRID);
    const g0y = Math.floor((me.y - 200) / S.GRID), g1y = Math.floor((me.y + 200) / S.GRID);
    g.beginPath();
    for (let gx2 = g0x; gx2 <= g1x + 1; gx2++) { g.moveTo(gx2 * S.GRID, g0y * S.GRID); g.lineTo(gx2 * S.GRID, (g1y + 1) * S.GRID); }
    for (let gy2 = g0y; gy2 <= g1y + 1; gy2++) { g.moveTo(g0x * S.GRID, gy2 * S.GRID); g.lineTo((g1x + 1) * S.GRID, gy2 * S.GRID); }
    g.stroke();
    g.fillStyle = ok ? 'rgba(120, 255, 130, 0.35)' : 'rgba(255, 90, 90, 0.35)';
    g.fillRect(x, y, S.GRID, S.GRID);
    g.strokeStyle = ok ? '#7dff85' : '#ff5a5a';
    g.lineWidth = 3;
    g.strokeRect(x + 2, y + 2, S.GRID - 4, S.GRID - 4);
  }

  g.restore();

  // screen-space effects (CSS pixel space)
  g.save();
  g.scale(dpr, dpr);
  // vignettes
  if (vignette > 0.02 || stormVig > 0.02) {
    const vg = g.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.35, vw / 2, vh / 2, Math.max(vw, vh) * 0.72);
    if (vignette > 0.02) { vg.addColorStop(0, 'rgba(255,0,40,0)'); vg.addColorStop(1, 'rgba(255,0,40,' + (0.45 * vignette) + ')'); }
    else { vg.addColorStop(0, 'rgba(150,50,220,0)'); vg.addColorStop(1, 'rgba(150,50,220,' + (0.5 * stormVig) + ')'); }
    g.fillStyle = vg;
    g.fillRect(0, 0, vw, vh);
  }
  // custom crosshair (cursor hidden on canvas)
  if (mode === 'play' || mode === 'spec') {
    const cx = mouse.x, cy = mouse.y;
    const gap = 5 + kickT * 42;
    const len = 7;
    g.lineCap = 'round';
    for (const [col, w] of [['rgba(0,0,0,0.85)', 4], ['#ffffff', 2]]) {
      g.strokeStyle = col; g.lineWidth = w;
      g.beginPath();
      g.moveTo(cx - gap - len, cy); g.lineTo(cx - gap, cy);
      g.moveTo(cx + gap, cy); g.lineTo(cx + gap + len, cy);
      g.moveTo(cx, cy - gap - len); g.lineTo(cx, cy - gap);
      g.moveTo(cx, cy + gap); g.lineTo(cx, cy + gap + len);
      g.stroke();
    }
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(cx, cy, 1.4, 0, TAU); g.fill();
    // hitmarker (damage confirmed)
    if (hitmark > 0) {
      const a = Math.min(1, hitmark / 0.18);
      const hgap = 8, hlen = 6;
      g.strokeStyle = 'rgba(255, 210, 58,' + a + ')'; g.lineWidth = 2.6;
      g.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.moveTo(cx + sx * hgap, cy + sy * hgap);
        g.lineTo(cx + sx * (hgap + hlen), cy + sy * (hgap + hlen));
      }
      g.stroke();
    }
  }
  g.restore();
}

function drawChest(g, c, now) {
  const w = 44, h = 34;
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath(); g.ellipse(c.x, c.y + 16, 26, 8, 0, 0, TAU); g.fill();
  if (!c.open) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);
    g.strokeStyle = 'rgba(255, 210, 58,' + (0.35 + 0.4 * pulse) + ')';
    g.lineWidth = 4;
    g.strokeRect(c.x - w / 2 - 3, c.y - h / 2 - 3, w + 6, h + 6);
  }
  g.fillStyle = c.open ? '#6b5a35' : '#a5762f';
  g.fillRect(c.x - w / 2, c.y - h / 2, w, h);
  g.fillStyle = c.open ? '#57492c' : '#c9963f';
  g.fillRect(c.x - w / 2, c.y - h / 2, w, h * 0.42);
  g.strokeStyle = '#3d2f16'; g.lineWidth = 2.5;
  g.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
  g.fillStyle = '#3d2f16';
  g.fillRect(c.x - 4, c.y - 6, 8, 12);
}

function drawLoot(g, l, bob) {
  const x = l.x, y = l.y + bob;
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.beginPath(); g.ellipse(x, l.y + 14, 15, 5, 0, 0, TAU); g.fill();
  if (l.kind === 'weapon') {
    const col = S.RARITY[l.r].color;
    g.fillStyle = col + '55';
    g.beginPath(); g.arc(x, y, 18, 0, TAU); g.fill();
    g.strokeStyle = col; g.lineWidth = 2.5;
    g.beginPath(); g.arc(x, y, 18, 0, TAU); g.stroke();
    g.save(); g.translate(x, y); g.rotate(-0.5);
    drawGunSprite(g, l.w, false, 42, true);
    g.restore();
  } else if (l.kind === 'ammo') {
    g.fillStyle = '#3b4252';
    g.fillRect(x - 10, y - 8, 20, 16);
    g.strokeStyle = '#262b38'; g.lineWidth = 2; g.strokeRect(x - 10, y - 8, 20, 16);
    const band = { light: '#ffd23a', medium: '#54d43a', heavy: '#ff5566', shell: '#ff9d3a' }[l.at];
    g.fillStyle = band; g.fillRect(x - 10, y - 3, 20, 6);
  } else if (l.kind === 'consum') {
    g.fillStyle = '#173a52';
    g.beginPath(); g.arc(x, y, 15, 0, TAU); g.fill();
    g.strokeStyle = S.CONSUM[l.c].color; g.lineWidth = 2.5;
    g.beginPath(); g.arc(x, y, 15, 0, TAU); g.stroke();
    // drawn glyphs (shield / medkit cross / mini potion)
    if (l.c === 'shield') {
      g.fillStyle = '#4aa7e8';
      g.beginPath();
      g.moveTo(x, y - 8); g.lineTo(x + 6.5, y - 5.5); g.lineTo(x + 6.5, y + 0.5);
      g.quadraticCurveTo(x + 6.5, y + 6, x, y + 8);
      g.quadraticCurveTo(x - 6.5, y + 6, x - 6.5, y + 0.5); g.lineTo(x - 6.5, y - 5.5); g.closePath(); g.fill();
      g.strokeStyle = '#e8f6ff'; g.lineWidth = 2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.stroke();
    } else if (l.c === 'medkit') {
      g.fillStyle = '#e8ecdf';
      g.fillRect(x - 7, y - 6, 14, 12);
      g.fillStyle = '#e04444';
      g.fillRect(x - 1.5, y - 4.5, 3, 9); g.fillRect(x - 4.5, y - 1.5, 9, 3);
    } else {
      g.fillStyle = '#57b34c';
      g.fillRect(x - 4, y - 2, 8, 9);
      g.fillRect(x - 2, y - 7, 4, 5);
      g.fillStyle = '#9ad54c';
      g.fillRect(x - 2, y - 7, 4, 3);
    }
  } else if (l.kind === 'mats') {
    const col = S.MAT_COLOR[l.m];
    g.fillStyle = col;
    g.fillRect(x - 9, y - 9, 18, 18);
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 2; g.strokeRect(x - 9, y - 9, 18, 18);
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x - 9, y - 9, 18, 5);
  }
}

function drawPlayer(g, p, x, y, aim, now, focus, alt) {
  if (p == null) return;
  alt = alt || 0;
  const isMe = p.id === myId;
  const teamCol = p.team > 0 ? S.TEAMS[p.team].color : null;
  const air = alt > 0.001;
  // bush hiding (ground only)
  let alpha = 1;
  if (!air && mode !== 'lobby') {
    for (const o of bushList) {
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < 40 * 40) { alpha = 0.45; break; }
    }
  }
  g.globalAlpha = alpha;

  if (air) {
    // skydiver: the ground shadow marks the landing spot, the body hangs under a canopy
    const k = 1 - alt * 0.35;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(x, y + 6, 22 * k, 9 * k, 0, 0, TAU); g.fill();
    y -= alt * 170;
    g.globalAlpha = alpha * Math.min(1, alt * 6);
    g.save(); g.translate(x, y - 30);
    g.strokeStyle = 'rgba(20,24,16,0.6)'; g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-30, 2); g.lineTo(-6, 20); g.moveTo(30, 2); g.lineTo(6, 20);
    g.moveTo(-14, -1); g.lineTo(-4, 20); g.moveTo(14, -1); g.lineTo(4, 20);
    g.stroke();
    g.beginPath(); g.arc(0, 0, 36, Math.PI, 0); g.closePath();
    g.fillStyle = teamCol || '#ffd23a'; g.fill();
    g.strokeStyle = '#1b261b'; g.lineWidth = 2; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-18, -31); g.lineTo(-18, 0); g.moveTo(0, -36); g.lineTo(0, 0); g.moveTo(18, -31); g.lineTo(18, 0);
    g.stroke();
    g.restore();
    g.globalAlpha = alpha;
  } else {
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath(); g.ellipse(x, y + 16, 18, 7, 0, 0, TAU); g.fill();
  }

  // swing animation
  let swing = 0;
  const sw = swings.get(p.id);
  if (sw != null) swing = 1 - sw / 0.3;

  FLArt.player(g, x, y, S.OUTFITS[p.outfit || 0].color, p.id);
  if (teamCol) { g.strokeStyle = teamCol; g.lineWidth = 3; g.beginPath(); g.arc(x, y, S.PLAYER_R + 3, 0, TAU); g.stroke(); }

    // weapon + hands (over body, rotated toward aim)
  g.save();
  g.translate(x, y);
  g.rotate(aim);
  const holding = p.wv >= 0 && p.wv <= 4;
  if (swing > 0) {
    g.rotate(-0.9 + swing * 1.8);
    drawPickaxe(g);
    drawHand(g, 12, 7);
    drawHand(g, 19, -5);
  } else if (holding) {
    const flip = Math.cos(aim) < 0;            // keep the sprite upright when aiming left
    const fy = flip ? -1 : 1;
    const gw = GUN_W[S.WEAPONS[p.wv].id];
    g.translate(-(kicks.get(p.id) || 0) * 55, 0); // recoil kick
    drawGunSprite(g, p.wv, flip, 0, false);
    drawHand(g, gw * 0.2, 5 * fy);             // trigger hand on the grip
    drawHand(g, gw * 0.62, 3 * fy);            // support hand on the foregrip
  } else {
    // pickaxe at rest / consumable / build
    drawPickaxe(g);
    drawHand(g, 12, 7);
    drawHand(g, 19, -5);
  }
  g.restore();

  // hit flash
  if (p.hitT > 0) {
    g.fillStyle = 'rgba(255,255,255,' + (p.hitT * 2.2) + ')';
    g.beginPath(); g.arc(x, y, S.PLAYER_R + 2, 0, TAU); g.fill();
  }

  // use ring
  if (p.wv === 5 && isMe && you) {
    g.strokeStyle = '#ffd23a'; g.lineWidth = 4;
    g.beginPath(); g.arc(x, y, S.PLAYER_R + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (you.use || 0)); g.stroke();
  }

  // name + hp bar
  g.font = '700 13px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillText(p.name, x + 1, y - 36);
  g.fillStyle = isMe ? '#ffd76e' : (teamCol ? teamCol : '#ffffff');
  g.fillText(p.name, x, y - 37);
  // hp bar
  const bw = 46;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x - bw / 2, y - 32, bw, 5);
  const hpf = Math.max(0, p.hp / 100);
  g.fillStyle = hpf > 0.5 ? '#8ad24a' : hpf > 0.25 ? '#ffd23a' : '#ff5566';
  g.fillRect(x - bw / 2, y - 32, bw * hpf, 5);
  if (p.shield > 0) {
    g.fillStyle = '#4aa7e8';
    g.fillRect(x - bw / 2, y - 36, bw * Math.min(1, p.shield / 100), 3);
  }
  g.globalAlpha = 1;
}

// ============================================================
//  Spawn island (lobby), POIs, Battle Bus
// ============================================================
function drawSpawnIsland(g, now, viewL, viewR, viewT, viewB) {
  const I = S.ISLAND, cx = I.x, cy = I.y;
  // open water
  g.fillStyle = '#1d70b3';
  g.fillRect(viewL - 20, viewT - 20, viewR - viewL + 40, viewB - viewT + 40);
  // animated ripple rings
  g.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    g.strokeStyle = 'rgba(170, 225, 250, ' + (0.16 - i * 0.02) + ')';
    g.setLineDash([26, 34]);
    g.lineDashOffset = (now / 40) * (i % 2 ? 1 : -1);
    g.beginPath(); g.arc(cx, cy, I.r + 90 + i * 75, 0, TAU); g.stroke();
  }
  g.setLineDash([]);
  // foam, sand, grass plateau
  g.fillStyle = 'rgba(235, 250, 255, 0.55)';
  g.beginPath(); g.arc(cx, cy, I.r + 22 + Math.sin(now / 700) * 3, 0, TAU); g.fill();
  g.fillStyle = '#e4cf93';
  g.beginPath(); g.arc(cx, cy, I.r + 6, 0, TAU); g.fill();
  g.save();
  g.beginPath(); g.arc(cx, cy, I.r - 46, 0, TAU); g.clip();
  g.fillStyle = grassPat;
  g.fillRect(cx - I.r, cy - I.r, I.r * 2, I.r * 2);
  g.restore();
  g.strokeStyle = '#cdb67a'; g.lineWidth = 6;
  g.beginPath(); g.arc(cx, cy, I.r - 46, 0, TAU); g.stroke();

  // fixed prop layout (palms, rocks, crates, sign)
  const palm = (x, y, rot) => {
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.arc(x + 10, y + 12, 34, 0, TAU); g.fill();
    for (let k = 0; k < 7; k++) {
      const a = rot + k * TAU / 7;
      g.fillStyle = k % 2 ? '#3f8a3a' : '#2f6d2c';
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.45) * 30, y + Math.sin(a + 0.45) * 30, x + Math.cos(a) * 52, y + Math.sin(a) * 52);
      g.quadraticCurveTo(x + Math.cos(a - 0.45) * 30, y + Math.sin(a - 0.45) * 30, x, y);
      g.fill();
    }
    g.fillStyle = '#8a6a44';
    g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill();
    g.fillStyle = '#b08a5c';
    g.beginPath(); g.arc(x - 2, y - 2, 4, 0, TAU); g.fill();
  };
  palm(cx - 300, cy - 230, 0.3);
  palm(cx + 330, cy - 180, 1.7);
  palm(cx - 380, cy + 170, 2.9);
  palm(cx + 250, cy + 300, 4.1);
  palm(cx + 60, cy + 360, 0.8);
  // rocks
  for (const [dx, dy, r] of [[-120, 300, 26], [200, -330, 20], [400, 60, 24], [-420, -40, 18]]) {
    g.fillStyle = '#d0d2c6';
    g.beginPath(); g.arc(cx + dx, cy + dy, r, 0, TAU); g.fill();
    g.fillStyle = '#e6e8de';
    g.beginPath(); g.arc(cx + dx - r * 0.28, cy + dy - r * 0.3, r * 0.5, 0, TAU); g.fill();
    g.strokeStyle = '#8f9188'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx + dx, cy + dy, r, 0, TAU); g.stroke();
  }
  // supply crates
  for (const [dx, dy] of [[-40, 120], [-16, 146], [230, 170]]) {
    g.fillStyle = '#5f6d7e'; g.fillRect(cx + dx - 18, cy + dy - 18, 36, 36);
    g.strokeStyle = '#45505e'; g.lineWidth = 3; g.strokeRect(cx + dx - 18, cy + dy - 18, 36, 36);
    g.beginPath(); g.moveTo(cx + dx - 18, cy + dy - 18); g.lineTo(cx + dx + 18, cy + dy + 18);
    g.moveTo(cx + dx + 18, cy + dy - 18); g.lineTo(cx + dx - 18, cy + dy + 18); g.stroke();
  }
  // sign post
  g.fillStyle = '#6b4e2e';
  g.fillRect(cx - 4, cy - 150, 8, 48);
  g.fillStyle = '#e8c27a'; g.strokeStyle = '#6b4e2e'; g.lineWidth = 3;
  g.fillRect(cx - 118, cy - 196, 236, 52);
  g.strokeRect(cx - 118, cy - 196, 236, 52);
  g.fillStyle = '#3d2a12';
  g.font = '900 22px "Segoe UI", sans-serif'; g.textAlign = 'center';
  g.fillText('SPAWN ISLAND', cx, cy - 172);
  g.font = '700 12px "Segoe UI", sans-serif';
  g.fillText('Battle Bus departs when the timer ends', cx, cy - 155);

  // players waiting on the island
  for (const [id, lp] of lpos) {
    const info = lobbyInfo.get(id);
    if (!info || (id === myId && lme)) continue;
    drawPlayer(g, { id, name: info.name, team: info.team, hp: 100, shield: 0, wv: -1, hitT: 0 }, lp.x, lp.y, lp.a, now, null, 0);
  }
  if (lme) {
    const pd = lobbyInfo.get(myId) || { id: myId, name: connectedName || 'You', team: 0 };
    drawPlayer(g, { id: myId, name: pd.name, team: pd.team, hp: 100, shield: 0, wv: -1, hitT: 0 }, lme.x, lme.y, lme.aim, now, null, 0);
  }
}

// POIs are drawn on the minimap only (buildMinimapStatic), never in the world

// the Battle Bus: stylised, original design (gold/blue livery, Fortlite bolt on the side)
function drawBus(g, rt) {
  const bp = interpBus(rt);
  if (!bp) return;
  g.save();
  g.translate(bp.x + 30, bp.y + 36);   // shadow sits on the ground, offset from the bus
  g.rotate(bp.a);
  rrPath(g, -100, -44, 200, 88, 24);
  g.fillStyle = 'rgba(0,0,0,0.26)'; g.fill();
  g.restore();

  g.save();
  g.translate(bp.x, bp.y);
  g.rotate(bp.a);
  rrPath(g, -100, -42, 200, 84, 22);
  g.fillStyle = '#eef2f7'; g.fill();
  g.strokeStyle = '#2b3646'; g.lineWidth = 4; g.stroke();
  g.fillStyle = '#2f6fd0'; g.fillRect(-98, -22, 196, 9);
  g.fillStyle = '#ffd23a'; g.fillRect(-98, -11, 196, 10);
  g.fillStyle = '#2f6fd0'; g.fillRect(-98, 9, 196, 6);
  // side windows
  g.fillStyle = '#22385c';
  for (let i = 0; i < 4; i++) { rrPath(g, -84 + i * 34, -36, 24, 10, 3); g.fill(); }
  // windshield at the front
  g.fillStyle = '#1b2d4d';
  rrPath(g, 64, -30, 28, 60, 9); g.fill();
  // roof hatch and bolt logo
  g.fillStyle = '#c9d2de';
  rrPath(g, -70, -26, 96, 52, 12); g.fill();
  g.fillStyle = '#ffd23a'; g.strokeStyle = '#0e1206'; g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-6, -18); g.lineTo(-20, 4); g.lineTo(-10, 4); g.lineTo(-16, 18); g.lineTo(2, -2); g.lineTo(-8, -2); g.closePath();
  g.fill(); g.stroke();
  g.restore();
}

function applyDropHUD(ph) {
  const dropping = ph === S.PH.bus || ph === S.PH.fall;
  $('hud').classList.toggle('dropping', dropping);
  const h = $('dropHint');
  h.classList.toggle('hidden', !dropping);
  h.classList.toggle('skydive', ph === S.PH.fall);
  h.textContent = ph === S.PH.bus
    ? 'BATTLE BUS: press SPACE to jump'
    : 'SKYDIVING: steer with WASD, pick your POI';
}

// ============================================================
//  Minimap
// ============================================================
let mmStatic = null;
function buildMinimapStatic() {
  mmStatic = document.createElement('canvas');
  mmStatic.width = mmStatic.height = 176;
  const g = mmStatic.getContext('2d');
  const k = 176 / world.size;
  g.fillStyle = '#698e41';
  g.fillRect(0, 0, 176, 176);
  // water blobs
  g.fillStyle = '#1d70b3';
  for (const o of world.obstacles) {
    if (o.type !== 'water') continue;
    g.beginPath(); g.arc(o.x * k, o.y * k, Math.max(1.5, o.r * k), 0, TAU); g.fill();
  }
  for (const f of world.floors) {
    g.fillStyle = 'rgba(30,30,40,0.55)';
    g.fillRect(f.x * k, f.y * k, f.w * k, f.h * k);
  }
  for (const o of world.obstacles) {
    if (o.type === 'tree') g.fillStyle = '#4c6e2e';
    else if (o.type === 'rock') g.fillStyle = '#a8aaa0';
    else if (o.type === 'crate') g.fillStyle = '#5f6d7e';
    else continue;
    g.fillRect(o.x * k - 1.5, o.y * k - 1.5, 3, 3);
  }
  for (const w of world.walls.values()) {
    g.fillStyle = 'rgba(220,220,230,0.5)';
    g.fillRect(w.gx * S.GRID * k, w.gy * S.GRID * k, S.GRID * k, S.GRID * k);
  }
  // POI dots with names: the only place POI names appear
  g.font = '700 9px "Segoe UI", sans-serif';
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.lineJoin = 'round';
  for (const p of world.pois || []) {
    const x = p.x * k, y = p.y * k;
    g.fillStyle = '#ffd76e'; g.beginPath(); g.arc(x, y, 3, 0, TAU); g.fill();
    // labels flip to the left of the dot near the right edge so they stay on the minimap
    const left = x > 118;
    g.textAlign = left ? 'right' : 'left';
    const tx = left ? x - 5 : x + 5;
    g.lineWidth = 3; g.strokeStyle = 'rgba(8,12,8,0.9)'; g.strokeText(p.n, tx, y);
    g.fillStyle = '#fff1c4'; g.fillText(p.n, tx, y);
  }
}
function renderMinimap() {
  if (!mmStatic) return;
  const g = mmCtx;
  g.clearRect(0, 0, 176, 176);
  if (mode === 'lobby') return;
  g.drawImage(mmStatic, 0, 0);
  const k = 176 / world.size;
  // chests
  g.fillStyle = '#ffd23a';
  for (const c of world.chests.values()) if (!c.open) g.fillRect(c.x * k - 1.5, c.y * k - 1.5, 3, 3);
  // storm
  if (storm) {
    g.strokeStyle = 'rgba(200,130,255,0.95)'; g.lineWidth = 1.8;
    g.beginPath(); g.arc(storm.x * k, storm.y * k, storm.r * k, 0, TAU); g.stroke();
    if (storm.nr < storm.r - 5) {
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.beginPath(); g.arc(storm.nx * k, storm.ny * k, storm.nr * k, 0, TAU); g.stroke();
    }
  }
  // self / teammates / spectate target
  const drawDot = (x, y, col, r) => {
    g.fillStyle = col;
    g.beginPath(); g.arc(x * k, y * k, r || 3, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
    g.stroke();
  };
  const myTeam = players.get(myId) ? players.get(myId).team : 0;
  if (mode === 'play' && me && you && you.alive) {
    drawDot(me.x, me.y, '#fff', 3.5);
    if (myTeam > 0) for (const p of players.values()) {
      if (p.id === myId || p.team !== myTeam || !p.buf.length) continue;
      const ip = interpPlayer(p, performance.now() - 120);
      if (ip) drawDot(ip.x, ip.y, S.TEAMS[p.team].color, 3);
    }
  } else if ((mode === 'spec' || mode === 'dead') && specId) {
    const p = players.get(specId);
    if (p) {
      const ip = interpPlayer(p, performance.now() - 120);
      if (ip) drawDot(ip.x, ip.y, '#fff', 3.5);
    }
  }
}

// ============================================================
//  Main loop
// ============================================================
let lastFrame = performance.now();
let specGuard = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (dt > 0.1) dt = 0.1;
  const rt = now - 100; // render time for interpolation (about two snapshots behind)

  // decay fx
  vignette = Math.max(0, vignette - dt * 2.5);
  stormVig = Math.max(0, stormVig - dt * 1.5);
  shakeMag *= Math.max(0, 1 - dt * 9); if (shakeMag < 0.05) shakeMag = 0;
  hitmark = Math.max(0, hitmark - dt);
  kickT = Math.max(0, kickT - dt);
  if (storm && storm.dps > 0 && me && you && you.alive) {
    if (Math.hypot(me.x - storm.x, me.y - storm.y) > storm.r) stormVig = 1;
  }
  for (let i = tracers.length - 1; i >= 0; i--) { tracers[i].t += dt; if (tracers[i].t >= tracers[i].life) tracers.splice(i, 1); }
  for (let i = dmgNums.length - 1; i >= 0; i--) { dmgNums[i].t += dt; if (dmgNums[i].t > 1.1) dmgNums.splice(i, 1); }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
    if (p.t >= p.life) parts.splice(i, 1);
  }
  for (const [id, t] of swings) { const nt = t - dt; if (nt <= 0) swings.delete(id); else swings.set(id, nt); }
  for (const [id, t] of kicks) { const nt = t - dt; if (nt <= 0) kicks.delete(id); else kicks.set(id, nt); }
  for (const p of players.values()) if (p.hitT > 0) p.hitT -= dt;

  // prediction & camera (with slight aim lookahead)
  const busRt = interpBus(rt);
  if (mode === 'lobby') {
    predictLobby(dt);
    // island sits right of centre so the lobby panel does not cover it
    const off = (vw * 0.2) / scale;
    camFocus = lme ? { x: lme.x + off, y: lme.y } : { x: S.ISLAND.x + off, y: S.ISLAND.y };
    camZoom += (1 - camZoom) * Math.min(1, dt * 3);
  } else if (mode === 'play' && me && me.ph !== S.PH.ground) {
    // riding the bus or skydiving: follow the server, no local prediction
    const ip = interpPlayer(players.get(myId), rt);
    if (ip) { me.x = ip.x; me.y = ip.y; }
    camFocus = (me.ph === S.PH.bus && busRt) ? { x: busRt.x, y: busRt.y } : { x: me.x, y: me.y };
    camZoom += ((me.ph === S.PH.bus ? 0.62 : 0.8) - camZoom) * Math.min(1, dt * 2.5);
  } else if (mode === 'play' && me && you && you.alive) {
    predictSelf(dt);
    camZoom += (1 - camZoom) * Math.min(1, dt * 3);
    // aim lookahead from the mouse's offset to the screen centre (not from the
    // camera's own position, which made the camera drift and return after a stop)
    const ax = (mouse.x - vw / 2) / scale, ay = (mouse.y - vh / 2) / scale;
    camFocus = {
      x: me.x + Math.max(-90, Math.min(90, ax * 0.16)),
      y: me.y + Math.max(-90, Math.min(90, ay * 0.16)),
    };
  } else if (mode === 'spec' || mode === 'dead') {
    specGuard -= dt;
    if (!specId || !players.get(specId) || !players.get(specId).buf.length) {
      if (specGuard <= 0) { cycleSpec(1); specGuard = 1; }
    }
    const p = specId ? players.get(specId) : null;
    if (p) {
      const ip = interpPlayer(p, rt);
      if (ip) camFocus = { x: ip.x, y: ip.y };
    }
    if (!camFocus) camFocus = { x: S.WORLD / 2, y: S.WORLD / 2 };
  } else {
    camFocus = camFocus || { x: S.WORLD / 2, y: S.WORLD / 2 };
  }
  if (mode === 'spec' || mode === 'dead') camZoom += (1 - camZoom) * Math.min(1, dt * 3);
  scale = baseScale * camZoom;
  // phase HUD: bus / skydive hints replace the item bar
  const ph = (mode === 'play' && me) ? me.ph : -1;
  if (ph !== lastPh) { lastPh = ph; applyDropHUD(ph); }
  // a tighter follow while alive on the ground, so the camera does not keep sliding after you stop
  const tight = mode === 'play' && me && you && you.alive && me.ph === S.PH.ground;
  const cl = Math.min(1, dt * (tight ? 25 : 7));
  cam.x += (camFocus.x - cam.x) * cl;
  cam.y += (camFocus.y - cam.y) * cl;
  const camPad = (me && me.ph === S.PH.bus) ? 900 : 0;
  cam.x = S.clamp(cam.x, -camPad, world.size + camPad);
  cam.y = S.clamp(cam.y, -camPad, world.size + camPad);

  // input send
  sendInput(false);

  const renderT0 = performance.now();
  render(now, rt);
  renderMs = renderMs * 0.9 + (performance.now() - renderT0) * 0.1;
  renderMinimap();
}
requestAnimationFrame(frame);

// storm timer text refresh (1s granularity)
setInterval(() => { if (mode === 'play') { updateStormTxt(); } }, 500);

// ============================================================
//  Menu wiring (Fortlite, Zombs-style)
// ============================================================
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('fortlite_name') || localStorage.getItem('fc2d_name') || '';
let myModeChoice = localStorage.getItem('fl_mode') || 'solo';
let lowFx = localStorage.getItem('fl_low') === '1';

function updateQualityBtn() { $('qualityBtn').textContent = 'Quality: ' + (lowFx ? 'Low' : 'High'); }
updateQualityBtn();
$('qualityBtn').onclick = () => {
  lowFx = !lowFx;
  localStorage.setItem('fl_low', lowFx ? '1' : '0');
  resize();
  updateQualityBtn();
  toast(lowFx ? 'Low quality — fewer effects' : 'High quality — full effects');
};

$('navProfile').onclick = () => openAcct('account');
$('navFriends').onclick = () => openAcct('friends');
$('navLeaders').onclick = () => openAcct('leaders');
$('navCosmetics').onclick = () => openAcct('account');   // outfits live in the account panel
$('acctTop').onclick = () => openAcct('account');

// ============================================================
//  Accounts: sign-in, profile, friends, leaderboard (server: /api/*)
// ============================================================
const TOKEN_KEY = 'fl_token';
let acct = null;                     // { name, matches, wins, kills, best } when signed in
function apiBase() { return (window.FORTLITE_SERVER || '').replace(/\/+$/, ''); }
async function api(path, body) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  try {
    const r = await fetch(apiBase() + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch (_) { /* empty body */ }
    return { ok: r.ok, status: r.status, data };
  } catch (_) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server' } };
  }
}
function setMsg(id, text, bad) { const el = $(id); el.textContent = text || ''; el.classList.toggle('err', !!bad); }
function acctTab(name) {
  document.querySelectorAll('.acctTab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['account', 'friends', 'leaders']) $('tab-' + t).classList.toggle('hidden', t !== name);
  if (name === 'friends') loadFriends();
  if (name === 'leaders') loadLeaders();
}
function openAcct(tab) {
  show('acctPanel');
  acctTab(tab);
  renderAcct();
}
function renderAcct() {
  const on = !!acct;
  $('acctTop').textContent = on ? acct.name : 'Sign in';
  $('authForm').classList.toggle('hidden', on);
  $('authUser').classList.toggle('hidden', !on);
  $('friendAddRow').classList.toggle('hidden', !on);
  if (on) {
    $('acctName').textContent = acct.name;
    $('acMatches').textContent = acct.matches; $('acWins').textContent = acct.wins;
    $('acKills').textContent = acct.kills; $('acBest').textContent = acct.best ? '#' + acct.best : '#-';
    nameInput.value = acct.name; nameInput.readOnly = true;
    renderOutfits();
    if (!$('friendList').children.length) setMsg('friendMsg', '');
  } else {
    nameInput.readOnly = false;
  }
  if (!on && !$('friendList').children.length) setMsg('friendMsg', 'Log in to add friends.');
}
// cosmetics: outfit picker (the server enforces the unlocks too)
const UNLOCK_WORDS = { wins: ['win', 'wins'], matches: ['match', 'matches'], kills: ['elim', 'elims'] };
function unlockText(o) {
  if (!o.unlock) return '';
  const w = UNLOCK_WORDS[o.unlock.stat];
  return 'Locked: ' + o.unlock.min + ' ' + (o.unlock.min === 1 ? w[0] : w[1]);
}
function renderOutfits() {
  const row = $('outfitRow');
  row.innerHTML = '';
  const cur = acct ? (acct.outfit || 0) : 0;
  const unlocked = acct && acct.unlocked ? acct.unlocked : [0];
  S.OUTFITS.forEach((o, i) => {
    const ok = unlocked.includes(i);
    const b = document.createElement('button');
    b.className = 'outfitBtn' + (i === cur ? ' on' : '') + (ok ? '' : ' lock');
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color;
    const nm = document.createElement('span'); nm.textContent = o.name;
    const hint = document.createElement('small');
    hint.textContent = ok ? (i === cur ? 'Equipped' : 'Equip') : unlockText(o);
    b.append(sw, nm, hint);
    b.onclick = () => equipOutfit(i, ok);
    row.append(b);
  });
  // the menu avatar shows the equipped outfit
  const body = document.querySelector('.charBody');
  if (body) body.style.background = S.OUTFITS[cur].color;
}
async function equipOutfit(i, ok) {
  if (!acct) return;
  if (!ok) { setMsg('outfitMsg', unlockText(S.OUTFITS[i]) + '.', true); return; }
  const r = await api('/api/outfit', { outfit: i });
  if (!r.ok) { setMsg('outfitMsg', r.data.error || 'Could not change outfit.', true); return; }
  acct = r.data;
  setMsg('outfitMsg', S.OUTFITS[i].name + ' equipped. It shows from your next match.');
  renderOutfits();
}
function signIn(data) {
  localStorage.setItem(TOKEN_KEY, data.token);
  const { token: _token, ...rest } = data;
  acct = rest;
  $('authPass').value = '';
  setMsg('authMsg', 'Signed in as ' + data.name);
  renderAcct();
  loadFriends();
}
async function authDo(kind) {
  const name = $('authName').value.trim(), password = $('authPass').value;
  if (!name || !password) { setMsg('authMsg', 'Enter a name and a password.', true); return; }
  setMsg('authMsg', kind === 'register' ? 'Creating account…' : 'Logging in…');
  const r = await api(kind === 'register' ? '/api/register' : '/api/login', { name, password });
  if (!r.ok) { setMsg('authMsg', r.data.error || 'Something went wrong.', true); return; }
  signIn(r.data);
}
$('registerBtn').onclick = () => authDo('register');
$('loginBtn').onclick = () => authDo('login');
$('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') authDo('login'); });
$('logoutBtn').onclick = async () => {
  await api('/api/logout', {});
  localStorage.removeItem(TOKEN_KEY);
  acct = null;
  nameInput.value = ''; nameInput.readOnly = false;
  setMsg('authMsg', 'Logged out.');
  renderAcct();
};
$('acctClose').onclick = () => {
  if (mode === 'menu') { show('menu'); return; }
  $('acctPanel').classList.add('hidden');   // opened from the Esc menu: go back to it
  togglePause(true);
};
document.querySelectorAll('.acctTab').forEach(b => b.onclick = () => acctTab(b.dataset.tab));

async function loadMe() {
  if (!localStorage.getItem(TOKEN_KEY)) { renderAcct(); return; }
  const r = await api('/api/me');
  if (r.ok) { acct = r.data; renderAcct(); }
  else { localStorage.removeItem(TOKEN_KEY); acct = null; renderAcct(); }
}
async function loadFriends() {
  const list = $('friendList');
  list.innerHTML = '';
  if (!acct) { setMsg('friendMsg', 'Log in to see your friends.'); return; }
  const r = await api('/api/friends');
  if (!r.ok) { setMsg('friendMsg', r.data.error || 'Could not load friends.', true); return; }
  setMsg('friendMsg', r.data.rows.length ? '' : 'No friends yet. Add someone by their name.');
  for (const f of r.data.rows) {
    const row = document.createElement('div');
    row.textContent = f.name + '  ·  ' + f.wins + ' wins, ' + f.kills + ' elims';
    list.appendChild(row);
  }
}
$('friendAdd').onclick = async () => {
  const name = $('friendName').value.trim();
  if (!name) return;
  const r = await api('/api/friends/add', { name });
  if (!r.ok) { setMsg('friendMsg', r.data.error || 'Could not add that friend.', true); return; }
  $('friendName').value = '';
  setMsg('friendMsg', 'Friend added.');
  loadFriends();
};
async function loadLeaders() {
  const t = $('leaderTable');
  t.innerHTML = '';
  const r = await api('/api/leaderboard');
  if (!r.ok) { setMsg('leaderMsg', 'Could not load the leaderboard.', true); return; }
  setMsg('leaderMsg', r.data.rows.length ? '' : 'No results yet. Win a match to get on the board.');
  r.data.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (i + 1) + '</td><td></td><td class="n">' + row.wins + ' wins</td><td class="n">' + row.kills + ' elims</td>';
    tr.children[1].textContent = row.name;
    t.appendChild(tr);
  });
}
loadMe();

// ---- queue for a match ----
function queue(modeChoice) {
  myModeChoice = modeChoice;
  localStorage.setItem('fl_mode', modeChoice);
  const name = (nameInput.value || '').trim().slice(0, 16) || 'Player' + ((Math.random() * 900 + 100) | 0);
  localStorage.setItem('fortlite_name', name);
  connectedName = name;
  sfx.ui();
  if (ws && ws.readyState === 1) {
    send({ t: 'mode', m: myModeChoice });
    show(null);
  } else {
    show(null);
    mode = 'menu';
    connect();
  }
}
$('soloBtn').onclick = () => queue('solo');
$('duoBtn').onclick = () => queue('duo');
if ('ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches) {
  setStatus('This game needs a keyboard and mouse.');
}

$('inviteBtn').onclick = () => {
  const url = location.href;
  const done = () => toast('Invite link copied!');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
  else fallbackCopy(url, done);
};
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — URL: ' + text); }
  ta.remove();
}
$('reconnectBtn').onclick = () => location.reload();

})();
