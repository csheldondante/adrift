// Vibration scan: knock on the structure you're touching and listen to what comes back.
// A pulse spreads from the contact point through solid matter only (like conducted sound:
// it doesn't cross gaps), up to a radius, and draws what it passed through as a black and
// white schematic over the walls (an x-ray of the structure):
//   - every surface it reached as a bright line: wall faces, and hidden cavities behind them
//   - boundaries between materials as finer lines, with a 1 m drafting grid in plain structure
//   - tough material (burns only at white heat: frame, armor, pressure doors) hatched
//   - systems by pattern: cores solid white; power lines solid when live, dashed when dead;
//     sockets solid when live, dotted when dead; pumps cross-hatched; fixtures and eyes
//     dotted; fuel ruled; thrusters and weapons lined
// A bright ring runs out at about 45 m/s, then the picture holds and fades.
//
// Footfalls while hull-walking send small pulses; V knocks a strong one (anything you're
// touching). The overlay is drawn after the darkness, so it reads in the dark.
//
// Likely growth: sensors hear knocks (a loud scan is a risk); a scan upgrade with range;
// remembering scanned features on the minimap.

import * as THREE from 'three/webgpu';
import { CELL } from '../config';
import { F, M, MAT_BURN, MAT_FLAGS } from '../pixel/materials';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';

interface Pulse {
  obj: PixelObject;
  /** Window cells in the order the pulse reached them (sorted by distance). */
  order: Int32Array;
  /** Path length through matter (cells) of each entry of `order`. */
  dist: Float32Array;
  /** Finished schematic, S×S texels per window cell. */
  img: Uint32Array;
  w: number; // window width in cells
  px: Uint32Array; // texture pixels
  tex: THREE.DataTexture;
  mesh: THREE.Mesh;
  age: number;
  reach: number; // cells
  strength: number;
  shown: number; // entries of `order` drawn so far
  band: number; // first entry still inside the bright ring front
}

const S = 3; // texels per cell: room for hairlines inside a cell
const SPEED = 45 / CELL; // cells per second
const RING = 2.5; // cells: width of the bright front
const HOLD = 2.5; // s the finished picture holds
const FADE = 2.5; // s it then takes to fade
const MAX_PULSES = 5;

// what each material is on the schematic
const K = { NONE: 0, STRUCT: 1, TOUGH: 2, CONDUIT: 3, POWER: 4, SOCKET: 5, PUMP: 6, FIXTURE: 7, FUEL: 8, ENGINE: 9, WEAPON: 10 } as const;
const KIND = new Uint8Array(256);
for (let m = 1; m < 256; m++) if (MAT_FLAGS[m] & F.SOLID) KIND[m] = MAT_BURN[m] >= 0.85 ? K.TOUGH : K.STRUCT;
KIND[M.CONDUIT] = K.CONDUIT;
KIND[M.POWER] = K.POWER;
KIND[M.SOCKET] = K.SOCKET;
KIND[M.PUMP] = K.PUMP;
KIND[M.LIGHT] = K.FIXTURE;
KIND[M.EYE] = K.FIXTURE;
KIND[M.FUEL] = K.FUEL;
KIND[M.THRUSTER] = K.ENGINE;
KIND[M.WEAPON] = K.WEAPON;
/** Systems worth reporting (tests): cores, lines, sockets, pumps, fixtures, fuel. */
const FEATURE = (k: number) => k === K.CONDUIT || k === K.POWER || k === K.SOCKET || k === K.PUMP || k === K.FIXTURE || k === K.FUEL;

const grey = (v: number, a: number) => ((a << 24) | (v << 16) | (v << 8) | v) >>> 0;
const PAPER = grey(0, 228); // the black fill over the walls
const RING_PX = grey(255, 210);

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

export class Scanner {
  private readonly pulses: Pulse[] = [];
  /** Pulses sent so far, and the last few: cells reached and features revealed (tests). */
  sent = 0;
  readonly history: { reached: number; features: number; strength: number }[] = [];

  /** A knock's schematic is on screen (HUD legend). */
  get showing(): boolean {
    return this.pulses.some((p) => p.strength >= 0.9);
  }

  /**
   * Sends a pulse into `obj` from world point (wx, wy), reaching `radius` meters through its
   * matter. Strength 0..1 scales opacity.
   */
  ping(obj: PixelObject, wx: number, wy: number, radius: number, strength: number): void {
    const g = obj.grid;
    const lp = obj.worldToLocal(wx, wy, { x: 0, y: 0 });
    // start from the nearest solid cell to the contact point
    let sx = -1;
    let sy = -1;
    let best = Infinity;
    const cx = Math.floor(lp.x);
    const cy = Math.floor(lp.y);
    for (let dy = -12; dy <= 12; dy++)
      for (let dx = -12; dx <= 12; dx++) {
        const d = dx * dx + dy * dy;
        if (d < best && g.solid(cx + dx, cy + dy)) {
          best = d;
          sx = cx + dx;
          sy = cy + dy;
        }
      }
    if (sx < 0) return;
    const reach = Math.round(radius / CELL);
    const x0 = Math.max(0, sx - reach);
    const y0 = Math.max(0, sy - reach);
    const w = Math.min(g.w, sx + reach + 1) - x0;
    const h = Math.min(g.h, sy + reach + 1) - y0;
    const seen = new Uint8Array(w * h);
    const order: number[] = [];
    const dist: number[] = [];
    // breadth-first through solid cells: distance = path length through the matter
    let frontier = [(sy - y0) * w + (sx - x0)];
    seen[frontier[0]] = 1;
    let features = 0;
    for (let step = 0; frontier.length && step <= reach; step++) {
      const next: number[] = [];
      for (const k of frontier) {
        order.push(k);
        dist.push(step);
        const lx = k % w;
        const ly = (k - lx) / w;
        if (FEATURE(KIND[g.mat[(ly + y0) * g.w + lx + x0]])) features++;
        for (let d = 0; d < 4; d++) {
          const nx = lx + (d === 0 ? -1 : d === 1 ? 1 : 0);
          const ny = ly + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (seen[j] || !(MAT_FLAGS[g.mat[(ny + y0) * g.w + nx + x0]] & F.SOLID)) continue;
          seen[j] = 1;
          next.push(j);
        }
      }
      frontier = next;
    }
    this.sent++;
    this.history.push({ reached: order.length, features, strength });
    if (this.history.length > 8) this.history.shift();

    // draw the finished schematic once; frames only reveal it
    const tw = w * S;
    const img = new Uint32Array(tw * h * S);
    const kindAt = (x: number, y: number) => (g.inside(x, y) ? KIND[g.mat[y * g.w + x]] : K.NONE);
    for (const k of order) {
      const lx = k % w;
      const ly = (k - lx) / w;
      const x = lx + x0;
      const y = ly + y0;
      const gi = y * g.w + x;
      const kind = KIND[g.mat[gi]];
      const live = g.powered[gi] === 1;
      const nl = kindAt(x - 1, y);
      const nr = kindAt(x + 1, y);
      const nd = kindAt(x, y - 1);
      const nu = kindAt(x, y + 1);
      for (let ty = 0; ty < S; ty++)
        for (let tx = 0; tx < S; tx++) {
          // outlines: surfaces bright, boundaries between materials finer
          let edge = -1;
          if (tx === 0 && nl !== kind) edge = nl === K.NONE ? 255 : 175;
          if (tx === S - 1 && nr !== kind) edge = Math.max(edge, nr === K.NONE ? 255 : 175);
          if (ty === 0 && nd !== kind) edge = Math.max(edge, nd === K.NONE ? 255 : 175);
          if (ty === S - 1 && nu !== kind) edge = Math.max(edge, nu === K.NONE ? 255 : 175);
          const v = edge >= 0 ? edge : pattern(kind, live, x, y, tx, ty);
          img[(ly * S + ty) * tw + lx * S + tx] = v >= 0 ? grey(v, 255) : PAPER;
        }
    }
    const data = new Uint8Array(img.length * 4);
    const tex = new THREE.DataTexture(data, tw, h * S, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(w * CELL, h * CELL);
    geo.translate((x0 + w / 2) * CELL, (y0 + h / 2) * CELL, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = ORDER.glow;
    mesh.frustumCulled = false;
    obj.view.object.add(mesh); // rides along with a moving body
    this.pulses.push({ obj, order: Int32Array.from(order), dist: Float32Array.from(dist), img, w, px: new Uint32Array(data.buffer), tex, mesh, age: 0, reach, strength, shown: 0, band: 0 });
    while (this.pulses.length > MAX_PULSES) this.drop(0);
  }

  frameUpdate(dt: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.age += dt;
      const front = p.age * SPEED;
      const done = p.age - (p.reach + RING) / SPEED; // s since the ring ran out
      const fade = done < HOLD ? 1 : 1 - (done - HOLD) / FADE;
      if (fade <= 0 || (p.obj as { alive?: boolean }).alive === false) {
        this.drop(i);
        continue;
      }
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = fade * p.strength;
      if (p.band >= p.order.length) continue; // fully drawn, only fading
      // reveal up to the ring front, with the front itself drawn bright
      let shown = p.shown;
      while (shown < p.order.length && p.dist[shown] <= front) shown++;
      let band = p.band;
      while (band < shown && p.dist[band] <= front - RING) band++;
      if (front > p.reach + RING) band = shown = p.order.length;
      for (let e = p.band; e < shown; e++) this.blit(p, p.order[e], e >= band);
      p.shown = shown;
      p.band = band;
      p.tex.needsUpdate = true;
    }
  }

  /** Copies one window cell's block of the schematic (or the ring) to the texture. */
  private blit(p: Pulse, k: number, ring: boolean): void {
    const lx = k % p.w;
    const ly = (k - lx) / p.w;
    const tw = p.w * S;
    for (let ty = 0; ty < S; ty++) {
      const row = (ly * S + ty) * tw + lx * S;
      for (let tx = 0; tx < S; tx++) p.px[row + tx] = ring ? RING_PX : p.img[row + tx];
    }
  }

  private drop(i: number): void {
    const p = this.pulses[i];
    p.mesh.removeFromParent();
    p.mesh.geometry.dispose();
    (p.mesh.material as THREE.Material).dispose();
    p.tex.dispose();
    this.pulses.splice(i, 1);
  }

  dispose(): void {
    while (this.pulses.length) this.drop(0);
  }
}
