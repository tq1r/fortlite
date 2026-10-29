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
const MODE = opts.mode === 'duo' ? 'duo' : 'solo';   // this room's mode: duo rooms hold parties of two only
const onMatchEnd = typeof opts.onMatchEnd === 'function' ? opts.onMatchEnd : null;   // reports human results (accounts)
const onLobby = typeof opts.onLobby === 'function' ? opts.onLobby : null;           // tells the matchmaker whether this room takes players

const TICK_MS = 50;
const DT = TICK_MS / 1000;
const LOBBY_CD = FAST ? 4 : S.LOBBY_COUNTDOWN;
const END_TIME = FAST ? 3 : S.END_TIME;
const STORM_CFG = S.STORM;
const stormPhases = FAST
  ? STORM_CFG.phases.map(p => ({ wait: p.wait / 12, shrink: p.shrink / 12, r: p.r, dps: p.dps }))   // fast test rounds: the storm ends in about 100 s
  : STORM_CFG.phases;
const STORM_GRACE = FAST ? 4 : STORM_CFG.grace;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);


// ============================================================
//  Game state
// ============================================================
let nextEntityId = 1;
let lobbyAcc = 0;           // seconds since the last lobby message
const clients = new Map();   // id -> client {id, ws, name, team, player|null, lastMsgT}
const G = {
  state: 'lobby',            // lobby (spawn island) | bus (battle bus flight) | active | end
  countdown: LOBBY_CD,
  endTimer: 0,
  matchTime: 0,
  bus: null,                 // {sx,sy,dx,dy,len,speed,dur,t,a}
  pois: [],                  // named points of interest {id,n,k,x,y,r}
  roads: [],                 // road polylines {pts: [[x,y],...]}
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
// The map: an island in a sea. Biomes (snow, forest, desert, swamp, plains) come from
// S.biomeAt, which the client also uses to draw the ground. Here we place POIs on land,
// connect them with roads, run rivers from the mountains to the sea (with bridges where
// they cross roads), and scatter trees, rocks and bushes in biome-weighted clusters.
// Roads and building areas are kept clear of obstacles, so the map reads clearly.
const ROAD_HALF = 26;   // road half-width (drawn 52 px wide)

function genMap(seed) {
  const rand = S.mulberry32(seed);
  G.obstacles = []; G.obstacleById = new Map(); G.walls = new Map();
  G.chests = []; G.loot = new Map(); G.floors = []; G.bullets = []; G.roads = [];
  const W = S.WORLD;
  const AREA = (W / 4200) ** 2;   // density reference: the old 4200 map

  // ---- spatial index for placement checks (obstacles only exist here while generating)
  const CELL = 200, MAX_R = 130;
  const grid = new Map();
  const ckey = (cx, cy) => cx * 100003 + cy;
  const nearObs = (x, y, rad) => {
    const out = [];
    const cx0 = Math.floor((x - rad) / CELL), cx1 = Math.floor((x + rad) / CELL);
    const cy0 = Math.floor((y - rad) / CELL), cy1 = Math.floor((y + rad) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const b = grid.get(ckey(cx, cy));
      if (b) for (const o of b) out.push(o);
    }
    return out;
  };

  // ---- roads: polylines, kept clear of obstacles
  const roadSegs = [];
  const roadDist = (x, y) => {
    let best = 1e9;
    for (const [x1, y1, x2, y2] of roadSegs) {
      const vx = x2 - x1, vy = y2 - y1;
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / l2));
      const d = Math.hypot(x - (x1 + vx * t), y - (y1 + vy * t));
      if (d < best) best = d;
    }
    return best;
  };

  const nearestRoadPoint = (x, y) => {
    let best = 1e18, bx = x, by = y;
    for (const [x1, y1, x2, y2] of roadSegs) {
      const vx = x2 - x1, vy = y2 - y1;
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / l2));
      const px = x1 + vx * t, py = y1 + vy * t, d = S.dist2(x, y, px, py);
      if (d < best) { best = d; bx = px; by = py; }
    }
    return [bx, by];
  };
  // POIs are kept clear of trees and rocks so each named place reads as a place
  const nearPoi = (x, y) => G.pois.some(p => S.dist2(p.x, p.y, x, y) < (p.r + 60) ** 2);

  const okSpot = (x, y, r, minDist) => {
    if (x < 80 + r || y < 80 + r || x > W - 80 - r || y > W - 80 - r) return false;
    if (S.coastDist(x, y) < r + 40) return false;
    if (roadDist(x, y) < r + ROAD_HALF + 34) return false;
    if (G.walls.has(S.wallKey(Math.floor(x / S.GRID), Math.floor(y / S.GRID)))) return false;
    for (const o of nearObs(x, y, r + minDist + MAX_R)) {
      if (S.dist2(x, y, o.x, o.y) < (minDist + o.r) ** 2) return false;
    }
    return true;
  };
  const addObs = (type, x, y, r, hp, mat) => {
    const o = { id: nextEntityId++, type, x, y, r, hp, maxHp: hp, mat: mat || null };
    G.obstacles.push(o); G.obstacleById.set(o.id, o);
    const k = ckey(Math.floor(x / CELL), Math.floor(y / CELL));
    let b = grid.get(k); if (!b) { b = []; grid.set(k, b); } b.push(o);
    return o;
  };

  // ---- the hand-made layout (map_layout.js): places, roads and buildings are authored, not random
  const LAYOUT = require('./map_layout.js');
  const WALL_MAT = { castle: 'stone', ruins: 'stone', industrial: 'metal' };
  const PROP_OBS = { X: ['crate', 26, 250, 'metal'], T: ['tree', 26, 200, 'wood'], R: ['rock', 30, 250, 'stone'], B: ['bush', 28, 999, null], P: ['water', 34, 1, null] };
  const placed = LAYOUT.POIS.map(def => {
    const rows = LAYOUT.turnPlan(LAYOUT.compilePOI(def).rows, def.rot);
    const cols = Math.max(...rows.map(r => r.length));
    return { def, rows, cols, gx0: Math.round(def.x / S.GRID) - Math.floor(cols / 2), gy0: Math.round(def.y / S.GRID) - Math.floor(rows.length / 2) };
  });
  G.pois = placed.map((pl, i) => ({ id: i, n: pl.def.n, k: pl.def.k, x: pl.def.x, y: pl.def.y, r: Math.round(Math.max(pl.cols, pl.rows.length) * 30 + 110) }));
  for (const rd of LAYOUT.ROADS) {
    G.roads.push({ pts: rd.map(p => [Math.round(p[0]), Math.round(p[1])]) });
    for (let i = 0; i + 1 < rd.length; i++) roadSegs.push([rd[i][0], rd[i][1], rd[i + 1][0], rd[i + 1][1]]);
  }
  for (const pl of placed) {
    const mat = WALL_MAT[pl.def.k] || 'wood';
    const hp = S.MAT_HP[mat] * 2.5;
    for (let r = 0; r < pl.rows.length; r++) {
      let run = -1;
      for (let c = 0; c <= pl.cols; c++) {
        const ch = c < pl.cols ? (pl.rows[r][c] || ' ') : ' ';
        const gx = pl.gx0 + c, gy = pl.gy0 + r;
        const wx = gx * S.GRID + S.GRID / 2, wy = gy * S.GRID + S.GRID / 2;
        if (ch === '#') G.walls.set(S.wallKey(gx, gy), { gx, gy, mat, hp, maxHp: hp, prebuilt: true });
        if (ch === 'C' || ch === 'L') G.chests.push({ id: nextEntityId++, x: wx, y: wy, open: false, legendary: ch === 'L' });
        if (PROP_OBS[ch]) { const o = PROP_OBS[ch]; addObs(o[0], wx, wy, o[1], o[2], o[3]); }
        const isFloor = ch === '.' || ch === 'D' || ch === 'C' || ch === 'L';
        if (isFloor && run < 0) run = c;
        if (!isFloor && run >= 0) { G.floors.push({ x: (pl.gx0 + run) * S.GRID, y: gy * S.GRID, w: (c - run) * S.GRID, h: S.GRID, mat }); run = -1; }
      }
    }
  }

  // ---- lakes and rivers (water is impassable; bridges where roads cross)
  const bridgeNear = (x, y) => roadDist(x, y) < ROAD_HALF + 22;
  const onBuilding = (x, y) => G.floors.some(f => x > f.x - 40 && x < f.x + f.w + 40 && y > f.y - 40 && y < f.y + f.h + 40);
  const nLakes = Math.round(6 * AREA / 5.7) + 2;
  let lakesMade = 0;
  for (let t = 0; t < 400 && lakesMade < nLakes; t++) {
    const lx = rand() * W, ly = rand() * W;
    if (!S.isLand(lx, ly) || S.coastDist(lx, ly) < 500) continue;
    if (bridgeNear(lx, ly) || onBuilding(lx, ly)) continue;
    if (S.biomeAt(lx, ly) === 'desert' || S.biomeAt(lx, ly) === 'snow') continue;
    const nBlobs = 4 + Math.floor(rand() * 5);
    for (let b = 0; b < nBlobs; b++) {
      const a = rand() * Math.PI * 2, d = rand() * 130;
      const x = lx + Math.cos(a) * d, y = ly + Math.sin(a) * d;
      if (roadDist(x, y) < ROAD_HALF + 60) continue;
      addObs('water', x, y, 55 + rand() * 45, 1, null);
    }
    lakesMade++;
  }
  // rivers start in the north mountains and run down to the sea
  const nRivers = 2;
  for (let rv = 0; rv < nRivers; rv++) {
    let sx = 0, sy = 0, ok = false;
    for (let t = 0; t < 2000 && !ok; t++) {
      sx = rand() * W; sy = rand() * W;
      ok = S.biomeAt(sx, sy) === 'snow' && S.coastDist(sx, sy) > 900 && roadDist(sx, sy) > 300;
    }
    if (!ok) continue;
    // flow direction: outward from the island centre, with a slow wobble
    const base = Math.atan2(sy - S.LAND.cy, sx - S.LAND.cx);
    const wob = rand() * 6.28, amp = 0.35 + rand() * 0.3;
    let x = sx, y = sy;
    for (let step = 0; step < 400; step++) {
      if (!S.isLand(x, y) && step > 10) break;
      if (S.coastDist(x, y) < 0) break;
      const a = base + Math.sin(step * 0.08 + wob) * amp * 0.4;
      if (!bridgeNear(x, y) && !onBuilding(x, y)) addObs('water', x, y, 34, 1, null);
      x += Math.cos(a) * 60; y += Math.sin(a) * 60;
      if (x < 0 || y < 0 || x > W || y > W) break;
    }
  }

  // ---- trees, rocks, bushes: clustered by biome
  // cluster seeds make forests, mountain ranges and bush patches instead of an even scatter
  const seeds = (kind, count, sigma) => {
    const out = [];
    for (let t = 0; t < count * 60 && out.length < count; t++) {
      const x = rand() * W, y = rand() * W;
      if (!S.isLand(x, y) || S.coastDist(x, y) < 300) continue;
      if (S.biomeAt(x, y) === kind) out.push({ x, y, s: sigma });
    }
    return out;
  };
  const forestSeeds = seeds('forest', 26, 520);
  const mountainSeeds = seeds('snow', 18, 420);
  const bushSeeds = seeds('plains', 30, 340);
  const clusterW = (list, x, y) => {
    let w = 0;
    for (const s of list) { const d2 = S.dist2(x, y, s.x, s.y); w += Math.exp(-d2 / (2 * s.s * s.s)); }
    return Math.min(1, w);
  };
  const TREE_P = { forest: 1.0, plains: 0.22, swamp: 0.6, desert: 0.05, snow: 0.08 };
  const ROCK_P = { snow: 1.0, desert: 0.45, plains: 0.1, forest: 0.07, swamp: 0.05 };
  const BUSH_P = { plains: 0.6, forest: 0.45, swamp: 0.4, desert: 0.12, snow: 0.03 };

  const scatterByBiome = (type, target, r0, r1, hp, mat, probs, weightFn, tries, minD = 36) => {
    let placed = 0;
    for (let t = 0; t < tries && placed < target; t++) {
      const x = 120 + rand() * (W - 240), y = 120 + rand() * (W - 240);
      if (!S.isLand(x, y)) continue;
      const p = (probs[S.biomeAt(x, y)] || 0) * weightFn(x, y);
      if (rand() > p) continue;
      const r = r0 + rand() * (r1 - r0);
      if (nearPoi(x, y) || !okSpot(x, y, r, minD)) continue;
      if (G.floors.some(f => x > f.x - 30 && x < f.x + f.w + 30 && y > f.y - 30 && y < f.y + f.h + 30)) continue;
      addObs(type, x, y, r, hp, mat); placed++;
    }
    return placed;
  };
  const treeTarget = Math.round(70 * AREA);
  scatterByBiome('tree', treeTarget, 24, 30, 200, 'wood', TREE_P, (x, y) => 0.12 + 0.88 * clusterW(forestSeeds, x, y), 400000, 62);
  scatterByBiome('rock', Math.round(16 * AREA), 30, 34, 250, 'stone', ROCK_P, (x, y) => 0.25 + 0.75 * clusterW(mountainSeeds, x, y), 300000);
  // mountain boulders: larger rocks in the snow
  scatterByBiome('rock', Math.round(10 * AREA), 58, 96, 420, 'stone', { snow: 1.0 }, (x, y) => 0.2 + 0.8 * clusterW(mountainSeeds, x, y), 200000);
  scatterByBiome('bush', Math.round(40 * AREA), 28, 32, 999, null, BUSH_P, (x, y) => 0.2 + 0.8 * clusterW(bushSeeds, x, y), 300000);

  // open-field chests and crates
  for (let i = 0; i < Math.round(5 * AREA); i++) {   // few open-field chests: gear is found by searching
    for (let tries = 0; tries < 300; tries++) {
      const x = 160 + rand() * (W - 320), y = 160 + rand() * (W - 320);
      if (okSpot(x, y, 34, 60)) { G.chests.push({ id: nextEntityId++, x, y, open: false }); break; }
    }
  }
  scatterByBiome('crate', Math.round(16 * AREA), 26, 26, 250, 'metal', { plains: 1, forest: 0.6, swamp: 0.6, desert: 1, snow: 0.6 }, () => 1, 100000);

  // floor loot
  const roll = (arr) => { let t = 0; for (const a of arr) t += a[1]; let r = rand() * t; for (const a of arr) { r -= a[1]; if (r <= 0) return a[0]; } return arr[0][0]; };
  const floorRarity = () => roll([[0, 50], [1, 30], [2, 15], [3, 5]]);
  const nFloor = Math.round(18 * AREA);   // loose gear on the ground is scarce: most gear comes from chests, POIs and kills
  for (let i = 0; i < nFloor; i++) {
    let tries = 0;
    while (tries++ < 300) {
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
// headwear id -> small number for the wire: 0 = none, else 1 + index in S.HEADS
function headIndex(id) { const i = S.HEADS.findIndex(h => h.id === id); return i < 0 ? 0 : i + 1; }
function clampOutfit(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < S.OUTFITS.length ? n : 0;
}

function makePlayer(id, name, team, isBot) {
  return {
    id, name, team, bot: isBot, outfit: 0, head: 0,
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
    kn: false, knT: 0, knBy: null, knGrace: 0, revT: 0, revSeen: -9,   // knocked (duo): bleed timer, revive progress
    stuckT: 0, lastX: 0, lastY: 0,
    ph: S.PH.ground, fallT: 0, alt: 0, fallVx: 0, fallVy: 0, vx: 0, vy: 0,
  };
}
// ---- bot brain ---------------------------------------------------------
// Each bot gets its own temperament so they do not all play the same way.
// It only knows what it can see (line of sight, bush cover), remembers where it
// last saw an enemy, turns at a limited speed, leads moving targets, fires in
// bursts with short pauses, dodges when shot, backs off when hurt and searches
// the last known spot.
function botSkill() {
  const r = Math.random;
  // skill tier: many bots are rough, most are normal, some are sharp (they win the fights they start)
  const t = r();
  const k = t < 0.25 ? 0.7 : t < 0.8 ? 1 : 1.35;
  return {
    k,
    aimSpeed: (3.0 + r() * 3.0) * (0.85 + 0.15 * k),  // rad/s: how fast it turns onto a target
    jitter: (0.03 + r() * 0.08) / k,                   // aim wobble (radians) re-rolled each think
    react: (0.35 + r() * 0.5) / k,                     // seconds before it fires at a newly seen enemy
    err: 9 / k,                                        // position estimate error in px per 100 px of distance
    lead: 0.5 + r() * 0.5,                             // how much it leads a moving target
    aggro: r(),                                        // 0 cautious .. 1 aggressive
    strafeHold: 0.8 + r() * 1.4,                       // average seconds between strafe direction changes
    build: (0.4 + r() * 0.6) * k,                      // how often it throws up cover in a fight
  };
}
function newBotAI() {
  return {
    mode: 'wander', thinkT: Math.random() * 0.3,
    jumpS: undefined, poi: null, drop: null,
    skill: botSkill(),
    target: null, reactT: 0,
    mem: null,                    // last seen enemy: {x, y, vx, vy, t}
    hitBy: null, hitT: -99,       // who last damaged this bot, and when
    curAim: Math.random() * Math.PI * 2, desAim: 0, fireTol: 0.15,
    wantFire: false, burstT: 0.6, pauseT: 0,
    strafeDir: 1, strafeT: 0, dodgeCd: 0,
    panicWallT: 0, lootT: 0, goal: null,
    idleT: 0, wx: 0, wy: 0, newWanderT: 0,
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

function lobbyMode() { return MODE; }

function lobbyState(forClient) {
  const players = [];
  for (const c of clients.values()) players.push({ id: c.id, name: c.name, team: c.team, bot: false, party: !!c.party, outfit: c.outfit || 0, head: c.head || 0 });
  return {
    t: 'lobby', state: G.state, cd: Math.max(0, Math.ceil(G.countdown)),
    players, maxPlayers: S.MAX_PLAYERS, mode: lobbyMode(),
    waiting: !!forClient && G.state !== 'lobby' && !forClient.player,
  };
}
// each client gets its own lobby state: a client who joined while a match is running
// is told it is waiting for the next match (it is not dropped into spectating)
function broadcastLobby() { for (const c of clients.values()) sendTo(c, lobbyState(c)); }
function reportLobby() {
  if (!onLobby) return;
  onLobby({ state: G.state, players: clients.size, cd: Math.max(0, Math.ceil(G.countdown)), max: S.MAX_PLAYERS });
}

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
      chests: G.chests.map(c => ({ i: c.id, x: Math.round(c.x), y: Math.round(c.y), open: c.open, lg: c.legendary ? 1 : 0 })),
      walls: [...G.walls.values()].map(w => ({ gx: w.gx, gy: w.gy, m: w.mat, hp: Math.round(w.hp), mhp: w.maxHp })),
      loot: [...G.loot.values()].map(serializeLoot),
      storm: { grace: STORM_GRACE, phases: stormPhases, startR: STORM_CFG.startR },
      pois: G.pois.map(p => ({ i: p.id, n: p.n, k: p.k, x: Math.round(p.x), y: Math.round(p.y), r: p.r })),
      roads: G.roads.map(r => r.pts),
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
  p.landT = G.matchTime;   // bots loot for a while after landing before they start fights
  p.alt = 0; p.fallT = 0;
  const [nx, ny] = S.resolveCircle(p.x, p.y, S.PLAYER_R + 2, world);
  p.x = nx; p.y = ny;
  p.lastX = p.x; p.lastY = p.y;
  ev({ k: 'land', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
}
// how far a dive drifts along the bus route: the carried speed decays while falling
function diveDrift() {
  const v0 = G.bus.speed * S.FALL_CARRY;
  return v0 * (1 - Math.exp(-0.9 * S.FALL_TIME)) / 0.9;
}
// bus progress along its route, in units (matches busPos)
function busProgress() { return Math.min(G.bus.t, G.bus.dur) * G.bus.speed; }
// A bot picks where to land before the bus gets there. It aims for a POI on the route,
// or (sometimes) a random spot, and jumps once the bus reaches the point the dive drifts from.
// Nothing ever jumps after the bus has crossed the map.
function pickDrop(p) {
  const ai = p.ai, b = G.bus, now = busProgress();
  const drift = diveDrift();
  const W = S.WORLD, m = 400;
  const use = G.dropUse || (G.dropUse = new Map());
  // a point is usable when the bus can get a dive there: near enough to the route to steer onto
  // and not already passed
  const usable = (x, y) => {
    const ox = x - b.sx, oy = y - b.sy;
    const along = ox * b.dx + oy * b.dy, perp = Math.abs(ox * b.dy - oy * b.dx);
    const js = along - drift;
    if (perp > 760 || js < now + 120 || js > b.dur * b.speed) return null;
    // only inside the start circle: a bot dropped outside it has to run for the storm
    const st = G.storm;
    if (st && S.dist(x, y, st.cx, st.cy) > st.r * 0.55) return null;
    return { x, y, js };
  };
  let pick = null, poi = null;
  for (let tries = 0; tries < 60 && !pick; tries++) {
    if (Math.random() < 0.5 && G.pois.length) {
      // a POI, but the less a POI has been picked this match, the more likely (spreads the bots out)
      const q = G.pois[(Math.random() * G.pois.length) | 0];
      if (Math.random() > 1 / (1 + (use.get(q.id) || 0) * 0.5)) continue;
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * q.r * 1.1;
      const c = usable(q.x + Math.cos(a) * d, q.y + Math.sin(a) * d);
      if (c) { pick = c; poi = q; }
    } else {
      // a random spot anywhere on the island
      const c = usable(m + Math.random() * (W - 2 * m), m + Math.random() * (W - 2 * m));
      if (c) pick = c;
    }
  }
  if (!pick) {
    // nothing usable found: aim at the middle of the map
    pick = usable(W / 2, W / 2) || { x: W / 2, y: W / 2, js: Math.min(S.BUS.span, now + 300) };
  }
  if (poi) use.set(poi.id, (use.get(poi.id) || 0) + 1);
  ai.poi = poi;
  ai.drop = { x: pick.x, y: pick.y };
  ai.jumpS = pick.js + (Math.random() - 0.5) * 90;   // not every bot lands on the same pixel
}
// bot brain while riding the bus or skydiving
function botAir(p, dt) {
  const ai = p.ai, inp = p.input;
  inp.fire = false; inp.build = false;
  if (p.ph === S.PH.bus) {
    if (ai.jumpS === undefined) pickDrop(p);
    if (ai.jumpS != null && busProgress() >= ai.jumpS) startFall(p);
    return;
  }
  if (p.ph === S.PH.fall && ai.drop) {
    const dx = ai.drop.x - p.x, dy = ai.drop.y - p.y, d = Math.hypot(dx, dy);
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
  G.dropUse = new Map();   // how often each POI was picked as a drop this match
  G.mode = lobbyMode();
  const humans = [...clients.values()];
  let teamTotal = 0;
  if (G.mode === 'duo') {
    // a party of two is one team; teams are numbered from 1
    const teamOf = new Map();
    for (const c of humans) {
      const key = c.party ? c.party.id : 'c' + c.id;
      if (!teamOf.has(key)) teamOf.set(key, teamOf.size + 1);
      c.team = teamOf.get(key);
    }
    teamTotal = Math.max(teamOf.size, Math.floor(Math.min(S.MAX_PLAYERS, BOT_FILL) / 2));
  } else {
    for (const c of humans) c.team = 0;
  }

  // humans
  for (const c of humans) {
    const p = makePlayer(c.id, c.name, c.team, false);
    p.client = c; c.player = p; p.outfit = c.outfit || 0; p.head = c.head || 0;
    G.players.push(p);
  }
  // bots
  const names = S.BOT_NAMES.slice();
  const pickName = (i) => names.length ? names.splice((Math.random() * names.length) | 0, 1)[0] : 'Bot' + i;
  if (G.mode === 'duo') {
    // every team ends up with two players: a lone party member gets a bot partner
    const members = new Map();
    for (const c of humans) members.set(c.team, (members.get(c.team) || 0) + 1);
    let bi = 0;
    for (let t = 1; t <= teamTotal; t++) {
      for (let k = members.get(t) || 0; k < 2; k++) {
        G.players.push(makePlayer(nextEntityId++, pickName(bi++), t, true));
      }
    }
  } else {
    const botCount = Math.max(0, Math.min(S.MAX_PLAYERS, BOT_FILL) - G.players.length);
    for (let bi = 0; bi < botCount; bi++) G.players.push(makePlayer(nextEntityId++, pickName(bi), 0, true));
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
  reportLobby();   // a started match is no longer open for joins
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
  if (onMatchEnd) {
    const rows = [];
    for (const c of clients.values()) {
      if (!c.player || !c.token) continue;
      rows.push({ token: c.token, name: c.name, kills: c.player.kills || 0, place: c.player.alive ? 1 : (c.player.placement || 0), won: !!c.player.alive });
    }
    if (rows.length) { try { Promise.resolve(onMatchEnd(rows)).catch(() => {}); } catch (_) { /* reporting must never break the match */ } }
  }
  const winnerIds = winners.map(p => p.id);
  let winnerName = 'Nobody';
  if (winners.length) {
    if (winners[0].team > 0) winnerName = S.teamName(winners[0].team);
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
  reportLobby();
}

// ============================================================
//  Combat / damage
// ============================================================
function damagePlayer(victim, amount, attacker, cause) {
  if (!victim.alive || G.state !== 'active' || victim.ph !== S.PH.ground) return;
  if (victim.kn) {
    // a knocked player is safe for a moment, then any hit finishes them
    if (victim.knGrace > 0) return;
    killPlayer(victim, attacker, cause);
    return;
  }
  let dmg = amount;
  if (victim.shield > 0) {
    const absorbed = Math.min(victim.shield, dmg);
    victim.shield -= absorbed; dmg -= absorbed;
  }
  victim.hp -= dmg;
  victim.lastDmgT = G.matchTime;
  if (victim.ai && attacker && attacker !== victim) { victim.ai.hitBy = attacker; victim.ai.hitT = G.matchTime; }
  ev({ k: 'dmg', x: victim.x, y: victim.y, n: Math.round(amount), vid: victim.id, kid: attacker ? attacker.id : null });
  if (attacker && attacker.alive && !attacker.bot) { /* killer feedback handled client side */ }
  if (victim.hp <= 0) {
    if (canKnock(victim, cause)) knockPlayer(victim, attacker);
    else killPlayer(victim, attacker, cause);
  }
}

// ---- knocked states (duo only). A downed player keeps bleeding for S.KNOCK.bleed seconds
// and is revived by a living teammate who holds E next to them. The storm never knocks.
// A team is only knocked while the other member is up, so two players are never down at once.
function canKnock(v, cause) {
  if (G.mode !== 'duo' || !(v.team > 0) || cause === 'storm') return false;
  return G.players.some(q => q !== v && q.alive && !q.kn && q.team === v.team);
}
function knockPlayer(v, attacker) {
  v.kn = true; v.knT = S.KNOCK.bleed; v.knBy = attacker || null; v.knGrace = S.KNOCK.grace;
  v.hp = 0; v.shield = 0; v.revT = 0; v.revSeen = -9;
  v.pending = []; v.useT = 0; v.reloadT = 0; v.vx = 0; v.vy = 0;
  v.input.fire = false; v.input.build = false; v.input.mx = 0; v.input.my = 0; v.input.r = false;
  ev({ k: 'knock', vid: v.id, vname: v.name, vteam: v.team, kid: attacker ? attacker.id : null,
    kname: attacker ? attacker.name : 'The Fade', kteam: attacker ? attacker.team : 0, x: Math.round(v.x), y: Math.round(v.y) });
}
function updateKnocked(p, dt) {
  const inp = p.input;
  p.pending = []; inp.fire = false; inp.build = false; inp.mx = 0; inp.my = 0; inp.r = false;
  // revive progress decays if nobody is reviving any more
  if (G.matchTime - p.revSeen > 0.25) p.revT = Math.max(0, p.revT - dt * 2);
  p.knT -= dt;
  if (p.knGrace > 0) p.knGrace -= dt;
  if (p.knT <= 0) killPlayer(p, p.knBy, 'bleed');
}
// a living teammate standing still within reach, holding E, revives the nearest knocked teammate
function updateRevive(p, dt) {
  const inp = p.input;
  if (Math.hypot(inp.mx, inp.my) > 0.2) return;
  let mate = null, md = S.KNOCK.range * S.KNOCK.range;
  for (const q of G.players) {
    if (q === p || !q.kn || !q.alive || q.team !== p.team) continue;
    const d = S.dist2(p.x, p.y, q.x, q.y);
    if (d < md) { md = d; mate = q; }
  }
  if (!mate) return;
  mate.revT += dt; mate.revSeen = G.matchTime;
  if (mate.revT >= S.KNOCK.revive) reviveKnocked(mate, p);
}
function reviveKnocked(q, by) {
  q.kn = false; q.knT = 0; q.knBy = null; q.revT = 0;
  q.hp = S.KNOCK.hp; q.lastDmgT = G.matchTime;
  ev({ k: 'revive', vid: q.id, vname: q.name, rid: by.id, rname: by.name, vteam: q.team, kteam: by.team, x: Math.round(q.x), y: Math.round(q.y) });
}

function killPlayer(victim, attacker, cause) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.kn = false;
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
  // a knocked teammate has no one left to revive them
  if (victim.team > 0) for (const q of G.players) if (q.alive && q.kn && q.team === victim.team) killPlayer(q, attacker || victim.knBy, 'bleed');
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
  G.lastSound = { x: p.x, y: p.y, t: G.matchTime };   // gunfire: bots nearby can hear where it came from
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
  const legendary = !!chest.legendary;
  const rar = legendary ? roll([[3, 70], [4, 30]]) : roll([[0, 35], [1, 30], [2, 20], [3, 10], [4, 5]]);
  const wi = Math.floor(Math.random() * S.WEAPONS.length);
  const drops = [];
  const dropDef = (def) => {
    const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 40;
    const it = spawnLoot(chest.x + Math.cos(a) * d, chest.y + Math.sin(a) * d, def);
    drops.push(it); ev({ k: 'lootAdd', l: serializeLoot(it) });
  };
  dropDef({ kind: 'weapon', w: wi, r: rar, ammo: ammoForWeapon(wi) });
  dropDef({ kind: 'ammo', at: S.WEAPONS[wi].ammo, count: S.WEAPONS[wi].ammo === 'heavy' ? 6 : S.WEAPONS[wi].ammo === 'shell' ? 8 : 24 });
  if (legendary) dropDef({ kind: 'weapon', w: Math.floor(Math.random() * S.WEAPONS.length), r: roll([[3, 60], [4, 40]]), ammo: 0 });
  if (legendary) dropDef({ kind: 'consum', c: 'medkit', count: 2 });
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

// what a bot can see: nearest living enemy with a clear line and not hidden in a bush
const BOT_SIGHT = 560;   // px: a bot cannot see across the whole map
function botSenses(p) {
  let best = null, bd = 1e9;
  for (const q of G.players) {
    if (!q.alive || q === p || effTeam(q) === effTeam(p)) continue;
    const d = S.dist(p.x, p.y, q.x, q.y);
    if (d > BOT_SIGHT || d >= bd) continue;
    const shotRecently = (G.matchTime - q.lastShotT) < 1.5;
    if (d > 130 && !shotRecently && G.obstacles.some(o => o.type === 'bush' && S.dist2(q.x, q.y, o.x, o.y) < 40 * 40)) continue;
    if (!S.clearSeg(p.x, p.y, q.x, q.y, world)) continue;
    best = q; bd = d;
  }
  return best;
}

// how far (up to L, in steps) the bot can walk on heading a before walls, trees or rocks stop it
function freeLen(p, a, L) {
  const cx = Math.cos(a), cy = Math.sin(a);
  let free = 0;
  for (let d = 25; d <= L; d += 25) {
    const [nx, ny] = S.moveCircle(p.x, p.y, S.PLAYER_R, cx * d, cy * d, world);
    if (Math.hypot(nx - p.x - cx * d, ny - p.y - cy * d) > 3) break;
    free = d;
  }
  return free;
}
// keep the wanted heading when it is open; otherwise take the open heading closest to it
// (a bot boxed in a room picks the way out, the one with the longest clear run)
function freeHeading(p, want) {
  if (freeLen(p, want, 46) >= 46) return want;
  let best = want, bs = -1e9;
  for (const off of [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.0, -2.0, 2.5, -2.5, Math.PI]) {
    const a = want + off;
    const sc = freeLen(p, a, 150) - Math.abs(off) * 40;
    if (sc > bs) { bs = sc; best = a; }
  }
  return best;
}

const ROUND_LIMIT = 60 * 22;   // safety cap in match seconds: the storm ends the round at about 20 min
const BOT_LOOT_GRACE = 45;   // seconds after landing in which a bot loots instead of starting a fight (unless shot at)
function botThink(p, dt) {
  const ai = p.ai, sk = ai.skill;
  if (p.kn) { p.input.mx = 0; p.input.my = 0; p.input.fire = false; p.input.r = false; return; }
  ai.thinkT -= dt;
  ai.reactT -= dt; ai.strafeT -= dt; ai.panicWallT -= dt; ai.newWanderT -= dt;
  ai.lootT -= dt; ai.idleT -= dt; ai.dodgeCd -= dt;
  if (ai.thinkT > 0) { botApplyMove(p, dt); return; }
  ai.thinkT = 0.15 + Math.random() * 0.2;

  const inp = p.input;
  inp.fire = false; inp.build = false; inp.r = false;
  ai.wantFire = false;

  // unstick: if the bot keeps pushing and not moving, reverse for a moment
  const moved = S.dist(p.x, p.y, p.lastX, p.lastY);
  p.lastX = p.x; p.lastY = p.y;
  if (moved < 1.5 && (Math.abs(inp.mx) + Math.abs(inp.my)) > 0.3) p.stuckT += 0.2; else p.stuckT = 0;

  // ---- senses and memory
  // an unarmed bot does not start a fight from across the map: it keeps looting until the enemy is close or has shot at it
  const armedNow = p.slots.some((s, i) => i > 0 && s && s.kind === 'weapon' && (s.mag > 0 || p.ammo[S.WEAPONS[s.w].ammo] > 0));
  let seen = botSenses(p);
  const looting = G.matchTime - (p.landT || 0) < BOT_LOOT_GRACE;
  if (seen && G.matchTime - ai.hitT > 2 && (looting || (!armedNow && S.dist(p.x, p.y, seen.x, seen.y) > 160))) seen = null;
  // what the bot believes about the enemy: the position is a guess that gets rougher with distance,
  // and the velocity is measured from the last few sightings (it is not read from the enemy)
  let est = null;
  if (seen) {
    const dd = S.dist(p.x, p.y, seen.x, seen.y);
    const e = sk.err * dd / 100;
    est = { x: seen.x + (Math.random() - 0.5) * 2 * e, y: seen.y + (Math.random() - 0.5) * 2 * e, vx: 0, vy: 0 };
    const lo = ai.lastObs;
    if (lo && lo.id === seen.id && G.matchTime - lo.t < 1 && G.matchTime > lo.t) {
      const dt2 = G.matchTime - lo.t;
      est.vx = lo.vx * 0.6 + ((seen.x - lo.x) / dt2) * 0.4;
      est.vy = lo.vy * 0.6 + ((seen.y - lo.y) / dt2) * 0.4;
    }
    ai.lastObs = { id: seen.id, x: seen.x, y: seen.y, t: G.matchTime, vx: est.vx, vy: est.vy };
  }
  if (seen) {
    if (ai.target !== seen) { ai.target = seen; ai.reactT = sk.react * (0.7 + Math.random() * 0.6); }
    ai.mem = { x: est.x, y: est.y, vx: est.vx, vy: est.vy, t: G.matchTime };
  } else {
    ai.target = null;
    // shot from somewhere it cannot see: turn toward the shooter
    if (ai.hitBy && ai.hitBy.alive && G.matchTime - ai.hitT < 1.2 && (!ai.mem || ai.mem.t < ai.hitT)) {
      ai.mem = { x: ai.hitBy.x, y: ai.hitBy.y, vx: 0, vy: 0, t: ai.hitT };
    }
  }
  // hearing: gunfire close by pulls the bot toward it (it goes to search there), unless it is busy looting
  const snd = G.lastSound;
  if (!seen && !looting && snd && G.matchTime - snd.t < 4 && S.dist(p.x, p.y, snd.x, snd.y) < 450 && Math.random() < 0.35) {
    ai.mem = { x: snd.x + (Math.random() - 0.5) * 120, y: snd.y + (Math.random() - 0.5) * 120, vx: 0, vy: 0, t: G.matchTime };
  }
  const quietFor = ai.mem ? G.matchTime - ai.mem.t : 99;

  const st = G.storm;
  const distToSafe = S.dist(p.x, p.y, st ? st.tx : S.WORLD / 2, st ? st.ty : S.WORLD / 2);
  const danger = !!st && S.dist(p.x, p.y, st.cx, st.cy) > st.r - 40;   // in the storm: leave now, even mid-fight

  // ---- heal when no enemy has been seen for a moment
  const hurt = p.hp < 55 || p.shield < 20;
  if (!seen && quietFor > 1.5 && hurt && p.useT <= 0) {
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

  // a downed duo partner comes before loot and far-off enemies
  const mate = (!danger && p.team > 0 && G.mode === 'duo') ? G.players.find(q => q !== p && q.alive && q.kn && q.team === p.team) : null;
  // a teammate is down: keep reviving unless the enemy is close or has been shooting at us
  const keepReviving = mate && (!seen || (S.dist(p.x, p.y, seen.x, seen.y) > 90 && G.matchTime - p.lastDmgT > 0.8));
  if (seen && !danger && !keepReviving) {
    // ---------- fight
    ai.mode = 'fight';
    // best weapon for the fight
    let best = -1, bs = -1;
    for (let i = 1; i < 5; i++) {
      const s = p.slots[i];
      if (!s || s.kind !== 'weapon') continue;
      if (s.mag <= 0 && p.ammo[S.WEAPONS[s.w].ammo] <= 0) continue;
      const sc = [2, 3, 3, 4, 3.5][s.w] * (1 + s.r * 0.3);
      if (sc > bs) { bs = sc; best = i; }
    }
    if (best >= 0 && p.sel !== best && p.useT <= 0) p.sel = best;
    else if (best === -1 && p.useT <= 0) p.sel = 0; // pickaxe rush

    const s = curSlot(p);
    const weapon = s && s.kind === 'weapon' ? S.WEAPONS[s.w] : null;
    const td = S.dist(p.x, p.y, seen.x, seen.y);

    // hurt and well outside the enemy's reach: heal now instead of waiting for a quiet moment
    if (p.hp < 35 && td > 260 && p.useT <= 0) {
      let hi = -1;
      for (let i = 1; i < 5; i++) {
        const cs2 = p.slots[i];
        if (!cs2 || cs2.kind !== 'consum') continue;
        if (S.CONSUM[cs2.c].heal) { hi = i; break; }
      }
      if (hi >= 0) { p.sel = hi; startUse(p); }
    }
    const healing = p.useT > 0;   // a heal is in progress: do not shoot (shooting cancels it)

    // aim where the bot thinks the target will be when the bullet arrives
    let px = est.x, py = est.y;
    if (weapon) {
      const tt = Math.min(1.2, td / weapon.speed) * sk.lead;
      px += est.vx * tt; py += est.vy * tt;
    }
    const aimTrue = Math.atan2(py - p.y, px - p.x);
    ai.desAim = aimTrue + (Math.random() - 0.5) * 2 * sk.jitter * (0.5 + td / 400);
    const tol = weapon ? ({ sniper: 0.05, ar: 0.12, pistol: 0.14, smg: 0.18, shotgun: 0.22 }[weapon.id] || 0.15) : 0.5;
    ai.fireTol = tol;

    // cover: low and close, or pinned at mid range, throw up a wall in front of the enemy
    if (p.hp < 60 && ai.panicWallT <= 0 && p.mats[p.buildMat] >= S.WALL_COST) {
      p.input.aim = aimTrue;
      ai.panicWallT = 3;
      tryPlaceWall(p);
    } else if (td > 160 && td < 420 && ai.panicWallT <= 0 && p.mats[p.buildMat] >= S.WALL_COST && Math.random() < 0.25 * sk.build) {
      p.input.aim = aimTrue;
      ai.panicWallT = 4;
      tryPlaceWall(p);
    }

    const aimAng = Math.atan2(est.y - p.y, est.x - p.x);
    if (ai.strafeT <= 0) {
      ai.strafeDir = Math.random() < 0.5 ? 1 : -1;
      ai.strafeT = sk.strafeHold * (0.6 + Math.random() * 0.8);
    }
    // dodge: a shot just landed, so often step sideways
    if (G.matchTime - ai.hitT < 0.25 && ai.dodgeCd <= 0 && Math.random() < 0.45 * (1 - sk.aggro * 0.5)) {
      ai.strafeDir = -ai.strafeDir;
      ai.strafeT = sk.strafeHold * (0.6 + Math.random() * 0.8);
      ai.dodgeCd = 1.2;
    }

    if (!weapon) {
      // no gun: rush and swing
      inp.mx = Math.cos(aimAng); inp.my = Math.sin(aimAng);
      ai.wantFire = !healing && td < 60;
      ai.fireTol = 0.5;
    } else {
      const prefRange = { pistol: 260, smg: 220, shotgun: 120, ar: 340, sniper: 480 }[weapon.id] || 260;
      const perp = aimAng + Math.PI / 2 * ai.strafeDir;
      let mx = Math.cos(perp), my = Math.sin(perp);
      // keep the preferred range; a hurt, less aggressive bot backs off
      const pull = S.clamp((td - prefRange) / 200, -1, 1);
      const retreat = (p.hp < 35 && sk.aggro < 0.6) ? 1.2 : 0;
      mx -= Math.cos(aimAng) * (pull + retreat);
      my -= Math.sin(aimAng) * (pull + retreat);
      const mag = Math.hypot(mx, my) || 1;
      inp.mx = mx / mag; inp.my = my / mag;
      ai.wantFire = !healing && p.reloadT <= 0 && td < weapon.range * 0.9;
    }
  } else if (danger || (st && distToSafe > st.tr * 0.85 && (st.sh || st.t < 30))) {
    // ---------- storm first: head for the next circle at full speed, no looting on the way
    ai.mode = 'storm';
    const a = Math.atan2(st.ty - p.y, st.tx - p.x) + (Math.random() - 0.5) * 0.3;
    ai.desAim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
  } else if (mate) {
    // ---------- revive: walk to the knocked teammate, stand still and hold E
    ai.mode = 'revive';
    const dm = S.dist(p.x, p.y, mate.x, mate.y), a = Math.atan2(mate.y - p.y, mate.x - p.x);
    ai.desAim = a;
    if (dm > S.KNOCK.range * 0.6) { inp.mx = Math.cos(a); inp.my = Math.sin(a); }
    else { inp.mx = 0; inp.my = 0; inp.r = true; }
  } else if (ai.mem && quietFor < 3 && S.dist(p.x, p.y, ai.mem.x, ai.mem.y) > 70) {
    // ---------- search: walk to where the enemy was last seen
    ai.mode = 'search';
    const a = Math.atan2(ai.mem.y - p.y, ai.mem.x - p.x);
    ai.desAim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
  } else {
    // ---------- loot, then wander
    let goal = ai.goal;
    if (ai.lootT <= 0) {
      ai.lootT = 1.2;
      goal = null;
      let gd = 1e9;
      for (const l of G.loot.values()) {
        if (!botWantsItem(p, l)) continue;
        const d = S.dist2(p.x, p.y, l.x, l.y);
        if (d < gd && d < 600 * 600) { gd = d; goal = { x: l.x, y: l.y }; }
      }
      if (!goal) {
        for (const c of G.chests) {
          if (c.open) continue;
          const d = S.dist2(p.x, p.y, c.x, c.y);
          if (d < gd && d < 700 * 700) { gd = d; goal = { x: c.x, y: c.y }; }
        }
      }
      ai.goal = goal;
    }

    if (goal && S.dist(p.x, p.y, goal.x, goal.y) > 50) {
      ai.mode = 'loot';
      const a = Math.atan2(goal.y - p.y, goal.x - p.x);
      ai.desAim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
      // grab nearby wanted loot; if pockets are full, swap out the weakest weapon
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
        // sometimes stop for a moment to look around, like a player would
        if (Math.random() < 0.3) ai.idleT = 0.6 + Math.random() * 1.2;
      }
      const a = Math.atan2(ai.wy - p.y, ai.wx - p.x);
      if (ai.idleT > 0) {
        inp.mx = 0; inp.my = 0;
        ai.desAim = ai.desAim + (Math.random() - 0.5) * 1.2;
      } else {
        ai.desAim = a; inp.mx = Math.cos(a); inp.my = Math.sin(a);
      }
    }
  }

  // no weapon after a while: find one (keeps bots threatening)
  if (G.matchTime > 40 && !p.slots.some(s => s && s.kind === 'weapon')) {
    const wi = Math.floor(Math.random() * 3); // pistol/smg/shotgun
    const empty = p.slots.indexOf(null, 1);
    const idx = empty !== -1 ? empty : 1;
    p.slots[idx] = { kind: 'weapon', w: wi, r: Math.floor(Math.random() * 2), mag: S.WEAPONS[wi].mag };
    p.ammo[S.WEAPONS[wi].ammo] += 30;
  }
  if (p.stuckT > 0.6) { const t = inp.mx; inp.mx = -inp.my; inp.my = t; p.stuckT = 0.2; }
  const mv = Math.hypot(inp.mx, inp.my);
  if (mv > 0.05 && !inp.r) { const fa = freeHeading(p, Math.atan2(inp.my, inp.mx)); inp.mx = Math.cos(fa) * mv; inp.my = Math.sin(fa) * mv; }
  botApplyMove(p, dt);
}

// runs every tick: turns the aim toward the desired aim at the bot's own speed,
// then fires in bursts only when the aim is on target
function botApplyMove(p, dt) {
  const inp = p.input;
  const m = Math.hypot(inp.mx, inp.my);
  if (m > 1) { inp.mx /= m; inp.my /= m; }
  const ai = p.ai;
  if (!ai) return;

  const d = S.angDiff(ai.curAim, ai.desAim);            // signed turn needed
  const step = S.clamp(d, -ai.skill.aimSpeed * dt, ai.skill.aimSpeed * dt);
  ai.curAim += step;
  inp.aim = ai.curAim;

  if (ai.wantFire && ai.reactT <= 0 && Math.abs(S.angDiff(ai.curAim, ai.desAim)) < ai.fireTol) {
    if (ai.pauseT > 0) { ai.pauseT -= dt; inp.fire = false; }
    else {
      inp.fire = true;
      ai.burstT -= dt;
      if (ai.burstT <= 0) { ai.pauseT = 0.12 + Math.random() * 0.3; ai.burstT = 0.35 + Math.random() * 0.6; }
    }
  } else {
    inp.fire = false;
  }
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
  if (p.kn) { updateKnocked(p, dt); return; }
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
  if (inp.r && p.team > 0 && G.state === 'active') updateRevive(p, dt);
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
  const wantFire = inp.fire || inp.firePulse;
  inp.firePulse = false;
  if (wantFire && G.state === 'active') {
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
      p.useT > 0 ? 1 : 0, p.kills, p.ph, Math.round(p.alt * 100), p.outfit,
      p.kn ? 1 : 0, p.kn ? Math.ceil(p.knT) : 0, Math.round(Math.min(1, p.revT / S.KNOCK.revive) * 100),
      p.head || 0,
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
      if (G.state === 'lobby') {
        lobbyAcc += dt;
        if (lobbyAcc >= 1) { lobbyAcc = 0; broadcastLobby(); }
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
        } else if (G.matchTime > 3 && G.players.some(p => !p.bot) && !G.players.some(p => !p.bot && p.alive)) {
          // every human is out: the round is over even if bots are still standing
          endMatch(null);
        } else if (G.aliveCount <= 1 || G.matchTime > ROUND_LIMIT) {
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
      // match events go only to clients in the match (waiting clients are in the lobby)
      for (const e of evQueue) { const m = JSON.stringify({ t: 'ev', ...e }); for (const c of clients.values()) if (c.player && c.ws && !c.ws.closed) c.ws.send(m); }
      evQueue = [];
    }
    // snapshot (bus and match)
    if (G.state === 'active' || G.state === 'bus') {
      const snap = buildSnapshot();
      const s = JSON.stringify(snap);
      for (const c of clients.values()) {
        if (!c.ws || c.ws.closed || !c.player) continue;
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
            ack: p.input.seq | 0, sx: Math.round(p.x * 10) / 10, sy: Math.round(p.y * 10) / 10,
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
// account: null for guests, or { token, name, outfit } that the Worker verified from a ticket.
// Guests send a name only; their token and outfit are ignored (outfit 0, no stats).
function acceptSocket(conn, account) {
  let client = null;

  conn.onmessage = (str) => {
    if (str.length > 4096) return;
    let msg;
    try { msg = JSON.parse(str); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (!client) {
      if (msg.t === 'hello') {
        const acct = (account && typeof account === 'object') ? account : null;
        if (MODE === 'duo' && !(acct && acct.party)) {
          sendTo({ ws: conn }, { t: 'err', msg: 'Duo needs a party of two. Sign in, invite a friend, then press Duo.' });
          conn._close();
          return;
        }
        client = {
          id: nextEntityId++, ws: conn, name: sanitizeName(acct ? acct.name : msg.name),
          token: acct && typeof acct.token === 'string' ? acct.token.slice(0, 80) : '',
          outfit: acct ? clampOutfit(acct.outfit) : 0,
          head: acct && typeof acct.head === 'string' ? headIndex(acct.head) : 0,
          team: 0, player: null,
          party: acct && acct.party ? { id: String(acct.party.id), partnerName: String(acct.party.partnerName || '') } : null,
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
            reportLobby();
            log(`Client left: ${client.name} (${clients.size} connected)`);
          }
        };
        log(`Client joined: ${client.name} (${clients.size} connected)`);
        // always start on the spawn island; a match already running is joined at the next start
        sendTo(client, { t: 'welcome', id: client.id, state: 'lobby', ver: 1 });
        broadcastLobby();
        reportLobby();
      }
      return;
    }

      switch (msg.t) {
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
        i.seq = (+msg.n) | 0;   // input sequence number, echoed back in 'you' so the client can reconcile
        if (msg.f) i.firePulse = true;   // a quick tap must not be lost between ticks
        i.build = !!msg.b;
        i.r = !!msg.r;   // holding E: revive a knocked teammate if one is in reach
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
