// Prop factories: small PixelGrids for loose bodies.

import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';

export function crate(w: number, h: number): PixelGrid {
  const g = new PixelGrid(w, h);
  const p = new Painter(g).rect(0, 0, w, h, M.PLATE).box(0, 0, w, h, 2, M.HULL);
  p.line(2, 2, w - 3, h - 3, 2, M.HULL);
  return g;
}

export function barrel(r: number): PixelGrid {
  const d = Math.ceil(r * 2);
  const g = new PixelGrid(d, d);
  new Painter(g).circle(r, r, r, M.HULL).circle(r, r, r - 2, M.FUEL).rect(Math.floor(r) - 1, 2, 2, d - 4, M.HULL);
  return g;
}

export function scrap(seed: number, size: number): PixelGrid {
  const g = new PixelGrid(size, size);
  const p = new Painter(g);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const c = size / 2;
  for (let i = 0; i < 4; i++) {
    const w = 3 + rnd() * size * 0.5;
    const h = 2 + rnd() * size * 0.25;
    p.line(c - w / 2 + rnd() * 2, c - h / 2 + rnd() * h, c + w / 2, c + (rnd() - 0.5) * size * 0.5, 2 + rnd() * 3, rnd() < 0.5 ? M.SCRAP : M.HULL);
  }
  p.circle(c, c, 2.5, M.SCRAP); // keep it one connected piece
  return g;
}

/** The salvage component: a reactor capsule with an indestructible casing and lit panels. */
export function salvageCore(): PixelGrid {
  const w = 44;
  const h = 30;
  const g = new PixelGrid(w, h);
  const p = new Painter(g);
  p.rect(6, 0, w - 12, h, M.CORE).circle(7, h / 2, h / 2, M.CORE).circle(w - 7, h / 2, h / 2, M.CORE);
  for (let x = 12; x < w - 12; x += 5) p.rect(x, 6, 2, h - 12, M.LIGHT);
  p.rect(10, h / 2 - 1, w - 20, 2, M.CORE);
  p.seams(0, 0, w, h, M.CORE, 11, 100, 90);
  return g;
}
