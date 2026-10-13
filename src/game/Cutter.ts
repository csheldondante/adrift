// Cutting beam: a hitscan ray to the first solid pixel. Each physics step it pours heat into
// the matter there; cells hotter than their material's burn point give way (soft metal almost
// at once, armor and girders only at white heat). It also heats the gas/heat field, pushes
// loose bodies (radiation pressure, tuned for fun) and throws sparks by material. A heat meter
// limits use: firing heats it (faster on tough material), idling cools it, and filling it
// overheats the laser until it has cooled all the way down. Nothing is uncuttable; tough
// things just cost more laser.
//
// Likely growth: weapons share this shape (ray -> impact -> effects). If several appear,
// extract the "ray + impact effect" into a reusable beam component.

import { tune } from '../config';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import { MAT_LOAD, MAT_NAME, MAT_SPARK } from '../pixel/materials';
import type { PixelBody } from '../pixel/PixelBody';
import type { GameContext, Tool } from './types';

const nose = { x: 0, y: 0 };

export class Cutter implements Tool {
  readonly name = 'Cutter';
  private readonly core = new Ribbon(0xfff1d0, ORDER.fx + 1, true);
  private readonly glow = new Ribbon(0xff5a1e, ORDER.fx, true);
  private active = false;
  /** Firing this step (beam on). */
  get firing(): boolean {
    return this.active;
  }
  /** Firing and the beam is on matter. */
  get cutting(): boolean {
    return this.active && this.hitting;
  }
  /** Beam end point (world meters), valid while firing. */
  get beamEnd(): { x: number; y: number } {
    return { x: this.ex, y: this.ey };
  }
  private sx = 0;
  private sy = 0;
  private ex = 0;
  private ey = 0;
  private hitting = false;
  private t = 0;
  /** Material under the beam (0 when not on matter). */
  material = 0;
  /** Laser heat 0..1 (HUD meter). */
  heat = 0;
  /** Locked out after overheating, until heat returns to 0. */
  overheated = false;

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.glow.mesh, this.core.mesh);
  }

  press(): void {}
  release(): void {}

  fixedUpdate(dt: number, held: boolean): void {
    const { ctx } = this;
    const c = tune.cutter;
    this.active = held && ctx.ship.alive && !this.overheated;
    if (!this.active) {
      this.material = 0;
      this.heat = Math.max(0, this.heat - (this.overheated ? c.overheatCoolPerSecond : c.coolPerSecond) * dt);
      if (this.overheated && this.heat <= 0) this.overheated = false;
      return;
    }
    this.heat = Math.min(1, this.heat + c.heatPerSecond * (this.material ? MAT_LOAD[this.material] : 1) * dt);
    if (this.heat >= 1) {
      this.overheated = true;
      ctx.ship.nose(nose);
      for (let k = 0; k < 12; k++) ctx.particles.smoke(nose.x, nose.y, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.8, 0.35);
    }
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
    this.material = hit ? ctx.pixels.matAt(hit.target, hit.x + dx * 0.06, hit.y + dy * 0.06) : 0;
    if (!hit) {
      this.ex = nose.x + dx * c.range;
      this.ey = nose.y + dy * c.range;
      return;
    }
    this.ex = hit.x;
    this.ey = hit.y;
    const cx = hit.x + dx * c.radius * 0.5;
    const cy = hit.y + dy * c.radius * 0.5;
    // heat first: the struck surface glows, and whatever is past its burn point gives
    ctx.pixels.heatCircle(cx, cy, c.radius * 1.5, c.glowRate * dt);
    ctx.pixels.damageCircle(cx, cy, c.radius, c.damagePerSecond * dt, true);
    // shove what we're hitting (machines are kinematic and ignore it)
    if (hit.target.kind === 'pixelBody') (hit.target as PixelBody).body.applyImpulseAtPoint({ x: dx * c.push * dt, y: dy * c.push * dt }, { x: hit.x, y: hit.y }, true);
    ctx.field.inject(cx, cy, c.radius, 0, c.heat * dt);
    // sparks by material: glass melts quietly, armor and girders shower
    const sparks = MAT_SPARK[this.material] * 1.6;
    for (let k = 0; k < Math.floor(sparks + Math.random()); k++) {
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
    if (this.overheated) return 'OVERHEATED';
    // the beam tells you what you're on: in the dark that's how you learn what's tough
    return this.active ? (this.hitting ? `on ${MAT_NAME[this.material] ?? 'matter'}` : 'firing') : 'ready';
  }

  dispose(): void {
    this.core.dispose();
    this.glow.dispose();
  }
}
