// Fortlite art layer. Everything here is drawn once into offscreen canvases
// (sprites and ground tiles) and reused, so the per-frame loop only copies images.
// Gameplay never reads this file; it only changes how things look.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const TILE = 600;                       // world units per ground tile
  const TILE_PX = 300;                    // baked resolution (scaled up when drawn)
  const RES = Math.min(2, window.devicePixelRatio || 1);   // sprite sharpness on hi-dpi screens
  const sprites = new Map();
  const tiles = new Map();
  let W = null;                           // current match world
  let bakedThisFrame = 0;

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  // deterministic random from a seed (xorshift)
  function rnd(seed) {
    let s = (seed | 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  }
  function h2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    return 0.55 * vnoise(x / 90, y / 90) + 0.3 * vnoise(x / 31 + 5, y / 31 + 9) + 0.15 * vnoise(x / 9 + 2, y / 9 + 3);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Sprite cache: draw(g) runs once with the origin at the sprite centre, in world units.
  function sprite(key, size, draw) {
    let c = sprites.get(key);
    if (!c) {
      c = mk(size * RES, size * RES);
      const g = c.getContext('2d');
      g.setTransform(RES, 0, 0, RES, size * RES / 2, size * RES / 2);
      draw(g);
      sprites.set(key, c);
    }
    return c;
  }
  function blit(g, c, x, y, size) { g.drawImage(c, x - size / 2, y - size / 2, size, size); }

  // ---------- ground tiles (grass + sand + water, baked from the world's lakes) ----------
  const DARK = [74, 116, 50], MID = [104, 150, 66], LIGHT = [132, 176, 84];
  function bakeTile(tx, ty) {
    const c = mk(TILE_PX, TILE_PX);
    const g = c.getContext('2d');
    const K = TILE_PX / TILE;             // px per world unit
    const ox = tx * TILE, oy = ty * TILE;
    const img = g.createImageData(TILE_PX, TILE_PX);
    const d = img.data;
    for (let j = 0; j < TILE_PX; j++) {
      for (let i = 0; i < TILE_PX; i++) {
        const wx = ox + i / K, wy = oy + j / K;
        const v = fbm(wx, wy);
        const sp = (h2(wx * 3.1, wy * 2.7) - 0.5) * 9;
        let r, gg, b;
        if (v < 0.5) { const t = v * 2; r = lerp(DARK[0], MID[0], t); gg = lerp(DARK[1], MID[1], t); b = lerp(DARK[2], MID[2], t); }
        else { const t = (v - 0.5) * 2; r = lerp(MID[0], LIGHT[0], t); gg = lerp(MID[1], LIGHT[1], t); b = lerp(MID[2], LIGHT[2], t); }
        const k = (j * TILE_PX + i) * 4;
        d[k] = r + sp; d[k + 1] = gg + sp; d[k + 2] = b + sp * 0.6; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    g.setTransform(K, 0, 0, K, -ox * K, -oy * K);
    // grass blades and a few dirt patches
    const r = rnd(tx * 7919 + ty * 104729 + 17);
    for (let n = 0; n < 150; n++) {
      const x = ox + r() * TILE, y = oy + r() * TILE;
      const dark = r() < 0.55;
      g.strokeStyle = dark ? 'rgba(48, 88, 30, 0.45)' : 'rgba(164, 206, 110, 0.35)';
      g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 4, y - 4 - r() * 4); g.stroke();
    }
    for (let n = 0; n < 3; n++) {
      const x = ox + r() * TILE, y = oy + r() * TILE, rr = 40 + r() * 60;
      const grad = g.createRadialGradient(x, y, 0, x, y, rr);
      grad.addColorStop(0, 'rgba(140, 116, 72, 0.22)'); grad.addColorStop(1, 'rgba(140, 116, 72, 0)');
      g.fillStyle = grad; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
    }
    // lakes: sand rim, deep-to-shallow water, ripples and a foam line
    if (W && W.obstacles) {
      for (const o of W.obstacles) {
        if (o.type !== 'water') continue;
        if (o.x + o.r + 30 < ox || o.x - o.r - 30 > ox + TILE || o.y + o.r + 30 < oy || o.y - o.r - 30 > oy + TILE) continue;
        g.fillStyle = '#d6c28c';
        g.beginPath(); g.arc(o.x, o.y, o.r + 16, 0, TAU); g.fill();
        g.fillStyle = 'rgba(180, 150, 96, 0.35)';
        g.beginPath(); g.arc(o.x, o.y, o.r + 9, 0, TAU); g.fill();
        const wg = g.createRadialGradient(o.x, o.y, o.r * 0.15, o.x, o.y, o.r);
        wg.addColorStop(0, '#3aa9e4'); wg.addColorStop(1, '#1d6aa9');
        g.fillStyle = wg; g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(210, 240, 255, 0.22)'; g.lineWidth = 2;
        g.beginPath(); g.arc(o.x, o.y, o.r * 0.55, 0.3, 2.4); g.stroke();
        g.beginPath(); g.arc(o.x, o.y, o.r * 0.8, 3.4, 5.2); g.stroke();
        g.strokeStyle = 'rgba(236, 252, 255, 0.6)'; g.lineWidth = 2.5;
        g.beginPath(); g.arc(o.x, o.y, o.r + 1, 0, TAU); g.stroke();
      }
    }
    return c;
  }
  function getTile(tx, ty) {
    const key = tx + ',' + ty;
    let c = tiles.get(key);
    if (c) return c;
    if (bakedThisFrame >= 2) return null;   // spread the cost over frames
    bakedThisFrame++;
    c = bakeTile(tx, ty);
    tiles.set(key, c);
    return c;
  }
  function drawGround(g, l, t, r, b) {
    bakedThisFrame = 0;
    const size = W ? W.size : 3000;
    const n = Math.ceil(size / TILE);
    const x0 = Math.max(0, Math.floor(l / TILE)), x1 = Math.min(n - 1, Math.floor(r / TILE));
    const y0 = Math.max(0, Math.floor(t / TILE)), y1 = Math.min(n - 1, Math.floor(b / TILE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const c = getTile(tx, ty);
        if (c) g.drawImage(c, tx * TILE, ty * TILE, TILE, TILE);
        else { g.fillStyle = '#68963f'; g.fillRect(tx * TILE, ty * TILE, TILE, TILE); }
      }
    }
  }

  // ---------- nature: trees, bushes, rocks ----------
  function canopyDraw(g, R, seed) {
    const r = rnd(seed);
    const lobes = [];
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = i / N * TAU + r() * 0.5;
      const d = R * (0.42 + r() * 0.12), lr = R * (0.34 + r() * 0.1);
      lobes.push([Math.cos(a) * d, Math.sin(a) * d, lr]);
    }
    lobes.push([0, 0, R * 0.6]);
    const cols = ['#5b8a37', '#6a9942', '#4f7d30', '#73a54a'];
    g.fillStyle = '#243a16';
    for (const [x, y, lr] of lobes) { g.beginPath(); g.arc(x, y, lr + 2.4, 0, TAU); g.fill(); }
    for (const [x, y, lr] of lobes) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.beginPath(); g.arc(x, y, lr, 0, TAU); g.fill();
      const sh = g.createRadialGradient(x - lr * 0.3, y - lr * 0.35, lr * 0.08, x, y, lr * 1.02);
      sh.addColorStop(0, 'rgba(200, 240, 150, 0.5)'); sh.addColorStop(0.55, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(12, 30, 6, 0.42)');
      g.fillStyle = sh; g.beginPath(); g.arc(x, y, lr, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(206, 244, 160, 0.45)';
    for (let i = 0; i < 6; i++) {
      const [x, y, lr] = lobes[Math.floor(r() * lobes.length)];
      const a = r() * TAU, d = lr * (0.2 + r() * 0.4);
      g.beginPath(); g.arc(x + Math.cos(a) * d - lr * 0.2, y + Math.sin(a) * d - lr * 0.25, 1.8, 0, TAU); g.fill();
    }
  }
  function treeCanopy(g, o, alpha) {
    const R = Math.round(o.r * 1.75);
    const size = R * 2.2 + 8;
    const c = sprite('tc' + R, size, gg => canopyDraw(gg, R, R * 97 + 3));
    g.globalAlpha = alpha;
    blit(g, c, o.x, o.y, size);
    g.globalAlpha = 1;
  }
  function treeShadow(g, o) {
    const R = Math.round(o.r * 1.75);
    const size = R * 2.6;
    const c = sprite('ts' + R, size, gg => {
      gg.fillStyle = 'rgba(14, 30, 8, 0.38)';
      gg.beginPath(); gg.ellipse(R * 0.16, R * 0.2, R * 1.0, R * 0.9, 0, 0, TAU); gg.fill();
      gg.fillStyle = '#6b4e2e';
      gg.beginPath(); gg.arc(0, 0, R * 0.3, 0, TAU); gg.fill();
    });
    blit(g, c, o.x, o.y, size);
  }
  function bush(g, o) {
    const R = Math.round(o.r);
    const size = R * 2.6 + 8;
    const c = sprite('bu' + R, size, gg => {
      const r = rnd(R * 31 + 5);
      const lobes = [[-R * 0.45, -R * 0.2, R * 0.66], [R * 0.45, -R * 0.25, R * 0.6], [0, R * 0.3, R * 0.72], [0, -R * 0.1, R * 0.5]];
      gg.fillStyle = '#243a16';
      for (const [x, y, lr] of lobes) { gg.beginPath(); gg.arc(x, y, lr + 2.2, 0, TAU); gg.fill(); }
      const cols = ['#4f7a36', '#5c8a3e', '#466f2f'];
      for (const [x, y, lr] of lobes) {
        gg.fillStyle = cols[Math.floor(r() * cols.length)];
        gg.beginPath(); gg.arc(x, y, lr, 0, TAU); gg.fill();
        const sh = gg.createRadialGradient(x - lr * 0.3, y - lr * 0.35, lr * 0.1, x, y, lr);
        sh.addColorStop(0, 'rgba(190, 230, 140, 0.45)'); sh.addColorStop(1, 'rgba(10, 26, 6, 0.4)');
        gg.fillStyle = sh; gg.beginPath(); gg.arc(x, y, lr, 0, TAU); gg.fill();
      }
    });
    g.globalAlpha = 0.92;
    blit(g, c, o.x, o.y, size);
    g.globalAlpha = 1;
  }
  function rock(g, o) {
    const R = Math.round(o.r);
    const size = R * 2 + 14;
    const c = sprite('rk' + R, size, gg => {
      const r = rnd(R * 53 + 11);
      const pts = [];
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + (r() - 0.5) * 0.3;
        const rr = R * (0.84 + r() * 0.16);
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      gg.fillStyle = 'rgba(16, 24, 12, 0.35)';
      gg.beginPath(); gg.ellipse(R * 0.14, R * 0.2, R * 1.02, R * 0.92, 0, 0, TAU); gg.fill();
      const path = () => { gg.beginPath(); pts.forEach(([x, y], i) => (i ? gg.lineTo(x, y) : gg.moveTo(x, y))); gg.closePath(); };
      path(); gg.fillStyle = '#c3c6ba'; gg.fill();
      gg.save(); path(); gg.clip();
      gg.fillStyle = '#e6e9de';
      gg.beginPath(); gg.ellipse(-R * 0.3, -R * 0.34, R * 0.6, R * 0.42, -0.5, 0, TAU); gg.fill();
      gg.fillStyle = '#9ea194';
      gg.beginPath(); gg.ellipse(R * 0.36, R * 0.38, R * 0.72, R * 0.4, -0.5, 0, TAU); gg.fill();
      gg.restore();
      gg.strokeStyle = '#686b62'; gg.lineWidth = 2.4; gg.lineJoin = 'round';
      path(); gg.stroke();
      gg.strokeStyle = 'rgba(70, 74, 64, 0.6)'; gg.lineWidth = 1.6;
      gg.beginPath(); gg.moveTo(-R * 0.1, R * 0.1); gg.lineTo(R * 0.2, R * 0.38); gg.lineTo(R * 0.12, R * 0.6); gg.stroke();
      gg.fillStyle = 'rgba(120, 160, 80, 0.45)';
      gg.beginPath(); gg.arc(-R * 0.45, R * 0.35, R * 0.12, 0, TAU); gg.fill();
    });
    blit(g, c, o.x, o.y, size);
  }
  function crate(g, o) {
    const R = Math.round(o.r);
    const size = R * 2 + 12;
    const c = sprite('cr' + R, size, gg => {
      const s = R * 0.95;
      gg.fillStyle = 'rgba(20, 14, 6, 0.35)';
      gg.fillRect(-s + 4, -s + 6, s * 2, s * 2);
      gg.fillStyle = '#a77142';
      gg.fillRect(-s, -s, s * 2, s * 2);
      gg.fillStyle = '#8a5a30';
      for (const y of [-s * 0.45, s * 0.1, s * 0.62]) gg.fillRect(-s, y, s * 2, s * 0.22);
      gg.fillStyle = 'rgba(255, 220, 160, 0.18)';
      gg.fillRect(-s, -s, s * 2, 4);
      gg.fillStyle = '#5d6b78';
      for (const [x, y] of [[-s, -s], [s - 7, -s], [-s, s - 7], [s - 7, s - 7]]) gg.fillRect(x, y, 7, 7);
      gg.strokeStyle = '#3e2816'; gg.lineWidth = 3;
      gg.strokeRect(-s, -s, s * 2, s * 2);
    });
    blit(g, c, o.x, o.y, size);
  }

  // ---------- building: walls and floors ----------
  const WALL_PX = 120;   // 2x the 60-unit grid cell
  function wallDraw(gg, mat, stage, flat) {
    const r = rnd(mat.length * 977 + stage * 13 + (flat ? 5 : 0));
    // drawing space is 0..WALL_PX with the top-left at 0,0
    if (mat === 'wood') {
      gg.fillStyle = '#9a7048'; gg.fillRect(0, 0, WALL_PX, WALL_PX);
      for (let i = 0; i < 4; i++) {
        const y = i * 30;
        gg.fillStyle = ['#a57a4f', '#94693f', '#a57a4f', '#8e623a'][i];
        gg.fillRect(0, y, WALL_PX, 30);
        gg.fillStyle = 'rgba(60, 36, 16, 0.35)'; gg.fillRect(0, y + 28, WALL_PX, 2);
        gg.fillStyle = 'rgba(255,220,170,0.14)'; gg.fillRect(0, y, WALL_PX, 2);
        gg.fillStyle = '#3c2612';
        gg.beginPath(); gg.arc(10, y + 15, 2, 0, TAU); gg.arc(WALL_PX - 10, y + 15, 2, 0, TAU); gg.fill();
      }
    } else if (mat === 'stone') {
      gg.fillStyle = '#6d7379'; gg.fillRect(0, 0, WALL_PX, WALL_PX);
      for (let row = 0; row < 4; row++) {
        const off = row % 2 ? 20 : 0;
        for (let k = -1; k < 3; k++) {
          const x = off + k * 40, y = row * 30;
          const left = Math.max(0, x + 1), right = Math.min(WALL_PX, x + 39);
          if (right <= left) continue;
          const tone = 128 + r() * 22;
          gg.fillStyle = `rgb(${tone}, ${tone + 3}, ${tone + 7})`;
          gg.fillRect(left, y + 1, right - left, 28);
        }
      }
      gg.fillStyle = 'rgba(255,255,255,0.12)'; gg.fillRect(0, 0, WALL_PX, 3);
    } else {
      gg.fillStyle = '#5b6878'; gg.fillRect(0, 0, WALL_PX, WALL_PX);
      for (const [x, y] of [[4, 4], [60, 4], [4, 60], [60, 60]]) {
        gg.fillStyle = '#6f7e91'; gg.fillRect(x, y, 56, 56);
        gg.fillStyle = 'rgba(255,255,255,0.18)'; gg.fillRect(x, y, 56, 2); gg.fillRect(x, y, 2, 56);
        gg.fillStyle = 'rgba(0,0,0,0.25)'; gg.fillRect(x, y + 54, 56, 2); gg.fillRect(x + 54, y, 2, 56);
        gg.fillStyle = '#b8c3d0';
        for (const [ax, ay] of [[8, 8], [48, 8], [8, 48], [48, 48]]) { gg.beginPath(); gg.arc(x + ax, y + ay, 2.2, 0, TAU); gg.fill(); }
      }
    }
    if (!flat) {
      // a raised block: lit top-left edge, shaded bottom-right edge, heavy dark outline
      gg.fillStyle = 'rgba(255,255,255,0.22)'; gg.fillRect(0, 0, WALL_PX, 5); gg.fillRect(0, 0, 5, WALL_PX);
      gg.fillStyle = 'rgba(0,0,0,0.36)'; gg.fillRect(0, WALL_PX - 12, WALL_PX, 12); gg.fillRect(WALL_PX - 12, 0, 12, WALL_PX);
      gg.strokeStyle = '#15120c'; gg.lineWidth = 6;
      gg.strokeRect(3, 3, WALL_PX - 6, WALL_PX - 6);
    } else {
      // ground-level floor: lighter, flat, only thin seams between cells
      gg.fillStyle = 'rgba(255,255,255,0.08)'; gg.fillRect(0, 0, WALL_PX, WALL_PX);
      gg.strokeStyle = 'rgba(0,0,0,0.28)'; gg.lineWidth = 3;
      gg.strokeRect(1.5, 1.5, WALL_PX - 3, WALL_PX - 3);
    }
    if (stage > 0) {
      gg.strokeStyle = 'rgba(20, 12, 6, 0.8)'; gg.lineWidth = 3; gg.lineCap = 'round';
      const cracks = stage + 1;
      for (let i = 0; i < cracks; i++) {
        let x = 20 + r() * 80, y = 10 + r() * 30;
        gg.beginPath(); gg.moveTo(x, y);
        for (let k = 0; k < 3; k++) { x += (r() - 0.5) * 30; y += 14 + r() * 14; gg.lineTo(x, y); }
        gg.stroke();
      }
      if (stage >= 3) { gg.fillStyle = 'rgba(0,0,0,0.25)'; gg.fillRect(0, 0, WALL_PX, WALL_PX); }
    }
  }
  // a 60-unit grid cell, authored at 120 px and scaled down
  function wallSprite(mat, stage, flat) {
    return sprite('w' + mat + stage + (flat ? 'f' : ''), 60, gg => {
      gg.translate(-30, -30); gg.scale(0.5, 0.5);
      wallDraw(gg, mat, stage, flat);
    });
  }
  // x, y is the top-left corner of the cell in world units
  function wall(g, x, y, mat, stage) {
    blit(g, wallSprite(mat, stage, false), x + 30, y + 30, 60);
  }
  // cast shadows of all walls, drawn before any wall so one wall's shadow never sits on another's top
  function wallShadows(g, list) {
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (const w of list) g.fillRect(w.x + 8, w.y + 10, 60, 60);
  }
  function floorCell(g, x, y, mat) {
    blit(g, wallSprite(mat, 0, true), x + 30, y + 30, 60);
  }
  function floors(g, list) {
    for (const f of list) {
      const cx = Math.round(f.w / 60), cy = Math.round(f.h / 60);
      for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) floorCell(g, f.x + i * 60, f.y + j * 60, f.mat);
    }
  }

  // ---------- players ----------
  const HAIR = ['#3a2716', '#d9a441', '#8b2e1f', '#2b2b2b', '#c9c2b0'];
  function hashId(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function playerSprite(teamCol, id) {
    const R = 20;
    const h = hashId(id);
    const hair = HAIR[h % HAIR.length];
    const style = h % 4;              // 0 bare, 1 cap, 2 helmet, 3 bare
    const outfit = teamCol || '#557a62';
    const key = 'pl' + outfit + '|' + hair + '|' + style;
    return sprite(key, R * 2 + 8, gg => {
      gg.fillStyle = 'rgba(0,0,0,0.25)';
      gg.beginPath(); gg.arc(1.5, 2, R + 1, 0, TAU); gg.fill();
      gg.fillStyle = outfit; gg.beginPath(); gg.arc(0, 0, R, 0, TAU); gg.fill();
      gg.strokeStyle = 'rgba(0,0,0,0.45)'; gg.lineWidth = 2.5;
      gg.beginPath(); gg.arc(0, 0, R - 0.5, 0, TAU); gg.stroke();
      // shoulders: a lighter band across the outfit
      gg.fillStyle = 'rgba(255,255,255,0.12)';
      gg.beginPath(); gg.ellipse(0, 4, R * 0.85, R * 0.36, 0, 0, TAU); gg.fill();
      // head from above: hair crescent, then skin
      gg.fillStyle = hair; gg.beginPath(); gg.arc(1.8, 1.6, R * 0.6, 0, TAU); gg.fill();
      gg.fillStyle = '#f2c078'; gg.beginPath(); gg.arc(-1, -0.6, R * 0.5, 0, TAU); gg.fill();
      gg.strokeStyle = '#9c6d38'; gg.lineWidth = 1.6;
      gg.beginPath(); gg.arc(-1, -0.6, R * 0.5, 0, TAU); gg.stroke();
      if (style === 1) {
        gg.fillStyle = outfit; gg.beginPath(); gg.arc(-1.5, -3, R * 0.42, Math.PI, TAU); gg.fill();
        gg.fillStyle = 'rgba(255,255,255,0.2)'; gg.beginPath(); gg.arc(-3, -5, 3, 0, TAU); gg.fill();
      } else if (style === 2) {
        gg.fillStyle = '#8c9aa6'; gg.beginPath(); gg.arc(-1, -1, R * 0.52, 0, TAU); gg.fill();
        gg.fillStyle = 'rgba(255,255,255,0.35)'; gg.beginPath(); gg.arc(-5, -6, 3.2, 0, TAU); gg.fill();
        gg.strokeStyle = '#4e5a64'; gg.lineWidth = 1.5;
        gg.beginPath(); gg.arc(-1, -1, R * 0.52, 0, TAU); gg.stroke();
      }
    });
  }
  function player(g, x, y, teamCol, id) {
    const c = playerSprite(teamCol, id);
    g.drawImage(c, x - (20 + 4), y - (20 + 4), 48, 48);
  }

  // ---------- storm ----------
  let stormPat = null;
  function stormPattern(g) {
    if (stormPat) return stormPat;
    const c = mk(28, 28);
    const cg = c.getContext('2d');
    cg.strokeStyle = 'rgba(180, 110, 255, 0.55)'; cg.lineWidth = 6;
    cg.beginPath(); cg.moveTo(-6, 34); cg.lineTo(34, -6); cg.moveTo(-6, 6); cg.lineTo(6, -6); cg.moveTo(22, 34); cg.lineTo(34, 22); cg.stroke();
    stormPat = g.createPattern(c, 'repeat');
    return stormPat;
  }

  // ---------- lifecycle ----------
  function reset(world) {
    W = world;
    tiles.clear();
  }

  window.FLArt = {
    reset, drawGround, floors, wall, wallShadows,
    treeShadow, treeCanopy, bush, rock, crate,
    player, stormPattern,
  };
})();
