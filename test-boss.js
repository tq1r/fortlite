// In-process tests for POI bosses, armor, and medallions. No sockets: the game is driven
// directly through the debug hook (createGame({ debug: true })).
//   node test-boss.js
const { createGame } = require('./core.js');
const S = require('./shared.js');

let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  PASS', l); } else { failed++; console.log('  FAIL:', l); } };

const g = createGame({ bots: 0, nobus: true, nostorm: true, fast: true, debug: true });
const I = g.__internal, G = I.G;

// tick() ends rounds when no human client is connected, and when aliveCount is low.
// These tests have no sockets, so each tick keeps the round alive by resetting those two values.
let tickErrors = 0;
const origErr = console.error;
console.error = (...a) => { if (String(a[0]).includes('TICK ERROR')) tickErrors++; else origErr(...a); };
function run(n) {
  for (let i = 0; i < n; i++) {
    G.matchTime = 0;
    // at least two so the round is not called over; the real count is not what these checks are about
    G.aliveCount = Math.max(2, G.players.filter(p => !p.boss && p.alive).length);
    I.tick();
  }
}

console.log('=== boss / armor / medallion tests ===');
I.startMatch();
const bosses = G.players.filter(p => p.boss);
const pois = G.pois;

console.log('-- spawn');
ok(pois.length === 18 && bosses.length === pois.length, `one boss per POI (${bosses.length} bosses, ${pois.length} POIs)`);
ok(bosses.every(b => b.hp === S.BOSS.hp && b.shield === 0), `bosses start at ${S.BOSS.hp} hp`);
ok(bosses.every(b => b.armor === S.BOSS.armor), 'bosses wear heavy armor');
ok(bosses.every(b => b.slots[1] && b.slots[1].kind === 'weapon' && S.WEAPONS[b.slots[1].w].id === S.BOSS.weapon),
  `bosses carry the ${S.BOSS.weapon} rifle`);
ok(bosses.every(b => Math.hypot(b.x - b.boss.cx, b.y - b.boss.cy) <= 60 + 1), 'each boss spawns at its POI');
ok(G.aliveCount === 0, `bosses do not count as alive players (aliveCount ${G.aliveCount})`);

console.log('-- leash');
run(200);   // 10 s with no humans near: the bosses idle near their POIs
ok(bosses.every(b => Math.hypot(b.x - b.boss.cx, b.y - b.boss.cy) <= S.BOSS.leash + 40), 'bosses stay near their POI with nobody around');

console.log('-- armor');
const h = I.makePlayer(9001, 'Tester', 0, false);
G.players.push(h);
h.x = bosses[0].boss.cx + 500; h.y = bosses[0].boss.cy + 500;
h.armor = 'heavy';
h.hp = 100;
I.damagePlayer(h, 100, null, 'test');
ok(Math.abs(h.hp - (100 - 100 * (1 - S.ARMOR.heavy.red))) < 1e-6, `heavy armor cuts 100 damage to ${h.hp.toFixed(1)} hp`);
const h2 = I.makePlayer(9002, 'Tester2', 0, false);
G.players.push(h2);
h2.x = h.x + 60; h2.y = h.y;
ok(I.tryPickup(h2, { kind: 'armor', tier: 'light' }) && h2.armor === 'light', 'light armor is picked up');
ok(I.tryPickup(h2, { kind: 'armor', tier: 'heavy' }) && h2.armor === 'heavy', 'heavy armor replaces light');
ok(!I.tryPickup(h2, { kind: 'armor', tier: 'light' }) && h2.armor === 'heavy', 'light armor does not replace heavy');

console.log('-- medallion');
ok(I.tryPickup(h2, { kind: 'medal' }) === true, 'medallion goes into a hotbar slot');
ok(I.tryPickup(h2, { kind: 'medal' }) === false, 'a player holds only one medallion');
const snap = I.buildSnapshot();
const e2 = snap.p.find(a => a[0] === h2.id), e1 = snap.p.find(a => a[0] === h.id);
ok(e2 && e2[19] === 1, 'snapshot flags the medallion holder (index 19)');
ok(e1 && e1[19] === 0, 'snapshot does not flag players without a medallion');
ok(snap.p.filter(a => a[18] === 1).length === pois.length, 'snapshot flags every boss (index 18)');

console.log('-- auto pickup');
const hp = I.makePlayer(9010, 'Walker', 0, false);   // a human with auto pick left off (the default)
G.players.push(hp);
hp.x = 1000; hp.y = 1000;
const ammoL = { id: 91001, x: 1000, y: 1000, kind: 'ammo', at: 'light', count: 10 };
const matL = { id: 91002, x: 1005, y: 1000, kind: 'mats', m: 'wood', amount: 20 };
const gunL = { id: 91003, x: 1002, y: 1000, kind: 'weapon', w: 0, r: 0, ammo: 0 };
G.loot.set(ammoL.id, ammoL); G.loot.set(matL.id, matL); G.loot.set(gunL.id, gunL);
I.autoPickup(hp);
ok(hp.ammo.light === 10, 'ammo is picked up on walk-over with auto pick off');
ok(hp.mats.wood === 20, 'materials are picked up on walk-over with auto pick off');
ok(!hp.slots.some(s => s && s.kind === 'weapon'), 'a weapon still needs E with auto pick off');
ok(!G.loot.has(ammoL.id) && !G.loot.has(matL.id) && G.loot.has(gunL.id), 'only the ammo and materials leave the ground');
hp.client = { autoPick: true };
I.autoPickup(hp);
ok(hp.slots.some(s => s && s.kind === 'weapon'), 'with auto pick on the weapon is picked up too');

console.log('-- bosses wait for the bus');
G.state = 'bus';
ok(!I.buildSnapshot().p.some(a => a[18] === 1), 'bosses are hidden from the snapshot while the bus flies');
G.state = 'active';

console.log('-- bosses fight');
const b0 = bosses[0];
// a player 260 px from boss 0, inside its sight and leash
const spot = [b0.boss.cx + 260, b0.boss.cy];
const fighter = I.makePlayer(9003, 'Bait', 0, false);
G.players.push(fighter);
[fighter.x, fighter.y] = spot;
fighter.hp = 100000;   // keep it alive so the test measures shots, not deaths
// count the boss's shots as they leave: bullets are removed when they hit, so check after every tick
let bossShots = 0;
for (let i = 0; i < 60; i++) {
  const seen = new Set(G.bullets);
  G.matchTime = 0;
  G.aliveCount = Math.max(2, G.players.filter(p => !p.boss && p.alive).length);
  I.tick();
  for (const bl of G.bullets) if (!seen.has(bl) && bl.owner === b0.id) bossShots++;
}
ok(bossShots > 0, `boss fires at a fighter in sight (${bossShots} shots from boss 0)`);
ok(fighter.hp < 100000, 'the fighter takes boss damage');

console.log('-- drops');
const before = G.loot.size;
const acBefore = G.aliveCount;
const realRandom = Math.random;
Math.random = () => 0;   // every roll succeeds, so the medallion drop is guaranteed for this check
try { I.killPlayer(b0, null, 'test'); } finally { Math.random = realRandom; }
const drops = [...G.loot.values()].slice(before);
ok(drops.some(l => l.kind === 'armor' && l.tier === 'heavy'), 'boss drops its heavy armor');
ok(drops.some(l => l.kind === 'medal'), 'boss drops a medallion on a successful roll');
ok(drops.some(l => l.kind === 'weapon' && l.w === S.WIDX[S.BOSS.weapon]), 'boss drops its rifle');
ok(G.aliveCount === acBefore, 'boss death leaves aliveCount alone');
ok(!b0.alive, 'dead boss is out of play');

console.log('-- rounds');
// fighters left: h, h2, fighter. Kill them all; bosses still standing must not keep the round alive.
const aliveHumans = () => G.players.filter(p => !p.boss && p.alive);
for (const p of aliveHumans()) I.killPlayer(p, null, 'test');
ok(G.state !== 'active', `round ends when the last player falls, bosses still up (state ${G.state})`);
ok(bosses.filter(b => b.alive).length > 0, 'bosses are still standing at the end');

console.log('-- armor on death');
G.state = 'active';
const dying = I.makePlayer(9004, 'Dying', 0, false);
dying.armor = 'light';
G.players.push(dying);
const beforeArmor = G.loot.size;
I.killPlayer(dying, null, 'test');
const armorDrops = [...G.loot.values()].slice(beforeArmor);
ok(armorDrops.some(l => l.kind === 'armor' && l.tier === 'light'), 'a player who dies drops their armor');

console.log('-- errors');
ok(tickErrors === 0, `no tick errors (${tickErrors})`);
console.error = origErr;

console.log(`\n=== BOSS RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
