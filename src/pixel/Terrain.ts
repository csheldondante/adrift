// Static, world-aligned pixel terrain. Colliders are box-merged per CHUNK so a cut only
// rebuilds the chunks it touched.
//
// Likely growth: very large worlds -> stream chunks / per-chunk textures instead of one
// texture; smoother collision -> swap greedyRects for marching-squares polylines per chunk.
// Both stay behind rebuildChunk().

import { CELL, CHUNK } from '../config';
import { MAT_DENSITY } from './materials';
import { PixelGrid, type Rect } from './PixelGrid';
import { PixelObject } from './PixelObject';
import type { Body, Collider, Physics } from '../physics/Physics';

export class Terrain extends PixelObject {
  readonly kind = 'terrain' as const;
  readonly body: Body;
  private readonly cw: number;
  private readonly ch: number;
  private readonly chunkColliders: Collider[][];
  private readonly dirtyChunks = new Set<number>();

  constructor(
    private readonly physics: Physics,
    grid: PixelGrid,
    renderOrder: number,
  ) {
    super(grid, renderOrder);
    this.body = physics.world.createRigidBody(physics.R.RigidBodyDesc.fixed());
    this.cw = Math.ceil(grid.w / CHUNK);
    this.ch = Math.ceil(grid.h / CHUNK);
    this.chunkColliders = Array.from({ length: this.cw * this.ch }, () => []);
    this.syncTransform();
  }

  syncTransform(): void {
    this.setTransform(0, 0, 0);
  }

  markCollidersDirty(r: Rect): void {
    const cx0 = Math.max(0, Math.floor(r.x0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(r.y0 / CHUNK));
    const cx1 = Math.min(this.cw - 1, Math.floor((r.x1 - 1) / CHUNK));
    const cy1 = Math.min(this.ch - 1, Math.floor((r.y1 - 1) / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.dirtyChunks.add(cy * this.cw + cx);
  }

  rebuildAllColliders(): void {
    for (let i = 0; i < this.cw * this.ch; i++) this.dirtyChunks.add(i);
    this.rebuildDirtyColliders();
  }

  rebuildDirtyColliders(): void {
    for (const c of this.dirtyChunks) this.rebuildChunk(c);
    this.dirtyChunks.clear();
  }

  private rebuildChunk(c: number): void {
    const { physics, grid } = this;
    for (const col of this.chunkColliders[c]) physics.removeCollider(col);
    const list: Collider[] = (this.chunkColliders[c] = []);
    const cx = c % this.cw;
    const cy = Math.floor(c / this.cw);
    const rects: number[] = [];
    grid.greedyRects(cx * CHUNK, cy * CHUNK, Math.min(grid.w, (cx + 1) * CHUNK), Math.min(grid.h, (cy + 1) * CHUNK), rects);
    for (let k = 0; k < rects.length; k += 4) {
      const [x, y, w, h] = [rects[k], rects[k + 1], rects[k + 2], rects[k + 3]];
      const desc = physics.R.ColliderDesc.cuboid((w * CELL) / 2, (h * CELL) / 2)
        .setTranslation((x + w / 2) * CELL, (y + h / 2) * CELL)
        .setFriction(0.5)
        .setRestitution(0.1)
        .setDensity(MAT_DENSITY[grid.mat[y * grid.w + x]]);
      list.push(physics.createCollider(desc, this.body, this));
    }
  }
}
