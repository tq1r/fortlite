# FORTLITE

A 2D top-down battle royale with real building — loot weapons, harvest materials,
throw up walls, outlast the Fade, and take the Victory Royale. Made to play
with friends over the internet. **Zero dependencies** — the whole game is plain
Node.js + HTML5 canvas.

Loot. Build. Outlast.

---

## Quick start

You need Node.js 16+ (no `npm install` needed — there are no packages!):

```bash
node server.js
```

Open http://localhost:3000 in your browser. Set your nickname, then queue
**SOLO** (everyone for themselves) or **DUO** (teams of two — win as a pair).
The server fills the match with AI bots, so you can play instantly even alone.

## How to play with friends

The game is a server + clients. Whoever runs the server shares one link;
everyone else just opens it in a browser. Pick one:

### Option A — Free cloud hosting (works over the internet, recommended)

The app is a single zero-dependency Node service, so it deploys anywhere in
about 2 minutes:

**Render.com (free tier):**
1. Push this folder to a GitHub repo.
2. On render.com: New, Web Service, connect the repo.
3. Build command: (leave empty) — Start command: `node server.js`.
4. Share the public URL with your friends.

**Railway / Fly.io / Glitch:** same idea — a Node service with `node server.js`
as the start command, exposing port 3000 (the server honors the `PORT` env
variable too).

### Option B — Same network (LAN)

1. Run `node server.js` on your machine.
2. Find your local IP:
   - Windows: `ipconfig` — look for IPv4 Address
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
3. Friends open `http://YOUR_IP:3000` in a browser.

### Option C — Tunnel (play over the internet without a cloud account)

Run a tunnel (for example `cloudflared tunnel --url http://localhost:3000`
or an ngrok tunnel) and share the generated URL.

## Controls

| Key | Action |
| --- | --- |
| **WASD** | Move |
| **Mouse** | Aim |
| **LMB** | Shoot / swing pickaxe / place wall |
| **Q** | Toggle build mode |
| **Z X C** | Wood / stone / metal wall |
| **1–5** | Select slot |
| **R** | Reload |
| **E** | Open chest / interact |
| **G** | Drop item |
| **Space** | Jump from the Battle Bus (on the bus, then steer the skydive with WASD) |
| **M** | Mute |
| **Enter** | Quick-queue Solo from the menu |
| **Arrows** | Switch spectate target (after dying) |

Tips: swing your pickaxe at trees, rocks and metal crates for materials.
Chests hold the best loot. The Fade (the shrinking zone) hurts — watch the
timer at the top of the screen and the white next-circle on the map.

## The game

- **Spawn island** — everyone waits on the island in the middle of the map
  while the lobby countdown runs. Walk around, then the Battle Bus departs.
- **Battle Bus** — the bus flies across the map along a random route. Press
  **Space** over the map to jump, then steer with WASD to a named POI. You
  cannot shoot or build until you land. Everyone is out of the bus before
  the match goes live.
- **POIs** — seven named points of interest (towns, depots and outposts) with
  better loot. The camera zooms out during the bus and skydive so you can
  see the labels. The minimap shows them as dots.
- **Solo** — classic free-for-all. Last player standing takes the Victory Royale.
- **Duo** — squads of two. Pick a team in the lobby (or let Auto pair you)
  and win together. The lobby votes with its mode buttons; majority rules.
- **Building** — harvest wood / stone / metal, then place walls to block
  bullets and movement. Walls have HP by material; pickaxe them back down.
- **Weapons** — Pistol, SMG, Shotgun, Assault Rifle and Sniper Rifle in four
  rarity tiers. Light / medium / heavy / shell ammo.
- **Consumables** — Mini potion, Shield potion and Medkit.
- **The Fade** — the shrinking zone. It forms, waits, then closes in seven
  phases, dealing more damage each time. Final circle: radius zero.
- **Season profile** — wins and eliminations earn XP and season tiers
  (Rookie through Victory Royale), tracked in your browser.

## Credits

Gun sprites: "2D Guns" by Kay Lousberg, CC0 (public domain). See
`public/assets/guns/CREDITS.txt`.

## Server options

```bash
node server.js --port 3000 --bots 12 --fast --nostorm
```

| Flag | Meaning |
| --- | --- |
| `--port N` | Port to listen on (default 3000, `PORT` env works too) |
| `--bots N` | Fill matches to N players with bots (default 12) |
| `--fast` | Fast storm timings + short lobby (for testing) |
| `--nostorm` | Disable the Fade entirely (deathmatch vibes) |

## Project layout

```
server.js          zero-dependency HTTP + WebSocket server, authoritative sim
shared.js          constants shared by server and client (weapons, teams, storm)
public/index.html  menu + HUD markup
public/style.css   all styling
public/game.js     rendering, prediction, interpolation, FX, audio
test.js            protocol test: lobby, match flow, combat, end
test-gameplay.js   gameplay test: harvest, build, loot, shoot, win
test-client.js     headless client smoke test (menu, HUD, events)
```

Run the test suite with `npm test`.

## Tuning the game

Everything lives in `shared.js`:
- `S.WEAPONS` — damage, rate of fire, magazine, spread, range per weapon
- `S.STORM` — the Fade's phases, timing and damage
- `S.SPEED`, `S.PLAYER_R` — movement speed and body size
- `S.MAT_HP` — wall HP per material
- `S.TEAMS` / `S.PICKABLE_TEAMS` — duo team colors and lobby team buttons

## How it works (nerd corner)

- One authoritative server tick (20 Hz); clients send inputs and render
  interpolated snapshots, with local prediction + reconciliation for your
  own player.
- The server implements WebSocket from scratch (no `ws` package), plus a
  tiny static file server. That's the whole dependency list: zero.
- Bots use a small state machine: loot, hunt, fight, flee to the circle.

## Roadmap

Cosmetics and skins, more weapons, rifts and jump pads, squad mode (4s),
persistent leaderboards. The bot API is intentionally simple so new
behaviors are easy to bolt on.

Have fun — and watch out for SweatyPete.
