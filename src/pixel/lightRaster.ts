// Rasterizes pixel matter into the lighting grid (see render/Lighting.ts): which texels block
// light, which glow (emissive materials and heat), and which are inside the derelict (over
// the back wall, so they get interior ambient instead of starlight).
//
// Glass passes light. Terrain is axis-aligned at its origin, so it's sampled directly; pixel
// bodies are sampled through their transform, only where their bounds overlap the grid.

import { CELL } from '../config';
import type { PixelGrid } from './PixelGrid';
import type { PixelWorld } from './PixelWorld';
import { F, M, MAT_FLAGS, MAT_RGB } from './materials';

/** Where the derelict's interior is (non-zero = over the back wall). */
export interface InteriorMask {
  mat: Uint8Array;
  w: number;
  h: number;
}

const circ = { x: 0, y: 0, r: 0 };

/** Writes one cell's contribution into texel k (flags keep the interior bit). */
function sampleCell(g: PixelGrid, cx: number, cy: number, out: Float32Array, k: number, weight: number, occlusion = true): void {
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return;
  const ci = cy * g.w + cx;
  const m = g.mat[ci];
  if (m === 0) return;
  if (occlusion && OCCLUDES[m] && out[k + 3] % 2 < 1) out[k + 3] += 1;
  if (EMITS[m]) {
    const s = 0.9 * weight;
    out[k] += (MAT_RGB[m * 3] / 255) * s;
    out[k + 1] += (MAT_RGB[m * 3 + 1] / 255) * s;
    out[k + 2] += (MAT_RGB[m * 3 + 2] / 255) * s;
  }
  const h = g.heat[ci];
  if (h > 0.02) {
    const s = Math.min(1, h) * 1.3 * weight;
    out[k] += s;
    out[k + 1] += s * 0.42 * h;
    out[k + 2] += s * 0.12 * h * h;
  }
}

// per-material lookups: occludes light, and emitted rgb (fixtures stay dark: unpowered)
const OCCLUDES = new Uint8Array(256);
const EMITS = new Uint8Array(256);
for (let m = 1; m < 256; m++) {
  OCCLUDES[m] = MAT_FLAGS[m] & F.SOLID && m !== M.GLASS ? 1 : 0;
  EMITS[m] = MAT_FLAGS[m] & F.EMISSIVE && m !== M.LIGHT ? 1 : 0;
}
let colsA = new Int32Array(0);
let colsB = new Int32Array(0);

export function rasterPixels(world: PixelWorld, backdrop: InteriorMask | null, out: Float32Array, gw: number, gh: number, ox: number, oy: number, ts: number): void {
  const terrain = world.terrain;
  const tg = terrain.grid;
  const W = tg.w;
  const H = tg.h;
  const mat = tg.mat;
  const hot = terrain.hotCount > 0;
  const bmat = backdrop && backdrop.w === W && backdrop.h === H ? backdrop.mat : null;
  // two diagonal samples per texel when a texel spans several cells, so 1-cell walls still block
  const q = ts > CELL * 1.5 ? ts / 4 : 0;
  if (colsA.length < gw) {
    colsA = new Int32Array(gw);
    colsB = new Int32Array(gw);
  }
  for (let ix = 0; ix < gw; ix++) {
    const wx = ox + (ix + 0.5) * ts - terrain.px;
    colsA[ix] = Math.floor((wx - q) / CELL);
    colsB[ix] = Math.floor((wx + q) / CELL);
  }
  for (let iy = 0; iy < gh; iy++) {
    const wy = oy + (iy + 0.5) * ts - terrain.py;
    const ra = Math.floor((wy - q) / CELL);
    const rb = Math.floor((wy + q) / CELL);
    if (rb < 0 || ra >= H) continue;
    const okA = ra >= 0 && ra < H;
    const okB = rb >= 0 && rb < H;
    const rowA = ra * W;
    const rowB = rb * W;
    let k = iy * gw * 4;
    for (let ix = 0; ix < gw; ix++, k += 4) {
      const ca = colsA[ix];
      const cb = colsB[ix];
      const ia = okA && ca >= 0 && ca < W ? rowA + ca : -1;
      const ib = okB && cb >= 0 && cb < W ? rowB + cb : -1;
      const ma = ia >= 0 ? mat[ia] : 0;
      const mb = ib >= 0 ? mat[ib] : 0;
      let flags = OCCLUDES[ma] | OCCLUDES[mb];
      if (bmat && ia >= 0 && bmat[ia] !== 0) flags |= 2;
      out[k + 3] = flags;
      if ((ma | mb) === 0) continue;
      if (EMITS[ma] | EMITS[mb] || hot) {
        if (ia >= 0) sampleCell(tg, ca, ra, out, k, 0.5, false);
        if (ib >= 0) sampleCell(tg, cb, rb, out, k, 0.5, false);
      }
    }
  }

  const x1 = ox + gw * ts;
  const y1 = oy + gh * ts;
  for (const b of world.bodies) {
    b.boundingCircle(circ);
    if (circ.x + circ.r < ox || circ.x - circ.r > x1 || circ.y + circ.r < oy || circ.y - circ.r > y1) continue;
    const g = b.grid;
    const ix0 = Math.max(0, Math.floor((circ.x - circ.r - ox) / ts));
    const iy0 = Math.max(0, Math.floor((circ.y - circ.r - oy) / ts));
    const ix1 = Math.min(gw - 1, Math.floor((circ.x + circ.r - ox) / ts));
    const iy1 = Math.min(gh - 1, Math.floor((circ.y + circ.r - oy) / ts));
    const { cos, sin, px, py } = b;
    for (let iy = iy0; iy <= iy1; iy++) {
      const dy = oy + (iy + 0.5) * ts - py;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = ox + (ix + 0.5) * ts - px;
        const lx = (cos * dx + sin * dy) / CELL;
        const ly = (-sin * dx + cos * dy) / CELL;
        if (lx < 0 || ly < 0 || lx >= g.w || ly >= g.h) continue;
        sampleCell(g, Math.floor(lx), Math.floor(ly), out, (iy * gw + ix) * 4, 1);
      }
    }
  }
}
