// ============================================================
//  FORTLITE core: game simulation shared by the Node server (server.js)
//  and the Cloudflare Durable Object (worker/room.js).
//  No Node-specific APIs in here: sockets are passed in through acceptSocket().
// ============================================================
const S = require('./shared.js');

function createGame(opts = {}) {
// ---------------- game config (from opts) ----------------
const FAST = !!opts.fast;
const NO_STORM = !!opts.nostorm;
const NO_BUS = !!opts.nobus;   // debug: drop everyone straight onto the map
const BOT_FILL = (typeof opts.bots === 'number') ? opts.bots : S.BOT_FILL;

const TICK_MS = 50;
const DT = TICK_MS / 1000;
const LOBBY_CD = FAST ? 4 : S.LOBBY_COUNTDOWN;
const END_TIME = FAST ? 3 : S.END_TIME;
const STORM_CFG = S.STORM;
const stormPhases = FAST
  ? STORM_CFG.phases.map(p => ({ wait: p.wait / 5, shrink: p.shrink / 5, r: p.r, dps: p.dps }))
  : STORM_CFG.phases;
const STORM_GRACE = FAST ? 4 : STORM_CFG.grace;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);


// ============================================================
//  Game state
// ============================================================
let nextEntityId = 1;
const clients = new Map();   // id -> client {id, ws, name, team, player|null, lastMsgT}
const G = {
  state: 'lobby',            // lobby (spawn island) | bus (battle bus flight) | active | end
  countdown: LOBBY_CD,
  endTimer: 0,
  matchTime: 0,
  bus: null,                 // {sx,sy,dx,dy,len,speed,dur,t,a}
  pois: [],                  // named points of interest {id,n,k,x,y,r}
  players: [],               // all match participants (humans + bots)
  obstacles: [],
  obstacleById: new Map(),
  buckets: new Map(),        // spatial hash for obstacles
  walls: new Map(),          // wallKey -> {gx, gy, mat, hp, maxHp}
  chests: [],
  loot: new Map(),
  bullets: [],
  floors: [],
  storm: null,
  aliveCount: 0,
};

// collision world (shared helpers call into this)
const world = {
  size: S.WORLD,
  obstaclesNear(x, y, r) {
    const out = [];
    const cs = 240; // bucket size
    const gx0 = Math.floor((x - r) / cs), gx1 = Math.floor((x + r) / cs);
    const gy0 = Math.floor((y - r) / cs), gy1 = Math.floor((y + r) / cs);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const b = G.buckets.get(gx * 10000 + gy);
      if (b) for (const o of b) out.push(o);
    }
    return out;
  },
  wallAt(gx, gy) { return G.walls.get(S.wallKey(gx, gy)) || null; },
};
function rebucketObstacles() {
  G.buckets.clear();
  const cs = 240;
  for (const o of G.obstacles) {
    const k1 = Math.floor(o.x / cs) * 10000 + Math.floor(o.y / cs);
    let b = G.buckets.get(k1); if (!b) { b = []; G.buckets.set(k1, b); }
    b.push(o);
  }
}

// ============================================================
//  Map generation
// ============================================================
function genMap(seed) {
  const rand = S.mulberry32(seed);
  G.obstacles = []; G.obstacleById = new Map(); G.walls = new Map();
  G.chests = []; G.loot = new Map(); G.floors = []; G.bullets = [];
  const W = S.WORLD;

  const okSpot = (x, y, r, minDist) => {
    if (x < 80 + r || y < 80 + r || x > W - 80 - r || y > W - 80 - r) return false;
    for (const o of G.obstacles) {
      if (S.dist2(x, y, o.x, o.y) < (minDist + o.r) ** 2) return false;
    }
    return true;
  };
  const addObs = (type, x, y, r, hp, mat) => {
    const o = { id: nextEntityId++, type, x, y, r, hp, maxHp: hp, mat: mat || null };
    G.obstacles.push(o); G.obstacleById.set(o.id, o);
    return o;
  };

  // ---- building helper: perimeter walls with door gaps + interior chests ----
  const placeBuilding = (gx0, gy0, cw, ch, mat, nChests) => {
    G.floors.push({ x: gx0 * S.GRID, y: gy0 * S.GRID, w: cw * S.GRID, h: ch * S.GRID, mat });
    const doors = new Set();
    doors.add('n' + Math.floor(rand() * cw)); doors.add('s' + Math.floor(rand() * cw));
    doors.add('w' + Math.floor(rand() * ch)); doors.add('e' + Math.floor(rand() * ch));
    const hp = S.MAT_HP[mat] * 2.5;
    for (let i = 0; i < cw; i++) {
      if (!doors.has('n' + i)) G.walls.set(S.wallKey(gx0 + i, gy0), { gx: gx0 + i, gy: gy0, mat, hp, maxHp: hp, prebuilt: true });
      if (!doors.has('s' + i)) G.walls.set(S.wallKey(gx0 + i, gy0 + ch), { gx: gx0 + i, gy: gy0 + ch, mat, hp, maxHp: hp, prebuilt: true });
    }
    for (let j = 0; j < ch; j++) {
      if (!doors.has('w' + j)) G.walls.set(S.wallKey(gx0, gy0 + j), { gx: gx0, gy: gy0 + j, mat, hp, maxHp: hp, prebuilt: true });
      if (!doors.has('e' + j)) G.walls.set(S.wallKey(gx0 + cw, gy0 + j), { gx: gx0 + cw, gy: gy0 + j, mat, hp, maxHp: hp, prebuilt: true });
    }
    for (let c = 0; c < nChests; c++) {
      G.chests.push({
        id: nextEntityId++,
        x: (gx0 + 1 + rand() * (cw - 2)) * S.GRID,
        y: (gy0 + 1 + rand() * (ch - 2)) * S.GRID,
        open: false,
      });
    }
  };
  const floorFree = (gx0, gy0, cw, ch) => {
    if (gx0 < 2 || gy0 < 2 || gx0 + cw > S.CELLS - 2 || gy0 + ch > S.CELLS - 2) return false;
    const x0 = gx0 * S.GRID - 40, y0 = gy0 * S.GRID - 40, x1 = (gx0 + cw) * S.GRID + 40, y1 = (gy0 + ch) * S.GRID + 40;
    return !G.floors.some(f => !(f.x + f.w < x0 || f.x > x1 || f.y + f.h < y0 || f.y > y1));
  };

  // ---- named points of interest (POIs): clusters of buildings with better loot ----
  const POI_POOL = [
    ['Rustwater Yard', 'industrial'], ['Gull Point Light', 'coast'], ['Thornwick Farm', 'farm'],
    ['Cinder Hollow', 'quarry'], ['Lantern Market', 'town'], ['Hightower Depot', 'town'],
    ['Mossgate Ruins', 'ruins'], ['Fogbank Harbor', 'coast'],
  ];
  for (let i = POI_POOL.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [POI_POOL[i], POI_POOL[j]] = [POI_POOL[j], POI_POOL[i]];
  }
  G.pois = [];
  let poiTries = 0;
  while (G.pois.length < S.POI_COUNT && poiTries++ < 3000) {
    const x = 330 + rand() * (W - 660), y = 330 + rand() * (W - 660);
    if (G.pois.some(p => S.dist(p.x, p.y, x, y) < 760)) continue;
    const [n, k] = POI_POOL[G.pois.length];
    G.pois.push({ id: G.pois.length, n, k, x, y, r: 280 });
  }
  for (const poi of G.pois) {
    const nB = 2 + (rand() < 0.5 ? 1 : 0);
    let placed = 0, tries = 0;
    while (placed < nB && tries++ < 60) {
      const cw = 4 + Math.floor(rand() * 3), ch = 3 + Math.floor(rand() * 2);
      const a = rand() * Math.PI * 2, d = 40 + rand() * 170;
      const cx = poi.x + Math.cos(a) * d, cy = poi.y + Math.sin(a) * d;
      const gx0 = Math.round((cx - cw * S.GRID / 2) / S.GRID), gy0 = Math.round((cy - ch * S.GRID / 2) / S.GRID);
      if (!floorFree(gx0, gy0, cw, ch)) continue;
      const mat = poi.k === 'ruins' ? 'stone' : poi.k === 'industrial' ? 'metal' : ['wood', 'stone', 'metal'][Math.floor(rand() * 3)];
      placeBuilding(gx0, gy0, cw, ch, mat, 1 + (rand() < 0.6 ? 1 : 0));
      placed++;
    }
  }
  // a few lone houses between the POIs
  for (let b = 0; b < 3; b++) {
    for (let tries = 0; tries < 80; tries++) {
      const cw = 3 + Math.floor(rand() * 2), ch = 3;
      const gx0 = 3 + Math.floor(rand() * (S.CELLS - 6 - cw)), gy0 = 3 + Math.floor(rand() * (S.CELLS - 6 - ch));
      if (!floorFree(gx0, gy0, cw, ch)) continue;
      if (G.pois.some(p => S.dist(p.x, p.y, (gx0 + cw / 2) * S.GRID, (gy0 + ch / 2) * S.GRID) < 420)) continue;
      placeBuilding(gx0, gy0, cw, ch, ['wood', 'stone', 'metal'][Math.floor(rand() * 3)], 1);
      break;
    }
  }

  // ---- water lakes (avoid buildings) ----
  const nLakes = 4 + Math.floor(rand() * 3);
  let lakeTries = 0;
  for (let l = 0; l < nLakes && lakeTries < 60; l++) {
    lakeTries++;
    const lx = 350 + rand() * (W - 700), ly = 350 + rand() * (W - 700);
    if (G.floors.some(f => S.dist2(f.x + f.w / 2, f.y + f.h / 2, lx, ly) < 380 * 380)) { l--; continue; }
    const nBlobs = 4 + Math.floor(rand() * 5);
    for (let b = 0; b < nBlobs; b++) {
      const a = rand() * Math.PI * 2, d = rand() * 130;
      addObs('water', lx + Math.cos(a) * d, ly + Math.sin(a) * d, 55 + rand() * 45, 1, null);
    }
  }

  // trees (clustered), rocks, crates, bushes
  const scatter = (type, count, r, hp, mat, cluster) => {
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      let x, y;
      if (cluster && placed % 5 === 0) { // cluster seed point
        x = 120 + rand() * (W - 240); y = 120 + rand() * (W - 240);
      } else if (cluster) {
        const seed = G.obstacles[G.obstacles.length - 1];
        x = seed.x + (rand() - 0.5) * 320; y = seed.y + (rand() - 0.5) * 320;
      } else { x = 120 + rand() * (W - 240); y = 120 + rand() * (W - 240); }
      if (!okSpot(x, y, r, 40)) continue;
      // don't place inside building floors
      if (G.floors.some(f => x > f.x - 30 && x < f.x + f.w + 30 && y > f.y - 30 && y < f.y + f.h + 30)) continue;
      addObs(type, x, y, r, hp, mat); placed++;
    }
  };
  scatter('tree', 85, 26, 200, 'wood', true);
  scatter('rock', 40, 30, 250, 'stone', false);
  scatter('crate', 16, 26, 250, 'metal', false);
  scatter('bush', 42, 30, 999, null, true);

  // open-field chests
  for (let i = 0; i < 16; i++) {
    let tries = 0;
    while (tries++ < 200) {
      const x = 160 + rand() * (W - 320), y = 160 + rand() * (W - 320);
      if (okSpot(x, y, 34, 60)) { G.chests.push({ id: nextEntityId++, x, y, open: false }); break; }
    }
  }

  // floor loot
  const roll = (arr) => { let t = 0; for (const a of arr) t += a[1]; let r = rand() * t; for (const a of arr) { r -= a[1]; if (r <= 0) return a[0]; } return arr[0][0]; };
  const floorRarity = () => roll([[0, 50], [1, 30], [2, 15], [3, 5]]);
  const nFloor = 85;
  for (let i = 0; i < nFloor; i++) {
    let tries = 0;
    while (tries++ < 200) {
      const x = 120 + rand() * (W - 240), y = 120 + rand() * (W - 240);
      if (!okSpot(x, y, 20, 20)) continue;
      const kind = roll([['weapon', 45], ['consum', 25], ['ammo', 20], ['mats', 10]]);
      let def = null;
      if (kind === 'weapon') def = { kind: 'weapon', w: Math.floor(rand() * S.WEAPONS.length), r: floorRarity(), ammo: S.WEAPON_PICKUP_AMMO[S.WEAPONS[Math.floor(rand() * S.WEAPONS.length)].ammo] };
      else if (kind === 'consum') def = { kind: 'consum', c: roll([['mini', 45], ['shield', 25], ['medkit', 30]]), count: 1 + (rand() < 0.3 ? 1 : 0) };
      else if (kind === 'ammo') def = { kind: 'ammo', at: roll([['light', 30], ['medium', 30], ['heavy', 15], ['shell', 25]]), count: 0 };
      else def = { kind: 'mats', m: roll([['wood', 40], ['stone', 35], ['metal', 25]]), amount: 30 };
      if (def.kind === 'weapon') def.ammo = S.WEAPON_PICKUP_AMMO[S.WEAPONS[def.w].ammo];
      if (def.kind === 'ammo') def.count = def.at === 'heavy' ? 6 : def.at === 'shell' ? 8 : 24;
      spawnLoot(x, y, def);
      break;
    }
  }

  // POI loot: better rarities and extra consumables around each named POI
  for (const poi of G.pois) {
    const picks = [
      { kind: 'weapon', w: Math.floor(rand() * S.WEAPONS.length), r: 2 + Math.floor(rand() * 3) },
      { kind: 'weapon', w: Math.floor(rand() * S.WEAPONS.length), r: 1 + Math.floor(rand() * 3) },
      { kind: 'consum', c: roll([['medkit', 50], ['shield', 50]]), count: 1 },
      { kind: 'ammo', at: roll([['light', 30], ['medium', 30], ['heavy', 15], ['shell', 25]]), count: 0 },
      { kind: 'mats', m: roll([['wood', 40], ['stone', 35], ['metal', 25]]), amount: 60 },
    ];
    for (const def of picks) {
      for (let tries = 0; tries < 80; tries++) {
        const a = rand() * Math.PI * 2, d = 30 + rand() * (poi.r - 50);
        const x = poi.x + Math.cos(a) * d, y = poi.y + Math.sin(a) * d;
        if (!okSpot(x, y, 20, 20)) continue;
        if (def.kind === 'weapon') def.ammo = S.WEAPON_PICKUP_AMMO[S.WEAPONS[def.w].ammo];
        if (def.kind === 'ammo') def.count = def.at === 'heavy' ? 6 : def.at === 'shell' ? 8 : 24;
        spawnLoot(x, y, Object.assign({}, def));
        break;
      }
    }
  }

  rebucketObstacles();
}

function spawnLoot(x, y, def) {
  const item = Object.assign({ id: nextEntityId++, x, y }, def);
  G.loot.set(item.id, item);
  return item;
}

// ============================================================
//  Players / clients
// ============================================================
function makePlayer(id, name, team, isBot) {
  return {
    id, name, team, bot: isBot,
    client: null,
    x: 0, y: 0, aim: 0,
    input: { mx: 0, my: 0, aim: 0, fire: false, build: false },
    pending: [],
    hp: S.START_HP, shield: S.START_SHIELD,
    alive: true, kills: 0, placement: 0,
    mats: { wood: 0, stone: 0, metal: 0 },
    ammo: { light: 0, medium: 0, heavy: 0, shell: 0 },
    slots: [{ kind: 'pickaxe' }, null, null, null, null],
    sel: 0,
    fireCd: 0, swingCd: 0, placeCd: 0, interactCd: 0,
    reloadT: 0, reloadTotal: 0,
    useT: 0, useTotal: 0,
    buildMat: 'wood',
    stormAcc: 0,
    lastShotT: -99, lastDmgT: -99,
    ai: isBot ? newBotAI() : null,
    stuckT: 0, lastX: 0, lastY: 0,
    ph: S.PH.ground, fallT: 0, alt: 0, fallVx: 0, fallVy: 0, vx: 0, vy: 0,
  };
}
function newBotAI() {
  return {
    mode: 'wander', thinkT: Math.random() * 0.3,
    target: null, targetSeenT: 0,
    wx: 0, wy: 0, newWanderT: 0,
    strafeDir: 1, strafeT: 0,
    fireT: 0, pauseT: 0,
    reactT: 0,
    panicWallT: 0, lootT: 0,
  };
}

// ============================================================
//  Broadcast helpers
// ============================================================
function sendTo(client, obj) { if (client.ws && !client.ws.closed) client.ws.send(JSON.stringify(obj)); }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients.values()) if (c.ws && !c.ws.closed) c.ws.send(s);
}
let evQueue = [];
function ev(obj) { evQueue.push(obj); }

function lobbyMode() {
  let duo = 0, solo = 0;
  for (const c of clients.values()) (c.modeChoice === 'duo' ? duo++ : solo++);
  return duo > solo ? 'duo' : 'solo';
}

function lobbyState() {
  const players = [];
  for (const c of clients.values()) players.push({ id: c.id, name: c.name, team: c.team, bot: false, mode: c.modeChoice || 'solo' });
  return {
    t: 'lobby', state: G.state, cd: Math.max(0, Math.ceil(G.countdown)),
    players, maxPlayers: S.MAX_PLAYERS, mode: lobbyMode(),
  };
}
function broadcastLobby() { broadcast(lobbyState()); }

function rosterMsg() {
  return G.players.map(p => ({ id: p.id, name: p.name, team: p.team, bot: p.bot }));
}

function startMsg(forClient) {
  return {
    t: 'start',
    world: {
      size: S.WORLD, grid: S.GRID,
      obstacles: G.obstacles.map(o => ({ i: o.id, ty: o.type, x: Math.round(o.x), y: Math.round(o.y), r: o.r, hp: o.hp, mhp: o.maxHp })),
      floors: G.floors,
      chests: G.chests.map(c => ({ i: c.id, x: Math.round(c.x), y: Math.round(c.y), open: c.open })),
      walls: [...G.walls.values()].map(w => ({ gx: w.gx, gy: w.gy, m: w.mat, hp: Math.round(w.hp), mhp: w.maxHp })),
      loot: [...G.loot.values()].map(serializeLoot),
      storm: { grace: STORM_GRACE, phases: stormPhases, startR: STORM_CFG.startR },
      pois: G.pois.map(p => ({ i: p.id, n: p.n, k: p.k, x: Math.round(p.x), y: Math.round(p.y), r: p.r })),
    },
    players: rosterMsg(),
    you: forClient ? forClient.id : null,
    mode: G.mode || 'solo',
  };
}
function serializeLoot(l) {
  return { i: l.id, x: Math.round(l.x), y: Math.round(l.y), k: l.kind, w: l.w, r: l.r, c: l.c, n: l.count, m: l.m, a: l.amount, at: l.at, am: l.ammo };
}

// ============================================================
//  Spawn island (lobby), Battle Bus and skydive
// ============================================================
function spawnOnIsland(c) {
  const a = Math.random() * Math.PI * 2, d = Math.random() * (S.ISLAND.r - 150);
  c.lx = S.ISLAND.x + Math.cos(a) * d;
  c.ly = S.ISLAND.y + Math.sin(a) * d;
  c.la = 0; c.li = null;
}
function stepIslandClient(c, dt) {
  const i = c.li;
  if (!i) return;
  let mx = i.x, my = i.y;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  if (m > 0.01) c.la = Math.atan2(my, mx);
  const [nx, ny] = S.clampIsland(c.lx + mx * S.ISLAND_SPEED * dt, c.ly + my * S.ISLAND_SPEED * dt);
  c.lx = nx; c.ly = ny;
}
function broadcastIsland() {
  const pts = [];
  for (const c of clients.values()) {
    if (c.player) continue;
    pts.push([c.id, Math.round(c.lx * 10) / 10, Math.round(c.ly * 10) / 10, Math.round(c.la * 100) / 100]);
  }
  if (pts.length) broadcast({ t: 'lpos', p: pts });
}

// The bus flies a straight route across the map, from off-map on one side to off-map on the other.
function makeBus() {
  const W = S.WORLD;
  const a = Math.random() * Math.PI * 2;
  const cx = W / 2 + (Math.random() - 0.5) * 700, cy = W / 2 + (Math.random() - 0.5) * 700;
  const dx = Math.cos(a), dy = Math.sin(a), span = S.BUS.span;
  G.bus = {
    sx: cx - dx * span, sy: cy - dy * span, dx, dy,
    speed: S.BUS.speed, dur: (span * 2) / S.BUS.speed, t: 0, a: Math.atan2(dy, dx),
  };
}
function busPos() {
  const b = G.bus;
  const d = Math.min(b.t, b.dur) * b.speed;
  return { x: b.sx + b.dx * d, y: b.sy + b.dy * d };
}
function followBus(p) {
  const q = busPos();
  p.x = q.x; p.y = q.y; p.aim = G.bus.a;
}
function startFall(p) {
  if (p.ph !== S.PH.bus || !G.bus) return;
  const b = G.bus;
  p.ph = S.PH.fall;
  p.fallT = S.FALL_TIME;
  p.alt = 1;
  p.fallVx = b.dx * b.speed * S.FALL_CARRY;
  p.fallVy = b.dy * b.speed * S.FALL_CARRY;
  p.input.fire = false; p.input.build = false;
  ev({ k: 'jump', id: p.id });
}
function updateFall(p, dt) {
  const inp = p.input;
  let mx = inp.mx, my = inp.my;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  const decay = Math.max(0, 1 - dt * 0.9);
  p.fallVx *= decay; p.fallVy *= decay;
  p.x = S.clamp(p.x + (mx * S.FALL_SPEED + p.fallVx) * dt, 30, S.WORLD - 30);
  p.y = S.clamp(p.y + (my * S.FALL_SPEED + p.fallVy) * dt, 30, S.WORLD - 30);
  p.fallT -= dt;
  p.alt = Math.max(0, p.fallT / S.FALL_TIME);
  if (p.fallT <= 0) landPlayer(p);
}
function landPlayer(p) {
  p.ph = S.PH.ground;
  p.alt = 0; p.fallT = 0;
  const [nx, ny] = S.resolveCircle(p.x, p.y, S.PLAYER_R + 2, world);
  p.x = nx; p.y = ny;
  p.lastX = p.x; p.lastY = p.y;
  ev({ k: 'land', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
}
// bot brain while riding the bus or skydiving
function botAir(p, dt) {
  const ai = p.ai, inp = p.input;
  inp.fire = false; inp.build = false;
  if (p.ph === S.PH.bus) {
    if (ai.jumpT === undefined) {
      ai.poi = G.pois.length ? G.pois[(Math.random() * G.pois.length) | 0] : null;
      ai.jumpT = Math.random() < 0.35 ? 1 + Math.random() * Math.max(1, G.bus.dur - 3) : null;
    }
    const b = G.bus, q = busPos();
    const near = ai.poi && S.dist(q.x, q.y, ai.poi.x, ai.poi.y) < 220;
    if ((ai.jumpT != null && b.t >= ai.jumpT) || near || b.t >= b.dur - 0.05) startFall(p);
    return;
  }
  if (p.ph === S.PH.fall && ai.poi) {
    const dx = ai.poi.x - p.x, dy = ai.poi.y - p.y, d = Math.hypot(dx, dy);
    if (d > 40) { inp.mx = dx / d; inp.my = dy / d; } else { inp.mx = 0; inp.my = 0; }
  }
}

// ============================================================
//  Match lifecycle
// ============================================================
function effTeam(p) { return p.team > 0 ? p.team : -(p.id); }

function startMatch() {
  genMap((Math.random() * 1e9) | 0);
  G.players = [];
  G.matchTime = 0;
  G.mode = lobbyMode();
  const humans = [...clients.values()];
  const counts = new Map(); // team -> member count
  let nextTeam = S.PICKABLE_TEAMS + 1;

  if (G.mode === 'duo') {
    // respect manual picks (capacity 2)
    for (const c of humans) {
      if (c.team >= 1 && c.team <= S.PICKABLE_TEAMS && (counts.get(c.team) || 0) < 2) {
        counts.set(c.team, (counts.get(c.team) || 0) + 1);
      } else c.team = 0;
    }
    // auto-pair the rest: join a half-full team first (so players pair up), then empty teams
    for (const c of humans) {
      if (c.team !== 0) continue;
      let placed = false;
      for (let t = 1; t <= S.PICKABLE_TEAMS && !placed; t++) {
        if ((counts.get(t) || 0) === 1) { c.team = t; counts.set(t, 2); placed = true; }
      }
      for (let t = 1; t <= S.PICKABLE_TEAMS && !placed; t++) {
        if ((counts.get(t) || 0) === 0) { c.team = t; counts.set(t, 1); placed = true; }
      }
      if (!placed) {
        const t = ((nextTeam - 1) % (S.TEAMS.length - 1)) + 1; nextTeam++;
        c.team = t; counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
  } else {
    for (const c of humans) c.team = 0;
  }

  // humans
  for (const c of humans) {
    const p = makePlayer(c.id, c.name, c.team, false);
    p.client = c; c.player = p;
    G.players.push(p);
  }
  // bots (paired up in duo)
  const botCount = Math.max(0, Math.min(S.MAX_PLAYERS, BOT_FILL) - G.players.length);
  const names = S.BOT_NAMES.slice();
  let bi = 0;
  while (bi < botCount) {
    let team = 0;
    if (G.mode === 'duo') {
      team = null;
      for (let t = 1; t <= S.PICKABLE_TEAMS; t++) {
        if ((counts.get(t) || 0) < 2) { team = t; break; }
      }
      if (team === null) { team = ((nextTeam - 1) % (S.TEAMS.length - 1)) + 1; nextTeam++; }
      counts.set(team, (counts.get(team) || 0) + 2);
    }
    const pair = Math.min(2, botCount - bi);
    for (let k = 0; k < pair; k++) {
      const n = names.length ? names.splice((Math.random() * names.length) | 0, 1)[0] : 'Bot' + bi;
      const p = makePlayer(nextEntityId++, n, team, true);
      G.players.push(p);
    }
    bi += pair;
  }
  // spawn: everyone rides the Battle Bus (--nobus drops them straight onto the map for debugging)
  G.bus = null;
  if (NO_BUS) {
    const W = S.WORLD, taken = [];
    for (const p of G.players) {
      let x = W / 2, y = W / 2, tries = 0;
      do {
        x = 150 + Math.random() * (W - 300);
        y = 150 + Math.random() * (W - 300);
        tries++;
      } while (tries < 300 && (taken.some(t => S.dist2(x, y, t[0], t[1]) < 260 * 260) || S.resolveCircle(x, y, S.PLAYER_R + 2, world)[0] !== x));
      taken.push([x, y]);
      p.x = x; p.y = y;
    }
  } else {
    makeBus();
    for (const p of G.players) { p.ph = S.PH.bus; p.alt = 0; followBus(p); }
  }
  G.storm = {
    phase: -1, t: STORM_GRACE,
    cx: S.WORLD / 2, cy: S.WORLD / 2, r: STORM_CFG.startR,
    fx: S.WORLD / 2, fy: S.WORLD / 2, fr: STORM_CFG.startR,       // shrink-from
    tx: S.WORLD / 2, ty: S.WORLD / 2, tr: STORM_CFG.startR,       // shrink-to
    shrinking: false, dps: 0,
  };
  G.aliveCount = G.players.length;
  G.state = NO_BUS ? 'active' : 'bus';
  if (!NO_BUS) ev({ k: 'busStart' });
  log(`Match started [${G.mode}]: ${G.players.length} players (${clients.size} human)${NO_STORM ? ' [no storm]' : ''}${NO_BUS ? ' [no bus]' : ''}`);
  for (const c of clients.values()) sendTo(c, startMsg(c.player ? c : null));
  broadcastLobby();
}

function endMatch(winnerTeam) {
  if (G.state !== 'active') return;
  G.state = 'end';
  G.endTimer = END_TIME;
  const winners = G.players.filter(p => p.alive);
  const winnerIds = winners.map(p => p.id);
  let winnerName = 'Nobody';
  if (winners.length) {
    if (winners[0].team > 0) winnerName = 'Team ' + S.TEAMS[winners[0].team].name;
    else winnerName = winners[0].name;
  }
  const board = G.players
    .map(p => {
      if (p.alive && !p.placement) p.placement = 1;
      return { name: p.name, team: p.team, kills: p.kills, place: p.placement || 99, bot: p.bot };
    })
    .sort((a, b) => (a.place - b.place) || (b.kills - a.kills))
    .slice(0, 5);
  broadcast({
    t: 'end', winner: winnerName, winnerIds, winnerTeam: winners.length ? winners[0].team : 0,
    board, time: Math.round(G.matchTime),
  });
  log(`Match ended. Winner: ${winnerName}`);
  // detach human players
  for (const c of clients.values()) c.player = null;
  G.players = [];
}

function resetToLobby() {
  G.state = 'lobby';
  G.bus = null;
  for (const c of clients.values()) spawnOnIsland(c);
  G.countdown = LOBBY_CD;
  broadcastLobby();
}

// ============================================================
//  Combat / damage
// ============================================================
function damagePlayer(victim, amount, attacker, cause) {
  if (!victim.alive || G.state !== 'active' || victim.ph !== S.PH.ground) return;
  let dmg = amount;
  if (victim.shield > 0) {
    const absorbed = Math.min(victim.shield, dmg);
    victim.shield -= absorbed; dmg -= absorbed;
  }
  victim.hp -= dmg;
  victim.lastDmgT = G.matchTime;
  ev({ k: 'dmg', x: victim.x, y: victim.y, n: Math.round(amount), vid: victim.id, kid: attacker ? attacker.id : null });
  if (attacker && attacker.alive && !attacker.bot) { /* killer feedback handled client side */ }
  if (victim.hp <= 0) killPlayer(victim, attacker, cause);
}

function killPlayer(victim, attacker, cause) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.placement = G.aliveCount;
  G.aliveCount--;
  // drop loot
  const dropAt = (def) => {
    const a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 45;
    const it = spawnLoot(victim.x + Math.cos(a) * d, victim.y + Math.sin(a) * d, def);
    ev({ k: 'lootAdd', l: serializeLoot(it) });
  };
  for (let i = 1; i < 5; i++) {
    const s = victim.slots[i];
    if (!s) continue;
    if (s.kind === 'weapon') dropAt({ kind: 'weapon', w: s.w, r: s.r, ammo: 0 });
    else if (s.kind === 'consum') dropAt({ kind: 'consum', c: s.c, count: s.count });
  }
  for (const m of S.MATS) if (victim.mats[m] >= 20) dropAt({ kind: 'mats', m, amount: Math.min(100, Math.floor(victim.mats[m] / 2)) });
  const ammoDrop = (at, n) => { if (n >= 4) dropAt({ kind: 'ammo', at, count: Math.min(n, 20) }); };
  ammoDrop('light', victim.ammo.light); ammoDrop('medium', victim.ammo.medium);
  ammoDrop('heavy', victim.ammo.heavy); ammoDrop('shell', victim.ammo.shell);

  if (attacker && attacker !== victim) attacker.kills++;
  const kname = attacker ? attacker.name : (cause === 'left' ? 'Disconnected' : 'The Fade');
  ev({
    k: 'kill', vid: victim.id, vname: victim.name, vteam: victim.team, vplace: victim.placement,
    kid: attacker ? attacker.id : null, kname,
    kteam: attacker ? attacker.team : 0, w: cause || 'storm', bot: victim.bot,
  });
  // win check
  const teams = new Set();
  for (const p of G.players) if (p.alive) teams.add(effTeam(p));
  if (teams.size <= 1) {
    const only = teams.size === 1 ? [...teams][0] : null;
    endMatch(only);
  }
}

// ============================================================
//  Weapons / building / harvesting
// ============================================================
function curSlot(p) { return p.slots[p.sel]; }

function startReload(p) {
  const s = curSlot(p);
  if (p.reloadT > 0 || !s || s.kind !== 'weapon') return;
  const w = S.WEAPONS[s.w];
  if (s.mag >= w.mag) return;
  if (p.ammo[w.ammo] <= 0) { if (!p.bot) ev({ k: 'noAmmo', id: p.id }); return; }
  p.useT = 0; // cancel consumable
  p.reloadT = w.reload; p.reloadTotal = w.reload;
}
function finishReload(p) {
  const s = curSlot(p);
  if (!s || s.kind !== 'weapon') return;
  const w = S.WEAPONS[s.w];
  const need = w.mag - s.mag;
  const take = Math.min(need, p.ammo[w.ammo]);
  s.mag += take; p.ammo[w.ammo] -= take;
}

function tryFire(p) {
  const s = curSlot(p);
  if (!s || s.kind !== 'weapon') return;
  if (p.reloadT > 0) return;
  const w = S.WEAPONS[s.w];
  if (p.fireCd > 0) return;
  if (s.mag <= 0) { startReload(p); return; }
  s.mag--;
  p.fireCd = w.rof;
  p.useT = 0;
  p.lastShotT = G.matchTime;
  const mult = S.RARITY[s.r].mult;
  const mx = p.x + Math.cos(p.input.aim) * 30, my = p.y + Math.sin(p.input.aim) * 30;
  ev({ k: 'shot', x: mx, y: my, a: p.input.aim, w: s.w, id: p.id });
  for (let i = 0; i < w.pellets; i++) {
    const a = p.input.aim + (Math.random() - 0.5) * 2 * w.spread;
    G.bullets.push({
      x: mx, y: my,
      vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
      dmg: w.dmg * mult, range: w.range, traveled: 0,
      owner: p.id, team: effTeam(p), wi: s.w,
    });
  }
  if (s.mag <= 0) startReload(p);
}

function tryPlaceWall(p) {
  if (p.placeCd > 0) return;
  const mat = p.buildMat;
  if (p.mats[mat] < S.WALL_COST) { if (!p.bot) ev({ k: 'noMats', id: p.id, m: mat }); return; }
  // aim point → grid cell
  const px = p.x + Math.cos(p.input.aim) * 55, py = p.y + Math.sin(p.input.aim) * 55;
  const gx = Math.floor(px / S.GRID), gy = Math.floor(py / S.GRID);
  if (gx < 0 || gy < 0 || gx * S.GRID + S.GRID > S.WORLD || gy * S.GRID + S.GRID > S.WORLD) return;
  if (G.walls.has(S.wallKey(gx, gy))) return;
  // no obstacle overlap
  const wx = gx * S.GRID, wy = gy * S.GRID;
  for (const o of world.obstaclesNear(wx + 30, wy + 30, 90)) {
    if (o.type === 'bush') continue;
    const cx = S.clamp(o.x, wx, wx + S.GRID), cy = S.clamp(o.y, wy, wy + S.GRID);
    if (S.dist2(cx, cy, o.x, o.y) < o.r * o.r * 0.64) return; // 0.8*r clearance
  }
  // no player overlap (including self)
  for (const q of G.players) {
    if (!q.alive) continue;
    const cx = S.clamp(q.x, wx, wx + S.GRID), cy = S.clamp(q.y, wy, wy + S.GRID);
    if (S.dist2(cx, cy, q.x, q.y) < S.PLAYER_R * S.PLAYER_R) return;
  }
  p.mats[mat] -= S.WALL_COST;
  p.placeCd = 0.18;
  const hp = S.MAT_HP[mat];
  G.walls.set(S.wallKey(gx, gy), { gx, gy, mat, hp, maxHp: hp });
  ev({ k: 'wall', gx, gy, m: mat, hp, mhp: hp });
}

function damageWall(wall, dmg, attacker) {
  wall.hp -= dmg;
  if (wall.hp <= 0) {
    G.walls.delete(S.wallKey(wall.gx, wall.gy));
    ev({ k: 'wallGone', gx: wall.gx, gy: wall.gy });
    ev({ k: 'rubble', x: wall.gx * S.GRID + 30, y: wall.gy * S.GRID + 30, m: wall.mat });
  } else {
    ev({ k: 'wallHp', gx: wall.gx, gy: wall.gy, hp: Math.max(1, Math.round(wall.hp)) });
  }
}

function pickaxeSwing(p) {
  if (p.swingCd > 0) return;
  p.swingCd = S.PICK_CD;
  p.lastShotT = G.matchTime;
  ev({ k: 'swing', x: p.x, y: p.y, a: p.input.aim, id: p.id });
  const hx = p.x + Math.cos(p.input.aim) * 42, hy = p.y + Math.sin(p.input.aim) * 42;
  let hitSomething = false;

  // walls near the hit point
  const G2 = S.GRID;
  const gx0 = Math.floor((hx - 28) / G2), gx1 = Math.floor((hx + 28) / G2);
  const gy0 = Math.floor((hy - 28) / G2), gy1 = Math.floor((hy + 28) / G2);
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const w = world.wallAt(gx, gy);
    if (!w) continue;
    const cx = S.clamp(hx, gx * G2, gx * G2 + G2), cy = S.clamp(hy, gy * G2, gy * G2 + G2);
    if (S.dist2(cx, cy, hx, hy) < 30 * 30) {
      damageWall(w, S.PICK_DMG_RESOURCE, p);
      hitSomething = true;
    }
  }

  // obstacles
  let best = null, bestD = 1e9;
  for (const o of world.obstaclesNear(p.x, p.y, S.PICK_RANGE + 60)) {
    if (o.type === 'bush') continue;
    const d = S.dist(p.x, p.y, o.x, o.y) - o.r;
    if (d > S.PICK_RANGE) continue;
    const ang = Math.atan2(o.y - p.y, o.x - p.x);
    if (Math.abs(S.angDiff(p.input.aim, ang)) > 1.1) continue;
    if (d < bestD) { bestD = d; best = o; }
  }
  if (best) {
    best.hp -= S.PICK_DMG_RESOURCE;
    let gained = 0;
    if (best.mat) {
      gained = S.HARVEST_PER_HIT;
      if (best.hp <= 0) gained += S.HARVEST_BONUS;
      p.mats[best.mat] = Math.min(S.HARVEST_CAP, p.mats[best.mat] + gained);
    }
    ev({ k: 'harvest', x: best.x, y: best.y, m: best.mat, n: gained, oid: best.id, hp: Math.max(0, best.hp), id: p.id });
    if (best.hp <= 0) {
      G.obstacles.splice(G.obstacles.indexOf(best), 1);
      G.obstacleById.delete(best.id);
      rebucketObstacles();
      ev({ k: 'obsGone', oid: best.id });
    }
    hitSomething = true;
  }

  // players
  for (const q of G.players) {
    if (q === p || !q.alive || effTeam(q) === effTeam(p)) continue;
    const d = S.dist(p.x, p.y, q.x, q.y);
    if (d > S.PICK_RANGE + S.PLAYER_R) continue;
    const ang = Math.atan2(q.y - p.y, q.x - p.x);
    if (Math.abs(S.angDiff(p.input.aim, ang)) > 1.0) continue;
    damagePlayer(q, S.PICK_DMG_PLAYER, p, 'pick');
    hitSomething = true;
    break;
  }
  if (hitSomething && p.bot === false) { /* sound handled client side via events */ }
}

// ============================================================
//  Loot / pickup / chests
// ============================================================
function ammoForWeapon(widx) { return S.WEAPON_PICKUP_AMMO[S.WEAPONS[widx].ammo]; }

function tryPickup(p, item, explicit) {
  const def = item;
  if (def.kind === 'ammo') {
    if (p.ammo[def.at] >= S.AMMO_MAX[def.at]) return false;
    p.ammo[def.at] = Math.min(S.AMMO_MAX[def.at], p.ammo[def.at] + def.count);
    return true;
  }
  if (def.kind === 'mats') {
    p.mats[def.m] = Math.min(S.HARVEST_CAP, p.mats[def.m] + def.amount);
    return true;
  }
  if (def.kind === 'consum') {
    // stack first
    for (let i = 1; i < 5; i++) {
      const s = p.slots[i];
      if (s && s.kind === 'consum' && s.c === def.c && s.count < 6) {
        const room = 6 - s.count;
        const take = Math.min(room, def.count);
        s.count += take; def.count -= take;
        if (def.count <= 0) return true;
      }
    }
    const empty = p.slots.indexOf(null, 1);
    if (empty === -1) return false;
    p.slots[empty] = { kind: 'consum', c: def.c, count: def.count };
    return true;
  }
  if (def.kind === 'weapon') {
    const empty = p.slots.indexOf(null, 1);
    if (empty === -1) {
      if (!explicit || p.sel === 0) return false;
      // swap with selected
      const old = p.slots[p.sel];
      const dropDef = old.kind === 'weapon'
        ? { kind: 'weapon', w: old.w, r: old.r, ammo: 0 }
        : { kind: 'consum', c: old.c, count: old.count };
      const dropped = spawnLoot(p.x + (Math.random() - 0.5) * 30, p.y + (Math.random() - 0.5) * 30, dropDef);
      ev({ k: 'lootAdd', l: serializeLoot(dropped) });
      p.slots[p.sel] = { kind: 'weapon', w: def.w, r: def.r, mag: S.WEAPONS[def.w].mag };
      if (def.ammo) p.ammo[S.WEAPONS[def.w].ammo] = Math.min(S.AMMO_MAX[S.WEAPONS[def.w].ammo], p.ammo[S.WEAPONS[def.w].ammo] + def.ammo);
      return true;
    }
    p.slots[empty] = { kind: 'weapon', w: def.w, r: def.r, mag: S.WEAPONS[def.w].mag };
    if (def.ammo) p.ammo[S.WEAPONS[def.w].ammo] = Math.min(S.AMMO_MAX[S.WEAPONS[def.w].ammo], p.ammo[S.WEAPONS[def.w].ammo] + def.ammo);
    return true;
  }
  return false;
}

function removeLoot(item) {
  G.loot.delete(item.id);
  ev({ k: 'lootGone', i: item.id });
}

function autoPickup(p) {
  for (const item of G.loot.values()) {
    if (S.dist2(p.x, p.y, item.x, item.y) > 38 * 38) continue;
    if (item.kind === 'weapon' && p.slots.indexOf(null, 1) === -1) continue; // need E to swap
    if (item.kind === 'consum') {
      const stackable = p.slots.some(s => s && s.kind === 'consum' && s.c === item.c && s.count < 6);
      if (!stackable && p.slots.indexOf(null, 1) === -1) continue;
    }
    if (item.kind === 'ammo' && p.ammo[item.at] >= S.AMMO_MAX[item.at]) continue;
    if (tryPickup(p, item, false)) { removeLoot(item); ev({ k: 'pickup', id: p.id, x: item.x, y: item.y, k2: item.kind }); }
  }
}

function openChest(p, chest) {
  chest.open = true;
  const roll = (arr) => { let t = 0; for (const a of arr) t += a[1]; let r = Math.random() * t; for (const a of arr) { r -= a[1]; if (r <= 0) return a[0]; } return arr[0][0]; };
  const rar = roll([[0, 35], [1, 30], [2, 20], [3, 10], [4, 5]]);
  const wi = Math.floor(Math.random() * S.WEAPONS.length);
  const drops = [];
  const dropDef = (def) => {
    const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 40;
    const it = spawnLoot(chest.x + Math.cos(a) * d, chest.y + Math.sin(a) * d, def);
    drops.push(it); ev({ k: 'lootAdd', l: serializeLoot(it) });
  };
  dropDef({ kind: 'weapon', w: wi, r: rar, ammo: ammoForWeapon(wi) });
  dropDef({ kind: 'ammo', at: S.WEAPONS[wi].ammo, count: S.WEAPONS[wi].ammo === 'heavy' ? 6 : S.WEAPONS[wi].ammo === 'shell' ? 8 : 24 });
  if (Math.random() < 0.55) dropDef({ kind: 'consum', c: roll([['mini', 40], ['shield', 25], ['medkit', 35]]), count: 1 + (Math.random() < 0.35 ? 1 : 0) });
  if (Math.random() < 0.45) dropDef({ kind: 'mats', m: roll([['wood', 40], ['stone', 35], ['metal', 25]]), amount: 30 });
  ev({ k: 'chest', i: chest.id, x: chest.x, y: chest.y, id: p.id });
  // bots: instantly consider
  if (p.bot) {
    for (const d of drops) {
      if (S.dist2(p.x, p.y, d.x, d.y) < 60 * 60 && botWantsItem(p, d)) { if (tryPickup(p, d, true)) removeLoot(d); }
    }
  }
}

function interact(p) {
  if (p.interactCd > 0) return;
  p.interactCd = 0.15;
  // chest first
  let bestChest = null, bd = 62 * 62;
  for (const c of G.chests) {
    if (c.open) continue;
    const d = S.dist2(p.x, p.y, c.x, c.y);
    if (d < bd) { bd = d; bestChest = c; }
  }
  if (bestChest) { openChest(p, bestChest); return; }
  // then loot
  let bestLoot = null; bd = 55 * 55;
  for (const l of G.loot.values()) {
    const d = S.dist2(p.x, p.y, l.x, l.y);
    if (d < bd) { bd = d; bestLoot = l; }
  }
  if (bestLoot && tryPickup(p, bestLoot, true)) { removeLoot(bestLoot); ev({ k: 'pickup', id: p.id, x: bestLoot.x, y: bestLoot.y, k2: bestLoot.kind }); }
}

function dropSelected(p) {
  const s = curSlot(p);
  if (!s || p.sel === 0) return;
  const def = s.kind === 'weapon' ? { kind: 'weapon', w: s.w, r: s.r, ammo: 0 }
    : s.kind === 'consum' ? { kind: 'consum', c: s.c, count: s.count } : null;
  if (!def) return;
  p.slots[p.sel] = null;
  p.useT = 0;
  const it = spawnLoot(p.x + Math.cos(p.input.aim) * 40, p.y + Math.sin(p.input.aim) * 40, def);
  ev({ k: 'lootAdd', l: serializeLoot(it) });
}

function startUse(p) {
  const s = curSlot(p);
  if (!s || s.kind !== 'consum' || p.useT > 0) return;
  const c = S.CONSUM[s.c];
  if (c.heal) { if (p.hp >= S.START_HP) { if (!p.bot) ev({ k: 'full', id: p.id }); return; } }
  else if (p.shield >= c.cap) { if (!p.bot) ev({ k: 'full', id: p.id, sh: true }); return; }
  if (p.reloadT > 0) p.reloadT = 0;
  p.useT = c.time; p.useTotal = c.time;
}
function finishUse(p) {
  const s = curSlot(p);
  if (!s || s.kind !== 'consum') { p.useT = 0; return; }
  const c = S.CONSUM[s.c];
  if (c.heal) p.hp = Math.min(S.START_HP, p.hp + c.heal);
  else p.shield = Math.min(c.cap, p.shield + c.add);
  s.count--;
  if (s.count <= 0) p.slots[p.sel] = null;
  ev({ k: 'used', id: p.id, x: p.x, y: p.y });
}

// ============================================================
//  Bot AI
// ============================================================
function botWantsItem(p, item) {
  if (item.kind === 'ammo' || item.kind === 'mats') return true;
  if (item.kind === 'consum') return true;
  if (item.kind !== 'weapon') return false;
  const score = (w, r) => [2, 3, 3, 4, 3.5][w] * (1 + r * 0.3);
  const myBest = Math.max(1,
    ...p.slots.filter(s => s && s.kind === 'weapon').map(s => score(s.w, s.r)));
  return p.slots.indexOf(null, 1) !== -1 || score(item.w, item.r) > myBest;
}

function botThink(p, dt) {
  const ai = p.ai;
  ai.thinkT -= dt;
  ai.strafeT -= dt; ai.fireT -= dt; ai.pauseT -= dt; ai.reactT -= dt;
  ai.panicWallT -= dt; ai.newWanderT -= dt; ai.lootT -= dt;
  if (ai.thinkT > 0) { botApplyMove(p, dt); return; }
  ai.thinkT = 0.15 + Math.random() * 0.2;

  const inp = p.input;
  inp.fire = false; inp.build = false;

  // --- unstick logic
  const moved = S.dist(p.x, p.y, p.lastX, p.lastY);
  p.lastX = p.x; p.lastY = p.y;
  if (moved < 1.5 && (Math.abs(inp.mx) + Math.abs(inp.my)) > 0.3) ai.stuckT += 0.2; else ai.stuckT = 0;

  // --- find target
  let target = null, td = 1e9;
  for (const q of G.players) {
    if (!q.alive || q === p || effTeam(q) === effTeam(p)) continue;
    const d = S.dist(p.x, p.y, q.x, q.y);
    let maxSee = 640;
    if (d > maxSee) continue;
    // bush hiding
    const inBush = G.obstacles.some(o => o.type === 'bush' && S.dist2(q.x, q.y, o.x, o.y) < 40 * 40);
    if (inBush && d > 130 && (G.matchTime - q.lastShotT) > 2) continue;
    if (!S.clearSeg(p.x, p.y, q.x, q.y, world)) continue;
    if (d < td) { td = d; target = q; }
  }
  if (target && ai.target !== target) {
    ai.target = target;
    ai.reactT = 0.2 + Math.random() * 0.35; // reaction delay
  }
  const fighting = target && ai.reactT <= 0;

  const st = G.storm;
  const distToSafe = S.dist(p.x, p.y, st ? st.tx : S.WORLD / 2, st ? st.ty : S.WORLD / 2);
  const outsideStorm = st && S.dist(p.x, p.y, st.cx, st.cy) > st.r - 60;

  // --- heal when safe
  const hurt = p.hp < 55 || p.shield < 20;
  if (!target && hurt && p.useT <= 0) {
    let idx = -1;
    for (let i = 1; i < 5; i++) {
      const s = p.slots[i];
      if (!s || s.kind !== 'consum') continue;
      const c = S.CONSUM[s.c];
      if (c.heal && p.hp < 70) { idx = i; break; }
      if (!c.heal && p.shield < c.cap - 10) { idx = i; break; }
    }
    if (idx >= 0) { p.sel = idx; startUse(p); }
  }

  if (fighting) {
    ai.mode = 'fight';
    // select best weapon
    let best = -1, bs = -1;
    for (let i = 1; i < 5; i++) {
      const s = p.slots[i];
      if (!s || s.kind !== 'weapon') continue;
      if (s.mag <= 0 && p.ammo[S.WEAPONS[s.w].ammo] <= 0) continue;
      const sc = [2, 3, 3, 4, 3.5][s.w] * (1 + s.r * 0.3);
      if (sc > bs) { bs = sc; best = i; }
    }
    if (best >= 0 && p.sel !== best && p.useT <= 0) { p.sel = best; }
    else if (best === -1) p.sel = 0; // pickaxe rush

    // panic wall
    if (p.hp < 40 && ai.panicWallT <= 0 && p.mats[p.buildMat] >= S.WALL_COST) {
      p.input.aim = Math.atan2(target.y - p.y, target.x - p.x);
      ai.panicWallT = 3;
      tryPlaceWall(p);
    }

    const aimAng = Math.atan2(target.y - p.y, target.x - p.x);
    const err = (Math.random() - 0.5) * 0.16;
    inp.aim = aimAng + err;

    // strafe + range keeping
    const prefRange = (() => {
      const s = curSlot(p);
      if (!s || s.kind !== 'weapon') return 50;
      return { pistol: 260, smg: 220, shotgun: 120, ar: 340, sniper: 480 }[S.WEAPONS[s.w].id] || 260;
    })();
    if (ai.strafeT <= 0) { ai.strafeDir = Math.random() < 0.5 ? 1 : -1; ai.strafeT = 0.7 + Math.random() * 0.9; }
    const perp = aimAng + Math.PI / 2 * ai.strafeDir;
    let mx = Math.cos(perp), my = Math.sin(perp);
    const rangeErr = td - prefRange;
    mx -= Math.cos(aimAng) * S.clamp(rangeErr / 200, -1, 1);
    my -= Math.sin(aimAng) * S.clamp(rangeErr / 200, -1, 1);
    const mag = Math.hypot(mx, my) || 1;
    inp.mx = mx / mag; inp.my = my / mag;

    // fire discipline
    const s = curSlot(p);
    const canFight = s && s.kind === 'weapon' && p.reloadT <= 0 && Math.abs(S.angDiff(inp.aim, aimAng)) < 0.35 && td < S.WEAPONS[s.w].range * 0.9;
    if (canFight) {
      if (ai.pauseT > 0) { inp.fire = false; }
      else {
        inp.fire = true;
        if (ai.fireT <= -0.4 - Math.random() * 0.8) ai.fireT = 0.5 + Math.random() * 0.7;
        if (ai.fireT <= 0) { ai.pauseT = 0.25 + Math.random() * 0.5; ai.fireT = 0; }
      }
    } else if (s && s.kind === 'weapon' && s.mag <= 0) {
      // reload handled automatically by tryFire; keep moving
    }
    if (ai.stuckT > 0.6) { inp.mx = -inp.mx; inp.my = -inp.my; ai.stuckT = 0.2; }
    botApplyMove(p, dt);
    return;
  }

  // --- no target: storm safety first
  if (outsideStorm || (st && distToSafe > st.tr * 0.85)) {
    ai.mode = 'storm';
    const a = Math.atan2(st.ty - p.y, st.tx - p.x) + (Math.random() - 0.5) * 0.6;
    inp.aim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
  } else {
    // --- loot seeking
    let goal = null, gd = 1e9;
    if (ai.lootT <= 0) {
      ai.lootT = 1.2;
      for (const l of G.loot.values()) {
        if (!botWantsItem(p, l)) continue;
        const d = S.dist2(p.x, p.y, l.x, l.y);
        if (d < gd && d < 600 * 600) { gd = d; goal = { x: l.x, y: l.y }; }
      }
      if (!goal) for (const c of G.chests) {
        if (c.open) continue;
        const d = S.dist2(p.x, p.y, c.x, c.y);
        if (d < gd && d < 700 * 700) { gd = d; goal = { x: c.x, y: c.y }; }
      }
      ai.goal = goal;
    } else goal = ai.goal;

    if (goal && S.dist(p.x, p.y, goal.x, goal.y) > 50) {
      ai.mode = 'loot';
      const a = Math.atan2(goal.y - p.y, goal.x - p.x);
      inp.aim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
      // grab nearby wanted loot; if pockets full, swap out weakest weapon
      if (p.slots.indexOf(null, 1) === -1) {
        let wi2 = -1, ws2 = 1e9;
        for (let i2 = 1; i2 < 5; i2++) {
          const s2 = p.slots[i2];
          if (s2 && s2.kind === 'weapon') { const sc2 = [2, 3, 3, 4, 3.5][s2.w] * (1 + s2.r * 0.3); if (sc2 < ws2) { ws2 = sc2; wi2 = i2; } }
        }
        if (wi2 >= 0) p.sel = wi2;
      }
      for (const l of [...G.loot.values()]) {
        if (S.dist2(p.x, p.y, l.x, l.y) > 42 * 42) continue;
        if (!botWantsItem(p, l)) continue;
        if (tryPickup(p, l, true)) removeLoot(l);
      }
      // open nearby chests
      for (const c of G.chests) if (!c.open && S.dist2(p.x, p.y, c.x, c.y) < 55 * 55) { openChest(p, c); break; }
    } else {
      ai.mode = 'wander';
      if (ai.newWanderT <= 0 || S.dist(p.x, p.y, ai.wx, ai.wy) < 60) {
        ai.newWanderT = 4 + Math.random() * 4;
        const st2 = G.storm;
        const rr = Math.max(100, (st2 ? st2.tr : 800) * 0.7);
        const a = Math.random() * Math.PI * 2, d = Math.random() * rr;
        ai.wx = S.clamp((st2 ? st2.tx : S.WORLD / 2) + Math.cos(a) * d, 60, S.WORLD - 60);
        ai.wy = S.clamp((st2 ? st2.ty : S.WORLD / 2) + Math.sin(a) * d, 60, S.WORLD - 60);
      }
      const a = Math.atan2(ai.wy - p.y, ai.wx - p.x);
      inp.aim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
    }
  }
  // no weapon after a while → "find" one (keeps bots threatening)
  if (G.matchTime > 25 && !p.slots.some(s => s && s.kind === 'weapon')) {
    const wi = Math.floor(Math.random() * 3); // pistol/smg/shotgun
    const empty = p.slots.indexOf(null, 1);
    if (empty === -1) { /* full of consumables: replace slot 1 */ }
    const idx = empty !== -1 ? empty : 1;
    p.slots[idx] = { kind: 'weapon', w: wi, r: Math.floor(Math.random() * 2), mag: S.WEAPONS[wi].mag };
    p.ammo[S.WEAPONS[wi].ammo] += 60;
  }
  // gentle ammo trickle so bots don't run dry
  const cs = curSlot(p);
  if (cs && cs.kind === 'weapon') {
    const at = S.WEAPONS[cs.w].ammo;
    if (p.ammo[at] < 10) p.ammo[at] += 1;
  }
  if (ai.stuckT > 0.6) { const t = inp.mx; inp.mx = -inp.my; inp.my = t; ai.stuckT = 0.2; }
  botApplyMove(p, dt);
}

function botApplyMove(p, dt) {
  // normalize
  const inp = p.input;
  const m = Math.hypot(inp.mx, inp.my);
  if (m > 1) { inp.mx /= m; inp.my /= m; }
}

// ============================================================
//  Main tick
// ============================================================
function updateStorm(dt) {
  const st = G.storm;
  if (!st || NO_STORM) return;
  if (st.phase === -1) {
    st.t -= dt;
    if (st.t <= 0) {
      st.phase = 0;
      const ph = stormPhases[0];
      st.t = ph.wait; st.shrinking = false; st.dps = 0;
      pickNextCircle(st, ph);
      ev({ k: 'stormMsg', phase: 0, msg: 'The Fade is forming!' });
    }
    return;
  }
  const ph = stormPhases[Math.min(st.phase, stormPhases.length - 1)];
  st.t -= dt;
  if (!st.shrinking) {
    if (st.t <= 0) {
      st.shrinking = true;
      st.t = ph.shrink;
      st.fx = st.cx; st.fy = st.cy; st.fr = st.r;
      ev({ k: 'stormMsg', phase: st.phase, msg: 'The Fade is closing in!' });
    }
  } else {
    const k = Math.min(1, Math.max(0, 1 - st.t / ph.shrink));
    st.cx = st.fx + (st.tx - st.fx) * k;
    st.cy = st.fy + (st.ty - st.fy) * k;
    st.r = st.fr + (st.tr - st.fr) * k;
    st.dps = ph.dps;
    if (st.t <= 0) {
      st.cx = st.tx; st.cy = st.ty; st.r = st.tr;
      st.dps = ph.dps;
      const done = st.phase >= stormPhases.length - 1;
      if (!done) {
        st.phase++;
        const np = stormPhases[st.phase];
        st.t = np.wait; st.shrinking = false;
        pickNextCircle(st, np);
      } else {
        st.t = 999;      // fully closed
        st.shrinking = false;
        st.dps = ph.dps; // keep final dps ticking on anyone outside r=0
      }
    }
  }
}
function pickNextCircle(st, ph) {
  const maxOff = Math.max(0, st.r - ph.r);
  const a = Math.random() * Math.PI * 2;
  const d = Math.random() * maxOff * 0.8;
  st.tx = S.clamp(st.cx + Math.cos(a) * d, ph.r + 40, S.WORLD - ph.r - 40);
  st.ty = S.clamp(st.cy + Math.sin(a) * d, ph.r + 40, S.WORLD - ph.r - 40);
  st.tr = ph.r;
}

function updateBullets(dt) {
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const b = G.bullets[i];
    let dist = Math.hypot(b.vx, b.vy) * dt;
    let steps = Math.max(1, Math.ceil(dist / 16));
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      b.x += b.vx * dt / steps; b.y += b.vy * dt / steps;
      b.traveled += dist / steps;
      if (b.x < 0 || b.y < 0 || b.x > S.WORLD || b.y > S.WORLD || b.traveled >= b.range) { dead = true; break; }
      // players
      for (const q of G.players) {
        if (!q.alive || q.ph !== S.PH.ground || q.id === b.owner || effTeam(q) === b.team) continue;
        if (S.dist2(b.x, b.y, q.x, q.y) < (S.PLAYER_R + 4) ** 2) {
          const owner = G.players.find(p => p.id === b.owner);
          damagePlayer(q, b.dmg, owner, S.WEAPONS[b.wi].id);
          ev({ k: 'hit', x: b.x, y: b.y });
          dead = true; break;
        }
      }
      if (dead) break;
      // walls
      const gx = Math.floor(b.x / S.GRID), gy = Math.floor(b.y / S.GRID);
      const w = world.wallAt(gx, gy);
      if (w) {
        const owner = G.players.find(p => p.id === b.owner);
        damageWall(w, b.dmg, owner);
        ev({ k: 'hit', x: b.x, y: b.y });
        dead = true; break;
      }
      // obstacles
      for (const o of world.obstaclesNear(b.x, b.y, 40)) {
        if (o.type === 'bush' || o.type === 'water') continue;
        if (S.dist2(b.x, b.y, o.x, o.y) < o.r * o.r) { ev({ k: 'hit', x: b.x, y: b.y, wood: o.type === 'tree' }); dead = true; break; }
      }
    }
    if (dead) G.bullets.splice(i, 1);
  }
}

function processPlayer(p, dt) {
  if (!p.alive) return;
  // pending actions
  const acts = p.pending; p.pending = [];
  for (const a of acts) {
    if (a.a === 'jump') { startFall(p); continue; }
    if (p.ph !== S.PH.ground) continue;   // no item actions on the bus or in the air
    switch (a.a) {
      case 'select': {
        const i = a.i | 0;
        if (i >= 0 && i < 5 && (i === 0 || p.slots[i])) {
          if (p.sel !== i) { p.sel = i; p.reloadT = 0; p.useT = 0; }
        }
        break;
      }
      case 'reload': startReload(p); break;
      case 'interact': interact(p); break;
      case 'drop': dropSelected(p); break;
      case 'mat': if (S.MATS.includes(a.m)) p.buildMat = a.m; break;
    }
  }

  // riding the bus or skydiving: no ground logic
  if (p.ph === S.PH.bus) { followBus(p); return; }
  if (p.ph === S.PH.fall) { updateFall(p, dt); return; }

  const inp = p.input;
  // timers
  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.swingCd > 0) p.swingCd -= dt;
  if (p.placeCd > 0) p.placeCd -= dt;
  if (p.interactCd > 0) p.interactCd -= dt;
  if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) finishReload(p); }
  if (p.useT > 0) { p.useT -= dt; if (p.useT <= 0) finishUse(p); }

  // movement
  let sp = S.SPEED * (p.useT > 0 ? S.SPEED_USE : 1);
  let mx = inp.mx, my = inp.my;
  const mag = Math.hypot(mx, my);
  if (mag > 1) { mx /= mag; my /= mag; }
  // accelerate / decelerate toward the input direction, then move by the resulting velocity
  const [vx, vy] = S.stepVel(p.vx || 0, p.vy || 0, mx * sp, my * sp, dt);
  p.vx = vx; p.vy = vy;
  if (vx || vy) {
    const [nx, ny] = S.moveCircle(p.x, p.y, S.PLAYER_R, vx * dt, vy * dt, world);
    p.x = nx; p.y = ny;
  }
  p.aim = inp.aim;

  // firing / building / pickaxe
  if (inp.fire && G.state === 'active') {
    if (inp.build) tryPlaceWall(p);
    else if (p.sel === 0) pickaxeSwing(p);
    else {
      const s = curSlot(p);
      if (s && s.kind === 'weapon') tryFire(p);
      else if (s && s.kind === 'consum') startUse(p);
    }
  }

  // auto pickup
  autoPickup(p);

  // storm damage
  const st = G.storm;
  if (st && st.dps > 0 && S.dist(p.x, p.y, st.cx, st.cy) > st.r) {
    p.stormAcc += st.dps * dt;
    if (p.stormAcc >= 1) {
      const d = Math.floor(p.stormAcc);
      p.stormAcc -= d;
      p.hp -= d;
      if (p.hp <= 0) killPlayer(p, null, 'storm');
    }
  }
}

function buildSnapshot() {
  const ps = [];
  for (const p of G.players) {
    if (!p.alive) continue;
    const s = curSlot(p);
    let wv = -1;
    if (p.input.build) wv = 6;
    else if (p.sel === 0) wv = -1;
    else if (s && s.kind === 'weapon') wv = s.w;
    else wv = 5;
    ps.push([
      p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10,
      Math.round(p.aim * 100) / 100, Math.round(p.hp), Math.round(p.shield),
      p.team, wv, (Math.abs(p.input.mx) + Math.abs(p.input.my)) > 0.1 ? 1 : 0,
      p.useT > 0 ? 1 : 0, p.kills, p.ph, Math.round(p.alt * 100),
    ]);
  }
  const st = G.storm;
  const bus = G.state === 'bus' && G.bus ? busPos() : null;
  return {
    t: 'snap', tm: Math.round(G.matchTime),
    p: ps,
    bus: bus ? { x: Math.round(bus.x), y: Math.round(bus.y), a: Math.round(G.bus.a * 1000) / 1000 } : null,
    st: (G.state === 'active' && st) ? {
      x: Math.round(st.cx), y: Math.round(st.cy), r: Math.round(st.r),
      nx: Math.round(st.tx), ny: Math.round(st.ty), nr: Math.round(st.tr),
      ph: st.phase, sh: st.shrinking ? 1 : 0, dps: st.dps,
      t: Math.round(Math.max(0, st.t)),
    } : null,
    alive: G.aliveCount,
  };
}

function tick() {
  try {
    const dt = DT;
    if (G.state === 'lobby') {
      // spawn island: players walk around while the countdown runs
      for (const c of clients.values()) if (!c.player) stepIslandClient(c, dt);
      broadcastIsland();
      if (clients.size > 0) {
        G.countdown -= dt;
        if (G.countdown <= 0) startMatch();
      }
    } else if (G.state === 'bus' || G.state === 'active') {
      if (G.state === 'active') G.matchTime += dt;
      else G.bus.t += dt;
      if (G.state === 'active') updateStorm(dt);
      for (const p of G.players) {
        if (!p.alive) continue;
        if (p.bot) { if (p.ph === S.PH.ground) botThink(p, dt); else botAir(p, dt); }
        processPlayer(p, dt);
      }
      if (G.state === 'bus') {
        if (G.bus.t >= G.bus.dur) {
          // anyone still aboard is dropped at the end of the route
          for (const p of G.players) if (p.alive && p.ph === S.PH.bus) startFall(p);
          G.state = 'active';
          ev({ k: 'live' });
          log('Battle Bus route complete: match is live');
        }
      } else {
        updateBullets(dt);
        // everyone gone?
        const humans = [...clients.values()].filter(c => c.player);
        if (humans.length === 0 && G.matchTime > 3) {
          const t = new Set(); for (const p of G.players) if (p.alive) t.add(effTeam(p));
          endMatch(t.size ? [...t][0] : null);
        } else if (G.aliveCount <= 1 || G.matchTime > 60 * 12) {
          const t = new Set(); for (const p of G.players) if (p.alive) t.add(effTeam(p));
          endMatch(t.size ? [...t][0] : null);
        }
      }
    } else if (G.state === 'end') {
      G.endTimer -= dt;
      if (G.endTimer <= 0) resetToLobby();
    }

    // flush events
    if (evQueue.length) {
      for (const e of evQueue) broadcast({ t: 'ev', ...e });
      evQueue = [];
    }
    // snapshot (bus and match)
    if (G.state === 'active' || G.state === 'bus') {
      const snap = buildSnapshot();
      const s = JSON.stringify(snap);
      for (const c of clients.values()) {
        if (!c.ws || c.ws.closed) continue;
        c.ws.send(s);
        // private state
        const p = c.player;
        if (p) {
          const slotData = p.slots.map((sl, i) => {
            if (!sl) return null;
            if (sl.kind === 'pickaxe') return { k: 'pick' };
            if (sl.kind === 'weapon') return { k: 'w', w: sl.w, r: sl.r, mag: sl.mag };
            return { k: 'c', c: sl.c, n: sl.count };
          });
          sendTo(c, {
            t: 'you',
            hp: Math.round(p.hp), sh: Math.round(p.shield),
            mats: p.mats, ammo: p.ammo, slots: slotData, sel: p.sel,
            reload: p.reloadT > 0 ? p.reloadT / p.reloadTotal : 0,
            use: p.useT > 0 ? 1 - p.useT / p.useTotal : 0,
            build: p.input.build, bmat: p.buildMat,
            alive: p.alive, kills: p.kills, place: p.placement,
          });
        }
      }
    }
  } catch (e) {
    console.error('TICK ERROR', e);
  }
}

// ============================================================
//  WebSocket connection handling
// ============================================================
const NAME_RE = /[^\p{L}\p{N} _\-!.]/gu;
function sanitizeName(n) {
  n = String(n || '').replace(NAME_RE, '').trim().slice(0, 16);
  return n || 'Player';
}


// ============================================================
//  Socket handling: conn = { send(str), ping(), slow(), closed, _close(), onmessage, onclose }
// ============================================================
function acceptSocket(conn) {
  let client = null;

  conn.onmessage = (str) => {
    if (str.length > 4096) return;
    let msg;
    try { msg = JSON.parse(str); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (!client) {
      if (msg.t === 'hello') {
        client = {
          id: nextEntityId++, ws: conn, name: sanitizeName(msg.name),
          team: 0, modeChoice: 'solo', player: null,
          lx: S.ISLAND.x, ly: S.ISLAND.y, la: 0, li: null,
        };
        spawnOnIsland(client);
        clients.set(client.id, client);
        conn.onclose = () => {
          if (client) {
            clients.delete(client.id);
            const p = client.player;
            if (p && p.alive && (G.state === 'active' || G.state === 'bus')) killPlayer(p, null, 'left');
            if (p) p.alive = false;
            client.player = null;
            broadcastLobby();
            log(`Client left: ${client.name} (${clients.size} connected)`);
          }
        };
        log(`Client joined: ${client.name} (${clients.size} connected)`);
        sendTo(client, { t: 'welcome', id: client.id, state: G.state, ver: 1 });
        if (G.state === 'bus' || G.state === 'active' || G.state === 'end') {
          sendTo(client, startMsg(null));
          sendTo(client, lobbyState());
        } else {
          broadcastLobby();
        }
      }
      return;
    }

      switch (msg.t) {
      case 'mode': {
        client.modeChoice = (msg.m === 'duo') ? 'duo' : 'solo';
        broadcastLobby();
        break;
      }
      case 'team': {
        const t = msg.team | 0;
        if (t === 0) { client.team = 0; broadcastLobby(); break; }
        if (t >= 1 && t <= S.PICKABLE_TEAMS && lobbyMode() === 'duo') {
          const n = [...clients.values()].filter(c => c.team === t).length;
          if (n < 2) { client.team = t; broadcastLobby(); }
        }
        break;
      }
      case 'input': {
        const p = client.player;
        if (!p) {
          // spawn island: walking only, no shooting or building
          client.li = { x: S.clamp(+msg.x || 0, -1, 1), y: S.clamp(+msg.y || 0, -1, 1), aim: +msg.aim || 0 };
          break;
        }
        if (!p.alive) return;
        const i = p.input;
        i.mx = S.clamp(+msg.x || 0, -1, 1);
        i.my = S.clamp(+msg.y || 0, -1, 1);
        i.aim = +msg.aim || 0;
        i.fire = !!msg.f;
        i.build = !!msg.b;
        break;
      }
      case 'act': {
        const p = client.player;
        if (!p || !p.alive || !msg.a) return;
        if (p.pending.length < 16) p.pending.push(msg);
        break;
      }
    }
  };
}

// ============================================================
//  Timers: start() when the first player connects, stop() when the room empties
// ============================================================
let timers = [];
function start() {
  if (timers.length) return;
  timers.push(setInterval(keepalive, 30000));
  timers.push(setInterval(tick, TICK_MS));
}
function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
function keepalive() {
  for (const c of clients.values()) {
    if (!c.ws || c.ws.closed) continue;
    c.ws.ping();
    if (c.ws.slow && c.ws.slow()) c.ws._close(); // very slow client
  }
}

return { acceptSocket, start, stop, clientCount: () => clients.size, stateName: () => G.state };
}

module.exports = { createGame };
