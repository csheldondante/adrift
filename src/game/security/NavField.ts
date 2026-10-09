// Coarse navigation for robots: the terrain downsampled to 2 m blocks (passable if nearly
// empty) and a BFS distance field toward a target, so any number of hunters can follow the
// gradient through corridors and doorways without per-robot pathfinding.
//
// Likely growth: incremental updates when terrain is cut (rebuild dirty blocks only), costs
// for hazards (avoid fuel rooms), several targets (distractions/noise lures).

import { CELL } from '../../config';
import type { PixelGrid } from '../../pixel/PixelGrid';

const BLOCK = 16; // cells per nav block (2 m)

export class NavField {
  readonly w: number;
  readonly h: number;
  readonly meters = BLOCK * CELL;
  private passable: Uint8Array;
  private dist: Int32Array;
  private queue: Int32Array;
  private tx = -1;
  private ty = -1;

  constructor(private readonly grid: PixelGrid) {
    this.w = Math.ceil(grid.w / BLOCK);
    this.h = Math.ceil(grid.h / BLOCK);
    this.passable = new Uint8Array(this.w * this.h);
    this.dist = new Int32Array(this.w * this.h).fill(-1);
    this.queue = new Int32Array(this.w * this.h);
    this.rebuild();
  }

  /** Re-derives passability from the terrain (call after big terrain changes). */
  rebuild(): void {
    const g = this.grid;
    for (let by = 0; by < this.h; by++)
      for (let bx = 0; bx < this.w; bx++) {
        let solid = 0;
        for (let y = by * BLOCK; y < (by + 1) * BLOCK && y < g.h; y += 2)
          for (let x = bx * BLOCK; x < (bx + 1) * BLOCK && x < g.w; x += 2) if (g.solid(x, y)) solid++;
        // a block counts as open if at most ~10% of it is matter
        this.passable[by * this.w + bx] = solid <= 6 ? 1 : 0;
      }
    if (this.tx >= 0) this.flood(this.tx, this.ty);
  }

  /** Recomputes distances toward a world point (only if it moved to a new block). */
  setTarget(x: number, y: number): void {
    const bx = Math.floor(x / this.meters);
    const by = Math.floor(y / this.meters);
    if (bx === this.tx && by === this.ty) return;
    this.tx = bx;
    this.ty = by;
    this.flood(bx, by);
  }

  private flood(bx: number, by: number): void {
    const { w, h, dist, queue, passable } = this;
    dist.fill(-1);
    if (bx < 0 || by < 0 || bx >= w || by >= h) return;
    let head = 0;
    let tail = 0;
    const s = by * w + bx;
    dist[s] = 0;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
        const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] >= 0 || !passable[j]) continue;
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }

  /**
   * Unit direction to step toward the target from a world point, following the distance
   * field; null if the point is cut off from the target (or there is no target).
   */
  direction(x: number, y: number, out: { x: number; y: number }): { x: number; y: number } | null {
    const bx = Math.floor(x / this.meters);
    const by = Math.floor(y / this.meters);
    let best = -1;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx;
        const ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const d = this.dist[ny * this.w + nx];
        // diagonal steps only when both orthogonal neighbors are open (no corner cutting)
        if (d < 0) continue;
        if (dx && dy && (this.dist[by * this.w + nx] < 0 || this.dist[ny * this.w + bx] < 0)) continue;
        if (d < bestD) [bestD, best] = [d, ny * this.w + nx];
      }
    if (best < 0) return null;
    const cx = ((best % this.w) + 0.5) * this.meters;
    const cy = (Math.floor(best / this.w) + 0.5) * this.meters;
    const l = Math.hypot(cx - x, cy - y) || 1;
    out.x = (cx - x) / l;
    out.y = (cy - y) / l;
    return out;
  }
}
