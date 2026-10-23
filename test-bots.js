#!/usr/bin/env node
/* Bot quality, measured on bot-only matches (no humans, so the end check is off):
     storm   : bot-seconds spent outside the circle while the storm is active, and the longest stay
     bus     : bots that jump after the bus has passed the map centre, and landings on the map edge
     duo     : knocks and revives in duo rooms
   Usage: node test-bots.js [dir-with-core.js] (default: this repo). Runs in-process; no server. */
'use strict';
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const dir = path.resolve(process.argv[2] || __dirname);
const file = path.join(dir, 'core.js');
const req = createRequire(file);
let src = fs.readFileSync(file, 'utf8');
// expose the internals the metrics need, and count knocks and revives
const expose = 'return { G: () => G, tick, startMatch, damagePlayer, killPlayer, ';
if (!src.includes('return { acceptSocket, start, stop')) throw new Error('core.js: exposure point not found');
src = src.replace('return { acceptSocket, start, stop', expose + 'acceptSocket, start, stop');
src = src.replace('if (humans.length === 0 && G.matchTime > 3) {', 'if (false) {');
src = src.replace('function knockPlayer(v, attacker) {', 'function knockPlayer(v, attacker) { global.__cnt = global.__cnt || {}; global.__cnt.knock = (global.__cnt.knock || 0) + 1;');
src = src.replace('function reviveKnocked(q, by) {', 'function reviveKnocked(q, by) { global.__cnt = global.__cnt || {}; global.__cnt.revive = (global.__cnt.revive || 0) + 1;');
src = src.replace('function killPlayer(victim, attacker, cause) {', 'function killPlayer(victim, attacker, cause) { global.__cnt = global.__cnt || {}; global.__cnt["death:" + cause] = (global.__cnt["death:" + cause] || 0) + 1;');
const mod = new Function('require', 'module', 'exports', '__filename', '__dirname', src + '\nreturn { createGame };')(req, { exports: {} }, {}, file, dir);
const S = req(path.join(dir, 'shared.js'));
const S2 = S.S || S;   // shared.js may export the namespace directly or under S

function matchStats(mode, seed) {
  global.__cnt = {};
  const g = mod.createGame({ bots: 100, fast: false, mode });
  g.startMatch();
  const G = g.G();
  const W = S2.WORLD, span = S2.BUS.span;
  const pts = G.pois.map(p => ({ x: p.x, y: p.y }));
  const prevPh = new Map();
  const jumps = []; const landings = [];
  let stormBotSec = 0, botSec = 0, longest = 0;
  const run = new Map();   // bot id -> seconds in a row outside the storm
  const DT = 1 / 20;
  let guard = 0;
  while (G.state !== 'end' && G.matchTime < 1400 && guard++ < 120000) {
    g.tick();
    // bus: record jump progress and landing spots
    if (G.bus && (G.state === 'bus' || G.state === 'active')) {
      const prog = Math.min(G.bus.t, G.bus.dur) * G.bus.speed;
      for (const p of G.players) {
        const was = prevPh.get(p.id);
        if (was === S2.PH.bus && p.ph === S2.PH.fall) jumps.push({ prog, after: prog > span });
        if (was === S2.PH.fall && p.ph === S2.PH.ground) landings.push({ x: p.x, y: p.y });
        prevPh.set(p.id, p.ph);
      }
    }
    // storm: bots outside the circle while it is active
    const st = G.storm;
    if (G.state === 'active' && st && st.phase >= 0) {
      for (const p of G.players) {
        if (!p.alive || !p.bot) continue;
        botSec += DT;
        const out = S2.dist(p.x, p.y, st.cx, st.cy) > st.r;
        if (out) { stormBotSec += DT; const r = (run.get(p.id) || 0) + DT; run.set(p.id, r); if (r > longest) longest = r; }
        else run.set(p.id, 0);
      }
    }
    if (G.state === 'active' && G.matchTime > 1300) break;
  }
  // how spread out the landings are: the share of all landings in the busiest 600x600 square
  const cells = new Map();
  for (const l of landings) { const k = Math.floor(l.x / 600) + ',' + Math.floor(l.y / 600); cells.set(k, (cells.get(k) || 0) + 1); }
  const busiest = landings.length ? Math.max(...cells.values()) / landings.length : 0;
  const edge = landings.filter(l => l.x < 40 || l.y < 40 || l.x > W - 40 || l.y > W - 40).length;
  const nearPoi = landings.filter(l => pts.some(q => S2.dist(l.x, l.y, q.x, q.y) < 350)).length;
  const after = jumps.filter(j => j.after).length;
  return {
    stormShare: botSec ? +(stormBotSec / botSec).toFixed(4) : 0,
    stormBotSec: +stormBotSec.toFixed(1), longestStormSec: +longest.toFixed(1),
    jumps: jumps.length, jumpsAfterCentre: after, landings: landings.length, edgeLandings: edge,
    nearPoiShare: landings.length ? +(nearPoi / landings.length).toFixed(2) : 0,
    busiestSquareShare: +busiest.toFixed(2),
    counts: global.__cnt,
  };
}

const runs = +(process.env.RUNS || 3);
const solo = [], duo = [];
for (let i = 0; i < runs; i++) solo.push(matchStats('solo'));
for (let i = 0; i < runs; i++) duo.push(matchStats('duo'));
const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
const agg = {
  solo: { stormShare: +(sum(solo, 'stormShare') / runs).toFixed(4), longestStormSec: Math.max(...solo.map(r => r.longestStormSec)),
    jumps: sum(solo, 'jumps'), jumpsAfterCentre: sum(solo, 'jumpsAfterCentre'), landings: sum(solo, 'landings'), edgeLandings: sum(solo, 'edgeLandings'),
    nearPoiShare: +(sum(solo, 'nearPoiShare') / runs).toFixed(2), busiestSquareShare: +(Math.max(...solo.map(r => r.busiestSquareShare))).toFixed(2) },
  duo: { stormShare: +(sum(duo, 'stormShare') / runs).toFixed(4), longestStormSec: Math.max(...duo.map(r => r.longestStormSec)),
    jumps: sum(duo, 'jumps'), jumpsAfterCentre: sum(duo, 'jumpsAfterCentre'), landings: sum(duo, 'landings'), edgeLandings: sum(duo, 'edgeLandings'),
    knocks: duo.reduce((a, r) => a + ((r.counts && r.counts.knock) || 0), 0), revives: duo.reduce((a, r) => a + ((r.counts && r.counts.revive) || 0), 0),
    bleedDeaths: duo.reduce((a, r) => a + ((r.counts && r.counts['death:bleed']) || 0), 0) },
};
console.log(JSON.stringify(agg, null, 1));
