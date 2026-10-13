// "Lantern": the hand-built derelict (default level). Built around the tools rather than
// generated: long dark corridors with hard corners for the harpoon, a hangar meant to be
// vented, a power-and-pressure puzzle, and a pneumatic transit tube.
//
// Layout (cells, y up; hull x 600..2640, y 500..1520; 8 cells = 1 m):
//   Dock     x640-820   y880-1060   open mouth to space on the left. Drifting junk; a locker
//                                   behind a thin plate wall holds a battery.
//   Spine A  x820-1420  y950-990    75 m dark corridor, hiding alcoves in its ceiling. A
//                                   security bot walks it end to end.
//   Hangar   x1000-1320 y516-938    PRESSURIZED, under spine A behind a glass window. Four
//                                   idle drones and cargo. Its floor is a plate hangar door:
//                                   cut it (or the window) and everything inside goes out.
//   Shaft    x1380-1420 y990-1340   45 m straight up, hard corners at both ends.
//   Spine B  x1380-1940 y1300-1340  70 m, a second patrol bot.
//   Hall     x1940-2060 y1230-1410  socket + fixture on its right wall.
//   Chamber  x2072-2240 y1240-1400  breached (a hole into the hall), pump, lamp; a pressure
//                                   door in its right wall to the transit station.
//   Station  x2252-2330 y1290-1350  the tube pump. Tube x2330-2500 y1306-1338, then a 60 m
//                                   drop to the vault. Powered, the pump drives air down it.
//   Vault    x2380-2600 y640-820    the core. Exhaust slots through its right wall to space
//                                   keep the tube flowing (and are a way out).
//
// The loop: sneak or fight down the spines; find power (the dock battery, or cut a drone's
// core free); patch the chamber's breach and plug the power in; the chamber fills, its door
// opens, the tube carries you to the vault; cut the core out and get it to extraction.

import { CELL, WORLD_H, WORLD_W } from '../../config';
import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { crate, hullPatch, powerCell, salvageCore, scrap } from './props';
import type { BodySpec, DeviceSpec, EntitySpec, LevelSpec, RoomInfo } from './types';

const m = (c: number) => c * CELL;

type R = [number, number, number, number]; // x0, y0, x1, y1 (cells)

/** Named spaces (cells), for tests and the minimap. */
export const LANTERN = {
  dock: [640, 880, 820, 1060] as R,
  locker: [700, 1066, 744, 1096] as R,
  spineA: [820, 950, 1420, 990] as R,
  hangar: [1000, 516, 1320, 938] as R,
  shaft: [1380, 990, 1420, 1340] as R,
  spineB: [1380, 1300, 1940, 1340] as R,
  hall: [1940, 1230, 2060, 1410] as R,
  chamber: [2072, 1240, 2240, 1400] as R,
  station: [2252, 1290, 2330, 1350] as R,
  tube: [2330, 1306, 2500, 1338] as R,
  drop: [2468, 820, 2500, 1338] as R,
  vault: [2380, 640, 2600, 820] as R,
  socket: { x: 2056, y: 1280 },
  breach: [2060, 1350, 2072, 1374] as R,
  pump: { x: 2107, y: 1243 },
  tubePump: { x: 2277, y: 1293 },
  pdoor: [2240, 1296, 2252, 1336] as R,
};

export function buildLantern(): LevelSpec {
  const g = new PixelGrid(WORLD_W, WORLD_H);
  const p = new Painter(g);
  const L = LANTERN;
  const carve = (r: R) => p.clear(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  const fill = (r: R, mat: number) => p.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], mat);

  // hull mass, girders through it, then the spaces
  p.poly(
    [
      [600, 560],
      [700, 500],
      [2500, 500],
      [2640, 600],
      [2640, 1440],
      [2540, 1520],
      [700, 1520],
      [600, 1440],
    ],
    M.HULL,
  );
  for (let x = 700; x < 2600; x += 160) p.rect(x, 500, 6, 1020, M.FRAME);
  for (const y of [700, 1120, 1460]) p.rect(620, y, 2000, 6, M.FRAME);
  p.seams(600, 500, 2040, 1020, M.HULL, 24, 16);
  for (const r of [L.dock, L.spineA, L.hangar, L.shaft, L.spineB, L.hall, L.chamber, L.station, L.tube, L.drop, L.vault]) carve(r);
  carve([600, 930, 640, 1010]); // dock mouth
  // hiding alcoves in spine A's ceiling
  for (const x of [960, 1120, 1280]) carve([x, 990, x + 40, 1030]);
  // dock locker behind a thin plate wall
  carve(L.locker);
  fill([700, 1060, 744, 1066], M.PLATE);
  // hangar: glass window up into spine A, a plate hangar door in its floor (to space)
  fill([1100, 938, 1220, 950], M.GLASS);
  fill([1060, 500, 1260, 516], M.PLATE); // 2 m of soft plate between the hangar and space
  p.seams(1060, 500, 200, 16, M.PLATE, 20, 40, 40);
  // vault exhaust slots through its right wall to space
  for (const y of [680, 720, 760]) carve([2600, y, 2640, y + 18]);
  // the chamber's breach into the hall
  carve(L.breach);

  // wiring in the walls: socket (hall side) -> down the wall -> floor -> pump, lamp, and on
  // under the station to the tube pump; up the wall to the hall fixture
  p.rect(L.socket.x, L.socket.y - 4, 4, 8, M.SOCKET);
  p.rect(2060, L.socket.y - 1, 6, 2, M.CONDUIT);
  p.rect(2064, 1233, 2, 70, M.CONDUIT); // riser in the hall/chamber wall (below the breach)
  p.rect(2052, 1300, 14, 2, M.CONDUIT).rect(2048, 1296, 4, 8, M.LIGHT); // hall fixture
  p.rect(2064, 1233, 216, 2, M.CONDUIT); // under the chamber floor, on under the station
  p.rect(2106, 1234, 2, 6, M.CONDUIT).rect(2100, 1240, 14, 6, M.PUMP); // chamber pump
  p.rect(2246, 1233, 2, 28, M.CONDUIT).rect(2240, 1258, 6, 2, M.CONDUIT).rect(2234, 1252, 6, 14, M.LIGHT); // chamber lamp
  p.rect(2276, 1234, 2, 56, M.CONDUIT).rect(2270, 1290, 14, 6, M.PUMP); // tube pump

  const devices: DeviceSpec[] = [
    { type: 'pump', cell: L.pump, outlet: { x: m(2120), y: m(1300) }, rate: 10, target: 1.1 },
    { type: 'pressureDoor', x0: L.pdoor[0], y0: L.pdoor[1], x1: L.pdoor[2], y1: L.pdoor[3], sensor: { x: m(2200), y: m(1320) }, open: 0.6, close: 0.3 },
    // the tube pump never reaches its target: the vault vents to space, so air keeps flowing
    { type: 'pump', cell: L.tubePump, outlet: { x: m(2300), y: m(1320) }, rate: 14, target: 3 },
  ];

  // back wall over every space (interior ambient) with some pipes for texture
  const back = new PixelGrid(WORLD_W, WORLD_H);
  const bp = new Painter(back);
  for (const r of [L.dock, L.locker, L.spineA, L.hangar, L.shaft, L.spineB, L.hall, L.chamber, L.station, L.tube, L.drop, L.vault]) {
    bp.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], M.PLATE);
    bp.seams(r[0], r[1], r[2] - r[0], r[3] - r[1], M.PLATE, 32, 24, 40);
  }
  for (const x of [960, 1120, 1280]) bp.rect(x, 990, 40, 40, M.PLATE);
  bp.line(820, 984, 1420, 984, 2, M.HULL).line(1380, 1306, 1940, 1306, 2, M.HULL).line(1386, 990, 1386, 1340, 2, M.HULL);
  bp.line(1000, 700, 1320, 700, 4, M.HULL).line(1160, 540, 1160, 938, 3, M.HULL);

  const bodies: BodySpec[] = [];
  const add = (grid: PixelGrid, cx: number, cy: number, extra: Partial<BodySpec> = {}) =>
    bodies.push({ grid, x: m(cx - grid.w / 2), y: m(cy - grid.h / 2), angle: 0, ...extra }) - 1;
  const salvageIndex = add(salvageCore(), 2490, 730, { tags: { salvage: true, label: 'Reactor core' } });
  // dock: junk, the locker's battery, a patch plate
  add(crate(16, 14), 700, 920, { w: 0.1 });
  add(scrap(11, 20), 760, 1010, { w: -0.1 });
  add(scrap(12, 16), 680, 1030);
  add(powerCell(), 722, 1081);
  add(hullPatch(12, 40), 780, 940, { w: 0.04 });
  // hangar cargo (it all goes when the door does)
  add(crate(20, 16), 1060, 580);
  add(crate(16, 16), 1250, 600);
  add(crate(14, 12), 1150, 860);
  add(scrap(13, 22), 1290, 820);
  // hall: a second patch, junk
  add(hullPatch(10, 34), 1990, 1300, { w: -0.03 });
  add(scrap(14, 18), 2000, 1380);
  // outside: drifting junk near the dock
  add(scrap(15, 24), 480, 1100, { vx: 0.2, w: 0.1 });
  add(crate(14, 14), 520, 820, { vx: 0.1, vy: 0.15, w: -0.1 });

  const pt = (x: number, y: number) => ({ x: m(x), y: m(y) });
  const entities: EntitySpec[] = [
    { type: 'securityBot', x: m(1340), y: m(970), patrol: [pt(1340, 970), pt(880, 970)], roomId: 1 },
    { type: 'securityBot', x: m(1460), y: m(1320), patrol: [pt(1460, 1320), pt(1900, 1320)], roomId: 4 },
    { type: 'drone', x: m(1080), y: m(700), angle: 0 },
    { type: 'drone', x: m(1170), y: m(780), angle: Math.PI },
    { type: 'drone', x: m(1250), y: m(680), angle: Math.PI / 2 },
    { type: 'drone', x: m(1150), y: m(640), angle: -Math.PI / 2 },
  ];

  const room = (id: number, kind: string, r: R, depth: number): RoomInfo => ({ id, kind, x0: m(r[0]), y0: m(r[1]), x1: m(r[2]), y1: m(r[3]), depth });
  const rooms = [
    room(0, 'dock', L.dock, 0),
    room(1, 'corridor', L.spineA, 1),
    room(2, 'hangar', L.hangar, 1),
    room(3, 'corridor', L.shaft, 2),
    room(4, 'corridor', L.spineB, 2),
    room(5, 'hall', L.hall, 3),
    room(6, 'chamber', L.chamber, 3),
    room(7, 'station', L.station, 4),
    room(8, 'vault', L.vault, 5),
  ];

  return {
    name: 'Derelict "Lantern"',
    seed: 0,
    rooms,
    doors: [],
    entities,
    devices,
    terrain: g,
    backdrop: back,
    bodies,
    salvageIndex,
    shipSpawn: { x: m(470), y: m(970), angle: 0 },
    extraction: { x0: m(2720), y0: m(640), x1: m(2840), y1: m(800) },
    pressurized: [{ x0: m(L.hangar[0]), y0: m(L.hangar[1]), x1: m(L.hangar[2]), y1: m(L.hangar[3]), gas: 1.0 }],
    center: { x: m(1620), y: m(1010) },
  };
}
