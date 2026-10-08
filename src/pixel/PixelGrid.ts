// Dense pixel-material grid plus the grid algorithms the destruction pipeline needs:
// circular damage, greedy rectangle merging (colliders), flood fill / components (detachment)
// and DDA raycast. Everything here is in local cell units; owners handle world transforms.
//
// Likely growth: per-cell temperature, more layers (wiring, background wall). Add parallel
// typed arrays here rather than packing bits into `mat`.

import { F, MAT_ARMOR, MAT_FLAGS, MAT_HP, M } from './materials';

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

export interface DestroyedCell {
  x: number; // local cell coords
  y: number;
  mat: number;
  shade: number;
}

export interface DamageResult {
  changed: Rect | null; // cells whose hp or material changed
  removed: Rect | null; // cells that became empty
  destroyed: DestroyedCell[];
}

export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 255;
}

export class PixelGrid {
  readonly mat: Uint8Array;
  readonly hp: Float32Array;
  readonly shade: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.mat = new Uint8Array(w * h);
    this.hp = new Float32Array(w * h);
    this.shade = new Uint8Array(w * h);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  solid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return (MAT_FLAGS[this.mat[y * this.w + x]] & F.SOLID) !== 0;
  }

  set(x: number, y: number, mat: number, shade = hash2(x, y)): void {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    this.mat[i] = mat;
    this.hp[i] = MAT_HP[mat];
    this.shade[i] = shade;
  }

  countSolid(): number {
    let n = 0;
    for (let i = 0; i < this.mat.length; i++) if (MAT_FLAGS[this.mat[i]] & F.SOLID) n++;
    return n;
  }

  /**
   * Damages cells in a circle (cell units). Full damage inside 60% of the radius, linear
   * falloff to the edge. Returns the changed region and the cells that were destroyed.
   */
  damageCircle(cx: number, cy: number, r: number, dmg: number, maxDestroyedReport = 256): DamageResult {
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.w, Math.ceil(cx + r) + 1);
    const y1 = Math.min(this.h, Math.ceil(cy + r) + 1);
    const res: DamageResult = { changed: null, removed: null, destroyed: [] };
    const r2 = r * r;
    const inner = r * 0.6;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = y * this.w + x;
        const m = this.mat[i];
        if (m === M.EMPTY) continue;
        const armor = MAT_ARMOR[m];
        if (armor === 0) continue;
        const d = Math.sqrt(d2);
        const fall = d <= inner ? 1 : 1 - (d - inner) / (r - inner);
        this.hp[i] -= dmg * armor * fall;
        res.changed = growRect(res.changed, x, y);
        if (this.hp[i] <= 0) {
          if (res.destroyed.length < maxDestroyedReport || MAT_FLAGS[m] & F.EXPLOSIVE) {
            res.destroyed.push({ x, y, mat: m, shade: this.shade[i] });
          }
          this.mat[i] = M.EMPTY;
          this.hp[i] = 0;
          res.removed = growRect(res.removed, x, y);
        }
      }
    }
    return res;
  }

  /** Clears the given cell indices. */
  clearCells(cells: ArrayLike<number>): void {
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      this.mat[i] = M.EMPTY;
      this.hp[i] = 0;
    }
  }

  /**
   * Greedy-merges solid cells in [x0,x1)×[y0,y1) into rectangles, appended to `out` as
   * flat [x, y, w, h] quadruples. Used to build box colliders.
   */
  greedyRects(x0: number, y0: number, x1: number, y1: number, out: number[]): void {
    const rw = x1 - x0;
    const rh = y1 - y0;
    const used = scratchU8(rw * rh);
    const { mat, w } = this;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (used[y * rw + x] || !(MAT_FLAGS[mat[(y + y0) * w + x + x0]] & F.SOLID)) continue;
        let ww = 1;
        while (x + ww < rw && !used[y * rw + x + ww] && MAT_FLAGS[mat[(y + y0) * w + x + x0 + ww]] & F.SOLID) ww++;
        let hh = 1;
        grow: while (y + hh < rh) {
          for (let k = 0; k < ww; k++) {
            const j = (y + hh) * rw + x + k;
            if (used[j] || !(MAT_FLAGS[mat[(y + y0 + hh) * w + x + x0 + k]] & F.SOLID)) break grow;
          }
          hh++;
        }
        for (let yy = 0; yy < hh; yy++) used.fill(1, (y + yy) * rw + x, (y + yy) * rw + x + ww);
        out.push(x + x0, y + y0, ww, hh);
      }
    }
  }

  /**
   * Labels 4-connected solid components over the whole grid. Returns a label per cell
   * (0 = empty) and the cell lists for each component, largest first.
   */
  components(): number[][] {
    const { w, h, mat } = this;
    const label = new Int32Array(w * h);
    const comps: number[][] = [];
    const stack: number[] = [];
    for (let s = 0; s < w * h; s++) {
      if (label[s] || !(MAT_FLAGS[mat[s]] & F.SOLID)) continue;
      const id = comps.length + 1;
      const cells: number[] = [];
      label[s] = id;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        cells.push(i);
        const x = i % w;
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (i >= w) visit(i - w);
        if (i < w * (h - 1)) visit(i + w);
      }
      comps.push(cells);
      function visit(j: number) {
        if (!label[j] && MAT_FLAGS[mat[j]] & F.SOLID) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    comps.sort((a, b) => b.length - a.length);
    return comps;
  }

  /**
   * DDA raycast against solid cells. Origin/direction in cell units, direction normalized.
   * Returns distance in cells to the first solid cell boundary, or -1.
   */
  raycast(ox: number, oy: number, dx: number, dy: number, maxT: number): number {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let t = 0;
    // enter the grid if starting outside it
    if (!this.inside(x, y)) {
      const tEnter = rayBoxEnter(ox, oy, dx, dy, this.w, this.h);
      if (tEnter < 0 || tEnter > maxT) return -1;
      const e = tEnter + 1e-4;
      const inner = this.raycast(ox + dx * e, oy + dy * e, dx, dy, maxT - e);
      return inner < 0 ? -1 : inner + e;
    }
    while (t <= maxT) {
      if (!this.inside(x, y)) return -1;
      if (MAT_FLAGS[this.mat[y * this.w + x]] & F.SOLID) return t;
      if (tmx < tmy) {
        t = tmx;
        tmx += tdx;
        x += stepX;
      } else {
        t = tmy;
        tmy += tdy;
        y += stepY;
      }
    }
    return -1;
  }
}

/** Entry distance of a ray into the box [0,w]×[0,h], or -1 if it misses. */
function rayBoxEnter(ox: number, oy: number, dx: number, dy: number, w: number, h: number): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const [o, d, hi] of [
    [ox, dx, w],
    [oy, dy, h],
  ]) {
    if (d === 0) {
      if (o < 0 || o > hi) return -1;
      continue;
    }
    let ta = (0 - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    tmin = Math.max(tmin, ta);
    tmax = Math.min(tmax, tb);
  }
  if (tmax < Math.max(tmin, 0)) return -1;
  return Math.max(tmin, 0);
}

export function growRect(r: Rect | null, x: number, y: number): Rect {
  if (!r) return { x0: x, y0: y, x1: x + 1, y1: y + 1 };
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (x + 1 > r.x1) r.x1 = x + 1;
  if (y + 1 > r.y1) r.y1 = y + 1;
  return r;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  a.x0 = Math.min(a.x0, b.x0);
  a.y0 = Math.min(a.y0, b.y0);
  a.x1 = Math.max(a.x1, b.x1);
  a.y1 = Math.max(a.y1, b.y1);
  return a;
}

let scratch = new Uint8Array(4096);
function scratchU8(n: number): Uint8Array {
  if (scratch.length < n) scratch = new Uint8Array(n * 2);
  const v = scratch.subarray(0, n);
  v.fill(0);
  return v;
}
