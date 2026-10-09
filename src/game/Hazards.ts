// Explosive hazard: fuel cells detonate when destroyed (cut, blasted) or when the heat field
// at a fuel site crosses the ignition threshold. An explosion carves pixels, kicks bodies,
// and dumps gas + heat into the field, which in turn pushes debris and can cook off more
// fuel — so chains emerge from the systems rather than scripts.
//
// Likely growth: more hazard kinds (electrical arcs, coolant leaks, reactor meltdown) —
// each a small module subscribing to the same inputs (destroyed cells, field samples).
// If that happens, split this into a registry of Hazard implementations.

import { CELL, tune } from '../config';
import type { FieldSample } from '../fields/GasField';
import { F, M, MAT_FLAGS } from '../pixel/materials';
import type { GameContext } from './types';

interface Pending {
  x: number;
  y: number;
  t: number;
}

const s: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };

export class Hazards {
  private ctx!: GameContext;
  private queue: Pending[] = [];
  private recent: Pending[] = []; // recent/queued blasts used to merge nearby triggers
  private time = 0;
  private heatCheck = 0;
  private fuelSites: { x: number; y: number; cx: number; cy: number }[] = [];
  explosions = 0;
  /** Invoked for each explosion (camera shake, damage, sound later). */
  onExplode?: (x: number, y: number) => void;

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.indexFuelSites();
  }

  /** Samples terrain fuel cells on a coarse lattice so heat checks stay cheap. */
  private indexFuelSites(): void {
    const g = this.ctx.pixels.terrain.grid;
    this.fuelSites = [];
    for (let y = 0; y < g.h; y += 5)
      for (let x = 0; x < g.w; x += 5)
        if (MAT_FLAGS[g.mat[y * g.w + x]] & F.EXPLOSIVE) this.fuelSites.push({ x: (x + 0.5) * CELL, y: (y + 0.5) * CELL, cx: x, cy: y });
  }

  /** Requests an explosion; merges with any blast already pending/recent nearby. */
  trigger(x: number, y: number, delay = tune.hazard.chainDelay): void {
    if (!tune.hazard.enabled) return;
    const merge = tune.hazard.explosionRadius * 0.6;
    for (const p of this.recent) if ((p.x - x) ** 2 + (p.y - y) ** 2 < merge * merge) return;
    const p = { x, y, t: this.time + delay };
    this.queue.push(p);
    this.recent.push(p);
  }

  /** Detonates the closest fuel to a point (debug). */
  detonateNearest(x: number, y: number): void {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    const g = this.ctx.pixels.terrain.grid;
    for (const f of this.fuelSites) {
      if (g.mat[f.cy * g.w + f.cx] !== M.FUEL) continue;
      const d = (f.x - x) ** 2 + (f.y - y) ** 2;
      if (d < bd) [bd, best] = [d, f];
    }
    for (const b of this.ctx.pixels.bodies) {
      if (!b.explosiveCells) continue;
      const c = b.body.worldCom();
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bd) [bd, best] = [d, { x: c.x, y: c.y }];
    }
    if (best) this.trigger(best.x, best.y, 0);
  }

  update(dt: number): void {
    this.time += dt;
    this.recent = this.recent.filter((p) => this.time - p.t < 0.6);
    const due = this.queue.filter((p) => p.t <= this.time);
    if (due.length) {
      this.queue = this.queue.filter((p) => p.t > this.time);
      for (const p of due) this.explode(p.x, p.y);
    }
    this.heatCheck -= dt;
    if (this.heatCheck <= 0 && tune.hazard.enabled) {
      this.heatCheck = 0.1;
      this.checkHeat();
    }
  }

  private checkHeat(): void {
    const { field, pixels } = this.ctx;
    const ign = tune.hazard.ignitionHeat;
    const g = pixels.terrain.grid;
    this.fuelSites = this.fuelSites.filter((f) => g.mat[f.cy * g.w + f.cx] === M.FUEL);
    for (const f of this.fuelSites) {
      if (field.sample(f.x, f.y, s).heat > ign) this.trigger(f.x, f.y, 0);
    }
    for (const b of pixels.bodies) {
      if (!b.explosiveCells) continue;
      const c = b.body.worldCom();
      if (field.sample(c.x, c.y, s).heat > ign) this.trigger(c.x, c.y, 0);
    }
  }

  private explode(x: number, y: number): void {
    const { ctx } = this;
    const h = tune.hazard;
    const R = h.explosionRadius;
    this.explosions++;
    // fuel destroyed here re-enters trigger() and chains (merged if close)
    ctx.pixels.damageCircle(x, y, R, h.explosionDamage);
    ctx.field.inject(x, y, R * 1.2, h.explosionGas, h.explosionHeat);

    const reach = R * 2.2;
    const kick = (body: import('@dimforge/rapier2d-compat').RigidBody, area: number) => {
      const c = body.worldCom();
      const dx = c.x - x;
      const dy = c.y - y;
      const d = Math.hypot(dx, dy);
      if (d > reach) return 0;
      const k = 1 - d / reach;
      const j = h.explosionImpulse * k * Math.min(area, 6);
      const nx = d > 1e-3 ? dx / d : Math.random() - 0.5;
      const ny = d > 1e-3 ? dy / d : Math.random() - 0.5;
      // off-center application adds spin
      body.applyImpulseAtPoint({ x: nx * j, y: ny * j }, { x: c.x + (Math.random() - 0.5) * 0.6, y: c.y + (Math.random() - 0.5) * 0.6 }, true);
      return k;
    };
    for (const b of ctx.pixels.bodies) kick(b.body, b.body.mass() / 60);
    const k = kick(ctx.ship.body, 1.8);
    if (k > 0) ctx.ship.damage(55 * k, 'explosion');

    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 18;
      ctx.particles.fire(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.3 + Math.random() * 0.5, 0.3 + Math.random() * 0.5);
    }
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 8 + Math.random() * 20;
      ctx.particles.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.5 + Math.random() * 0.6, 0.1);
    }
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 5;
      ctx.particles.smoke(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1.5 + Math.random() * 1.5, 0.6 + Math.random() * 0.8);
    }
    this.onExplode?.(x, y);
  }
}
