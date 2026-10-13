// Power networks in pixel matter. POWER cells are sources; anything flagged CONDUCTS (conduit,
// eyes, thrusters, weapons, power cells) carries it to its 4-neighbors. A cell is powered when
// a chain of conducting cells connects it to a power cell. The result lives in grid.powered,
// which rendering (emissive glow) and gameplay (robot systems) read.
//
// Cutting a conduit therefore really disconnects whatever is past the cut, and the matter is
// the only state: there's no separate wiring graph to fall out of sync with the pixels.
//
// Likely growth: the derelict's wall networks (terrain), with sockets and switches; a region
// limit so a terrain re-flood only touches the network that changed.

import { F, M, MAT_FLAGS } from './materials';
import type { PixelGrid } from './PixelGrid';

let stack = new Int32Array(1024);

/**
 * Recomputes grid.powered for the whole grid. Returns true if any cell changed (callers
 * repaint). Meant for small grids (robots, props); cost is O(cells).
 */
export function energize(g: PixelGrid): boolean {
  const { w, h, mat, powered } = g;
  const n = w * h;
  if (stack.length < n) stack = new Int32Array(n);
  const next = scratch(n);
  let sp = 0;
  for (let i = 0; i < n; i++)
    if (mat[i] === M.POWER) {
      next[i] = 1;
      stack[sp++] = i;
    }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  function visit(j: number) {
    if (next[j] || !(MAT_FLAGS[mat[j]] & F.CONDUCTS)) return;
    next[j] = 1;
    stack[sp++] = j;
  }
  let changed = false;
  for (let i = 0; i < n; i++)
    if (powered[i] !== next[i]) {
      powered[i] = next[i];
      changed = true;
    }
  return changed;
}

/** Counts powered cells of a material. */
export function countPowered(g: PixelGrid, m: number): number {
  let c = 0;
  for (let i = 0; i < g.mat.length; i++) if (g.mat[i] === m && g.powered[i]) c++;
  return c;
}

let buf = new Uint8Array(1024);
function scratch(n: number): Uint8Array {
  if (buf.length < n) buf = new Uint8Array(n * 2);
  const v = buf.subarray(0, n);
  v.fill(0);
  return v;
}
