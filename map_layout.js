'use strict';
// ============================================================
//  FORTLITE map layout (hand made)
//  Each point of interest is built from rooms. A room is a box [x0, y0, x1, y1] in
//  wall cells (one cell = 60 px). Rooms may overlap, which makes L, T and stepped
//  footprints and interior partitions. A room's edge is a wall, its inside is floor.
//  Doors are gaps in a wall cell. Chests are 'C' (normal) or 'L' (legendary: epic or
//  better). Props: 'X' crate, 'T' tree, 'R' rock, 'B' bush, 'P' pond (all block).
//  Lines are extra walls (fences) as [x0, y0, x1, y1] with straight ends.
//  x, y is the world position of the layout's centre. rot turns it in quarter turns.
// ============================================================

const POIS = [
  // ---- centre: the town and the hub ------------------------------------------
  { n: 'Lantern Market', k: 'town', x: 8000, y: 8000, rot: 0,
    rooms: [
      [1, 1, 8, 5], [1, 5, 5, 8],           // bakery: wide top, narrow foot (L)
      [12, 1, 20, 5], [15, 5, 17, 9],       // hall with a stem to the south (T)
      [1, 11, 4, 14],                       // tower
      [13, 11, 19, 14],                     // shop
    ],
    doors: [[7, 5], [8, 3], [3, 8], [12, 3], [16, 9], [13, 5], [4, 12], [13, 12]],
    chests: [[3, 2, 'C'], [4, 6, 'C'], [18, 3, 'L'], [2, 13, 'C'], [17, 13, 'C']],
    props: [[10, 7, 'P'], [10, 8, 'P'], [11, 7, 'P'], [11, 8, 'P'], [6, 10, 'B'], [14, 10, 'B']],
  },
  { n: 'Hightower Depot', k: 'town', x: 6650, y: 7150, rot: 0,
    rooms: [[0, 0, 9, 5], [7, 0, 9, 2], [11, 0, 14, 8]],   // warehouse, office inside, tower
    doors: [[4, 5], [9, 3], [7, 1], [12, 8]],
    chests: [[12, 2, 'C'], [8, 1, 'C']],
    props: [[2, 2, 'X'], [6, 3, 'X'], [2, 9, 'T'], [7, 9, 'T'], [17, 9, 'R']],
    lines: [[0, 7, 10, 7]], lineDoors: [[4, 7]],
  },
  { n: 'Brightwell Station', k: 'town', x: 9500, y: 7000, rot: 0,
    rooms: [[0, 0, 17, 4], [0, 0, 4, 4], [19, 1, 25, 3]],  // hall, ticket office inside it, a train car
    doors: [[4, 2], [2, 4], [9, 4], [17, 2], [19, 2]],
    chests: [[8, 2, 'C'], [12, 1, 'C'], [22, 2, 'L']],
    props: [[6, 6, 'X'], [10, 7, 'X'], [15, 7, 'R']],
  },

  // ---- north: snow, mountain camps -------------------------------------------
  { n: 'Frostspire Camp', k: 'quarry', x: 7300, y: 3900, rot: 0,
    rooms: [[0, 0, 4, 4], [0, 4, 2, 6], [6, 1, 11, 4], [13, 0, 16, 5]],  // cabin (L), long hall, lookout tower
    doors: [[4, 2], [1, 6], [8, 4], [13, 3]],
    chests: [[2, 2, 'C'], [9, 2, 'C'], [15, 3, 'L']],
    props: [[5, 7, 'T'], [0, 8, 'R'], [16, 8, 'R'], [9, 7, 'B']],
  },
  { n: 'Northcrest Lift', k: 'town', x: 9900, y: 4200, rot: 0,
    rooms: [[0, 0, 6, 4], [9, 1, 14, 4]],               // lift house, open-front shelter
    doors: [[3, 4], [6, 2], [10, 4], [13, 4]],
    chests: [[2, 2, 'C']],
    props: [[0, 7, 'R'], [12, 7, 'R'], [18, 6, 'T']],
  },
  { n: 'Ember Mine', k: 'industrial', x: 5900, y: 4500, rot: 0,
    rooms: [[0, 0, 10, 6], [3, 2, 6, 4], [12, 2, 14, 5]],   // shed, closet inside it, shaft house
    doors: [[4, 6], [10, 3], [3, 3], [12, 3]],
    chests: [[5, 3, 'L']],
    props: [[1, 1, 'X'], [8, 1, 'X'], [8, 5, 'X'], [1, 8, 'R'], [9, 9, 'R']],
  },

  // ---- west: forest, ruins, farms, coast -------------------------------------
  { n: 'Willow Bend', k: 'farm', x: 3300, y: 5700, rot: 0,
    rooms: [[0, 0, 5, 4], [3, 4, 5, 7], [8, 0, 13, 5], [15, 1, 17, 4]],  // farmhouse (L), barn, silo
    doors: [[0, 2], [1, 4], [5, 6], [8, 3], [10, 5], [15, 2]],
    chests: [[2, 2, 'C'], [11, 2, 'C']],
    props: [[6, 8, 'T'], [13, 8, 'T'], [9, 7, 'B'], [2, 8, 'X']],
  },
  { n: 'Mossgate Ruins', k: 'ruins', x: 3800, y: 7300, rot: 0,
    rooms: [[0, 0, 6, 5], [8, 2, 14, 8], [0, 8, 4, 11]],   // three broken rooms
    doors: [[6, 2], [3, 5], [8, 5], [11, 8], [2, 8]],
    chests: [[2, 10, 'C'], [5, 3, 'C']],
    lines: [[9, 0, 9, 1]],
    props: [[7, 10, 'R'], [5, 9, 'T'], [15, 4, 'R']],
  },
  { n: 'Ironbark Lodge', k: 'farm', x: 4200, y: 9300, rot: 0,
    rooms: [[0, 0, 10, 6], [9, 2, 15, 8]],                // main lodge and east wing
    doors: [[5, 6], [0, 3], [15, 5]],
    chests: [[2, 2, 'C'], [12, 5, 'C'], [4, 4, 'L']],
    props: [[7, 1, 'X'], [4, 8, 'B'], [1, 9, 'T']],
  },
  { n: 'Gull Point Light', k: 'coast', x: 1700, y: 7600, rot: 0,
    rooms: [[1, 0, 3, 3], [5, 1, 9, 4]],                  // lighthouse, keeper's house
    doors: [[2, 3], [5, 3]],
    chests: [[2, 1, 'C'], [8, 2, 'C']],
    props: [[0, 5, 'R'], [6, 6, 'R']],
  },

  // ---- south-west: marsh, shacks, works, harbour -----------------------------
  { n: 'Blackfen Shacks', k: 'farm', x: 6200, y: 11700, rot: 0,
    rooms: [[0, 0, 4, 3], [6, 1, 10, 4], [3, 6, 7, 9]],   // three shacks on stilts
    doors: [[2, 3], [6, 3], [5, 6]],
    chests: [[2, 1, 'C'], [9, 2, 'L']],
    props: [[9, 7, 'P'], [1, 7, 'P'], [11, 9, 'P']],
  },
  { n: 'Saltmarsh Works', k: 'industrial', x: 8200, y: 11400, rot: 0,
    rooms: [[0, 0, 11, 6], [7, 0, 11, 3], [13, 2, 15, 6]],  // hall, office inside it, silo
    doors: [[11, 3], [4, 6], [7, 2], [13, 4]],
    chests: [[9, 1, 'C']],
    props: [[2, 2, 'X'], [2, 3, 'X'], [8, 5, 'X'], [17, 0, 'R'], [1, 8, 'P']],
  },
  { n: 'Fogbank Harbor', k: 'coast', x: 8200, y: 14000, rot: 0,
    rooms: [[0, 0, 5, 4], [0, 6, 6, 9], [9, 4, 12, 6]],   // two houses and a pier shed
    doors: [[5, 2], [6, 7], [9, 5]],
    chests: [[2, 2, 'C'], [4, 8, 'C']],
    props: [[7, 1, 'T'], [9, 0, 'R']],
  },

  // ---- south-east: plains and the desert -------------------------------------
  { n: 'Rustwater Yard', k: 'industrial', x: 10200, y: 10700, rot: 0,
    rooms: [[0, 0, 8, 5], [11, 0, 13, 2], [11, 4, 13, 6], [4, 8, 7, 10]],   // workshop, two containers, pump house
    doors: [[0, 3], [8, 2], [11, 1], [13, 5], [5, 8]],
    chests: [[3, 2, 'C'], [6, 3, 'C']],
    props: [[2, 4, 'X'], [9, 7, 'X']],
  },
  { n: 'Sandsong Oasis', k: 'town', x: 12300, y: 9500, rot: 0,
    rooms: [[0, 1, 4, 4], [9, 1, 13, 4], [4, 8, 8, 11]],    // huts around a pond
    doors: [[4, 2], [9, 2], [6, 8]],
    chests: [[2, 2, 'C'], [11, 2, 'C']],
    props: [[6, 4, 'P'], [7, 4, 'P'], [6, 5, 'P'], [7, 5, 'P'], [1, 7, 'T'], [12, 8, 'T'], [5, 1, 'B']],
  },
  { n: 'Dune Hollow', k: 'ruins', x: 12200, y: 7200, rot: 0,
    rooms: [[0, 0, 7, 4], [9, 0, 13, 3]],                   // temple and a broken hall
    doors: [[7, 2], [3, 4], [11, 3]],
    chests: [[2, 2, 'C'], [5, 2, 'L']],
    props: [[9, 6, 'R'], [12, 6, 'R']],
  },
  { n: 'Eastwind Depot', k: 'industrial', x: 11300, y: 5600, rot: 0,
    rooms: [[0, 0, 6, 4], [8, 0, 14, 4], [9, 6, 11, 8]],    // two hangars and a control hut
    doors: [[6, 2], [8, 2], [9, 7]],
    chests: [[3, 2, 'C'], [11, 2, 'C']],
    props: [[7, 6, 'X'], [2, 6, 'R']],
  },
  { n: 'Glasswater Dock', k: 'coast', x: 13800, y: 6700, rot: 0,
    rooms: [[0, 0, 5, 4], [7, 2, 11, 6]],                   // lodge and boathouse
    doors: [[2, 4], [7, 4]],
    chests: [[3, 2, 'C'], [9, 4, 'C']],
    props: [[6, 0, 'T']],
  },
];

// Roads: hand-drawn polylines in world pixels. Each one joins two places.
const ROADS = [
  [[8000, 8000], [7400, 7600], [6650, 7150]],       // Lantern Market -> Hightower
  [[8000, 8000], [8800, 7500], [9500, 7000]],       // Lantern Market -> Brightwell
  [[8000, 8000], [9000, 9400], [10200, 10700]],     // Lantern Market -> Rustwater
  [[8000, 8000], [8100, 9600], [8200, 11400]],      // Lantern Market -> Saltmarsh
  [[9500, 7000], [9800, 5600], [9900, 4200]],       // Brightwell -> Northcrest
  [[7300, 3900], [8600, 4000], [9900, 4200]],       // Frostspire -> Northcrest
  [[7300, 3900], [5900, 4500], [5600, 5600], [3300, 5700]], // Frostspire -> Willow
  [[3300, 5700], [3500, 6500], [3800, 7300]],       // Willow -> Mossgate
  [[3800, 7300], [4000, 8300], [4200, 9300]],       // Mossgate -> Ironbark
  [[6650, 7150], [5300, 8000], [4200, 9300]],       // Hightower -> Ironbark
  [[4200, 9300], [2800, 8800], [1700, 7600]],       // Ironbark -> Gull Point
  [[4200, 9300], [5000, 10500], [6200, 11700]],     // Ironbark -> Blackfen
  [[6200, 11700], [7200, 11600], [8200, 11400]],    // Blackfen -> Saltmarsh
  [[8200, 11400], [9200, 11000], [10200, 10700]],   // Saltmarsh -> Rustwater
  [[10200, 10700], [11200, 10200], [12300, 9500]],  // Rustwater -> Sandsong
  [[12300, 9500], [12400, 8400], [12200, 7200]],    // Sandsong -> Dune Hollow
  [[12200, 7200], [11800, 6400], [11300, 5600]],    // Dune -> Eastwind
  [[11300, 5600], [10600, 4900], [9900, 4200]],     // Eastwind -> Northcrest
  [[9500, 7000], [10800, 7000], [12200, 7200]],     // Brightwell -> Dune
  [[12200, 7200], [13000, 6900], [13800, 6700]],    // Dune -> Glasswater
  [[8200, 11400], [8200, 12700], [8200, 14000]],    // Saltmarsh -> Fogbank
];

// Compile a POI's rooms, doors, chests, props and lines into text rows ('#', '.', 'D', 'C', 'L', 'X', 'T', 'R', 'B', 'P', ' ').
// Interiors are set first and edges after, so an overlapping room's wall cuts through another room (a partition).
function compilePOI(poi) {
  const cells = new Map();
  const key = (x, y) => x + ',' + y;
  const put = (x, y, ch) => cells.set(key(x, y), ch);
  const rooms = poi.rooms || [];
  for (const [x0, y0, x1, y1] of rooms) {
    for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) put(x, y, '.');
  }
  for (const [x0, y0, x1, y1] of rooms) {
    for (let x = x0; x <= x1; x++) { put(x, y0, '#'); put(x, y1, '#'); }
    for (let y = y0; y <= y1; y++) { put(x0, y, '#'); put(x1, y, '#'); }
  }
  for (const [x0, y0, x1, y1] of poi.lines || []) {
    if (x0 === x1) for (let y = y0; y <= y1; y++) put(x0, y, '#');
    else for (let x = x0; x <= x1; x++) put(x, y0, '#');
  }
  for (const [x, y] of poi.lineDoors || []) put(x, y, 'D');
  for (const [x, y] of poi.doors || []) put(x, y, 'D');
  for (const [x, y, t] of poi.chests || []) put(x, y, t);
  for (const [x, y, t] of poi.props || []) put(x, y, t);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of cells.keys()) {
    const [x, y] = k.split(',').map(Number);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const rows = [];
  for (let y = minY; y <= maxY; y++) {
    let s = '';
    for (let x = minX; x <= maxX; x++) s += cells.get(key(x, y)) || ' ';
    rows.push(s);
  }
  return { rows, minX, minY };
}

// Turn a plan by quarter turns (clockwise). Returns an array of strings.
function turnPlan(plan, rot) {
  let g = plan.map(r => r.split(''));
  for (let t = 0; t < (rot & 3); t++) {
    const h = g.length, w = Math.max(...g.map(r => r.length));
    const out = [];
    for (let c = 0; c < w; c++) {
      const row = [];
      for (let r = h - 1; r >= 0; r--) row.push(g[r][c] || ' ');
      out.push(row);
    }
    g = out;
  }
  return g.map(r => r.join(''));
}

module.exports = { POIS, ROADS, compilePOI, turnPlan };
