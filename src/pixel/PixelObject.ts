// Shared base for anything made of pixel cells: static terrain and dynamic pixel bodies.
// Owns the grid, its CPU color buffer, the tiled display (PixelView), and the local<->world
// transform (cells are CELL meters; local origin = grid bottom-left corner).
//
// Likely growth: a custom node material (per-cell emissive/heat glow, normal-ish edge
// lighting) reading a material-id texture instead of baked RGBA. Painting is isolated in
// `paint()` so that swap only touches this file.

import { CELL, tune } from '../config';
import { cellColor, MAT_COOL, MAT_HEATCAP, MAT_HP, MAX_HEAT } from './materials';
import { PixelGrid, type Rect } from './PixelGrid';
import type { PhysOwner } from '../physics/Physics';
import { PixelView } from '../render/PixelView';

let scratchHot = new Int32Array(1024);

export abstract class PixelObject implements PhysOwner {
  abstract readonly kind: 'terrain' | 'pixelBody';
  /** Display object (tiled textured quads), positioned from the cached transform. */
  readonly view: PixelView;
  private readonly pixels: Uint32Array;
  /** Cells with visual heat, cooled and repainted each frame. */
  private readonly hot = new Set<number>();

  // cached transform, refreshed by syncTransform()
  px = 0;
  py = 0;
  angle = 0;
  cos = 1;
  sin = 0;

  constructor(
    readonly grid: PixelGrid,
    renderOrder: number,
  ) {
    this.pixels = new Uint32Array(grid.w * grid.h);
    this.view = new PixelView(this.pixels, grid.w, grid.h, renderOrder);
    this.paint({ x0: 0, y0: 0, x1: grid.w, y1: grid.h });
    // pieces split off hot material keep glowing
    for (let i = 0; i < grid.heat.length; i++) if (grid.heat[i] > 0) this.hot.add(i);
  }

  /** Number of cells currently glowing with heat. */
  get hotCount(): number {
    return this.hot.size;
  }

  /** The cells currently holding heat (flat indices). Don't mutate while iterating. */
  get hotCells(): ReadonlySet<number> {
    return this.hot;
  }

  /** Marks a cell as holding heat (after writing grid.heat directly). */
  markHot(i: number): void {
    if (this.grid.heat[i] > 0) this.hot.add(i);
  }

  /** Adds heat energy in a circle (local cell units); each material warms by amount / heatCap. */
  heatCircle(cx: number, cy: number, r: number, amount: number): void {
    const g = this.grid;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(g.w, Math.ceil(cx + r));
    const y1 = Math.min(g.h, Math.ceil(cy + r));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r || !g.solid(x, y)) continue;
        const i = y * g.w + x;
        g.heat[i] = Math.min(MAX_HEAT, g.heat[i] + (amount * (1 - d / r)) / MAT_HEATCAP[g.mat[i]]);
        this.hot.add(i);
        this.paintCell(i);
      }
  }

  /**
   * Conducts heat into neighboring solid cells, radiates it away per material, and repaints.
   * Call once per frame. Conduction is what makes the metal around a cut glow (and weld).
   */
  cool(dt: number): void {
    if (this.hot.size === 0) return;
    const g = this.grid;
    const { w, h, mat, heat } = g;
    // snapshot: cells warmed this pass join the set but aren't processed until next frame
    let cells = scratchHot;
    if (cells.length < this.hot.size) cells = scratchHot = new Int32Array(this.hot.size * 2);
    let n = 0;
    for (const i of this.hot) cells[n++] = i;
    const k = Math.min(0.2, tune.heat.conduction * dt);
    for (let c = 0; c < n; c++) {
      const i = cells[c];
      if (mat[i] === 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      // each pair moves heat once: only the hotter side gives
      for (let d = 0; d < 4; d++) {
        const nx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
        const ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mat[j] === 0 || heat[j] >= heat[i]) continue;
        const q = (heat[i] - heat[j]) * k;
        heat[i] -= q;
        heat[j] += q;
        if (!this.hot.has(j)) {
          this.hot.add(j);
          this.paintCell(j);
        }
      }
    }
    for (let c = 0; c < n; c++) {
      const i = cells[c];
      const t = heat[i] * Math.exp(-dt * MAT_COOL[mat[i]]) - dt * 0.01;
      if (t <= 0.01 || mat[i] === 0) {
        heat[i] = 0;
        this.hot.delete(i);
      } else heat[i] = t;
      this.paintCell(i);
    }
  }

  private paintCell(i: number): void {
    const g = this.grid;
    const m = g.mat[i];
    const max = MAT_HP[m];
    this.pixels[i] = cellColor(m, g.shade[i], max > 0 ? g.hp[i] / max : 1, g.heat[i], g.powered[i]);
    const x = i % g.w;
    const y = (i - x) / g.w;
    this.view.markDirty(x, y, x + 1, y + 1);
  }

  /** Recomputes display colors for a cell region. */
  paint(r: Rect): void {
    const { grid, pixels } = this;
    const x0 = Math.max(0, r.x0);
    const y0 = Math.max(0, r.y0);
    const x1 = Math.min(grid.w, r.x1);
    const y1 = Math.min(grid.h, r.y1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * grid.w + x;
        const m = grid.mat[i];
        const max = MAT_HP[m];
        pixels[i] = cellColor(m, grid.shade[i], max > 0 ? grid.hp[i] / max : 1, grid.heat[i], grid.powered[i]);
      }
    }
    this.view.markDirty(x0, y0, x1, y1);
  }

  /** Uploads painted changes. Call once per frame before rendering. */
  syncVisual(): void {
    this.view.sync();
    this.view.object.position.set(this.px, this.py, 0);
    this.view.object.rotation.z = this.angle;
  }

  protected setTransform(px: number, py: number, angle: number): void {
    this.px = px;
    this.py = py;
    this.angle = angle;
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
  }

  abstract syncTransform(): void;

  /** World meters -> local cell coordinates (fractional). */
  worldToLocal(wx: number, wy: number, out: { x: number; y: number }): { x: number; y: number } {
    const dx = wx - this.px;
    const dy = wy - this.py;
    out.x = (this.cos * dx + this.sin * dy) / CELL;
    out.y = (-this.sin * dx + this.cos * dy) / CELL;
    return out;
  }

  /** Local cell coordinates -> world meters. */
  localToWorld(cx: number, cy: number, out: { x: number; y: number }): { x: number; y: number } {
    const lx = cx * CELL;
    const ly = cy * CELL;
    out.x = this.px + this.cos * lx - this.sin * ly;
    out.y = this.py + this.sin * lx + this.cos * ly;
    return out;
  }

  /** Rotates a world direction into local space (unit-preserving). */
  dirToLocal(dx: number, dy: number, out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.cos * dx + this.sin * dy;
    out.y = -this.sin * dx + this.cos * dy;
    return out;
  }

  /** Conservative world-space bounding circle (center + radius) of the grid. */
  boundingCircle(out: { x: number; y: number; r: number }): { x: number; y: number; r: number } {
    const hw = (this.grid.w * CELL) / 2;
    const hh = (this.grid.h * CELL) / 2;
    this.localToWorld(this.grid.w / 2, this.grid.h / 2, out);
    out.r = Math.hypot(hw, hh);
    return out;
  }

  dispose(): void {
    this.view.dispose();
  }
}
