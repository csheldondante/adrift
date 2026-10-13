// Cutting beam: a hitscan ray to the first solid pixel. Each physics step it pours heat into
// the matter there; cells hotter than their material's burn point give way (soft metal almost
// at once, armor and girders only at white heat). It also heats the gas/heat field, pushes
// loose bodies (radiation pressure, tuned for fun) and throws sparks by material. A heat meter
// limits use: firing heats it (faster on tough material), idling cools it, and filling it
// overheats the laser until it has cooled all the way down. Nothing is uncuttable; tough
// things just cost more laser.
//
// The emitter is on its own articulated arm under the nose (the probe's fifth arm): it swings
// out toward the aim while firing, clipped short of walls, and folds away when idle. The
// beam leaves from its tip along the mount -> aim line.
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
const mount = { x: 0, y: 0 };
const MOUNT = { x: 0.35, y: -0.7 }; // ship-local
const REST = { x: 0.95, y: -0.95 }; // tip, folded under the nose
const UPPER = 0.75;
const FORE = 0.75;
const REACH = 1.35; // m the tip reaches out toward the aim

export class Cutter implements Tool {
  readonly name = 'Cutter';
  private readonly core = new Ribbon(0xfff1d0, ORDER.fx + 1, true);
  private readonly glow = new Ribbon(0xff5a1e, ORDER.fx, true);
  private readonly upper = new Ribbon(0xd9d2c0, ORDER.ship - 1);
  private readonly fore = new Ribbon(0xe0a32a, ORDER.ship - 1);
  private readonly head = new Ribbon(0x2a2d33, ORDER.ship - 1);
  /** Arm tip, ship-local (eases toward its target). */
  private tipLX = REST.x;
  private tipLY = REST.y;
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
    ctx.fx.add(this.glow.mesh, this.core.mesh, this.upper.mesh, this.fore.mesh, this.head.mesh);
  }

  press(): void {}
  release(): void {}

  fixedUpdate(dt: number, held: boolean): void {
    const { ctx } = this;
    const c = tune.cutter;
    this.active = held && ctx.ship.alive && !this.overheated;
    this.moveArm(dt);
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
    // the beam leaves the arm's tip along the mount -> aim line
    this.toWorld(MOUNT.x, MOUNT.y, mount);
    let dx = ctx.controls.aimX - mount.x;
    let dy = ctx.controls.aimY - mount.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    dx /= len;
    dy /= len;
    this.toWorld(this.tipLX, this.tipLY, nose);
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

  private toWorld(lx: number, ly: number, out: { x: number; y: number }): { x: number; y: number } {
    const sh = this.ctx.ship;
    const a = sh.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.x = sh.x + c * lx - s * ly;
    out.y = sh.y + s * lx + c * ly;
    return out;
  }

  /** Swings the arm out toward the aim while firing (short of any wall), folds it when idle. */
  private moveArm(dt: number): void {
    const { ctx } = this;
    let tx = REST.x;
    let ty = REST.y;
    if (this.active) {
      this.toWorld(MOUNT.x, MOUNT.y, mount);
      const dx = ctx.controls.aimX - mount.x;
      const dy = ctx.controls.aimY - mount.y;
      const d = Math.hypot(dx, dy) || 1;
      let reach = Math.min(REACH, d * 0.8);
      const hit = ctx.pixels.raycast(mount.x, mount.y, dx / d, dy / d, reach + 0.2);
      if (hit) reach = Math.max(0.3, hit.dist - 0.2);
      // to ship-local
      const a = -ctx.ship.angle;
      const wx = (dx / d) * reach;
      const wy = (dy / d) * reach;
      tx = MOUNT.x + Math.cos(a) * wx - Math.sin(a) * wy;
      ty = MOUNT.y + Math.sin(a) * wx + Math.cos(a) * wy;
    }
    const k = Math.min(1, dt * 16);
    this.tipLX += (tx - this.tipLX) * k;
    this.tipLY += (ty - this.tipLY) * k;
  }

  /** Two-bone arm from the mount to the tip, elbow bent away from the hull (ship-local -y). */
  private drawArm(): void {
    const sh = this.ctx.ship;
    if (!sh.alive) {
      this.upper.hide();
      this.fore.hide();
      this.head.hide();
      return;
    }
    const mx = MOUNT.x;
    const my = MOUNT.y;
    let dx = this.tipLX - mx;
    let dy = this.tipLY - my;
    const d = Math.max(Math.abs(UPPER - FORE) + 1e-3, Math.min(UPPER + FORE - 1e-3, Math.hypot(dx, dy)));
    const base = Math.atan2(dy, dx);
    const cosA = (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d);
    const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
    // pick the elbow on the side away from the hull
    const e1 = { x: mx + Math.cos(base - alpha) * UPPER, y: my + Math.sin(base - alpha) * UPPER };
    const e2 = { x: mx + Math.cos(base + alpha) * UPPER, y: my + Math.sin(base + alpha) * UPPER };
    const el = e1.y < e2.y ? e1 : e2;
    const tipL = { x: mx + Math.cos(base) * d, y: my + Math.sin(base) * d };
    const m = this.toWorld(mx, my, { x: 0, y: 0 });
    const e = this.toWorld(el.x, el.y, { x: 0, y: 0 });
    const t = this.toWorld(tipL.x, tipL.y, { x: 0, y: 0 });
    this.upper.set(m.x, m.y, e.x, e.y, 0.17);
    this.fore.set(e.x, e.y, t.x, t.y, 0.13);
    dx = t.x - e.x;
    dy = t.y - e.y;
    const l = Math.hypot(dx, dy) || 1;
    this.head.set(t.x - (dx / l) * 0.06, t.y - (dy / l) * 0.06, t.x + (dx / l) * 0.2, t.y + (dy / l) * 0.2, 0.15);
  }

  frameUpdate(dt: number): void {
    this.t += dt;
    this.drawArm();
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
    this.upper.dispose();
    this.fore.dispose();
    this.head.dispose();
  }
}
