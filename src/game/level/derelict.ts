// "One derelict, one extraction" scenario, painted procedurally in cell coordinates.
//
// Layout (cells, y up; outer hull x 300..840, y 220..540):
//   A  entry bay        x312-440 y232-376   loose crates; cut in from the prow/belly
//   B  crew deck        x312-440 y384-528   PRESSURIZED; weak glass roof window
//   C  fuel room        x448-600 y232-376   fuel tanks joined by a fuel-line fuse, barrels
//   D  corridor         x448-600 y384-528   collapsed bulkhead slabs
//   E  cargo hold       x608-740 y232-528   salvage core held by pillars
//   F  engine room      x748-828            machinery
// Indestructible FRAME girders anchor the wreck; PLATE plugs in them are the "doors".
// Extraction zone sits above the hold, so the core leaves through the hold's roof or round.

import { CELL, WORLD_H, WORLD_W } from '../../config';
import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { barrel, crate, salvageCore, scrap } from './props';

import type { BodySpec, LevelSpec } from './types';

/** Cell coords -> meters. */
const m = (c: number) => c * CELL;

export function buildDerelict(): LevelSpec {
  const g = new PixelGrid(WORLD_W, WORLD_H);
  const p = new Painter(g);

  // hull shell with tapered prow (left) and engine bulge (right)
  p.poly(
    [
      [236, 380],
      [252, 290],
      [300, 220],
      [840, 220],
      [866, 262],
      [866, 498],
      [840, 540],
      [300, 540],
      [252, 470],
    ],
    M.HULL,
  );
  p.clear(312, 232, 516, 296);

  // structural frame
  for (const x of [440, 600, 740]) p.rect(x, 220, 8, 320, M.FRAME);
  p.rect(312, 376, 288, 8, M.FRAME);
  p.rect(748, 376, 80, 8, M.FRAME);

  // doors: PLATE plugs through frames
  p.rect(440, 250, 8, 50, M.PLATE); // A <-> C
  p.rect(440, 440, 8, 40, M.PLATE); // B <-> D
  p.rect(600, 300, 8, 50, M.PLATE); // C <-> E
  p.rect(600, 420, 8, 50, M.PLATE); // D <-> E
  p.rect(360, 376, 40, 8, M.PLATE); // A <-> B
  p.rect(500, 376, 40, 8, M.PLATE); // C <-> D
  p.rect(740, 260, 8, 40, M.PLATE); // E <-> F
  p.rect(740, 450, 8, 50, M.PLATE); // E <-> F upper

  // B: glass roof window + ceiling lights
  p.rect(340, 528, 80, 12, M.GLASS);
  for (let x = 320; x < 436; x += 22) p.rect(x, 524, 8, 3, M.LIGHT);

  // prow viewports (cosmetic, set into thick hull)
  p.rect(256, 360, 10, 8, M.GLASS).rect(256, 392, 10, 8, M.GLASS).rect(268, 376, 12, 8, M.GLASS);

  // C: fuel tanks joined by a fuel line (a fuse) along the ceiling
  const tanks: [number, number, number][] = [
    [478, 268, 14],
    [530, 262, 12],
    [574, 300, 13],
  ];
  for (const [x, y, r] of tanks) p.circle(x, y, r + 3, M.HULL).circle(x, y, r, M.FUEL);
  p.line(478, 282, 478, 350, 3, M.FUEL).line(478, 350, 574, 350, 3, M.FUEL).line(574, 350, 574, 313, 3, M.FUEL).line(530, 350, 530, 274, 3, M.FUEL);
  for (const [x, , r] of tanks) p.rect(x - 2, 232, 4, 22 - r + 10, M.PLATE); // tank supports

  // D: collapsed bulkhead slabs
  p.line(448, 398, 600, 505, 7, M.PLATE).line(466, 530, 520, 444, 6, M.PLATE).line(560, 384, 604, 430, 5, M.PLATE);

  // E: pillars bracketing the core cradle + collapsed beam
  p.rect(670, 232, 8, 120, M.PLATE).rect(656, 350, 36, 8, M.PLATE);
  p.rect(670, 408, 8, 120, M.PLATE).rect(656, 400, 36, 8, M.PLATE);
  p.line(612, 480, 664, 520, 6, M.PLATE).line(700, 232, 740, 300, 6, M.PLATE);
  for (let y = 250; y < 520; y += 30) p.rect(610, y, 3, 6, M.LIGHT);

  // F: engine machinery
  p.rect(760, 232, 30, 58, M.HULL).rect(796, 232, 24, 108, M.HULL).rect(760, 290, 28, 70, M.PLATE);
  p.rect(762, 384, 50, 46, M.HULL).rect(770, 430, 40, 98, M.PLATE).rect(816, 384, 12, 144, M.HULL);
  for (let y = 300; y < 500; y += 40) p.rect(866, y, 14, 18, M.FRAME); // exhaust nozzles

  // exterior details: antenna mast, weathering, panel seams
  p.rect(500, 540, 3, 70, M.FRAME).circle(501, 612, 3, M.LIGHT).line(501, 590, 530, 600, 2, M.FRAME);
  p.rect(780, 540, 4, 30, M.FRAME).rect(770, 568, 24, 4, M.FRAME);
  p.weather(300, 214, 540, 10, 18, 2, 5, 3);
  p.weather(300, 534, 540, 10, 18, 2, 5, 4);
  p.seams(230, 210, 650, 340, M.HULL, 24, 16);
  p.seams(230, 210, 650, 340, M.PLATE, 16, 16, 50);

  // back wall (visual only): interior panels, pipes, hazard striping in the fuel room
  const back = new PixelGrid(WORLD_W, WORLD_H);
  const bp = new Painter(back);
  bp.rect(312, 232, 516, 296, M.PLATE).seams(312, 232, 516, 296, M.PLATE, 32, 24, 40);
  bp.line(312, 300, 828, 300, 4, M.HULL).line(312, 470, 828, 470, 3, M.HULL).line(320, 232, 320, 528, 3, M.HULL);
  bp.line(560, 232, 560, 376, 4, M.HULL).line(700, 300, 700, 528, 5, M.HULL).line(790, 232, 790, 528, 3, M.SCRAP);
  for (let x = 448; x < 600; x += 10) bp.line(x, 240, x + 8, 250, 4, M.FUEL);
  for (let x = 616; x < 736; x += 24) bp.rect(x, 236, 12, 8, M.SCRAP);

  const bodies: BodySpec[] = [];
  const add = (grid: PixelGrid, cx: number, cy: number, extra: Partial<BodySpec> = {}) =>
    bodies.push({ grid, x: m(cx - grid.w / 2), y: m(cy - grid.h / 2), angle: 0, ...extra }) - 1;

  // salvage core in the hold
  const salvageIndex = add(salvageCore(), 674, 379, { tags: { salvage: true, label: 'Reactor core' } });

  // A: crates and junk
  add(crate(20, 16), 340, 260);
  add(crate(14, 14), 380, 250, { w: 0.2 });
  add(crate(18, 12), 410, 330, { w: -0.1 });
  add(scrap(1, 18), 360, 340);
  // B: loose furniture in the pressurized deck (it'll fly when breached)
  add(crate(12, 10), 340, 420);
  add(crate(10, 10), 400, 470);
  add(scrap(2, 16), 370, 500);
  add(scrap(3, 14), 420, 420);
  // C: explosive barrels
  add(barrel(7), 510, 300);
  add(barrel(6), 556, 250);
  // D: scrap in the corridor
  add(scrap(4, 20), 520, 470);
  add(scrap(5, 16), 470, 450);
  // E: crates in the hold
  add(crate(16, 16), 630, 260);
  add(crate(14, 12), 715, 470);
  // outside: drifting junk
  add(scrap(6, 22), 180, 300, { vx: 0.3, vy: 0.2, w: 0.15 });
  add(scrap(7, 18), 200, 520, { vx: 0.2, vy: -0.25, w: -0.2 });
  add(crate(14, 14), 560, 640, { vx: -0.2, w: 0.1 });
  add(barrel(6), 900, 420, { vx: -0.15, vy: 0.1, w: 0.3 });
  add(scrap(8, 24), 950, 200, { w: 0.05 });

  return {
    name: 'Derelict (classic)',
    seed: 0,
    rooms: [],
    doors: [],
    entities: [],
    terrain: g,
    backdrop: back,
    bodies,
    salvageIndex,
    shipSpawn: { x: m(150), y: m(380), angle: 0 },
    extraction: { x0: m(620), y0: m(610), x1: m(730), y1: m(700) },
    pressurized: [{ x0: m(312), y0: m(384), x1: m(440), y1: m(528), gas: 1.0 }],
    center: { x: m(560), y: m(380) },
  };
}
