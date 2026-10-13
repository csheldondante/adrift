// Welding: hot metal pressed together fuses. Every few physics steps, glowing cells on the
// edge of any piece look one cell past their open side; where that lands in another piece's
// matter, the two touch there. Enough hot touching cells, with the pieces nearly at rest
// relative to each other, and they weld (PixelWorld.weldToTerrain / weldBodies).
//
// Either side being hot is enough (heat the rim of a breach, push a cold plate in). A piece
// that was just cut free can't weld for a moment, or it would re-fuse across its own kerf.
// Machines, the salvage and live robots never weld: they belong to other systems.

import { FIXED_DT, tune } from '../config';
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
const p = { x: 0, y: 0 };

export class Welder {
  /** Welds made this run (tests). */
  welds = 0;
  /** Called after each weld at the joint's mean position. */
  onWeld?: (x: number, y: number) => void;
  private tick = 0;

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
    for (const o of objs) {
      if (o.hotCount === 0) continue;
      const self = this.weldable(o);
      if (!self && o.kind !== 'terrain') continue; // hot terrain may still weld a loose body
      const g = o.grid;
      for (const i of o.hotCells) {
        if (g.heat[i] < H.weldHeat || !g.mat[i]) continue;
        const x = i % g.w;
        const y = (i - x) / g.w;
        for (let d = 0; d < 4; d++) {
          const dx = d === 0 ? -1 : d === 1 ? 1 : 0;
          const dy = d === 2 ? -1 : d === 3 ? 1 : 0;
          if (g.solid(x + dx, y + dy)) continue; // not an open edge
          o.localToWorld(x + 0.5 + dx, y + 0.5 + dy, p);
          const other = world.objectAt(p.x, p.y, o);
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
        if (j.n < H.weldMinCells || used.has(j.a) || used.has(j.b)) continue;
        const x = j.x / j.n;
        const y = j.y / j.n;
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
