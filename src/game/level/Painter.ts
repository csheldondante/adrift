// Drawing primitives over a PixelGrid in cell coordinates (y up). Used by level builders
// and prop factories; later an image/tilemap importer can produce the same PixelGrids.

import { M } from '../../pixel/materials';
import { PixelGrid, hash2 } from '../../pixel/PixelGrid';

export class Painter {
  constructor(readonly g: PixelGrid) {}

  rect(x: number, y: number, w: number, h: number, mat: number): this {
    for (let yy = Math.max(0, y); yy < Math.min(this.g.h, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.g.w, x + w); xx++) this.g.set(xx, yy, mat);
    return this;
  }

  clear(x: number, y: number, w: number, h: number): this {
    return this.rect(x, y, w, h, M.EMPTY);
  }

  /** Hollow rectangle with wall thickness t. */
  box(x: number, y: number, w: number, h: number, t: number, mat: number): this {
    this.rect(x, y, w, t, mat);
    this.rect(x, y + h - t, w, t, mat);
    this.rect(x, y, t, h, mat);
    this.rect(x + w - t, y, t, h, mat);
    return this;
  }

  circle(cx: number, cy: number, r: number, mat: number): this {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.g.set(x, y, mat);
    return this;
  }

  line(x0: number, y0: number, x1: number, y1: number, thick: number, mat: number): this {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick / 2, mat);
    }
    return this;
  }

  /** Fills a polygon (even-odd rule). */
  poly(pts: [number, number][], mat: number): this {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) this.g.set(x, y, mat);
    }
    return this;
  }

  /** Darkens shade along a panel lattice for cells of `mat` (cosmetic seams). */
  seams(x: number, y: number, w: number, h: number, mat: number, sx: number, sy: number, shade = 24): this {
    const g = this.g;
    for (let yy = Math.max(0, y); yy < Math.min(g.h, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(g.w, x + w); xx++) {
        const i = yy * g.w + xx;
        if (g.mat[i] !== mat) continue;
        if (xx % sx === 0 || yy % sy === 0) g.shade[i] = shade;
        else if ((xx + 2) % sx === 0 && (yy + 2) % sy === 0) g.shade[i] = 230; // rivet glint
      }
    return this;
  }

  /** Bites random craters into the surface of `mat` cells for a weathered silhouette. */
  weather(x: number, y: number, w: number, h: number, count: number, rMin: number, rMax: number, seed: number): this {
    let s = seed;
    const rnd = () => (s = hash2(s, 91) + s * 13 + 7) % 1000 / 1000;
    for (let i = 0; i < count; i++) {
      const cx = x + rnd() * w;
      const cy = y + rnd() * h;
      this.circle(cx, cy, rMin + rnd() * (rMax - rMin), M.EMPTY);
    }
    return this;
  }
}
