// Wall turret: a housing of TURRET cells painted into the terrain at a wall point, with a
// barrel that tracks the ship within an arc around the wall normal. Dormant until an alarm,
// then fires led shots when it has line of sight. Cut the housing away and it dies.

import { CELL } from '../../config';
import { M } from '../../pixel/materials';
import { ORDER } from '../../render/order';
import { Ribbon } from '../../render/Ribbon';
import type { Security } from './Security';

const HOUSING_R = 1.0; // m
const ARC = 1.35; // rad either side of the wall normal
const RANGE = 34;
const BULLET_SPEED = 34;

export class Turret {
  alive = true;
  private aim: number;
  private cooldown = Math.random() * 0.5;
  private readonly cells: number[] = [];
  private readonly barrel = new Ribbon(0x2a2f3a, ORDER.bodies + 2);

  constructor(
    private readonly sec: Security,
    readonly x: number,
    readonly y: number,
    readonly dir: number,
  ) {
    this.aim = dir;
    // housing disc centered on the wall point: half buried in the wall, so it's anchored
    const px = sec.ctx.pixels;
    const g = px.terrain.grid;
    const cx = x / CELL;
    const cy = y / CELL;
    const r = HOUSING_R / CELL;
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
      const half = Math.sqrt(Math.max(0, r * r - (yy + 0.5 - cy) ** 2));
      px.paintTerrain(cx - half, yy, cx + half, yy + 1, M.TURRET, false);
      for (let xx = Math.floor(cx - half); xx < Math.ceil(cx + half); xx++) if (g.inside(xx, yy)) this.cells.push(yy * g.w + xx);
    }
    sec.ctx.fx.add(this.barrel.mesh);
  }

  private intact(): number {
    const g = this.sec.ctx.pixels.terrain.grid;
    let n = 0;
    for (const i of this.cells) if (g.mat[i] === M.TURRET) n++;
    return n / this.cells.length;
  }

  update(dt: number): void {
    if (!this.alive) return;
    if (this.intact() < 0.35) {
      this.alive = false;
      for (let k = 0; k < 12; k++) this.sec.ctx.particles.spark(this.x, this.y, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.35, 0.08, 0.6);
      return;
    }
    const { sec } = this;
    const ship = sec.ctx.ship;
    let want = this.dir;
    if (sec.alert && ship.alive) {
      const dx = ship.x - this.x;
      const dy = ship.y - this.y;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const off = Math.atan2(Math.sin(a - this.dir), Math.cos(a - this.dir));
      const mx = this.x + Math.cos(this.aim) * (HOUSING_R + 0.6);
      const my = this.y + Math.sin(this.aim) * (HOUSING_R + 0.6);
      if (d < RANGE && Math.abs(off) < ARC && sec.canSee(mx, my, a, Math.PI, RANGE)) {
        sec.spotted({ x: ship.x, y: ship.y });
        const sv = ship.body.linvel();
        const t = d / BULLET_SPEED;
        want = Math.atan2(ship.y + sv.y * t - this.y, ship.x + sv.x * t - this.x);
        this.cooldown -= dt;
        const err = Math.atan2(Math.sin(want - this.aim), Math.cos(want - this.aim));
        if (this.cooldown <= 0 && Math.abs(err) < 0.12) {
          this.cooldown = 0.32;
          sec.projectiles.fire(mx, my, Math.cos(this.aim) * BULLET_SPEED, Math.sin(this.aim) * BULLET_SPEED);
        }
      }
    }
    // clamp to the arc and slew toward the wanted angle
    const off = Math.atan2(Math.sin(want - this.dir), Math.cos(want - this.dir));
    want = this.dir + Math.max(-ARC, Math.min(ARC, off));
    const err = Math.atan2(Math.sin(want - this.aim), Math.cos(want - this.aim));
    this.aim += Math.max(-2.2 * dt, Math.min(2.2 * dt, err));
  }

  frameUpdate(): void {
    if (!this.alive) {
      this.barrel.hide();
      return;
    }
    const active = this.sec.alert;
    const len = HOUSING_R + 0.7;
    this.barrel.set(this.x, this.y, this.x + Math.cos(this.aim) * len, this.y + Math.sin(this.aim) * len, 0.32, active ? 0x6a2a2a : 0x2a2f3a, 1);
  }

  dispose(): void {
    this.barrel.dispose();
  }
}
