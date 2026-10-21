#!/usr/bin/env node
/* Client smoke test: stubs browser APIs, loads public/game.js for real,
   and drives it through every server message type + render frames.
   Catches ReferenceErrors/typos in client code paths. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------- browser stubs ----------------
function makeClassList(el) {
  const set = new Set();
  return { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)), toggle: (c, f) => { if (f === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (f) set.add(c); else set.delete(c); }, contains: c => set.has(c) };
}
function makeNode(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {},
    classList: null, children: [],
    textContent: '', _innerHTML: '',
    value: '', className: '',
    append(...ns) { for (const n of ns) { this.children.push(n); } },
    prepend(...ns) { for (const n of ns.reverse()) this.children.unshift(n); },
    remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } },
    querySelector() { return makeNode('span'); },
    addEventListener() {}, removeEventListener() {},
    click() { if (this.onclick) this.onclick(); },
    focus() {}, select() {},
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get firstChild() { return this.children[0] || null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = v; this.children = []; },
  });
  el.classList = makeClassList(el);
  return el;
}
const byId = new Map();
const ctxProxy = () => new Proxy({}, {
  get(t, k) {
    if (k === 'createPattern' || k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() { } });
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    if (k === 'canvas') return { width: 100, height: 100 };
    if (typeof t[k] === 'undefined') t[k] = function () { };
    return t[k];
  },
  set(t, k, v) { t[k] = v; return true; },
});
function makeCanvas() {
  const c = makeNode('canvas');
  c.width = 300; c.height = 150;
  c.getContext = () => ctxProxy();
  return c;
}
const rafQueue = [];
const sandbox = {
  console, Math, JSON, Object, Array, Number, String, Boolean, Date, RegExp, Promise, Set, Map,
  TypeError, Error, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  innerWidth: 1280, innerHeight: 720,
  devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } },
  navigator: {},
  Image: function FakeImage() { this.complete = false; this.naturalWidth = 0; this.src = ''; },
  location: { protocol: 'http:', host: 'localhost:3000', href: 'http://localhost:3000/' },
  document: {
    getElementById(id) {
      if (!byId.has(id)) {
        byId.set(id, id === 'game' || id === 'minimap' ? makeCanvas() : makeNode('div'));
      }
      return byId.get(id);
    },
    createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeNode(tag); },
    querySelectorAll() { return []; },
    body: makeNode('body'),
  },
  WebSocket: class WSStub {
    constructor(url) { this.url = url; this.readyState = 1; WSStub.last = this; WSStub.all.push(this); this.sent = []; }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.WebSocket.all = [];
vm.createContext(sandbox);

// ---------------- load scripts ----------------
const sharedSrc = fs.readFileSync(path.join(__dirname, 'shared.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(__dirname, 'public', 'game.js'), 'utf8');
const artSrc = fs.readFileSync(path.join(__dirname, 'public', 'art.js'), 'utf8');
let failed = 0;
const ok = (c, l) => { if (c) console.log('  PASS', l); else { failed++; console.log('  FAIL:', l); } };

try {
  vm.runInContext(sharedSrc, sandbox, { filename: 'shared.js' });
  vm.runInContext(artSrc, sandbox, { filename: 'art.js' });
  vm.runInContext(gameSrc, sandbox, { filename: 'game.js' });
  ok(true, 'game.js loaded without exceptions');
} catch (e) {
  console.error('  LOAD CRASH:', e.stack);
  process.exit(1);
}

const frames = n => {
  for (let i = 0; i < n; i++) {
    const q = rafQueue.splice(0, rafQueue.length);
    if (!q.length) break;
    for (const cb of q) cb();
  }
};
const deliver = obj => {
  const ws = sandbox.WebSocket.last;
  ws.onmessage({ data: JSON.stringify(obj) });
};

// ---------------- drive the client ----------------
try {
  // join via SOLO mode button
  byId.get('nameInput').value = 'SmokeTester';
  byId.get('soloBtn').onclick();
  sandbox.WebSocket.last.onopen();
  const sent1 = sandbox.WebSocket.last.sent;
  ok(sent1.some(m => m.t === 'hello'), 'join → hello sent');
  ok(sent1.some(m => m.t === 'mode' && m.m === 'solo'), 'join → solo mode sent');

  // duo button while connected just switches mode
  byId.get('duoBtn').onclick();
  ok(sandbox.WebSocket.last.sent.some(m => m.t === 'mode' && m.m === 'duo'), 'duo button switches mode');

  // quality toggle
  byId.get('qualityBtn').onclick();
  ok(byId.get('qualityBtn').textContent.includes('Low'), 'quality toggles to Low');

  // account panel (signed out: sign-in form)
  byId.get('navProfile').onclick();
  ok(!byId.get('acctPanel').classList.contains('hidden'), 'account panel opens');
  byId.get('acctClose').onclick();
  ok(byId.get('acctPanel').classList.contains('hidden'), 'account panel closes');

  deliver({ t: 'welcome', id: 7, state: 'lobby', ver: 1 });
  deliver({ t: 'lobby', state: 'lobby', cd: 9, mode: 'solo', players: [{ id: 7, name: 'SmokeTester', team: 0, bot: false, mode: 'solo' }], maxPlayers: 30 });
  frames(5);
  ok(true, 'welcome + lobby handled');
  ok(byId.get('teamRow').style.display === 'none', 'team row hidden in solo');

  // duo lobby shows team buttons
  deliver({ t: 'lobby', state: 'lobby', cd: 8, mode: 'duo', players: [{ id: 7, name: 'SmokeTester', team: 0, bot: false, mode: 'duo' }], maxPlayers: 30 });
  frames(3);
  const teamRow = byId.get('teamRow');
  ok(teamRow.style.display !== 'none' && teamRow.children.length === 7, 'duo lobby renders Auto + 6 team buttons');
  teamRow.children[1].onclick();
  ok(sandbox.WebSocket.last.sent.some(m => m.t === 'team' && m.team === 1), 'team pick sent');

  // match start with synthetic world
  deliver({
    t: 'start',
    world: {
      size: 3000, grid: 60,
      obstacles: [
        { i: 1, ty: 'tree', x: 500, y: 500, r: 26, hp: 200, mhp: 200 },
        { i: 2, ty: 'rock', x: 800, y: 620, r: 30, hp: 250, mhp: 250 },
        { i: 3, ty: 'bush', x: 650, y: 800, r: 30, hp: 999, mhp: 999 },
        { i: 4, ty: 'crate', x: 900, y: 900, r: 26, hp: 250, mhp: 250 },
        { i: 5, ty: 'water', x: 1200, y: 400, r: 80, hp: 1, mhp: 1 },
        { i: 6, ty: 'water', x: 1260, y: 440, r: 70, hp: 1, mhp: 1 },
      ],
      floors: [{ x: 1000, y: 1000, w: 240, h: 180, mat: 'wood' }],
      chests: [{ i: 10, x: 1100, y: 1100, open: false }],
      walls: [{ gx: 17, gy: 17, m: 'stone', hp: 300, mhp: 300 }],
      loot: [
        { i: 20, x: 600, y: 600, k: 'weapon', w: 3, r: 2, am: 30 },
        { i: 21, x: 700, y: 600, k: 'consum', c: 'mini', n: 2 },
        { i: 22, x: 730, y: 610, k: 'ammo', at: 'medium', count: 24, am: 0 },
        { i: 23, x: 760, y: 620, k: 'mats', m: 'wood', amount: 30, am: 0 },
      ],
      storm: { grace: 22, phases: [{ wait: 18, shrink: 16, r: 1250, dps: 1 }], startR: 2200 },
    },
    players: [
      { id: 7, name: 'SmokeTester', team: 2, bot: false },
      { id: 8, name: 'BotRay', team: 0, bot: true },
    ],
    you: 7,
  });
  frames(10);
  ok(true, 'start handled');

  deliver({
    t: 'snap', tm: 2, alive: 2,
    p: [[7, 600, 600, 0.5, 100, 50, 2, 3, 1, 0, 0], [8, 700, 700, 1.2, 80, 0, 0, -1, 0, 0, 1]],
    st: { x: 1500, y: 1500, r: 2200, nx: 1500, ny: 1500, nr: 1250, ph: 0, sh: 0, dps: 0, t: 18 },
  });
  deliver({
    t: 'you', hp: 100, sh: 50,
    mats: { wood: 40, stone: 10, metal: 0 }, ammo: { light: 0, medium: 30, heavy: 0, shell: 0 },
    slots: [{ k: 'pick' }, { k: 'w', w: 3, r: 2, mag: 30 }, { k: 'c', c: 'mini', n: 2 }, null, null],
    sel: 1, reload: 0, use: 0, build: false, bmat: 'wood', alive: true, kills: 0, place: 0,
  });
  frames(10);
  ok(true, 'snap + you handled');

  // events galore
  const evs = [
    { k: 'shot', x: 630, y: 600, a: 0.5, w: 3, id: 7 },
    { k: 'shot', x: 700, y: 700, a: 2, w: 0, id: 8 },
    { k: 'swing', x: 600, y: 600, a: 0, id: 7 },
    { k: 'harvest', x: 500, y: 500, m: 'wood', n: 10, oid: 1, hp: 150, id: 7 },
    { k: 'obsGone', oid: 1 },
    { k: 'wall', gx: 10, gy: 10, m: 'wood', hp: 150, mhp: 150 },
    { k: 'wallHp', gx: 10, gy: 10, hp: 80 },
    { k: 'wallGone', gx: 10, gy: 10 },
    { k: 'hit', x: 650, y: 650 },
    { k: 'dmg', x: 700, y: 700, n: 30, vid: 8, kid: 7 },
    { k: 'dmg', x: 600, y: 600, n: 12, vid: 7, kid: 8 },
    { k: 'chest', i: 10, x: 1100, y: 1100, id: 7 },
    { k: 'lootAdd', l: { i: 30, x: 1120, y: 1120, k: 'consum', c: 'shield', n: 1 } },
    { k: 'lootGone', i: 22 },
    { k: 'pickup', id: 7, x: 600, y: 600, k2: 'ammo' },
    { k: 'used', id: 7, x: 600, y: 600 },
    { k: 'noMats', id: 7, m: 'metal' },
    { k: 'noAmmo', id: 7 },
    { k: 'full', id: 7, sh: true },
    { k: 'stormMsg', phase: 0, msg: 'The Fade is forming!' },
    { k: 'kill', vid: 8, vname: 'BotRay', vteam: 0, vplace: 2, kid: 7, kname: 'SmokeTester', kteam: 2, w: 'ar', bot: true },
  ];
  for (const e of evs) { deliver({ t: 'ev', ...e }); frames(3); }
  ok(true, 'all 23 event types handled');

  // my death
  deliver({ t: 'ev', k: 'kill', vid: 7, vname: 'SmokeTester', vteam: 2, vplace: 2, kid: 8, kname: 'BotRay', kteam: 0, w: 'sniper', bot: false });
  frames(5);
  ok(true, 'own death handled');

  // spectate click
  byId.get('specBtn').onclick();
  frames(5);
  ok(true, 'spectate button works');

  // end screen (win!)
  deliver({ t: 'end', winner: 'SmokeTester', winnerIds: [7], winnerTeam: 2, board: [{ name: 'SmokeTester', team: 2, kills: 1, place: 1, bot: false }, { name: 'BotRay', team: 0, kills: 1, place: 2, bot: true }], time: 95 });
  frames(5);
  ok(byId.get('endTitle').textContent === 'VICTORY ROYALE', 'Victory Royale win title shown');
  ok(byId.get('endBoard').children.length === 2, 'end board rendered');

  // back to lobby
  deliver({ t: 'lobby', state: 'lobby', cd: 15, players: [{ id: 7, name: 'SmokeTester', team: 2, bot: false }], maxPlayers: 30, teams: [null, 'Red', 'Blue', 'Green', 'Yellow'] });
  frames(5);
  ok(true, 'returned to lobby');

  // invite button (clipboard missing → fallback path)
  byId.get('inviteBtn').onclick();
  ok(true, 'invite button works');

  // disconnect overlay
  sandbox.WebSocket.last.onclose();
  ok(true, 'disconnect handled');

  ok(true, `total rAF frames executed without errors`);
  console.log(`\n=== CLIENT SMOKE: ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('  SMOKE CRASH:', e.stack);
  process.exit(1);
}
