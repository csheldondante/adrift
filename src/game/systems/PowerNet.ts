// The derelict's power: a network in the terrain's matter. Sources are POWER cells built into
// the structure and SOCKET cells with something live plugged in (a battery, a robot core you
// cut free and hauled over: any loose body whose powered conductor touches the socket).
// Power floods through conducting cells (conduit, lights, pumps, sockets, door motors), so a
// cut conduit really cuts the power past it and a welded-in core really powers what it
// touches. Results live in terrain.grid.powered, which rendering and Devices read.
//
// Re-floods when the terrain changes (cuts, welds, doors) and every few steps to notice
// plugs. Loose bodies with power cells are energized here too (robots also do their own).
//
// Likely growth: switches and breakers (a conducting cell you can toggle), power capacity
// (a battery that drains), sensors and turrets that wake when their section is powered.

import { CELL } from '../../config';
import type { Light } from '../../render/Lighting';
import { F, M, MAT_FLAGS } from '../../pixel/materials';
import type { PixelBody } from '../../pixel/PixelBody';
import type { PixelWorld } from '../../pixel/PixelWorld';
import type { Rect } from '../../pixel/PixelGrid';
import { energize, energizeFrom } from '../../pixel/power';

const CHECK_EVERY = 10; // physics steps between socket checks
const LIGHT_BUCKET = 24; // cells: powered fixture cells closer than this share one light
const p = { x: 0, y: 0 };
const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** A wall socket (a cluster of socket cells): center, face (point and outward normal), live. */
export interface SocketSpot {
  x: number;
  y: number;
  /** Middle of the open face a plug presses on (m), and its outward normal. */
  fx: number;
  fy: number;
  nx: number;
  ny: number;
  live: boolean;
  /** One socket cell of the cluster (terrain index). */
  i: number;
}

export class PowerNet {
  /** Built-in POWER cells in the terrain. */
  private readonly cores = new Set<number>();
  /** SOCKET cells in the terrain. */
  private readonly sockets = new Set<number>();
  private on: number[] = [];
  private dirty = true;
  private tick = 0;
  /** Sockets with something live plugged in (tests, HUD). */
  live = 0;
  /** Lights cast by powered fixtures, rebuilt with the network. */
  readonly lights: Light[] = [];
  /** Re-floods so far (tests). */
  floods = 0;
  private spots: SocketSpot[] | null = null;

  constructor(private readonly world: PixelWorld) {
    this.scan({ x0: 0, y0: 0, x1: world.terrain.grid.w, y1: world.terrain.grid.h });
  }

  /** Terrain changed in a rect: pick up new cores/sockets, and re-flood soon. */
  terrainChanged(r: Rect): void {
    this.scan(r);
    this.dirty = true;
    this.spots = null;
  }

  private scan(r: Rect): void {
    const g = this.world.terrain.grid;
    for (let y = Math.max(0, r.y0); y < Math.min(g.h, r.y1); y++)
      for (let x = Math.max(0, r.x0); x < Math.min(g.w, r.x1); x++) {
        const i = y * g.w + x;
        const m = g.mat[i];
        if (m === M.POWER) this.cores.add(i);
        else if (m === M.SOCKET) this.sockets.add(i);
      }
  }

  /**
   * Wall sockets, one spot per cluster of socket cells (world meters), and whether each is
   * live. Dead ones get a slow blue beacon so they can be found in the dark.
   */
  socketSpots(): readonly SocketSpot[] {
    const g = this.world.terrain.grid;
    if (!this.spots) {
      type B = { x: number; y: number; n: number; i: number; open: number[]; fx: number[]; fy: number[]; fn: number[] };
      const buckets = new Map<number, B>();
      for (const i of this.sockets) {
        const x = i % g.w;
        const y = (i - x) / g.w;
        const key = Math.floor(x / LIGHT_BUCKET) * 65536 + Math.floor(y / LIGHT_BUCKET);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { x: 0, y: 0, n: 0, i, open: [0, 0, 0, 0], fx: [0, 0, 0, 0], fy: [0, 0, 0, 0], fn: [0, 0, 0, 0] }));
        b.x += x + 0.5;
        b.y += y + 0.5;
        b.n++;
        // open sides: where a plug can press on
        for (let d = 0; d < 4; d++) {
          if (g.solid(x + DIRS[d][0], y + DIRS[d][1])) continue;
          b.open[d]++;
          b.fx[d] += x + 0.5 + DIRS[d][0] * 0.5;
          b.fy[d] += y + 0.5 + DIRS[d][1] * 0.5;
          b.fn[d]++;
        }
      }
      this.spots = [...buckets.values()].map((b) => {
        // the face: the side with the most open cells
        let d = 0;
        for (let k = 1; k < 4; k++) if (b.open[k] > b.open[d]) d = k;
        const has = b.fn[d] > 0;
        return {
          x: (b.x / b.n) * CELL,
          y: (b.y / b.n) * CELL,
          live: false,
          i: b.i,
          nx: DIRS[d][0],
          ny: DIRS[d][1],
          fx: has ? (b.fx[d] / b.fn[d]) * CELL : (b.x / b.n) * CELL,
          fy: has ? (b.fy[d] / b.fn[d]) * CELL : (b.y / b.n) * CELL,
        };
      });
    }
    for (const sp of this.spots) sp.live = g.powered[sp.i] === 1;
    return this.spots;
  }

  /** Is terrain cell (x, y) powered? */
  powered(x: number, y: number): boolean {
    const g = this.world.terrain.grid;
    return g.inside(x, y) && g.powered[y * g.w + x] === 1;
  }

  fixedUpdate(): void {
    if (++this.tick % CHECK_EVERY && !this.dirty) return;
    const world = this.world;
    const g = world.terrain.grid;
    // loose bodies carrying power (batteries, robot cores, wrecks) energize themselves
    for (const b of world.bodies) if (hasPower(b) && energize(b.grid)) b.paint({ x0: 0, y0: 0, x1: b.grid.w, y1: b.grid.h });
    const sources: number[] = [];
    for (const i of this.cores) if (g.mat[i] === M.POWER) sources.push(i);
    else this.cores.delete(i);
    let live = 0;
    for (const i of this.sockets) {
      if (g.mat[i] !== M.SOCKET) {
        this.sockets.delete(i);
        continue;
      }
      if (this.plugged(i)) {
        sources.push(i);
        live++;
      }
    }
    const changed = live !== this.live;
    this.live = live;
    if (!this.dirty && !changed) return;
    this.dirty = false;
    this.floods++;
    const res = energizeFrom(g, sources, this.on);
    this.on = res.on;
    for (const i of res.flipped) {
      const x = i % g.w;
      const y = (i - x) / g.w;
      world.terrain.paint({ x0: x, y0: y, x1: x + 1, y1: y + 1 });
    }
    this.rebuildLights();
  }

  /** A socket is live when a powered conducting cell of a loose body is right against it. */
  private plugged(i: number): boolean {
    const world = this.world;
    const g = world.terrain.grid;
    const x = i % g.w;
    const y = (i - x) / g.w;
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? -1 : d === 1 ? 1 : 0;
      const dy = d === 2 ? -1 : d === 3 ? 1 : 0;
      if (g.solid(x + dx, y + dy)) continue; // only the socket's open face
      // reach two cells out: pressed against it, not welded into it
      for (let k = 1; k <= 2; k++) {
        const wx = (x + 0.5 + dx * k) * CELL;
        const wy = (y + 0.5 + dy * k) * CELL;
        const o = world.objectAt(wx, wy, world.terrain);
        if (!o) continue;
        const b = o as PixelBody;
        b.worldToLocal(wx, wy, p);
        const bx = Math.floor(p.x);
        const by = Math.floor(p.y);
        const j = by * b.grid.w + bx;
        if (b.grid.inside(bx, by) && b.grid.powered[j] && MAT_FLAGS[b.grid.mat[j]] & F.CONDUCTS) return true;
      }
    }
    return false;
  }

  /** One warm omni light per cluster of powered fixture cells. */
  private rebuildLights(): void {
    const g = this.world.terrain.grid;
    const buckets = new Map<number, { x: number; y: number; n: number }>();
    for (const i of this.on) {
      if (g.mat[i] !== M.LIGHT) continue;
      const x = i % g.w;
      const y = (i - x) / g.w;
      const key = Math.floor(x / LIGHT_BUCKET) * 65536 + Math.floor(y / LIGHT_BUCKET);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { x: 0, y: 0, n: 0 }));
      b.x += x + 0.5;
      b.y += y + 0.5;
      b.n++;
    }
    this.lights.length = 0;
    for (const b of buckets.values())
      this.lights.push({ x: (b.x / b.n) * CELL, y: (b.y / b.n) * CELL, dirX: 0, dirY: -1, cosHalf: -2, range: 9 + Math.min(10, b.n * 0.4), intensity: 0.85, r: 1, g: 0.86, b: 0.62, skin: 0.6 });
  }
}

/** Does a loose body carry a power core (a battery, a robot core, a wreck)? */
export function hasPower(b: PixelBody): boolean {
  const m = b.grid.mat;
  for (let i = 0; i < m.length; i++) if (m[i] === M.POWER) return true;
  return false;
}
