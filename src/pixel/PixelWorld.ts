// Facade over all pixel matter (terrain + dynamic pixel bodies). Gameplay calls
// damageCircle()/raycast(); once per physics step flush() turns the accumulated cuts into
// collider rebuilds, terrain detachment (flood fill from cut edges) and body splits.
//
// Likely growth: more matter types (e.g. pixel-body enemies, welded structures) plug in as
// PixelObject subclasses; damage shapes beyond circles (beams, cones) become new damage*
// methods that reuse the same post-processing path.

import * as THREE from 'three/webgpu';
import { CELL, tune } from '../config';
import { F, MAT_FLAGS } from './materials';
import { PixelGrid, type Rect } from './PixelGrid';
import { PixelBody, type BodyInit } from './PixelBody';
import type { PixelObject } from './PixelObject';
import { Terrain } from './Terrain';
import type { Physics } from '../physics/Physics';
import { ORDER } from '../render/order';

export interface PixelWorldEvents {
  /** A cell was destroyed or shed as tiny debris; world position and velocity. */
  cellDestroyed?(wx: number, wy: number, mat: number, shade: number, vx: number, vy: number): void;
  /** An explosive cell was destroyed (by any cause). */
  explosiveDestroyed?(wx: number, wy: number): void;
  /** Terrain solidity changed in this cell rect (for the gas field's wall mask). */
  terrainChanged?(r: Rect): void;
  bodyRemoved?(b: PixelBody): void;
}

export interface RayHit {
  dist: number;
  x: number;
  y: number;
  target: PixelObject;
}

const tmp = { x: 0, y: 0 };
const tmp2 = { x: 0, y: 0 };
const circ = { x: 0, y: 0, r: 0 };

export class PixelWorld {
  readonly terrain: Terrain;
  readonly bodies: PixelBody[] = [];
  readonly group = new THREE.Group();
  events: PixelWorldEvents = {};

  private pendingTerrainCuts: Rect[] = [];
  private readonly stamp: Uint32Array;
  private stack: Int32Array; // sized to the detach cap, not the world
  private stampCounter = 1;

  constructor(
    private readonly physics: Physics,
    terrainGrid: PixelGrid,
  ) {
    this.terrain = new Terrain(physics, terrainGrid, ORDER.terrain);
    this.group.add(this.terrain.view.object);
    this.stamp = new Uint32Array(terrainGrid.w * terrainGrid.h);
    this.stack = new Int32Array(0);
  }

  addBody(grid: PixelGrid, init: BodyInit): PixelBody {
    const b = new PixelBody(this.physics, grid, init, init.tags?.salvage ? ORDER.bodies + 1 : ORDER.bodies);
    this.bodies.push(b);
    this.group.add(b.view.object);
    return b;
  }

  removeBody(b: PixelBody): void {
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
    this.events.bodyRemoved?.(b);
    b.destroy();
  }

  bodyAt(wx: number, wy: number): PixelBody | null {
    for (const b of this.bodies) {
      b.worldToLocal(wx, wy, tmp);
      if (b.grid.solid(Math.floor(tmp.x), Math.floor(tmp.y))) return b;
    }
    return null;
  }

  syncTransforms(): void {
    for (const b of this.bodies) b.syncTransform();
  }

  syncVisuals(): void {
    this.terrain.syncVisual();
    for (const b of this.bodies) b.syncVisual();
  }

  /** Damages all pixel matter within a world-space circle. Returns cells destroyed. */
  damageCircle(wx: number, wy: number, radius: number, dmg: number): number {
    let destroyed = this.damageObject(this.terrain, wx, wy, radius, dmg);
    for (const b of this.bodies) {
      b.boundingCircle(circ);
      const reach = circ.r + radius;
      if ((circ.x - wx) ** 2 + (circ.y - wy) ** 2 > reach * reach) continue;
      destroyed += this.damageObject(b, wx, wy, radius, dmg);
    }
    return destroyed;
  }

  /** Adds visual heat (glow) to all pixel matter in a world-space circle. */
  heatCircle(wx: number, wy: number, radius: number, amount: number): void {
    const heat = (o: PixelObject) => {
      o.worldToLocal(wx, wy, tmp);
      o.heatCircle(tmp.x, tmp.y, radius / CELL, amount);
    };
    heat(this.terrain);
    for (const b of this.bodies) {
      b.boundingCircle(circ);
      const reach = circ.r + radius;
      if ((circ.x - wx) ** 2 + (circ.y - wy) ** 2 <= reach * reach) heat(b);
    }
  }

  /** Cools glowing cells everywhere; call once per frame. */
  cool(dt: number): void {
    this.terrain.cool(dt);
    for (const b of this.bodies) b.cool(dt);
  }

  private damageObject(o: PixelObject, wx: number, wy: number, radius: number, dmg: number): number {
    o.worldToLocal(wx, wy, tmp);
    const res = o.grid.damageCircle(tmp.x, tmp.y, radius / CELL, dmg);
    if (res.changed) o.paint(res.changed);
    if (res.removed) {
      if (o === this.terrain) {
        this.terrain.markCollidersDirty(res.removed);
        this.pendingTerrainCuts.push(res.removed);
        this.events.terrainChanged?.(res.removed);
      } else {
        (o as PixelBody).needsSplitCheck = true;
      }
    }
    for (const c of res.destroyed) this.emitCell(o, c.x, c.y, c.mat, c.shade);
    return res.destroyed.length;
  }

  private emitCell(o: PixelObject, x: number, y: number, mat: number, shade: number): void {
    o.localToWorld(x + 0.5, y + 0.5, tmp2);
    let vx = 0;
    let vy = 0;
    if (o.kind === 'pixelBody') {
      const v = (o as PixelBody).body.velocityAtPoint(tmp2);
      vx = v.x;
      vy = v.y;
    }
    if (MAT_FLAGS[mat] & F.EXPLOSIVE) this.events.explosiveDestroyed?.(tmp2.x, tmp2.y);
    this.events.cellDestroyed?.(tmp2.x, tmp2.y, mat, shade, vx, vy);
  }

  /** Nearest solid pixel along a ray (direction normalized), in meters. */
  raycast(ox: number, oy: number, dx: number, dy: number, maxDist: number, ignore?: PixelBody): RayHit | null {
    let best: RayHit | null = null;
    const t = this.terrain.grid.raycast(ox / CELL, oy / CELL, dx, dy, maxDist / CELL);
    if (t >= 0) best = { dist: t * CELL, x: 0, y: 0, target: this.terrain };
    for (const b of this.bodies) {
      if (b === ignore) continue;
      b.boundingCircle(circ);
      // reject bodies whose bounding circle the ray segment misses
      const cx = circ.x - ox;
      const cy = circ.y - oy;
      const along = Math.max(0, Math.min(maxDist, cx * dx + cy * dy));
      if ((cx - dx * along) ** 2 + (cy - dy * along) ** 2 > circ.r * circ.r) continue;
      b.worldToLocal(ox, oy, tmp);
      b.dirToLocal(dx, dy, tmp2);
      const tb = b.grid.raycast(tmp.x, tmp.y, tmp2.x, tmp2.y, maxDist / CELL);
      if (tb >= 0 && (!best || tb * CELL < best.dist)) best = { dist: tb * CELL, x: 0, y: 0, target: b };
    }
    if (best) {
      best.x = ox + dx * best.dist;
      best.y = oy + dy * best.dist;
    }
    return best;
  }

  /** Turns this step's cuts into collider updates, detached terrain and split bodies. */
  flush(): void {
    if (this.pendingTerrainCuts.length) {
      const cuts = this.pendingTerrainCuts;
      this.pendingTerrainCuts = [];
      this.detachTerrain(cuts);
    }
    this.terrain.rebuildDirtyColliders();
    for (const b of this.bodies.slice()) {
      if (b.alive && b.needsSplitCheck) this.splitBody(b);
    }
  }

  private detachTerrain(cuts: Rect[]): void {
    const { grid } = this.terrain;
    const genStart = this.stampCounter;
    for (const r of cuts) {
      const x0 = Math.max(0, r.x0 - 1);
      const y0 = Math.max(0, r.y0 - 1);
      const x1 = Math.min(grid.w, r.x1 + 1);
      const y1 = Math.min(grid.h, r.y1 + 1);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * grid.w + x;
          if (this.stamp[i] >= genStart || !(MAT_FLAGS[grid.mat[i]] & F.SOLID)) continue;
          const cells = this.floodTerrain(i, genStart);
          if (cells) this.spawnFromCells(this.terrain, cells);
        }
      }
    }
  }

  /**
   * Flood fill from a terrain cell. Returns the component's cells if it is free-floating,
   * or null if it is anchored (touches an ANCHOR cell, exceeds the cap, or reaches cells an
   * earlier anchored flood in this pass visited).
   */
  private floodTerrain(start: number, genStart: number): number[] | null {
    const { grid } = this.terrain;
    const { w, h, mat } = grid;
    const cap = tune.pixel.detachCap;
    // pending cells never exceed visited×4, and a flood aborts past the cap
    if (this.stack.length < cap * 4 + 16) this.stack = new Int32Array(cap * 4 + 16);
    const { stamp, stack } = this;
    const id = this.stampCounter++;
    const cells: number[] = [];
    let sp = 0;
    stack[sp++] = start;
    stamp[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      cells.push(i);
      if (MAT_FLAGS[mat[i]] & F.ANCHOR || cells.length > cap) return null;
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
        const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!(MAT_FLAGS[mat[j]] & F.SOLID) || stamp[j] === id) continue;
        if (stamp[j] >= genStart) return null; // joined an anchored region
        stamp[j] = id;
        if (sp >= stack.length) return null; // too big to be a loose chunk: treat as anchored
        stack[sp++] = j;
      }
    }
    return cells;
  }

  private splitBody(b: PixelBody): void {
    b.needsSplitCheck = false;
    const comps = b.grid.components();
    if (comps.length === 0) {
      this.removeBody(b);
      return;
    }
    for (let k = 1; k < comps.length; k++) this.spawnFromCells(b, comps[k]);
    if (comps[0].length < tune.pixel.debrisMinCells && !b.tags.salvage) {
      this.spawnFromCells(b, comps[0]);
      this.removeBody(b);
      return;
    }
    b.rebuildColliders();
  }

  /** Moves cells out of `src` into a new body (or debris particles if tiny). */
  private spawnFromCells(src: PixelObject, cells: number[]): void {
    const sg = src.grid;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (const i of cells) {
      const x = i % sg.w;
      const y = (i - x) / sg.w;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (cells.length < tune.pixel.debrisMinCells) {
      for (const i of cells) {
        const x = i % sg.w;
        this.emitCell(src, x, (i - x) / sg.w, sg.mat[i], sg.shade[i]);
      }
    } else {
      const g = new PixelGrid(maxX - minX + 1, maxY - minY + 1);
      for (const i of cells) {
        const x = i % sg.w;
        const y = (i - x) / sg.w;
        const j = (y - minY) * g.w + (x - minX);
        g.mat[j] = sg.mat[i];
        g.hp[j] = sg.hp[i];
        g.shade[j] = sg.shade[i];
        g.heat[j] = sg.heat[i];
      }
      src.localToWorld(minX, minY, tmp);
      const init: BodyInit = { x: tmp.x, y: tmp.y, angle: src.angle };
      if (src.kind === 'pixelBody') {
        const pb = src as PixelBody;
        src.localToWorld(minX + g.w / 2, minY + g.h / 2, tmp2);
        const v = pb.body.velocityAtPoint(tmp2);
        init.vx = v.x;
        init.vy = v.y;
        init.w = pb.body.angvel();
      }
      this.addBody(g, init);
    }
    sg.clearCells(cells);
    const rect = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
    src.paint(rect);
    if (src === this.terrain) {
      this.terrain.markCollidersDirty(rect);
      this.events.terrainChanged?.(rect);
    }
  }

  dispose(): void {
    for (const b of this.bodies) b.dispose();
    this.bodies.length = 0;
    this.terrain.dispose();
    this.group.removeFromParent();
  }
}
