// Vibration scan: knock on the structure you're touching and listen to what comes back.
// A pulse spreads from the contact point through solid matter only (like conducted sound:
// it doesn't cross gaps), up to a radius, and briefly lights up what it passed through:
//   - power and systems in the walls: cores, conduits, sockets, pumps, fixtures, fuel
//   - tough material (burns only at white heat: frame, armor, pressure doors) as a dim fill,
//     so you can tell what's worth cutting before you commit the laser
//   - the outline of every surface it reached, which shows hidden cavities behind walls
// The ring expands at about 45 m/s, then the picture fades over a few seconds.
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
  x0: number; // window origin in obj cells
  y0: number;
  w: number;
  h: number;
  /** Path length through matter to each window cell (cells), -1 if not reached. */
  dist: Float32Array;
  /** Feature color per window cell (ABGR), 0 = nothing to show. */
  color: Uint32Array;
  data: Uint8Array;
  tex: THREE.DataTexture;
  mesh: THREE.Mesh;
  age: number;
  reach: number; // cells
  strength: number;
}

const SPEED = 45 / CELL; // cells per second
const FADE = 4.5; // s after the ring has finished
const MAX_PULSES = 6;

const rgba = (r: number, g: number, b: number, a: number) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
// what a pulse shows per material (0 = only its surface outline, if any)
const FEATURE = new Uint32Array(256);
FEATURE[M.POWER] = rgba(255, 50, 60, 255);
FEATURE[M.CONDUIT] = rgba(255, 150, 60, 235);
FEATURE[M.SOCKET] = rgba(90, 170, 255, 255);
FEATURE[M.PUMP] = rgba(90, 255, 140, 255);
FEATURE[M.LIGHT] = rgba(255, 230, 140, 220);
FEATURE[M.FUEL] = rgba(255, 110, 40, 220);
FEATURE[M.EYE] = rgba(255, 210, 110, 220);
const EDGE = rgba(80, 220, 255, 150);
const TOUGH = rgba(150, 120, 255, 55);

export class Scanner {
  private readonly pulses: Pulse[] = [];
  /** Pulses sent so far, and the last few: cells reached and features revealed (tests). */
  sent = 0;
  readonly history: { reached: number; features: number; strength: number }[] = [];

  /**
   * Sends a pulse into `obj` from world point (wx, wy), reaching `radius` meters through its
   * matter. Strength 0..1 scales brightness.
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
    const dist = new Float32Array(w * h).fill(-1);
    const color = new Uint32Array(w * h);
    // breadth-first through solid cells: distance = path length through the matter
    let frontier = [(sy - y0) * w + (sx - x0)];
    dist[frontier[0]] = 0;
    let features = 0;
    let reached = 0;
    for (let step = 0; frontier.length && step <= reach; step++) {
      const next: number[] = [];
      for (const k of frontier) {
        const lx = k % w;
        const ly = (k - lx) / w;
        const gi = (ly + y0) * g.w + lx + x0;
        const m = g.mat[gi];
        reached++;
        let c = FEATURE[m];
        if (c) features++;
        else if (MAT_BURN[m] >= 0.85) c = TOUGH;
        // an open side: a surface (a wall face, or the inside of a hidden cavity)
        if (!FEATURE[m] && (!g.solid(lx + x0 - 1, ly + y0) || !g.solid(lx + x0 + 1, ly + y0) || !g.solid(lx + x0, ly + y0 - 1) || !g.solid(lx + x0, ly + y0 + 1))) c = EDGE;
        color[k] = c;
        for (let d = 0; d < 4; d++) {
          const nx = lx + (d === 0 ? -1 : d === 1 ? 1 : 0);
          const ny = ly + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (dist[j] >= 0 || !(MAT_FLAGS[g.mat[(ny + y0) * g.w + nx + x0]] & F.SOLID)) continue;
          dist[j] = step + 1;
          next.push(j);
        }
      }
      frontier = next;
    }
    this.sent++;
    this.history.push({ reached, features, strength });
    if (this.history.length > 8) this.history.shift();
    const data = new Uint8Array(w * h * 4);
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(w * CELL, h * CELL);
    geo.translate((x0 + w / 2) * CELL, (y0 + h / 2) * CELL, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = ORDER.glow;
    mesh.frustumCulled = false;
    obj.view.object.add(mesh); // rides along with a moving body
    this.pulses.push({ obj, x0, y0, w, h, dist, color, data, tex, mesh, age: 0, reach, strength });
    while (this.pulses.length > MAX_PULSES) this.drop(0);
  }

  frameUpdate(dt: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.age += dt;
      const front = p.age * SPEED;
      const ringDone = front > p.reach + 8;
      const fade = ringDone ? 1 - (p.age - (p.reach + 8) / SPEED) / FADE : 1;
      if (fade <= 0 || (p.obj as { alive?: boolean }).alive === false) {
        this.drop(i);
        continue;
      }
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, fade) * p.strength;
      if (ringDone && p.age - dt > (p.reach + 8) / SPEED) continue; // static now, only fading
      // reveal up to the ring front, brightest right behind it
      const px = new Uint32Array(p.data.buffer);
      for (let k = 0; k < p.color.length; k++) {
        const d = p.dist[k];
        const c = p.color[k];
        if (d < 0 || !c || d > front) {
          px[k] = 0;
          continue;
        }
        const behind = front - d;
        const boost = behind < 6 ? 1 + (6 - behind) / 6 : 1;
        const a = Math.min(255, ((c >>> 24) & 255) * boost);
        px[k] = ((a << 24) | (c & 0xffffff)) >>> 0;
      }
      p.tex.needsUpdate = true;
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
