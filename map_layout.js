'use strict';
// ============================================================
//  FORTLITE map layout (hand made)
//  Every point of interest (POI) is a building complex of 8 to 15 rooms. The castle has 14.
//  A room is a box [x0, y0, x1, y1] in wall cells (one cell = 60 px). Its edges are walls and
//  its inside is floor. Rooms share walls: two rooms that touch on a line share that wall, and
//  a door 'D' in that wall joins them. Every room has at least one door. Doors in an outer wall
//  are the gates. Roads run from one gate to a gate on the next place (see ROAD_PAIRS).
//  Chests: [x, y, 'C'] normal, [x, y, 'L'] legendary (epic or better).
//  Props: [x, y, 'X'] crate, 'T' tree, 'R' rock, 'B' bush, 'P' pond. Props block movement.
//  x, y is the world position of the centre of the plan's bounding box.
// ============================================================
const S = require('./shared.js');
const GRID = S.GRID;   // 60 px per cell

const POIS = [
  // ---- north: the castle, mountain camps, the lift -------------------------------
  { n: 'Frostspire Castle', k: 'castle', x: 7300, y: 3500, rot: 0,
    rooms: [
      [0, 0, 5, 7], [5, 0, 11, 7], [11, 0, 23, 7], [23, 0, 28, 7], [28, 0, 33, 7],   // north: NW tower, armoury, throne hall, chapel, NE tower
      [0, 7, 33, 25],                                                                 // courtyard (the castle yard)
      [0, 17, 5, 25], [5, 17, 11, 21], [5, 21, 11, 25], [11, 17, 15, 25], [15, 17, 19, 25], [19, 17, 23, 25], [23, 17, 28, 25], [28, 17, 33, 25],   // south: SW tower, barracks, kitchen, guard rooms, gate passage, cells, storeroom
    ],
    doors: [
      [5, 2], [11, 4], [23, 4], [28, 5],                 // north rooms to each other
      [2, 7], [8, 7], [17, 7], [25, 7], [30, 7],         // north rooms onto the courtyard
      [2, 17], [8, 17], [17, 17], [30, 17],              // south rooms onto the courtyard
      [5, 19], [8, 21], [11, 19], [11, 23], [15, 21], [19, 21], [23, 21], [28, 21],   // south rooms to each other
      [0, 13], [33, 13], [17, 25],                       // outer gates: west postern, east postern, south gate
    ],
    chests: [
      [2, 2, 'C'], [7, 2, 'C'], [9, 5, 'C'], [18, 2, 'L'], [13, 5, 'C'], [21, 5, 'C'],
      [25, 2, 'C'], [27, 5, 'C'], [31, 2, 'C'], [31, 4, 'C'],
      [2, 20, 'C'], [7, 18, 'C'], [9, 20, 'C'], [10, 24, 'C'], [13, 19, 'C'], [12, 23, 'C'],
      [21, 19, 'C'], [26, 23, 'L'], [25, 19, 'C'], [24, 21, 'C'], [30, 19, 'C'],
    ],
    props: [
      [15, 12, 'P'], [16, 12, 'P'], [15, 13, 'P'], [16, 13, 'P'],
      [4, 10, 'T'], [28, 10, 'T'], [6, 14, 'X'], [26, 14, 'X'], [9, 12, 'B'], [22, 12, 'B'],
      [7, 23, 'X'], [3, 23, 'X'], [31, 22, 'X'], [29, 24, 'X'],
    ] },

  { n: 'Northcrest Lift', k: 'town', x: 10200, y: 4000, rot: 0,
    rooms: [
      [0, 0, 5, 6], [5, 0, 10, 6], [10, 0, 15, 5], [15, 0, 20, 4],   // ticket hall, machine room, warming hut, sheds
      [0, 6, 7, 10], [7, 6, 10, 10], [10, 5, 15, 10], [15, 4, 20, 10], // shelter, toilets, store, garage
    ],
    doors: [[5, 3], [10, 2], [15, 2], [17, 4], [3, 6], [8, 6], [7, 8], [10, 7], [15, 7], [12, 5], [4, 10], [20, 7]],
    chests: [[2, 2, 'C'], [7, 2, 'C'], [13, 2, 'L'], [18, 2, 'C'], [2, 8, 'C'], [8, 9, 'C'], [12, 8, 'C'], [18, 8, 'C']],
    props: [[6, 4, 'X'], [19, 1, 'T'], [6, 9, 'R']],
  },

  { n: 'Eastwind Depot', k: 'industrial', x: 11500, y: 5600, rot: 0,
    rooms: [
      [0, 0, 6, 7], [6, 0, 11, 7], [11, 0, 15, 7], [15, 0, 19, 7], [19, 0, 24, 7],   // hangar A, parts store, hangar B (two bays), control hut
      [0, 7, 6, 13], [6, 7, 11, 13], [11, 7, 15, 13], [15, 7, 19, 13], [19, 7, 24, 13], // lounge, fuel, radio, tower, hangar C
    ],
    doors: [[6, 3], [11, 3], [15, 3], [19, 3], [3, 7], [6, 10], [8, 7], [11, 10], [13, 7], [15, 10], [17, 7], [19, 10], [21, 7], [3, 13], [22, 13], [24, 10]],
    chests: [[2, 2, 'C'], [8, 2, 'C'], [12, 2, 'C'], [17, 2, 'L'], [21, 2, 'C'], [2, 9, 'C'], [8, 10, 'C'], [13, 9, 'C'], [17, 11, 'C'], [21, 10, 'C']],
    props: [[4, 4, 'X'], [9, 4, 'X'], [13, 5, 'X'], [0, 0, 'T']],
  },

  // ---- centre: the town and the hub -----------------------------------------------
  { n: 'Hightower Depot', k: 'industrial', x: 6200, y: 7200, rot: 0,
    rooms: [
      [0, 0, 6, 7], [6, 0, 12, 4], [6, 4, 12, 7], [12, 0, 17, 7],   // loading bay, store A, store B, office
      [17, 0, 21, 3], [17, 3, 21, 8],                              // lookout, tower
      [0, 7, 8, 14], [8, 7, 15, 14], [15, 8, 20, 14], [20, 8, 24, 12], // garage W, garage E, pump house, cabin
    ],
    doors: [[6, 2], [9, 4], [12, 2], [17, 2], [19, 3], [4, 7], [8, 10], [15, 11], [20, 10], [10, 7], [4, 14], [24, 10]],
    chests: [[2, 2, 'C'], [4, 5, 'C'], [8, 2, 'C'], [10, 6, 'L'], [14, 5, 'C'], [18, 1, 'C'], [19, 6, 'C'], [2, 12, 'C'], [12, 9, 'C'], [17, 12, 'C'], [22, 10, 'C']],
    props: [[3, 2, 'X'], [1, 4, 'X'], [22, 3, 'T'], [22, 6, 'R'], [10, 9, 'B']],
  },

  { n: 'Brightwell Station', k: 'town', x: 10400, y: 7000, rot: 0,
    rooms: [
      [0, 0, 4, 7], [4, 0, 10, 7], [10, 0, 16, 7],                  // ticket office, waiting room, cafe
      [16, 1, 20, 6], [20, 1, 24, 6],                                // two train cars
      [0, 7, 6, 12], [6, 7, 12, 12], [12, 7, 16, 12],                // luggage, left luggage, restrooms
      [16, 6, 20, 11], [20, 6, 25, 11],                              // signal box, platform office
    ],
    doors: [[4, 3], [10, 3], [16, 3], [20, 3], [2, 7], [8, 7], [14, 7], [6, 9], [12, 9], [16, 9], [18, 6], [22, 6], [20, 8], [3, 12], [9, 12], [25, 8]],
    chests: [[2, 2, 'C'], [7, 2, 'C'], [12, 2, 'C'], [18, 3, 'C'], [22, 4, 'L'], [2, 9, 'C'], [8, 9, 'C'], [13, 9, 'C'], [18, 8, 'C'], [22, 9, 'C']],
    props: [[9, 4, 'X'], [14, 4, 'X']],
  },

  { n: 'Lantern Market', k: 'town', x: 8000, y: 8000, rot: 0,
    rooms: [
      [1, 1, 5, 6], [5, 1, 9, 6], [1, 6, 5, 10],                     // bakery: shop, oven, pantry
      [11, 1, 15, 6], [15, 1, 21, 6], [14, 6, 18, 10],               // town hall: west and east rooms, stem
      [23, 1, 28, 5], [23, 5, 28, 9],                                // clock tower, two floors
      [1, 12, 4, 17], [4, 12, 7, 17],                                // shops
      [10, 11, 13, 17], [13, 11, 16, 17],                            // inn: dining, rooms
      [19, 12, 24, 17],                                              // stable
      [26, 11, 28, 16], [28, 11, 31, 16],                            // two houses
    ],
    doors: [
      [5, 3], [3, 6], [7, 6], [1, 8],                                 // bakery
      [15, 3], [16, 6], [12, 6], [14, 8],                             // town hall
      [25, 5], [25, 9],                                               // clock tower
      [4, 14], [2, 17], [7, 15],                                      // shops
      [13, 14], [10, 14], [11, 17],                                   // inn
      [21, 12],                                                       // stable
      [28, 13], [26, 14], [30, 16], [31, 13],                         // houses (31,13 is an east gate)
    ],
    chests: [
      [2, 2, 'C'], [7, 2, 'C'], [2, 8, 'C'], [18, 3, 'L'], [16, 8, 'C'], [24, 2, 'C'], [26, 7, 'C'],
      [2, 13, 'C'], [5, 15, 'C'], [11, 12, 'C'], [14, 14, 'C'], [22, 15, 'C'], [27, 13, 'C'], [30, 15, 'C'],
    ],
    props: [[10, 3, 'P'], [10, 4, 'P'], [6, 10, 'B'], [8, 16, 'X'], [29, 4, 'T'], [30, 1, 'T'], [22, 9, 'B']],
  },

  { n: 'Sandsong Oasis', k: 'town', x: 12200, y: 10000, rot: 0,
    rooms: [
      [0, 1, 5, 6], [0, 6, 5, 10],                                   // hut 1 and its store
      [9, 1, 14, 6], [9, 6, 14, 10],                                 // hut 2 and its store
      [5, 8, 9, 14],                                                 // oasis bar, between the huts
      [0, 10, 5, 16], [9, 10, 14, 16],                               // stable, storehouse
      [14, 1, 18, 6], [14, 6, 18, 12], [18, 6, 23, 12],              // well house, date store, tent
    ],
    doors: [[2, 6], [11, 6], [5, 9], [9, 9], [11, 10], [9, 12], [2, 10], [5, 12], [14, 3], [16, 6], [14, 8], [18, 9], [2, 16], [11, 16], [23, 9]],
    chests: [[2, 2, 'C'], [2, 8, 'C'], [11, 2, 'C'], [11, 8, 'C'], [7, 11, 'L'], [2, 13, 'C'], [11, 13, 'C'], [16, 2, 'C'], [16, 9, 'C'], [20, 8, 'C'], [20, 11, 'C']],
    props: [[6, 2, 'P'], [7, 2, 'P'], [6, 3, 'P'], [7, 3, 'P'], [21, 2, 'T'], [3, 8, 'X']],
  },

  // ---- west: forest, ruins, farms, coast -------------------------------------------
  { n: 'Willow Bend', k: 'farm', x: 2900, y: 5800, rot: 0,
    rooms: [
      [0, 0, 3, 5], [3, 0, 7, 5], [0, 5, 4, 10], [4, 5, 7, 10],    // farmhouse: kitchen, parlour, bedroom, pantry
      [9, 0, 12, 7], [12, 0, 15, 7], [15, 0, 18, 4],               // barn: hay, stalls; silo
      [4, 12, 10, 15],                                             // shed
    ],
    doors: [[3, 2], [2, 5], [5, 5], [4, 7], [12, 3], [15, 2], [10, 7], [6, 12], [0, 2], [6, 15]],
    chests: [[1, 2, 'C'], [5, 2, 'C'], [2, 8, 'C'], [5, 8, 'C'], [10, 3, 'C'], [13, 5, 'C'], [17, 2, 'C'], [7, 13, 'C']],
    props: [[11, 1, 'X'], [17, 9, 'T'], [12, 10, 'B'], [2, 13, 'T'], [16, 11, 'R']],
  },

  { n: 'Mossgate Ruins', k: 'ruins', x: 3600, y: 7400, rot: 0,
    rooms: [
      [0, 0, 6, 6], [6, 0, 12, 6], [12, 0, 18, 8],                  // chapel, vault, broken tower
      [0, 6, 6, 12], [6, 6, 12, 12], [12, 8, 18, 12],               // cellar, hall, side room
      [0, 12, 6, 18], [6, 12, 12, 18], [12, 12, 18, 18], [18, 12, 22, 18],  // crypt, hall south, hall south east, pillar room
    ],
    doors: [[6, 3], [12, 2], [3, 6], [9, 6], [6, 9], [12, 10], [15, 8], [3, 12], [9, 12], [15, 12], [6, 15], [12, 15], [18, 15], [0, 3], [22, 15], [3, 18]],
    chests: [[2, 2, 'C'], [8, 4, 'C'], [15, 4, 'L'], [2, 8, 'C'], [9, 9, 'C'], [2, 16, 'C'], [16, 10, 'C'], [8, 16, 'C'], [15, 16, 'C'], [20, 14, 'C']],
    props: [[10, 13, 'R'], [4, 4, 'T'], [3, 15, 'X'], [20, 16, 'B'], [16, 6, 'T']],
  },

  { n: 'Ironbark Lodge', k: 'farm', x: 4200, y: 9300, rot: 0,
    rooms: [
      [0, 0, 5, 7], [5, 0, 10, 7], [10, 2, 16, 8],                  // hall, kitchen, dining
      [0, 7, 5, 13], [5, 7, 10, 13], [10, 8, 16, 13],               // bedroom 1, bedroom 2, wing bedroom
      [16, 2, 20, 8], [16, 8, 22, 14],                             // storeroom, barn
      [5, 13, 10, 17], [10, 13, 16, 17],                           // shed, smokehouse
    ],
    doors: [[5, 3], [10, 4], [2, 7], [8, 7], [5, 10], [10, 10], [13, 8], [16, 4], [18, 8], [16, 10], [7, 13], [12, 13], [10, 15], [7, 17], [22, 11]],
    chests: [[2, 2, 'C'], [3, 5, 'L'], [7, 2, 'C'], [13, 4, 'C'], [2, 10, 'C'], [7, 11, 'C'], [12, 11, 'C'], [18, 5, 'C'], [20, 11, 'C'], [6, 15, 'C'], [14, 15, 'C']],
    props: [[9, 1, 'X'], [1, 15, 'B'], [12, 0, 'T'], [18, 12, 'X']],
  },

  { n: 'Gull Point Light', k: 'coast', x: 1900, y: 8000, rot: 0,
    rooms: [
      [0, 0, 5, 5], [0, 5, 5, 10],                                  // lighthouse base, stair
      [5, 0, 10, 5], [5, 5, 10, 10],                                // keeper's kitchen, bedroom
      [10, 5, 14, 10], [10, 0, 16, 5], [10, 10, 16, 14],            // store, boat shed, oil room
      [0, 10, 5, 14],                                               // dock hut
    ],
    doors: [[5, 2], [2, 5], [10, 2], [5, 7], [7, 5], [10, 7], [12, 5], [12, 10], [2, 10], [13, 14], [16, 2]],
    chests: [[2, 2, 'L'], [2, 8, 'C'], [7, 2, 'C'], [8, 7, 'C'], [12, 7, 'C'], [13, 2, 'C'], [14, 12, 'C'], [3, 12, 'C']],
    props: [[11, 11, 'X'], [6, 6, 'X']],
  },

  // ---- south-west: marsh, shacks, works, harbour -----------------------------------
  { n: 'Blackfen Shacks', k: 'farm', x: 4900, y: 11700, rot: 0,
    rooms: [
      [0, 0, 6, 5], [6, 0, 11, 5], [11, 0, 16, 5],                  // shack A, shack B, shack D
      [0, 5, 4, 10], [4, 5, 11, 10], [11, 5, 16, 11],               // net store, bait room, boathouse
      [0, 10, 6, 14], [6, 10, 11, 14],                              // smokehouse, drying room
    ],
    doors: [[6, 2], [2, 5], [5, 5], [8, 5], [11, 2], [13, 5], [4, 7], [11, 8], [2, 10], [9, 10], [6, 12], [9, 14], [16, 8]],
    chests: [[2, 2, 'C'], [8, 2, 'C'], [14, 2, 'C'], [2, 8, 'C'], [6, 8, 'C'], [13, 8, 'L'], [2, 12, 'C'], [9, 12, 'C']],
    props: [[13, 13, 'P'], [14, 13, 'P'], [1, 4, 'X'], [1, 6, 'B']],
  },

  { n: 'Saltmarsh Works', k: 'industrial', x: 7600, y: 11600, rot: 0,
    rooms: [
      [0, 0, 4, 6], [4, 0, 11, 6],                                  // office, works hall
      [0, 6, 4, 11], [4, 6, 11, 11],                                // store, refinery
      [11, 0, 15, 6], [11, 6, 15, 11],                              // silo, silo tank
      [15, 4, 20, 10],                                              // pump shed
      [4, 11, 11, 15], [0, 11, 4, 15],                              // yard shed, lab
      [15, 10, 20, 15],                                             // yard hut
    ],
    doors: [[4, 3], [2, 6], [4, 8], [7, 6], [11, 3], [11, 8], [13, 6], [15, 5], [15, 8], [2, 11], [4, 13], [7, 11], [17, 10], [2, 15], [17, 15], [20, 7]],
    chests: [[2, 2, 'C'], [7, 2, 'C'], [9, 4, 'C'], [2, 9, 'C'], [6, 8, 'C'], [13, 4, 'C'], [13, 9, 'L'], [17, 5, 'C'], [9, 13, 'C'], [2, 13, 'C'], [18, 12, 'C']],
    props: [[1, 4, 'X'], [17, 8, 'X']],
  },

  { n: 'Fogbank Harbor', k: 'coast', x: 8000, y: 13800, rot: 0,
    rooms: [
      [0, 0, 6, 5], [6, 0, 11, 5], [0, 5, 6, 10],                   // two houses, a third house
      [6, 5, 13, 11],                                               // inn
      [13, 0, 18, 8], [18, 2, 23, 9],                               // warehouse, pier shed
      [13, 8, 18, 12], [18, 9, 23, 15],                             // bait shop, chapel
      [6, 11, 13, 15], [0, 10, 6, 15],                              // net loft, fish store
    ],
    doors: [[6, 2], [3, 5], [8, 5], [6, 7], [13, 6], [13, 9], [15, 8], [18, 4], [18, 11], [20, 9], [9, 11], [6, 13], [3, 10], [3, 15], [21, 15], [23, 12]],
    chests: [[2, 2, 'C'], [8, 2, 'C'], [2, 7, 'C'], [10, 7, 'C'], [12, 9, 'L'], [16, 2, 'C'], [15, 6, 'C'], [21, 4, 'C'], [15, 10, 'C'], [10, 13, 'C'], [3, 13, 'C'], [21, 12, 'C']],
    props: [[1, 8, 'X'], [20, 6, 'X'], [7, 14, 'P']],
  },

  // ---- south-east: plains and the desert -----------------------------------------
  { n: 'Rustwater Yard', k: 'industrial', x: 9800, y: 11100, rot: 0,
    rooms: [
      [0, 0, 4, 7], [4, 0, 9, 7], [9, 0, 14, 6], [14, 0, 18, 4], [14, 4, 18, 8],   // office, workshop, store, containers A and B
      [9, 6, 14, 12], [4, 7, 9, 13], [0, 7, 4, 13],                                // paint shop, pump house, yard shed
      [9, 12, 14, 16], [14, 8, 18, 12],                                            // container C, lab
    ],
    doors: [[4, 3], [9, 3], [14, 2], [16, 4], [16, 8], [11, 6], [9, 9], [6, 7], [2, 7], [4, 10], [11, 12], [14, 10], [11, 16], [18, 2], [18, 10]],
    chests: [[2, 2, 'C'], [6, 2, 'C'], [12, 2, 'C'], [16, 2, 'C'], [16, 6, 'C'], [12, 9, 'L'], [7, 11, 'C'], [2, 10, 'C'], [11, 14, 'C'], [16, 10, 'C']],
    props: [[1, 5, 'X'], [6, 4, 'X'], [12, 4, 'X']],
  },

  { n: 'Dune Hollow', k: 'ruins', x: 12900, y: 7500, rot: 0,
    rooms: [
      [0, 0, 6, 6], [6, 0, 13, 6], [0, 6, 6, 12], [6, 6, 13, 12],   // outer hall, shrine, crypt, sanctum
      [13, 0, 20, 6], [13, 6, 20, 12], [20, 6, 24, 12],             // broken hall, ruin store, pillar room
      [0, 12, 7, 16], [7, 12, 13, 16], [13, 12, 20, 16],            // three rooms under the temple
    ],
    doors: [[6, 3], [13, 3], [9, 6], [3, 6], [6, 9], [13, 9], [16, 6], [20, 9], [3, 12], [10, 12], [7, 14], [13, 14], [16, 12], [10, 16], [24, 9]],
    chests: [[2, 2, 'C'], [8, 2, 'C'], [2, 9, 'C'], [10, 9, 'L'], [16, 2, 'C'], [15, 9, 'C'], [2, 14, 'C'], [11, 14, 'C'], [15, 14, 'C'], [22, 9, 'C']],
    props: [[4, 4, 'R'], [19, 10, 'X'], [17, 14, 'B']],
  },

  { n: 'Ember Mine', k: 'industrial', x: 5600, y: 5000, rot: 0,
    rooms: [
      [0, 0, 5, 6], [5, 0, 10, 6], [10, 0, 14, 6], [14, 0, 18, 6],   // lamp store, tool shed, shaft house, office
      [0, 6, 5, 11], [5, 6, 10, 11], [10, 6, 14, 11], [14, 6, 18, 11], // entrance, crusher, ore hall, store
      [5, 11, 10, 15], [10, 11, 14, 15],                             // pump room, control room
    ],
    doors: [[5, 3], [10, 2], [14, 2], [2, 6], [8, 6], [12, 6], [16, 6], [5, 8], [10, 8], [14, 8], [7, 11], [12, 11], [10, 13], [7, 15], [12, 15], [18, 8]],
    chests: [[2, 2, 'C'], [7, 4, 'C'], [12, 4, 'L'], [16, 2, 'C'], [2, 9, 'C'], [12, 8, 'C'], [16, 9, 'C'], [7, 13, 'C'], [12, 13, 'C']],
    props: [[7, 8, 'X'], [2, 13, 'R'], [16, 13, 'T']],
  },

  { n: 'Glasswater Dock', k: 'coast', x: 13500, y: 6000, rot: 0,
    rooms: [
      [0, 0, 6, 6], [6, 0, 10, 6], [0, 6, 6, 10], [6, 6, 10, 10],   // lodge, boathouse bedroom, lodge bedroom, kitchen
      [10, 2, 14, 10], [14, 2, 18, 10],                              // boat bay, office
      [0, 10, 6, 14], [6, 10, 10, 14], [14, 10, 18, 14], [10, 10, 14, 14],   // dock shed, store, fish room, net loft
    ],
    doors: [[6, 3], [3, 6], [10, 4], [8, 6], [6, 8], [10, 8], [14, 5], [16, 10], [12, 10], [14, 12], [10, 12], [8, 10], [3, 10], [6, 12], [18, 6], [2, 14], [16, 14]],
    chests: [[2, 2, 'C'], [8, 2, 'C'], [2, 8, 'C'], [8, 8, 'C'], [12, 6, 'L'], [16, 4, 'C'], [2, 12, 'C'], [8, 12, 'C'], [12, 12, 'C'], [16, 12, 'C']],
    props: [[4, 4, 'X'], [7, 9, 'X']],
  },
];

// ---- roads: pairs of places; the route between their gates is found automatically ----------
const ROAD_PAIRS = [
  ['Lantern Market', 'Hightower Depot'], ['Lantern Market', 'Brightwell Station'],
  ['Lantern Market', 'Saltmarsh Works'], ['Lantern Market', 'Rustwater Yard'],
  ['Hightower Depot', 'Ember Mine'], ['Hightower Depot', 'Mossgate Ruins'],
  ['Ember Mine', 'Frostspire Castle'], ['Frostspire Castle', 'Northcrest Lift'],
  ['Northcrest Lift', 'Eastwind Depot'], ['Eastwind Depot', 'Brightwell Station'],
  ['Eastwind Depot', 'Glasswater Dock'], ['Brightwell Station', 'Dune Hollow'],
  ['Dune Hollow', 'Sandsong Oasis'], ['Sandsong Oasis', 'Rustwater Yard'],
  ['Dune Hollow', 'Glasswater Dock'], ['Frostspire Castle', 'Willow Bend'],
  ['Willow Bend', 'Mossgate Ruins'], ['Mossgate Ruins', 'Ironbark Lodge'],
  ['Ironbark Lodge', 'Gull Point Light'], ['Ironbark Lodge', 'Blackfen Shacks'],
  ['Blackfen Shacks', 'Saltmarsh Works'], ['Saltmarsh Works', 'Fogbank Harbor'],
  ['Hightower Depot', 'Ironbark Lodge'],
];

// Compile a POI's rooms, doors, chests and props into text rows.
// Coordinates keep the plan's own origin (0, 0), so the rows and the room numbers match.
// '#' wall, '.' floor, 'D' door, 'C' chest, 'L' legendary chest, 'X' 'T' 'R' 'B' 'P' props, ' ' open ground.
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
  for (const [x, y] of poi.doors || []) put(x, y, 'D');
  for (const [x, y, t] of poi.chests || []) put(x, y, t);
  for (const [x, y, t] of poi.props || []) put(x, y, t);
  let maxX = 0, maxY = 0;
  for (const k of cells.keys()) {
    const [x, y] = k.split(',').map(Number);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const rows = [];
  for (let y = 0; y <= maxY; y++) {
    let s = '';
    for (let x = 0; x <= maxX; x++) s += cells.get(key(x, y)) || ' ';
    rows.push(s);
  }
  return { rows, minX: 0, minY: 0 };
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

// The grid placement of each POI, the same way core.js places it: plan cell (c, r) is
// wall cell (gx0 + c, gy0 + r).
function placeAll() {
  const W = Math.ceil(S.WORLD / GRID);
  const out = new Map();
  for (const def of POIS) {
    const rows = turnPlan(compilePOI(def).rows, def.rot);
    const cols = Math.max(...rows.map(r => r.length));
    const gx0 = Math.round(def.x / GRID) - Math.floor(cols / 2);
    const gy0 = Math.round(def.y / GRID) - Math.floor(rows.length / 2);
    const gates = [];
    rows.forEach((row, r) => {
      for (let c = 0; c < cols; c++) {
        if ((row[c] || ' ') !== 'D') continue;
        const edge = r === 0 || r === rows.length - 1 || c === 0 || c === cols - 1;
        if (!edge) continue;
        const out1 = r === 0 ? [c, -1] : r === rows.length - 1 ? [c, rows.length] : c === 0 ? [-1, r] : [cols, r];
        gates.push({ door: [gx0 + c, gy0 + r], out: [gx0 + out1[0], gy0 + out1[1]] });
      }
    });
    out.set(def.n, { def, rows, cols, gx0, gy0, gates, box: [gx0, gy0, gx0 + cols - 1, gy0 + rows.length - 1] });
  }
  return { out, W };
}

// A* over the grid (60 px cells, eight directions) between any gate of A and any gate of B.
// Water and the sea are blocked, and so is every other building's box. Returns world points.
function routeRoad(placed, W, a, b, blocked) {
  const A = placed.get(a), B = placed.get(b);
  if (!A || !B) return null;
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && y >= 0 && x < W && y < W;
  const freeCell = (x, y) => inGrid(x, y) && !blocked[idx(x, y)];
  const sources = A.gates.map(g => g.out).filter(([x, y]) => freeCell(x, y));
  const goals = B.gates.map(g => g.out).filter(([x, y]) => freeCell(x, y));
  if (!sources.length || !goals.length) return null;
  const goalIdx = new Set(goals.map(([x, y]) => idx(x, y)));
  const h = (x, y) => { let m = Infinity; for (const [gx, gy] of goals) m = Math.min(m, Math.hypot(gx - x, gy - y)); return m; };
  const g = new Float64Array(W * W).fill(Infinity);
  const from = new Int32Array(W * W).fill(-1);
  const closed = new Uint8Array(W * W);
  const heap = [];
  const push = (f, i) => {
    heap.push([f, i]); let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    }
    return top;
  };
  for (const [x, y] of sources) { const i = idx(x, y); g[i] = 0; push(h(x, y), i); }
  let found = -1;
  while (heap.length) {
    const [, i] = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (goalIdx.has(i)) { found = i; break; }
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!freeCell(nx, ny)) continue;
      if (dx && dy && (blocked[idx(x + dx, y)] || blocked[idx(x, y + dy)])) continue;   // no squeezing past corners
      const ni = idx(nx, ny);
      const ng = g[i] + (dx && dy ? 1.414 : 1);
      if (ng < g[ni]) { g[ni] = ng; from[ni] = i; push(ng + h(nx, ny), ni); }
    }
  }
  if (found < 0) return null;
  const cells = [];
  for (let i = found; i >= 0; i = from[i]) { cells.push([i % W, Math.floor(i / W)]); if (from[i] < 0) break; }
  cells.reverse();
  // the door cell at each end, so the road meets the building
  const gateAt = (list, cell) => list.find(gt => gt.out[0] === cell[0] && gt.out[1] === cell[1]);
  const startGate = gateAt(A.gates, cells[0]), endGate = gateAt(B.gates, cells[cells.length - 1]);
  const pts = [];
  if (startGate) pts.push(startGate.door);
  pts.push(...cells);
  if (endGate) pts.push(endGate.door);
  // world points, then drop the middle points of straight runs
  const world = pts.map(([x, y]) => [x * GRID + GRID / 2, y * GRID + GRID / 2]);
  const simple = [world[0]];
  for (let k = 1; k + 1 < world.length; k++) {
    const p = simple[simple.length - 1], q = world[k], n = world[k + 1];
    const cross = (q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]);
    if (Math.abs(cross) > 1) simple.push(q);
  }
  simple.push(world[world.length - 1]);
  return simple.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

const ROAD_FAILS = [];
function buildRoads() {
  const { out: placed, W } = placeAll();
  // blocked: sea and coast, and every building's box
  const blocked = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const cx = x * GRID + GRID / 2, cy = y * GRID + GRID / 2;
    if (!S.isLand(cx, cy) || S.coastDist(cx, cy) < 60) blocked[y * W + x] = 1;
  }
  for (const p of placed.values()) {
    const [x0, y0, x1, y1] = p.box;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < W && y < W) blocked[y * W + x] = 1;
  }
  const roads = [];
  for (const [a, b] of ROAD_PAIRS) {
    const r = routeRoad(placed, W, a, b, blocked);
    if (r) roads.push(r); else { ROAD_FAILS.push(a + ' -> ' + b); roads.push([]); }
  }
  return roads.filter(r => r.length >= 2);
}

const ROADS = buildRoads();

module.exports = { POIS, ROADS, ROAD_PAIRS, ROAD_FAILS, compilePOI, turnPlan, placeAll };
