// "Lab": a small station that teaches the systems loop, and the test rig for it (?level=lab).
//
// Layout (cells, y up; station hull x 300..760, y 300..520):
//   Hall     x312-440 y312-508  vacuum, dark. Entered through a gap in the hull's left side.
//            A battery and a hull patch drift here; a socket and a fixture sit on the right wall.
//   Chamber  x452-588 y340-492  sealed except for a breach through its roof to space.
//            A pump on the floor and a light in the ceiling, wired through the walls to the
//            socket in the hall. A hull patch drifts above the station near the breach.
//   Vault    x600-748 y312-508  PRESSURIZED; the salvage core. Its door (in the chamber's
//            right wall) is a pressure door: it opens once the chamber holds air.
//
// The loop: weld the patch over the breach (heat the rim, press the plate on), plug the
// battery into the socket (arms or harpoon), lights and pump come on, the chamber fills, the
// pressure door opens. Then get the core out: cutting the vault open to space blows it out.

import { CELL, WORLD_H, WORLD_W } from '../../config';
import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { crate, hullPatch, powerCell, salvageCore } from './props';
import type { BodySpec, DeviceSpec, LevelSpec } from './types';

const m = (c: number) => c * CELL;

/** Where the lab's parts are (cells), for tests. */
export const LAB = {
  socket: { x: 436, y: 360 }, // socket face center (hall side of the wall)
  breach: { x0: 540, y0: 492, x1: 556, y1: 520 },
  chamber: { x0: 452, y0: 340, x1: 588, y1: 492 },
  pump: { x: 471, y: 343 },
  light: { x: 500, y: 490 },
  pdoor: { x0: 588, y0: 380, x1: 600, y1: 420 },
  vault: { x0: 600, y0: 312, x1: 748, y1: 508 },
};

export function buildLab(): LevelSpec {
  const g = new PixelGrid(WORLD_W, WORLD_H);
  const p = new Painter(g);

  // station shell, interior hollowed into three spaces
  p.rect(300, 300, 460, 220, M.HULL);
  p.clear(312, 312, 128, 196); // hall
  p.clear(452, 340, 136, 152); // chamber
  p.clear(600, 312, 148, 196); // vault
  p.clear(300, 390, 12, 40); // entry gap in the hull
  // girders anchor it
  for (const x of [440, 588]) p.rect(x + 4, 300, 4, 220, M.FRAME);
  p.rect(300, 304, 460, 4, M.FRAME).rect(300, 512, 460, 4, M.FRAME);
  p.seams(300, 300, 460, 220, M.HULL, 24, 16);

  // the breach: a hole through the chamber's roof to space (girder included)
  const B = LAB.breach;
  p.clear(B.x0, B.y0, B.x1 - B.x0, B.y1 - B.y0);

  // wiring, buried in the walls: socket -> up the wall -> ceiling light; -> down -> floor pump
  p.rect(LAB.socket.x, LAB.socket.y - 4, 4, 8, M.SOCKET); // the socket protrudes into the hall
  p.rect(440, LAB.socket.y - 1, 6, 2, M.CONDUIT); // into the wall
  p.rect(444, 334, 2, 165, M.CONDUIT); // riser inside the left wall
  p.rect(444, 497, 58, 2, M.CONDUIT); // along inside the roof
  p.rect(500, 491, 2, 7, M.CONDUIT); // drop to the fixture
  p.rect(LAB.light.x - 6, 488, 14, 4, M.LIGHT); // chamber light
  p.rect(444, 334, 28, 2, M.CONDUIT); // along inside the floor
  p.rect(470, 334, 2, 6, M.CONDUIT); // up to the pump
  p.rect(464, 340, 14, 6, M.PUMP); // pump housing on the floor
  p.rect(436, 381, 8, 2, M.CONDUIT).rect(432, 378, 4, 8, M.LIGHT); // hall fixture by the socket

  const devices: DeviceSpec[] = [
    { type: 'pump', cell: LAB.pump, outlet: { x: m(480), y: m(352) }, rate: 6, target: 1.1 },
    { type: 'pressureDoor', ...LAB.pdoor, sensor: { x: m(560), y: m(400) }, open: 0.6, close: 0.3 },
  ];

  // back wall (visual): interior panels over all three spaces
  const back = new PixelGrid(WORLD_W, WORLD_H);
  const bp = new Painter(back);
  bp.rect(312, 312, 436, 196, M.PLATE).seams(312, 312, 436, 196, M.PLATE, 32, 24, 40);
  bp.line(312, 480, 440, 480, 3, M.HULL).line(452, 400, 588, 400, 3, M.HULL).line(700, 312, 700, 508, 4, M.HULL);

  const bodies: BodySpec[] = [];
  const add = (grid: PixelGrid, cx: number, cy: number, extra: Partial<BodySpec> = {}) =>
    bodies.push({ grid, x: m(cx - grid.w / 2), y: m(cy - grid.h / 2), angle: 0, ...extra }) - 1;
  const salvageIndex = add(salvageCore(), 690, 400, { tags: { salvage: true, label: 'Reactor core' } });
  add(powerCell(), 360, 340, { w: 0.15 });
  add(hullPatch(34, 10), 520, 545, { w: -0.05 });
  add(crate(14, 12), 400, 480, { w: 0.1 });
  add(crate(12, 12), 650, 340);

  return {
    name: 'Lab',
    seed: 0,
    rooms: [],
    doors: [],
    entities: [],
    devices,
    terrain: g,
    backdrop: back,
    bodies,
    salvageIndex,
    shipSpawn: { x: m(230), y: m(410), angle: 0 },
    extraction: { x0: m(600), y0: m(600), x1: m(720), y1: m(690) },
    pressurized: [{ x0: m(LAB.vault.x0), y0: m(LAB.vault.y0), x1: m(LAB.vault.x1), y1: m(LAB.vault.y1), gas: 1.0 }],
    center: { x: m(530), y: m(410) },
  };
}
