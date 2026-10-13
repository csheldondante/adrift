// Scripted heavy machinery: crushers that slam on a cycle and movers that shuttle along a
// path. Both are kinematic pixel bodies (indestructible steel) driven by position each
// physics step, so they shove anything in the way and carry anything resting or clamped on
// them. Kinematic bodies report velocity from their motion, so friction and fixed joints
// (clamping) ride along naturally. Crushing (being pinned) is judged by Game from contact
// forces against a machine.
//
// Likely growth: rotating fans, conveyor belts, doors that open on triggers, machines that
// can be jammed (wedge a crate in a crusher) or powered down by cutting conduits.

import { CELL } from '../config';
import { M } from '../pixel/materials';
import type { PixelBody } from '../pixel/PixelBody';
import { PixelGrid } from '../pixel/PixelGrid';
import type { PixelWorld } from '../pixel/PixelWorld';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import type { EntitySpec, P } from './level/types';
import type * as THREE from 'three/webgpu';

type CrusherSpec = Extract<EntitySpec, { type: 'crusher' }>;
type MoverSpec = Extract<EntitySpec, { type: 'mover' }>;

interface Machine {
  body: PixelBody;
  /** World position of the body's center at time t. */
  center(t: number): P;
  shaft?: { ribbon: Ribbon; anchor: P; width: number };
  /** Speed last step (m/s), to detect hitting a stop. */
  speed: number;
}

/** Steel block with hazard stripes on the given faces. */
function machineGrid(wm: number, hm: number, stripe: 'top' | 'bottom' | 'ends'): PixelGrid {
  const w = Math.max(4, Math.round(wm / CELL));
  const h = Math.max(4, Math.round(hm / CELL));
  const g = new PixelGrid(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const band = stripe === 'top' ? y >= h - 4 : stripe === 'bottom' ? y < 4 : x < 5 || x >= w - 5;
      const s = band && Math.floor((x + y) / 3) % 2 === 0;
      g.set(x, y, s ? M.STRIPE : M.PISTON);
    }
  return g;
}

/** Slam profile: rest, fast slam (ease-in), hold, slow retract (ease-out). Returns 0..1. */
function slam(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < 0.45) return 0;
  if (p < 0.58) {
    const u = (p - 0.45) / 0.13;
    return u * u;
  }
  if (p < 0.68) return 1;
  const u = (p - 0.68) / 0.32;
  return 1 - u; // linear retract
}

export class Machinery {
  readonly machines: Machine[] = [];
  time = 0;
  /** A machine moving fast came to a dead stop (a crusher slamming home): sound, shake. */
  onStop?: (body: PixelBody, x: number, y: number, speed: number) => void;

  constructor(
    private readonly pixels: PixelWorld,
    fx: THREE.Group,
    entities: EntitySpec[],
  ) {
    for (const e of entities) {
      if (e.type === 'crusher') this.addCrusher(e, fx);
      else if (e.type === 'mover') this.addMover(e);
    }
    this.fixedUpdate(0);
  }

  private spawn(grid: PixelGrid, c: P): PixelBody {
    return this.pixels.addBody(grid, {
      x: c.x - (grid.w * CELL) / 2,
      y: c.y - (grid.h * CELL) / 2,
      kinematic: true,
      tags: { machine: true },
    });
  }

  private addCrusher(e: CrusherSpec, fx: THREE.Group): void {
    const down = e.dy < 0 || e.dx < 0;
    const grid = machineGrid(e.w, e.h, e.dy !== 0 ? (down ? 'bottom' : 'top') : 'ends');
    const phase0 = e.phase ?? Math.random();
    const center = (t: number): P => {
      const k = slam(t / e.period + phase0);
      return { x: e.x + e.dx * k, y: e.y + e.dy * k };
    };
    const body = this.spawn(grid, center(0));
    // the ram's shaft runs from the housing to the back of the piston (visual only)
    const len = Math.hypot(e.dx, e.dy) || 1;
    const back = { x: e.x - (e.dx / len) * (e.h / 2), y: e.y - (e.dy / len) * (e.h / 2) };
    const ribbon = new Ribbon(0x3c4250, ORDER.bodies - 1);
    fx.add(ribbon.mesh);
    this.machines.push({ body, center, shaft: { ribbon, anchor: back, width: e.w * 0.35 }, speed: 0 });
  }

  private addMover(e: MoverSpec): void {
    const grid = machineGrid(e.w, e.h, 'ends');
    const [a, b] = [e.path[0], e.path[e.path.length - 1]];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const travel = dist / e.speed;
    const pause = 1.5;
    const period = 2 * (travel + pause);
    const center = (t: number): P => {
      const p = (t % period) / period;
      // ping-pong with eased ends and a pause at each stop
      const half = (travel + pause) / period;
      let u = p < half ? p / half : (p - half) / half;
      u = Math.min(1, (u * (travel + pause)) / travel);
      const s = (1 - Math.cos(Math.PI * u)) / 2;
      const k = p < half ? s : 1 - s;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    };
    this.machines.push({ body: this.spawn(grid, center(0)), center, speed: 0 });
  }

  /** Drives machines to their next positions; call before the physics step. */
  fixedUpdate(dt: number): void {
    this.time += dt;
    for (const mc of this.machines) {
      if (!mc.body.alive) continue;
      const c = mc.center(this.time + dt);
      if (dt > 0) {
        const c0 = mc.center(this.time);
        const v = Math.hypot(c.x - c0.x, c.y - c0.y) / dt;
        if (mc.speed > 1.5 && v < 0.2) this.onStop?.(mc.body, c.x, c.y, mc.speed);
        mc.speed = v;
      }
      const g = mc.body.grid;
      mc.body.body.setNextKinematicTranslation({ x: c.x - (g.w * CELL) / 2, y: c.y - (g.h * CELL) / 2 });
    }
  }

  frameUpdate(): void {
    for (const mc of this.machines) {
      if (!mc.shaft || !mc.body.alive) continue;
      const t = mc.body.body.translation();
      const g = mc.body.grid;
      const c = { x: t.x + (g.w * CELL) / 2, y: t.y + (g.h * CELL) / 2 };
      mc.shaft.ribbon.set(mc.shaft.anchor.x, mc.shaft.anchor.y, c.x, c.y, mc.shaft.width, 0x3c4250, 1);
    }
  }

  isMachine(b: unknown): boolean {
    return this.machines.some((m) => m.body === b);
  }

  dispose(): void {
    for (const m of this.machines) m.shaft?.ribbon.dispose();
  }
}
