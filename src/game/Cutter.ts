// Cutting beam: a hitscan ray to the first solid pixel; damages a disc at the impact point
// each physics step, heats the gas/heat field there, and throws sparks.
//
// Likely growth: weapons share this shape (ray -> impact -> effects). If several appear,
// extract the "ray + impact effect" into a reusable beam component.

import { tune } from '../config';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import type { GameContext, Tool } from './types';

const nose = { x: 0, y: 0 };

export class Cutter implements Tool {
  readonly name = 'Cutter';
  private readonly core = new Ribbon(0xfff1d0, ORDER.fx + 1, true);
  private readonly glow = new Ribbon(0xff5a1e, ORDER.fx, true);
  private active = false;
  private sx = 0;
  private sy = 0;
  private ex = 0;
  private ey = 0;
  private hitting = false;
  private t = 0;

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.glow.mesh, this.core.mesh);
  }

  press(): void {}
  release(): void {}

  fixedUpdate(dt: number, held: boolean): void {
    const { ctx } = this;
    this.active = held && ctx.ship.alive;
    if (!this.active) return;
    const c = tune.cutter;
    ctx.ship.nose(nose);
    let dx = ctx.controls.aimX - nose.x;
    let dy = ctx.controls.aimY - nose.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    dx /= len;
    dy /= len;
    const hit = ctx.pixels.raycast(nose.x, nose.y, dx, dy, c.range);
    this.sx = nose.x;
    this.sy = nose.y;
    this.hitting = !!hit;
    if (!hit) {
      this.ex = nose.x + dx * c.range;
      this.ey = nose.y + dy * c.range;
      return;
    }
    this.ex = hit.x;
    this.ey = hit.y;
    const cx = hit.x + dx * c.radius * 0.5;
    const cy = hit.y + dy * c.radius * 0.5;
    ctx.pixels.damageCircle(cx, cy, c.radius, c.damagePerSecond * dt);
    ctx.field.inject(cx, cy, c.radius, 0, c.heat * dt);
    // the struck surface glows (uncuttable material too: it heats but never gives)
    ctx.pixels.heatCircle(cx, cy, c.radius * 1.5, c.glowRate * dt);
    for (let k = 0; k < 2; k++) {
      const sp = 3 + Math.random() * 7;
      const side = (Math.random() - 0.5) * 9;
      ctx.particles.spark(hit.x, hit.y, -dx * sp - dy * side, -dy * sp + dx * side, 0.25 + Math.random() * 0.3);
    }
  }

  frameUpdate(dt: number): void {
    this.t += dt;
    if (!this.active) {
      this.core.hide();
      this.glow.hide();
      return;
    }
    const flicker = 0.75 + Math.sin(this.t * 90) * 0.15 + Math.random() * 0.1;
    this.core.set(this.sx, this.sy, this.ex, this.ey, 0.07, undefined, flicker);
    this.glow.set(this.sx, this.sy, this.ex, this.ey, this.hitting ? 0.32 : 0.2, undefined, 0.35 * flicker);
  }

  status(): string {
    return this.active ? (this.hitting ? 'cutting' : 'firing') : 'ready';
  }

  dispose(): void {
    this.core.dispose();
    this.glow.dispose();
  }
}
