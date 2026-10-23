#!/usr/bin/env node
/* Knocked states (duo): a hit that would kill a player with a living teammate knocks them instead.
   A knocked player bleeds out, can be finished by any hit, is revived by a teammate holding E in reach,
   and dies with their teammate. The storm never knocks. Runs in-process on core.js. */
'use strict';
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const file = path.join(__dirname, 'core.js');
const req = createRequire(file);
let src = fs.readFileSync(file, 'utf8');
src = src.replace('return { acceptSocket, start, stop', 'return { G: () => G, tick, startMatch, damagePlayer, killPlayer, acceptSocket, start, stop');
src = src.replace('if (humans.length === 0 && G.matchTime > 3) {', 'if (false) {');
src = src.replace('function killPlayer(victim, attacker, cause) {', 'function killPlayer(victim, attacker, cause) { global.__deaths.push(cause);');
global.__deaths = [];
const mod = new Function('require', 'module', 'exports', '__filename', '__dirname', src + '\nreturn { createGame };')(req, { exports: {} }, {}, file, __dirname);
const S = req(path.join(__dirname, 'shared.js'));
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

// a fresh match with a known cast: A and B are one duo team, E is an enemy team. Everyone else is taken out of the way.
function setup(mode) {
  const g = mod.createGame({ bots: 100, fast: false, mode });
  g.startMatch();
  const G = g.G();
  let guard = 0;
  while (G.state !== 'active' && guard++ < 5000) g.tick();   // let the bus run out
  const ps = G.players;
  const A = ps[0], B = ps[1], E = ps[2];
  for (const p of ps) { if (p === A || p === B || p === E) continue; p.alive = false; }
  for (const p of [A, B, E]) { p.ph = S.PH.ground; p.alt = 0; p.hp = 100; p.shield = 0; p.bot = false; p.pending = []; p.input.mx = 0; p.input.my = 0; p.input.fire = false; p.input.r = false; }
  A.team = 1; B.team = 1; E.team = 9;
  // near the island centre, so the spot is land whatever the map size
  const cx = S.WORLD / 2, cy = S.WORLD / 2;
  A.x = cx; A.y = cy; B.x = cx + 40; B.y = cy; E.x = cx + 600; E.y = cy + 600;
  A.kills = 0; B.kills = 0; E.kills = 0;
  return { g, G, A, B, E };
}
const ticks = (g, n) => { for (let i = 0; i < n; i++) g.tick(); };

console.log('[2] duo: a hit that would kill is a knock');
{
  const { g, G, A, B, E } = setup('duo');
  G.players.forEach(p => { if (p.alive && !p.bot) p.bot = false; });
  g.damagePlayer(A, 300, E, 'ar');
  ok(A.alive && A.kn, 'A is knocked, not dead');
  ok(A.hp === 0, 'A has 0 hp while knocked');
  ok(A.knT === S.KNOCK.bleed, `A bleeds for ${S.KNOCK.bleed}s`);
  ok(A.knBy === E, 'the knock is credited to the attacker');
  g.damagePlayer(A, 5, E, 'ar');
  ok(A.alive && A.kn, 'a fresh knock is safe for a moment (grace), so it can be seen and revived');
  A.knGrace = 0;
  g.damagePlayer(A, 5, E, 'ar');
  ok(!A.alive, 'after the grace, the next hit finishes a knocked player');
  ok(E.kills === 1, 'the finisher gets the kill');
}

console.log('[3] duo: revive by a teammate holding E');
{
  const { g, G, A, B, E } = setup('duo');
  g.damagePlayer(A, 300, E, 'ar');
  ok(A.kn, 'A knocked');
  B.input.r = true; B.input.mx = 0; B.input.my = 0;
  let n = 0;
  while (A.kn && n < 200) { g.tick(); n++; }
  ok(!A.kn && A.alive, `A is revived after ${(n / 20).toFixed(1)}s`);
  ok(A.hp === S.KNOCK.hp, `A comes back on ${S.KNOCK.hp} hp`);
  ok(A.revT === 0, 'revive progress resets');
  B.input.r = false;
}

console.log('[4] duo: a revive needs the reviver to stand still and be in reach');
{
  const { g, A, B, E } = setup('duo');
  g.damagePlayer(A, 300, E, 'ar');
  B.x = A.x + 300; B.input.r = true;               // too far
  ticks(g, 80);
  ok(A.kn && A.revT === 0, 'nobody revives from 300 units away');
  B.x = A.x + 30; B.input.mx = 1; B.input.r = true; // moving
  ticks(g, 80);
  ok(A.kn && A.revT === 0, 'nobody revives while moving');
  B.input.mx = 0; B.input.my = 0;
  B.x = A.x + 30; B.y = A.y;                      // it walked off while moving: back in reach
  ticks(g, 20);
  ok(A.revT > 0, 'standing still in reach starts the revive');
  B.input.r = false;
}

console.log('[5] duo: bleed-out');
{
  const { g, A, B, E } = setup('duo');
  g.damagePlayer(A, 300, E, 'ar');
  A.knT = 1.0;
  global.__deaths = [];
  ticks(g, 40);
  ok(!A.alive, 'A bleeds out');
  ok(global.__deaths.includes('bleed'), 'the death is a bleed-out');
}

console.log('[6] duo: a knocked player dies with their teammate');
{
  const { g, A, B, E } = setup('duo');
  g.damagePlayer(A, 300, E, 'ar');
  g.killPlayer(B, E, 'ar');
  ok(!B.alive, 'B dies');
  ok(!A.alive, 'A dies too, nobody left to revive them');
}

console.log('[7] duo: the second member of a team is not knocked while the first is down');
{
  const { g, A, B, E } = setup('duo');
  g.damagePlayer(A, 300, E, 'ar');
  g.damagePlayer(B, 300, E, 'ar');
  ok(!B.alive, 'B dies outright: there is no one to revive B');
  ok(!A.alive, 'A dies with B');
}

console.log('[8] the storm never knocks');
{
  const { g, A, B } = setup('duo');
  g.damagePlayer(A, 300, null, 'storm');
  ok(!A.kn && !A.alive, 'a storm kill is a plain death');
}

console.log('[9] solo: no knocks, a hit is a kill');
{
  const { g, A, E } = setup('solo');
  A.team = 0; E.team = 0;
  g.damagePlayer(A, 300, E, 'ar');
  ok(!A.alive && !A.kn, 'solo player dies outright');
}

console.log(`\n=== KNOCK RESULTS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
