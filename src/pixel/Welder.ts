// Welding: hot metal pressed together fuses. Every few physics steps, glowing cells on the
// edge of any piece look one or two cells past their open side; where that lands in another piece's
// matter, the two touch there. Enough hot touching cells, with the pieces nearly at rest
// relative to each other, and they weld (PixelWorld.weldToTerrain / weldBodies).
//
// A cell is hot enough at a fixed fraction of its material's burn point: glowing but not yet
// giving way, so the cutter can bring a seam to welding heat without eating it, and tough
// material needs proportionally more. Either side being hot is enough (heat the rim of a
// breach, push a cold plate in). A piece
// that was just cut free can't weld for a moment, or it would re-fuse across its own kerf.
// Machines, the salvage and live robots never weld: they belong to other systems.

import { FIXED_DT, tune } from '../config';
import { MAT_BURN } from './materials';
import type { PixelBody } from './PixelBody';
import type { PixelObject } from './PixelObject';
import type { PixelWorld } from './PixelWorld';

interface Joint {
  a: PixelObject;
  b: PixelObject;
  n: number;
  x: number;
  y: number;
}

const EVERY = 4; // physics steps between checks
const REACH = 2; // cells past a hot edge that count as touching (molten metal bridges a hairline gap)
const p = { x: 0, y: 0 };

export class Welder {
  /** Welds made this run (tests). */
  welds = 0;
  /** Called after each weld at the joint's mean position. */
  onWeld?: (x: number, y: number) => void;
  private tick = 0;
  /** Last check: hot open-edge cells, best joint's touching cells and speed (tests, tuning). */
  readonly diag = { hotEdge: 0, bestN: 0, bestRel: 0 };

  constructor(private readonly world: PixelWorld) {}

  private weldable(o: PixelObject): boolean {
    if (o.kind === 'terrain') return false;
    const b = o as PixelBody;
    const t = b.tags;
    if (!b.alive || t.machine || t.salvage || (t.label && t.label !== 'wreck')) return false;
    return (this.world.steps - b.bornStep) * FIXED_DT > tune.heat.weldGrace;
  }

  fixedUpdate(): void {
    if (++this.tick % EVERY) return;
    const world = this.world;
    const H = tune.heat;
    const joints = new Map<PixelObject, Map<PixelObject, Joint>>();
    const objs: PixelObject[] = [world.terrain, ...world.bodies];
    const diag = this.diag;
    diag.hotEdge = diag.bestN = diag.bestRel = 0;
    for (const o of objs) {
      if (o.hotCount === 0) continue;
      const self = this.weldable(o);
      if (!self && o.kind !== 'terrain') continue; // hot terrain may still weld a loose body
      const g = o.grid;
      for (const i of o.hotCells) {
        if (!g.mat[i] || g.heat[i] < H.weldHeat * MAT_BURN[g.mat[i]]) continue;
        const x = i % g.w;
        const y = (i - x) / g.w;
        for (let d = 0; d < 4; d++) {
          const dx = d === 0 ? -1 : d === 1 ? 1 : 0;
          const dy = d === 2 ? -1 : d === 3 ? 1 : 0;
          if (g.solid(x + dx, y + dy)) continue; // not an open edge
          diag.hotEdge++;
          // the other piece one or two cells out: pressed on, or close enough to bridge
          let other: PixelObject | null = null;
          for (let k = 1; k <= REACH && !other; k++) {
            o.localToWorld(x + 0.5 + dx * k, y + 0.5 + dy * k, p);
            other = world.objectAt(p.x, p.y, o);
          }
          if (!other || (!self && !this.weldable(other))) continue;
          // one record per unordered pair
          const [a, b] = objs.indexOf(o) < objs.indexOf(other) ? [o, other] : [other, o];
          let m = joints.get(a);
          if (!m) joints.set(a, (m = new Map()));
          let j = m.get(b);
          if (!j) m.set(b, (j = { a, b, n: 0, x: 0, y: 0 }));
          j.n++;
          j.x += p.x;
          j.y += p.y;
        }
      }
    }
    const used = new Set<PixelObject>();
    for (const m of joints.values())
      for (const j of m.values()) {
        const x = j.x / j.n;
        const y = j.y / j.n;
        if (j.n > diag.bestN) [diag.bestN, diag.bestRel] = [j.n, relSpeed(j.a, j.b, x, y)];
        if (j.n < H.weldMinCells || used.has(j.a) || used.has(j.b)) continue;
        if (relSpeed(j.a, j.b, x, y) > H.weldSpeed) continue;
        used.add(j.a);
        used.add(j.b);
        if (j.a.kind === 'terrain') world.weldToTerrain(j.b as PixelBody);
        else if (j.b.kind === 'terrain') world.weldToTerrain(j.a as PixelBody);
        else world.weldBodies(j.a as PixelBody, j.b as PixelBody);
        this.welds++;
        this.onWeld?.(x, y);
      }
  }
}

function velAt(o: PixelObject, x: number, y: number): { x: number; y: number } {
  if (o.kind === 'terrain') return { x: 0, y: 0 };
  return (o as PixelBody).body.velocityAtPoint({ x, y });
}

function relSpeed(a: PixelObject, b: PixelObject, x: number, y: number): number {
  const va = velAt(a, x, y);
  const vb = velAt(b, x, y);
  return Math.hypot(va.x - vb.x, va.y - vb.y);
}
