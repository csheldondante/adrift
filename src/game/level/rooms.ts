// Room templates for the dungeon generator. Each paints a room interior (cell coordinates,
// y up) and registers bodies/entities through RoomCtx. Templates must keep terrain props
// touching a wall: anything floating would detach as a loose body on the first nearby cut.
//
// Adding a room kind = one function here + an entry in ROOM_KINDS.

import { CELL } from '../../config';
import { M } from '../../pixel/materials';
import type { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { barrel, crate, salvageCore, scrap } from './props';
import type { Rng } from './rng';
import type { BodySpec, EntitySpec } from './types';

export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RoomCtx {
  p: Painter; // terrain
  bp: Painter; // backdrop
  rng: Rng;
  r: CellRect; // interior (empty), cells
  id: number;
  addBody(grid: PixelGrid, cx: number, cy: number, extra?: Partial<BodySpec>): number;
  addEntity(e: EntitySpec): void;
  addPressurized(r: CellRect, gas: number): void;
  setCore(bodyIndex: number): void;
}

const m = (c: number) => c * CELL;
const w = (r: CellRect) => r.x1 - r.x0;
const h = (r: CellRect) => r.y1 - r.y0;
const cx = (r: CellRect) => (r.x0 + r.x1) / 2;
const cy = (r: CellRect) => (r.y0 + r.y1) / 2;

function ceilingLights(c: RoomCtx): void {
  const { p, r } = c;
  for (let x = r.x0 + 12; x < r.x1 - 12; x += 28) p.rect(x, r.y1 - 3, 10, 3, M.LIGHT);
}

function scatterLoose(c: RoomCtx, count: number): void {
  const { rng, r } = c;
  for (let i = 0; i < count; i++) {
    const x = rng.range(r.x0 + 24, r.x1 - 24);
    const y = rng.range(r.y0 + 24, r.y1 - 24);
    const k = rng.next();
    if (k < 0.55) c.addBody(crate(rng.int(10, 20), rng.int(10, 16)), x, y, { w: rng.range(-0.3, 0.3) });
    else c.addBody(scrap(rng.int(1, 999), rng.int(12, 22)), x, y, { w: rng.range(-0.5, 0.5) });
  }
}

export function cargoRoom(c: RoomCtx): void {
  const { p, rng, r } = c;
  // support pillars from floor and ceiling (touching walls)
  const n = Math.max(1, Math.floor(w(r) / 90));
  for (let i = 0; i < n; i++) {
    const x = Math.floor(r.x0 + ((i + 0.5) * w(r)) / n);
    const len = Math.floor(h(r) * rng.range(0.2, 0.4));
    if (rng.chance(0.5)) p.rect(x - 4, r.y0, 8, len, M.FRAME);
    else p.rect(x - 4, r.y1 - len, 8, len, M.FRAME);
  }
  ceilingLights(c);
  scatterLoose(c, Math.floor((w(r) * h(r)) / 9000) + 2);
}

export function fuelRoom(c: RoomCtx): void {
  const { p, bp, rng, r } = c;
  const tanks: [number, number, number][] = [];
  const n = Math.max(2, Math.floor(w(r) / 70));
  for (let i = 0; i < n; i++) {
    const rad = rng.int(10, 15);
    const x = Math.floor(r.x0 + ((i + 0.5) * w(r)) / n);
    const y = r.y0 + rad + 14;
    tanks.push([x, y, rad]);
    p.rect(x - 2, r.y0, 4, 14, M.PLATE); // support to the floor
    p.circle(x, y, rad + 3, M.HULL).circle(x, y, rad, M.FUEL);
  }
  // fuel line fuse along the ceiling, dropping to each tank
  const fy = r.y1 - 10;
  p.line(tanks[0][0], fy, tanks[tanks.length - 1][0], fy, 3, M.FUEL);
  p.rect(tanks[0][0] - 2, fy, 4, r.y1 - fy, M.PLATE); // fuse anchored to ceiling
  for (const [x, y, rad] of tanks) p.line(x, fy, x, y + rad, 3, M.FUEL);
  for (let x = r.x0; x < r.x1; x += 12) bp.line(x, r.y0 + 4, x + 8, r.y0 + 12, 4, M.FUEL); // hazard stripes
  for (let i = 0; i < rng.int(1, 2); i++) c.addBody(barrel(rng.int(5, 7)), rng.range(r.x0 + 20, r.x1 - 20), rng.range(cy(r), r.y1 - 30));
  ceilingLights(c);
}

export function crewRoom(c: RoomCtx): void {
  const { p, rng, r } = c;
  // bunks along the walls
  for (let y = r.y0 + 20; y < r.y1 - 20; y += 34) {
    p.rect(r.x0, y, 36, 5, M.PLATE);
    p.rect(r.x1 - 36, y, 36, 5, M.PLATE);
  }
  ceilingLights(c);
  scatterLoose(c, rng.int(3, 6));
  c.addPressurized(r, 1.0);
}

export function machineryRoom(c: RoomCtx): void {
  const { p, rng, r } = c;
  for (let i = 0; i < rng.int(3, 6); i++) {
    const bw = rng.int(16, 40);
    const bh = rng.int(16, Math.floor(h(r) * 0.45));
    const x = rng.int(r.x0, r.x1 - bw);
    if (rng.chance(0.5)) p.rect(x, r.y0, bw, bh, rng.chance(0.3) ? M.FRAME : M.HULL);
    else p.rect(x, r.y1 - bh, bw, bh, M.HULL);
  }
  for (let i = 0; i < 2; i++) {
    const y = rng.int(r.y0 + 20, r.y1 - 20);
    p.line(r.x0, y, r.x1, y + rng.int(-10, 10), 3, M.FRAME); // pipes wall to wall
  }
  ceilingLights(c);
  scatterLoose(c, rng.int(1, 3));
}

export function crusherRoom(c: RoomCtx): void {
  const { p, rng, r } = c;
  const n = Math.max(2, Math.floor(w(r) / 80));
  for (let i = 0; i < n; i++) {
    const pw = rng.int(36, 56);
    const x = Math.floor(r.x0 + ((i + 0.5) * w(r)) / n);
    const fromTop = i % 2 === 0;
    const ph = 24;
    // housing on the wall it slams from
    p.rect(x - pw / 2 - 6, fromTop ? r.y1 - 10 : r.y0, pw + 12, 10, M.FRAME);
    const travel = h(r) - ph - 10;
    c.addEntity({
      type: 'crusher',
      x: m(x),
      y: m(fromTop ? r.y1 - 10 - ph / 2 : r.y0 + 10 + ph / 2),
      w: m(pw),
      h: m(ph),
      dx: 0,
      dy: m(fromTop ? -travel : travel),
      period: rng.range(2.2, 3.6),
    });
  }
  ceilingLights(c);
}

export function moverHall(c: RoomCtx): void {
  const { p, r, rng } = c;
  // guide rails top and bottom
  p.rect(r.x0, r.y1 - 6, w(r), 6, M.FRAME).rect(r.x0, r.y0, w(r), 6, M.FRAME);
  const y = cy(r);
  c.addEntity({ type: 'mover', path: [{ x: m(r.x0 + 70), y: m(y) }, { x: m(r.x1 - 70), y: m(y) }], w: m(96), h: m(18), speed: rng.range(3, 5) });
  ceilingLights(c);
  scatterLoose(c, 2);
}

export function droneBay(c: RoomCtx): void {
  const { p, bp, r } = c;
  for (let x = r.x0 + 30; x < r.x1 - 30; x += 50) p.rect(x, r.y1 - 26, 6, 26, M.FRAME); // racks
  bp.box(cx(r) - 40, cy(r) - 40, 80, 80, 4, M.FUEL); // pad marking
  c.addEntity({ type: 'droneBay', x: m(cx(r)), y: m(cy(r)), roomId: c.id });
  ceilingLights(c);
}

/** A security bot walking a loop around the room (clockwise or not). */
export function addPatrolBot(c: RoomCtx): void {
  const { r, rng } = c;
  const inset = 30;
  const patrol = [
    { x: m(r.x0 + inset), y: m(r.y0 + inset) },
    { x: m(r.x1 - inset), y: m(r.y0 + inset) },
    { x: m(r.x1 - inset), y: m(r.y1 - inset) },
    { x: m(r.x0 + inset), y: m(r.y1 - inset) },
  ];
  if (rng.chance(0.5)) patrol.reverse();
  c.addEntity({ type: 'securityBot', x: patrol[0].x, y: patrol[0].y, patrol, roomId: c.id });
}

export function securityRoom(c: RoomCtx): void {
  const { r, rng } = c;
  addPatrolBot(c);
  c.addEntity({ type: 'turret', x: m(cx(r)), y: m(r.y1), dir: -Math.PI / 2, roomId: c.id });
  ceilingLights(c);
  scatterLoose(c, rng.int(1, 3));
}

export function vaultRoom(c: RoomCtx): void {
  const { p, r } = c;
  const x = cx(r);
  const y = cy(r);
  // cage of girders with cuttable plate gates around the cradle
  p.box(x - 48, y - 34, 96, 68, 6, M.FRAME);
  p.rect(x - 48, y - 12, 6, 24, M.PLATE).rect(x + 42, y - 12, 6, 24, M.PLATE);
  p.rect(x - 6, r.y0, 12, y - 34 - r.y0, M.FRAME); // cage strut to the floor
  const core = c.addBody(salvageCore(), x, y, { tags: { salvage: true, label: 'Reactor core' } });
  c.setCore(core);
  c.addEntity({ type: 'turret', x: m(r.x0), y: m(y + 30), dir: 0, roomId: c.id });
  c.addEntity({ type: 'turret', x: m(r.x1), y: m(y + 30), dir: Math.PI, roomId: c.id });
  ceilingLights(c);
}

export function entryRoom(c: RoomCtx): void {
  ceilingLights(c);
  scatterLoose(c, 2);
}

export const ROOM_KINDS = {
  entry: entryRoom,
  vault: vaultRoom,
  cargo: cargoRoom,
  fuel: fuelRoom,
  crew: crewRoom,
  machinery: machineryRoom,
  crusher: crusherRoom,
  moverHall,
  droneBay,
  security: securityRoom,
} as const;
export type RoomKind = keyof typeof ROOM_KINDS;

/** Rooms whose doorways start closed (plate plugs) so their air stays in. */
export const SEALED_KINDS: ReadonlySet<RoomKind> = new Set(['crew']);
