// The black and white schematic: how a cell of matter is drawn on a scan, and the map of
// everything you've scanned so far.
//
// Drawing (shared by the scan pulse and the map): every surface as a bright line (wall
// faces, hidden cavities), boundaries between materials as finer lines, a 1 m drafting grid
// in plain structure, tough material (frame, armor, pressure doors) hatched, and systems by
// pattern: cores solid white; power lines solid when live, dashed when dead; sockets and
// panels solid when live, dotted when dead; pumps cross-hatched; fixtures and eyes dotted;
// fuel ruled; thrusters and weapons lined. Grayscale only.
//
// The map remembers which cells a pulse reached (per object) and keeps them drawn, dimmer
// than a fresh pulse. It's redrawn from the matter as it is now, a few chunks a frame, so a
// mapped line that goes live turns solid, a door you watched open shows open, and cells cut
// away vanish from it. Terrain is split into 64-cell chunks, each its own texture, made on
// first use; bodies get the same (one chunk for most).
//
// Likely growth: a minimap from the same bits; map fading for areas not seen in a while.

import * as THREE from 'three/webgpu';
import { CELL } from '../config';
import { F, M, MAT_BURN, MAT_FLAGS } from '../pixel/materials';
import type { PixelGrid } from '../pixel/PixelGrid';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';

export const S = 3; // texels per cell: room for hairlines inside a cell

export const K = { NONE: 0, STRUCT: 1, TOUGH: 2, CONDUIT: 3, POWER: 4, SOCKET: 5, PUMP: 6, FIXTURE: 7, FUEL: 8, ENGINE: 9, WEAPON: 10 } as const;
export const KIND = new Uint8Array(256);
for (let m = 1; m < 256; m++) if (MAT_FLAGS[m] & F.SOLID) KIND[m] = MAT_BURN[m] >= 0.85 ? K.TOUGH : K.STRUCT;
KIND[M.CONDUIT] = K.CONDUIT;
KIND[M.POWER] = K.POWER;
KIND[M.SOCKET] = K.SOCKET;
KIND[M.PANEL] = K.SOCKET;
KIND[M.PUMP] = K.PUMP;
KIND[M.LIGHT] = K.FIXTURE;
KIND[M.EYE] = K.FIXTURE;
KIND[M.FUEL] = K.FUEL;
KIND[M.THRUSTER] = K.ENGINE;
KIND[M.WEAPON] = K.WEAPON;
/** Systems worth reporting (tests): cores, lines, sockets, pumps, fixtures, fuel. */
export const FEATURE = (k: number) => k === K.CONDUIT || k === K.POWER || k === K.SOCKET || k === K.PUMP || k === K.FIXTURE || k === K.FUEL;

export const grey = (v: number, a: number) => ((a << 24) | (v << 16) | (v << 8) | v) >>> 0;

/** Grey level of a texel inside a cell of kind k, or -1 for plain paper. */
function pattern(k: number, live: boolean, x: number, y: number, sx: number, sy: number): number {
  const tx = x * S + sx; // object texel coords, so patterns run on across cells
  const ty = y * S + sy;
  switch (k) {
    case K.STRUCT:
      return (x % 8 === 0 && sx === 0) || (y % 8 === 0 && sy === 0) ? 48 : -1; // 1 m drafting grid
    case K.TOUGH:
      return (tx + ty) % 5 === 0 ? 150 : -1;
    case K.CONDUIT:
      return live ? 255 : (((tx + ty) / (2 * S)) | 0) & 1 ? 200 : -1;
    case K.POWER:
      return 255;
    case K.SOCKET:
      return live || (sx === 1 && sy === 1) ? 255 : -1;
    case K.PUMP:
      return (tx + ty) % 4 === 0 || (tx - ty + 4096) % 4 === 0 ? (live ? 255 : 130) : -1;
    case K.FIXTURE:
      return sx === 1 && sy === 1 ? (live ? 255 : 130) : -1;
    case K.FUEL:
      return ty % 3 === 0 ? 170 : -1;
    case K.ENGINE:
      return tx % 3 === 0 ? (live ? 230 : 110) : -1;
    case K.WEAPON:
      return tx % 3 === 0 || ty % 3 === 0 ? (live ? 230 : 110) : -1;
  }
  return -1;
}

const kindAt = (g: PixelGrid, x: number, y: number) => (g.inside(x, y) ? KIND[g.mat[y * g.w + x]] : K.NONE);

/** Draws grid cell (x, y) as S×S texels into `img` (row stride tw) at texel (ox, oy). */
export function drawCell(g: PixelGrid, x: number, y: number, img: Uint32Array, tw: number, ox: number, oy: number, paper: number): void {
  const gi = y * g.w + x;
  const kind = KIND[g.mat[gi]];
  const live = g.powered[gi] === 1;
  const nl = kindAt(g, x - 1, y);
  const nr = kindAt(g, x + 1, y);
  const nd = kindAt(g, x, y - 1);
  const nu = kindAt(g, x, y + 1);
  for (let ty = 0; ty < S; ty++)
    for (let tx = 0; tx < S; tx++) {
      // outlines: surfaces bright, boundaries between materials finer
      let edge = -1;
      if (tx === 0 && nl !== kind) edge = nl === K.NONE ? 255 : 175;
      if (tx === S - 1 && nr !== kind) edge = Math.max(edge, nr === K.NONE ? 255 : 175);
      if (ty === 0 && nd !== kind) edge = Math.max(edge, nd === K.NONE ? 255 : 175);
      if (ty === S - 1 && nu !== kind) edge = Math.max(edge, nu === K.NONE ? 255 : 175);
      const v = edge >= 0 ? edge : pattern(kind, live, x, y, tx, ty);
      img[(oy + ty) * tw + ox + tx] = v >= 0 ? grey(v, 255) : paper;
    }
}

const CHUNK = 64; // cells
const MAP_PAPER = grey(0, 170);
const MAP_OPACITY = 0.6;
const RENDERS_PER_FRAME = 3; // chunk redraws per frame (new cells first, then a sweep)

interface Chunk {
  cx: number;
  cy: number;
  px: Uint32Array;
  tex: THREE.DataTexture;
  mesh: THREE.Mesh;
}

/** One object's map: which cells were scanned, drawn in chunks. */
class Layer {
  readonly mapped: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly chunks: (Chunk | undefined)[];
  readonly list: Chunk[] = [];
  readonly dirty = new Set<number>();
  readonly group = new THREE.Group();
  cells = 0;

  constructor(readonly obj: PixelObject) {
    const g = obj.grid;
    this.mapped = new Uint8Array(g.w * g.h);
    this.cols = Math.ceil(g.w / CHUNK);
    this.rows = Math.ceil(g.h / CHUNK);
    this.chunks = new Array(this.cols * this.rows);
    obj.view.object.add(this.group);
  }

  mark(x: number, y: number): void {
    const g = this.obj.grid;
    const i = y * g.w + x;
    if (this.mapped[i]) return;
    this.mapped[i] = 1;
    this.cells++;
    this.dirty.add(Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK));
  }

  render(ci: number): void {
    const g = this.obj.grid;
    let c = this.chunks[ci];
    if (!c) {
      const cx = ci % this.cols;
      const cy = (ci - cx) / this.cols;
      const data = new Uint8Array(CHUNK * S * CHUNK * S * 4);
      const tex = new THREE.DataTexture(data, CHUNK * S, CHUNK * S, THREE.RGBAFormat);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = new THREE.PlaneGeometry(CHUNK * CELL, CHUNK * CELL);
      geo.translate((cx + 0.5) * CHUNK * CELL, (cy + 0.5) * CHUNK * CELL, 0);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: MAP_OPACITY, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = ORDER.glow - 0.5; // under fresh pulses
      mesh.frustumCulled = false;
      this.group.add(mesh);
      c = { cx, cy, px: new Uint32Array(data.buffer), tex, mesh };
      this.chunks[ci] = c;
      this.list.push(c);
    }
    const tw = CHUNK * S;
    const x0 = c.cx * CHUNK;
    const y0 = c.cy * CHUNK;
    for (let ly = 0; ly < CHUNK; ly++) {
      const y = y0 + ly;
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = x0 + lx;
        if (x < g.w && y < g.h && this.mapped[y * g.w + x] && MAT_FLAGS[g.mat[y * g.w + x]] & F.SOLID) drawCell(g, x, y, c.px, tw, lx * S, ly * S, MAP_PAPER);
        else for (let ty = 0; ty < S; ty++) c.px.fill(0, (ly * S + ty) * tw + lx * S, (ly * S + ty) * tw + lx * S + S);
      }
    }
    c.tex.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const c of this.list) {
      c.mesh.geometry.dispose();
      (c.mesh.material as THREE.Material).dispose();
      c.tex.dispose();
    }
  }
}

/** Everything scanned so far, kept on the walls (and on bodies) as a dim schematic. */
export class SchematicMap {
  private readonly layers = new Map<PixelObject, Layer>();
  private sweep = 0;
  private visible = true;

  /** Cells mapped so far, over all objects (tests). */
  get cells(): number {
    let n = 0;
    for (const l of this.layers.values()) n += l.cells;
    return n;
  }

  /** Chunks drawn so far (tests). */
  get chunks(): number {
    let n = 0;
    for (const l of this.layers.values()) n += l.list.length;
    return n;
  }

  /** Is cell (x, y) of `obj` mapped? */
  isMapped(obj: PixelObject, x: number, y: number): boolean {
    const l = this.layers.get(obj);
    return !!l && obj.grid.inside(x, y) && l.mapped[y * obj.grid.w + x] === 1;
  }

  /** Records a scanned cell of `obj`. */
  mark(obj: PixelObject, x: number, y: number): void {
    let l = this.layers.get(obj);
    if (!l) {
      l = new Layer(obj);
      l.group.visible = this.visible;
      this.layers.set(obj, l);
    }
    l.mark(x, y);
  }

  /** Shows or hides the map (N). Returns the new state. */
  toggle(): boolean {
    this.visible = !this.visible;
    for (const l of this.layers.values()) l.group.visible = this.visible;
    return this.visible;
  }

  /** Redraws a few chunks: newly mapped ones first, then a slow sweep to keep the rest current. */
  frameUpdate(): void {
    let budget = RENDERS_PER_FRAME;
    for (const [obj, l] of this.layers) {
      if ((obj as { alive?: boolean }).alive === false) {
        l.dispose();
        this.layers.delete(obj);
        continue;
      }
      for (const ci of l.dirty) {
        if (budget <= 0) break;
        l.dirty.delete(ci);
        l.render(ci);
        budget--;
      }
    }
    if (budget <= 0 || !this.visible) return;
    // one chunk a frame across all layers, so live lines, opened doors and cuts show
    const all: [Layer, number][] = [];
    for (const l of this.layers.values()) for (let k = 0; k < l.list.length; k++) all.push([l, k]);
    if (!all.length) return;
    const [l, k] = all[this.sweep++ % all.length];
    const c = l.list[k];
    l.render(c.cy * l.cols + c.cx);
  }

  dispose(): void {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
  }
}
