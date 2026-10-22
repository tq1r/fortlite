/* ============================================================
   FORTLITE — shared constants & helpers
   Used by BOTH server.js (require) and public/game.js (<script>)
   Must stay in sync so client prediction matches server physics.
   ============================================================ */
(function () {
  const S = {};

  // ---- World -------------------------------------------------
  S.WORLD = 11000;           // world is WORLD x WORLD pixels; the island is inside, sea outside
  S.GRID = 60;               // wall grid cell size
  S.CELLS = S.WORLD / S.GRID;

  // ---- Island and sea (same on server and client, so movement and drawing agree) ----
  // The island is a blob with a wiggly coast. Everything outside the coastline is sea.
  S.LAND = { cx: S.WORLD / 2, cy: S.WORLD / 2, R: S.WORLD * 0.455 };
  const COAST_PH = [0.6, 2.1, 4.0, 1.3];
  // distance from the island centre to the coastline in the direction of (x, y)
  S.coastRadius = (x, y) => {
    const a = Math.atan2(y - S.LAND.cy, x - S.LAND.cx);
    const k = 1 + 0.075 * Math.sin(3 * a + COAST_PH[0]) + 0.05 * Math.sin(5 * a + COAST_PH[1])
      + 0.03 * Math.sin(9 * a + COAST_PH[2]) + 0.018 * Math.sin(17 * a + COAST_PH[3]);
    return S.LAND.R * k;
  };
  // >0 inland, <0 at sea
  S.coastDist = (x, y) => S.coastRadius(x, y) - Math.hypot(x - S.LAND.cx, y - S.LAND.cy);
  S.isLand = (x, y) => S.coastDist(x, y) > 0;
  // Biomes depend only on position, so the client can draw them without server data.
  // North: snowy mountains. West: forest. East: desert. South-west: marsh. The rest: plains.
  const biomeWobble = (x, y) => Math.sin(x / 1300 + 0.7) * Math.cos(y / 1100 - 0.4) + 0.5 * Math.sin((x + y) / 700 + 2.1);
  S.biomeAt = (x, y) => {
    const dx = (x - S.LAND.cx) / S.LAND.R, dy = (y - S.LAND.cy) / S.LAND.R;
    const n = biomeWobble(x, y) * 0.18;
    if (dy + n < -0.42) return 'snow';
    if (dx + n < -0.38) return 'forest';
    if (dx + n > 0.36) return 'desert';
    if (dy + n > 0.34 && dx + n < 0.05) return 'swamp';
    return 'plains';
  };
  S.PLAYER_R = 20;
  S.SPEED = 250;             // px/sec (top speed)
  S.ACCEL = 1700;            // px/sec^2 speeding up toward the input direction
  S.DECEL = 2200;            // px/sec^2 slowing down when input stops
  S.SPEED_USE = 0.5;         // movement multiplier while using consumable
  S.START_HP = 100;
  S.START_SHIELD = 0;

  // ---- Spawn island, Battle Bus, skydive -------------------------
  S.ISLAND = { x: 2100, y: 2100, r: 560 };   // lobby island (round, ringed by water)
  S.ISLAND_SPEED = 260;                       // walk speed on the island
  S.BUS = { span: 6160, speed: 600 };         // bus flies from -span to +span through map centre (about 19 s)
  S.FALL_TIME = 4.2;                          // seconds of skydive before landing
  S.FALL_SPEED = 230;                         // steering speed while skydiving
  S.FALL_CARRY = 0.45;                        // share of bus velocity carried into the dive
  S.POI_COUNT = 22;                            // named points of interest per map
  // player phases (sent as small ints in snapshots)
  S.PH = { ground: 0, bus: 1, fall: 2 };

  // keep a point inside the spawn island disc
  S.clampIsland = (x, y) => {
    const R = S.ISLAND.r - S.PLAYER_R - 14;
    const dx = x - S.ISLAND.x, dy = y - S.ISLAND.y;
    const d = Math.hypot(dx, dy);
    if (d <= R) return [x, y];
    return [S.ISLAND.x + dx / d * R, S.ISLAND.y + dy / d * R];
  };

  // ---- Weapons ------------------------------------------------
  // dmg per pellet, rof = seconds between shots, spread in radians,
  // speed = bullet px/sec, range = max travel px
  S.WEAPONS = [
    { id: 'pistol',  name: 'Pistol',         dmg: 24, rof: 0.26,  mag: 16, reload: 1.3, spread: 0.05, speed: 950,  range: 700,  ammo: 'light',  pellets: 1, bulletsz: 4 },
    { id: 'smg',     name: 'SMG',            dmg: 15, rof: 0.09,  mag: 30, reload: 1.7, spread: 0.12, speed: 900,  range: 560,  ammo: 'light',  pellets: 1, bulletsz: 3 },
    { id: 'shotgun', name: 'Shotgun',        dmg: 11, rof: 0.95,  mag: 5,  reload: 2.3, spread: 0.21, speed: 820,  range: 330,  ammo: 'shell',  pellets: 6, bulletsz: 3 },
    { id: 'ar',      name: 'Assault Rifle',  dmg: 30, rof: 0.165, mag: 30, reload: 2.2, spread: 0.07, speed: 1100, range: 900,  ammo: 'medium', pellets: 1, bulletsz: 4 },
    { id: 'sniper',  name: 'Sniper Rifle',   dmg: 95, rof: 1.6,   mag: 3,  reload: 2.6, spread: 0.01, speed: 1700, range: 1500, ammo: 'heavy',  pellets: 1, bulletsz: 5 },
  ];
  S.WIDX = { pistol: 0, smg: 1, shotgun: 2, ar: 3, sniper: 4 };

  S.RARITY = [
    { name: 'Common',    mult: 1.00, color: '#b9bec4' },
    { name: 'Uncommon',  mult: 1.10, color: '#54d43a' },
    { name: 'Rare',      mult: 1.20, color: '#37a8ff' },
    { name: 'Epic',      mult: 1.32, color: '#b45bf2' },
    { name: 'Legendary', mult: 1.45, color: '#ffa93a' },
  ];

  // ammo granted when the weapon is picked up
  S.WEAPON_PICKUP_AMMO = { light: 30, medium: 30, heavy: 6, shell: 8 };
  S.AMMO_NAME = { light: 'Light', medium: 'Medium', heavy: 'Heavy', shell: 'Shells' };
  S.AMMO_MAX = { light: 400, medium: 300, heavy: 60, shell: 60 };

  // ---- Consumables ---------------------------------------------
  S.CONSUM = {
    mini:    { name: 'Mini Shield',   time: 1.5, cap: 50,  add: 25, color: '#7fd8ff' },
    shield:  { name: 'Shield Potion', time: 3.0, cap: 100, add: 50, color: '#39b7ff' },
    medkit:  { name: 'Medkit',        time: 4.0, heal: 100, color: '#ff6b7a' },
  };

  // ---- Building -------------------------------------------------
  S.MATS = ['wood', 'stone', 'metal'];
  S.MAT_COLOR = { wood: '#c98d4b', stone: '#9aa0a8', metal: '#5f6d7e' };
  S.MAT_HP = { wood: 150, stone: 300, metal: 450 };
  S.WALL_COST = 10;
  S.HARVEST_CAP = 500;
  S.PICK_DMG_RESOURCE = 50;    // per swing vs trees/rocks/crates/walls
  S.PICK_DMG_PLAYER = 20;
  S.PICK_RANGE = 64;
  S.PICK_CD = 0.45;
  S.HARVEST_PER_HIT = 10;      // mats per pickaxe hit
  S.HARVEST_BONUS = 20;        // extra mats when destroying

  // ---- Storm -----------------------------------------------------
  // The Fade (storm). Radii scale with the world (11000 wide now). Timings are 25% slower than the
  // original tuned pace, so the circle closes more slowly and gives players time to move.
  S.STORM = {
    grace: 28, startR: 6600,
    phases: [
      { wait: 22, shrink: 20, r: 4587, dps: 1 },
      { wait: 18, shrink: 18, r: 2860, dps: 2 },
      { wait: 15, shrink: 15, r: 1727, dps: 4 },
      { wait: 12, shrink: 12, r: 990, dps: 6 },
      { wait: 11, shrink: 11, r: 517, dps: 8 },
      { wait: 10, shrink: 10, r: 165, dps: 10 },
      { wait: 10, shrink: 12, r: 0, dps: 12 },
    ],
  };

  // ---- Teams (duo mode uses up to 15 pair-colors) ----------------
  S.TEAMS = [
    null,
    { name: 'Red',    color: '#ff5566' },
    { name: 'Blue',   color: '#3aa0ff' },
    { name: 'Green',  color: '#54d43a' },
    { name: 'Yellow', color: '#ffd23a' },
    { name: 'Purple', color: '#b45bf2' },
    { name: 'Orange', color: '#ff8c3a' },
    { name: 'Teal',   color: '#35d4c0' },
    { name: 'Pink',   color: '#ff7ac8' },
    { name: 'Lime',   color: '#c0e04a' },
    { name: 'Navy',   color: '#5a6ee0' },
    { name: 'Amber',  color: '#d8a03a' },
    { name: 'Steel',  color: '#aab4c4' },
    { name: 'Mint',   color: '#7de0b0' },
    { name: 'Rose',   color: '#e07d9a' },
    { name: 'Slate',  color: '#8a97ad' },
  ];
  S.PICKABLE_TEAMS = 6;   // how many teams players can manually join in duo lobby

  // ---- Match -----------------------------------------------------
  S.LOBBY_COUNTDOWN = 15;   // seconds after first human joins
  S.END_TIME = 14;          // seconds on end screen
  S.MAX_PLAYERS = 100;      // humans + bots
  S.BOT_FILL = 100;         // fill matches to this many players

  // ---- Bot names (all original — no borrowed IP) ------------------
  S.BOT_NAMES = [
    'DefaultDanny', 'BushWhacker', 'CrankedKid', 'NoScopeNina', 'SweatyPete',
    'LootLarry', 'TurboTina', 'DriftKing', 'GoldieHands', 'BouncyBob',
    'SipSam', 'WarpRunner', 'ZiplineZack', 'FadeChaser', 'PickaxePete',
    'SaltySue', 'TangoTom', 'NanoNate', 'QuickscopeQuinn', 'BushCamper',
  ];

  // ================================================================
  //  Math / RNG
  // ================================================================
  S.clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  S.dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
  S.dist2 = (x1, y1, x2, y2) => { const dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy; };
  S.angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

  // deterministic RNG for map gen
  S.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  S.wallKey = (gx, gy) => gx * 1000 + gy;

  // ================================================================
  //  Collision helpers
  //  "world" interface (both sides implement):
  //    world.size                      -> number
  //    world.obstaclesNear(x, y, r)    -> array of obstacle objects {x,y,r,type,...}
  //    world.wallAt(gx, gy)            -> wall object or null
  // ================================================================

  // Push a circle out of obstacle circles & wall AABBs. Iterated a few times.
  S.resolveCircle = function (x, y, r, world) {
    const size = world.size;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      // world bounds
      if (x - r < 0) { x = r; moved = true; }
      if (y - r < 0) { y = r; moved = true; }
      if (x + r > size) { x = size - r; moved = true; }
      if (y + r > size) { y = size - r; moved = true; }
      // the sea: keep the circle on the island by projecting it back inside the coastline
      {
        const cdx = x - S.LAND.cx, cdy = y - S.LAND.cy, dd = Math.hypot(cdx, cdy);
        const lim = S.coastRadius(x, y) - r - 3;
        if (dd > lim && dd > 0) { const k = Math.max(0, lim) / dd; x = S.LAND.cx + cdx * k; y = S.LAND.cy + cdy * k; moved = true; }
      }
      const obs = world.obstaclesNear(x, y, r + 40);
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (o.type === 'bush') continue;           // bushes don't block
        const dx = x - o.x, dy = y - o.y;
        const rr = r + o.r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.0001 && d2 < rr * rr) {
          const d = Math.sqrt(d2);
          x = o.x + (dx / d) * rr; y = o.y + (dy / d) * rr; moved = true;
        } else if (d2 <= 0.0001) { x = o.x + rr; moved = true; }
      }
      // walls (grid cells around us)
      const G = S.GRID;
      const gx0 = Math.floor((x - r) / G), gx1 = Math.floor((x + r) / G);
      const gy0 = Math.floor((y - r) / G), gy1 = Math.floor((y + r) / G);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          if (!world.wallAt(gx, gy)) continue;
          // AABB of the wall (full cell)
          const wx = gx * G, wy = gy * G;
          const cx = S.clamp(x, wx, wx + G);
          const cy = S.clamp(y, wy, wy + G);
          const dx = x - cx, dy = y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r) {
            if (d2 > 0.0001) {
              const d = Math.sqrt(d2);
              x = cx + (dx / d) * r; y = cy + (dy / d) * r;
            } else {
              // center inside the AABB — push out along smallest axis
              const left = x - wx, right = wx + G - x, top = y - wy, bot = wy + G - y;
              const m = Math.min(left, right, top, bot);
              if (m === left) x = wx - r; else if (m === right) x = wx + G + r;
              else if (m === top) y = wy - r; else y = wy + G + r;
            }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return [x, y];
  };

  // Step a velocity (vx, vy) toward a target velocity with limited acceleration.
  // Used by the server and by client prediction, so both move the same way.
  S.stepVel = function (vx, vy, tx, ty, dt) {
    const dx = tx - vx, dy = ty - vy;
    const d = Math.hypot(dx, dy);
    const rate = (tx || ty) ? S.ACCEL : S.DECEL;
    const maxd = rate * dt;
    if (d <= maxd || d === 0) return [tx, ty];
    return [vx + dx / d * maxd, vy + dy / d * maxd];
  };

  // Move a circle with velocity, then resolve. Returns [x, y].
  S.moveCircle = function (x, y, r, dx, dy, world) {
    x += dx; y += dy;
    return S.resolveCircle(x, y, r, world);
  };

  // ---- segment vs circle: returns t in [0,1] or Infinity ----
  S.segCircle = function (x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1, dy = y2 - y1;
    const fx = x1 - cx, fy = y1 - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-9) return (fx * fx + fy * fy <= r * r) ? 0 : Infinity;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    disc = Math.sqrt(disc);
    const t1 = (-b - disc) / (2 * a), t2 = (-b + disc) / (2 * a);
    if (t1 >= 0 && t1 <= 1) return t1;
    if (t2 >= 0 && t2 <= 1) return t2;
    return Infinity;
  };

  // ---- segment vs AABB: returns t in [0,1] or Infinity ----
  S.segAABB = function (x1, y1, x2, y2, ax, ay, aw, ah) {
    const dx = x2 - x1, dy = y2 - y1;
    let tmin = 0, tmax = 1;
    for (let axis = 0; axis < 2; axis++) {
      const p = axis === 0 ? x1 : y1;
      const d = axis === 0 ? dx : dy;
      const lo = axis === 0 ? ax : ay;
      const hi = axis === 0 ? ax + aw : ay + ah;
      if (Math.abs(d) < 1e-9) {
        if (p < lo || p > hi) return Infinity;
      } else {
        let t1 = (lo - p) / d, t2 = (hi - p) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) return Infinity;
      }
    }
    return tmin;
  };

  // Line of sight: nothing blocking between two points.
  S.clearSeg = function (x1, y1, x2, y2, world) {
    // sample obstacles along the segment using a coarse pass
    const obs = world.obstaclesNear((x1 + x2) / 2, (y1 + y2) / 2, S.dist(x1, y1, x2, y2) / 2 + 80);
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.type === 'bush' || o.type === 'water') continue; // bushes hide, water is shootable-over
      if (S.segCircle(x1, y1, x2, y2, o.x, o.y, o.r) <= 1) return false;
    }
    // walls along the segment
    const G = S.GRID;
    const gx0 = Math.floor(Math.min(x1, x2) / G) - 1, gx1 = Math.floor(Math.max(x1, x2) / G) + 1;
    const gy0 = Math.floor(Math.min(y1, y2) / G) - 1, gy1 = Math.floor(Math.max(y1, y2) / G) + 1;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        if (!world.wallAt(gx, gy)) continue;
        if (S.segAABB(x1, y1, x2, y2, gx * G, gy * G, G, G) <= 1) return false;
      }
    }
    return true;
  };

  // Cosmetic outfits: the body colour of a player. Unlocked by account stats (see worker/index.js).
  // Index 0 is always free. Keep the order stable: the index is what travels over the wire.
  S.OUTFITS = [
    { id: 'scout',   name: 'Scout',   color: '#557a62', unlock: null },
    { id: 'moss',    name: 'Moss',    color: '#7a9a3a', unlock: { stat: 'wins', min: 1 } },
    { id: 'ember',   name: 'Ember',   color: '#c4572b', unlock: { stat: 'matches', min: 3 } },
    { id: 'glacier', name: 'Glacier', color: '#3e8fbf', unlock: { stat: 'kills', min: 10 } },
    { id: 'violet',  name: 'Violet',  color: '#7b4ea3', unlock: { stat: 'kills', min: 50 } },
    { id: 'gold',    name: 'Gold',    color: '#d9a92b', unlock: { stat: 'wins', min: 5 } },
  ];

  // export for node & browser
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  if (typeof window !== 'undefined') window.S = S;
})();
