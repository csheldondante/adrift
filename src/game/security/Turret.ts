// Wall turret / sentry: a housing of TURRET cells painted into the terrain at a wall point,
// with a barrel that moves within an arc around the wall normal.
//   - Idle: sweeps a narrow scanning cone back and forth across its arc. If it holds you in
//     the cone, suspicion builds (faster than a bot: it's a dedicated sensor) and it raises
//     the alarm itself.
//   - Alarm: tracks the ship with lead and fires while it has line of sight.
// It runs on power: the housing conducts, and it's dead (no sweep, no light, no gun) while
// nothing live reaches it. Wired ones hang off a line in the walls; the rest carry a power
// pack on the wall beside them, joined by a short exposed cable: cut the cable and it goes
// dark, cut the pack and it goes off like any power core. Cut the housing away and it dies.

import { CELL } from '../../config';
import { M } from '../../pixel/materials';
import type { Light } from '../../render/Lighting';
import { ORDER } from '../../render/order';
import { Ribbon } from '../../render/Ribbon';
import { VisionCone } from '../../render/VisionCone';
import type { Security } from './Security';

const HOUSING_R = 1.0; // m
const ARC = 1.35; // rad either side of the wall normal
const RANGE = 30;
const SCAN_HALF = 0.22; // rad half-width of the scanning cone
const BULLET_SPEED = 34;
const RAYS = 8;

export class Turret {
  alive = true;
  /** Power reaches the housing (updated each step). */
  live = true;
  suspicion = 0;
  private aim: number;
  private cooldown = Math.random() * 0.5;
  private sweepT = Math.random() * 10;
  private readonly cells: number[] = [];
  private readonly barrel = new Ribbon(0x2a2f3a, ORDER.bodies + 2);
  private readonly cone = new VisionCone(RAYS);
  private readonly lengths = new Float32Array(RAYS + 1);

  constructor(
    private readonly sec: Security,
    readonly x: number,
    readonly y: number,
    readonly dir: number,
    wired = false,
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
    if (!wired) {
      // power pack on the wall to one side, a cable along the wall face to the housing
      const nx = Math.cos(dir);
      const ny = Math.sin(dir);
      const tx = -ny;
      const ty = nx;
      const side = (Math.floor(x * 7 + y * 3) & 1) * 2 - 1;
      const pk = { x: cx + (tx * side * (r + 14)) - nx * 1, y: cy + (ty * side * (r + 14)) - ny * 1 };
      for (let k = 0; k <= r + 12; k++) {
        const qx = Math.floor(cx + tx * side * k - nx * 1.5);
        const qy = Math.floor(cy + ty * side * k - ny * 1.5);
        px.paintTerrain(qx, qy, qx + 2, qy + 2, M.CONDUIT, false);
      }
      px.paintTerrain(Math.floor(pk.x - 3), Math.floor(pk.y - 3), Math.floor(pk.x + 3), Math.floor(pk.y + 3), M.HULL, false);
      px.paintTerrain(Math.floor(pk.x - 2), Math.floor(pk.y - 2), Math.floor(pk.x + 2), Math.floor(pk.y + 2), M.POWER, false);
    }
    sec.ctx.fx.add(this.barrel.mesh, this.cone.mesh);
  }

  /** Any of the housing live (power reaches it)? */
  get powered(): boolean {
    const g = this.sec.ctx.pixels.terrain.grid;
    for (const i of this.cells) if (g.mat[i] === M.TURRET && g.powered[i]) return true;
    return false;
  }

  private intact(): number {
    const g = this.sec.ctx.pixels.terrain.grid;
    let n = 0;
    for (const i of this.cells) if (g.mat[i] === M.TURRET) n++;
    return n / this.cells.length;
  }

  private muzzle(): { x: number; y: number } {
    return { x: this.x + Math.cos(this.aim) * (HOUSING_R + 0.6), y: this.y + Math.sin(this.aim) * (HOUSING_R + 0.6) };
  }

  update(dt: number): void {
    if (!this.alive) return;
    if (this.intact() < 0.35) {
      this.alive = false;
      this.suspicion = 0;
      for (let k = 0; k < 12; k++) this.sec.ctx.particles.spark(this.x, this.y, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.35, 0.08, 0.6);
      return;
    }
    const { sec } = this;
    this.live = this.powered;
    if (!this.live) {
      // dead: the barrel sags toward the wall normal and it sees nothing
      this.suspicion = 0;
      const err = Math.atan2(Math.sin(this.dir - this.aim), Math.cos(this.dir - this.aim));
      this.aim += Math.max(-0.5 * dt, Math.min(0.5 * dt, err));
      return;
    }
    const ship = sec.ctx.ship;
    const m = this.muzzle();
    let want: number;
    if (!sec.alert) {
      // sentry sweep across the arc; holding the ship in the cone raises the alarm
      this.sweepT += dt;
      want = this.dir + Math.sin(this.sweepT * 0.7) * ARC * 0.9;
      const seen = ship.alive && sec.canSee(m.x, m.y, this.aim, SCAN_HALF, RANGE);
      const lit = !seen && sec.litByLamp(m.x, m.y);
      if (seen || lit) {
        this.suspicion = Math.min(1, this.suspicion + dt * (seen ? 1.6 : 0.8));
        want = Math.atan2(ship.y - this.y, ship.x - this.x); // lock on while it decides
        if (this.suspicion >= 1) sec.raiseAlarm({ x: ship.x, y: ship.y });
      } else this.suspicion = Math.max(0, this.suspicion - dt * 0.5);
    } else {
      this.suspicion = 0;
      want = this.aim;
      if (ship.alive) {
        const dx = ship.x - this.x;
        const dy = ship.y - this.y;
        const d = Math.hypot(dx, dy);
        const a = Math.atan2(dy, dx);
        const off = Math.atan2(Math.sin(a - this.dir), Math.cos(a - this.dir));
        if (d < RANGE && Math.abs(off) < ARC && sec.canSee(m.x, m.y, a, Math.PI, RANGE)) {
          sec.spotted({ x: ship.x, y: ship.y });
          const sv = ship.body.linvel();
          const t = d / BULLET_SPEED;
          want = Math.atan2(ship.y + sv.y * t - this.y, ship.x + sv.x * t - this.x);
          this.cooldown -= dt;
          const err = Math.atan2(Math.sin(want - this.aim), Math.cos(want - this.aim));
          if (this.cooldown <= 0 && Math.abs(err) < 0.12) {
            this.cooldown = 0.32;
            sec.projectiles.fire(m.x, m.y, Math.cos(this.aim) * BULLET_SPEED, Math.sin(this.aim) * BULLET_SPEED);
          }
        }
      }
    }
    // clamp to the arc and slew toward the wanted angle
    const off = Math.atan2(Math.sin(want - this.dir), Math.cos(want - this.dir));
    want = this.dir + Math.max(-ARC, Math.min(ARC, off));
    const err = Math.atan2(Math.sin(want - this.aim), Math.cos(want - this.aim));
    this.aim += Math.max(-2.2 * dt, Math.min(2.2 * dt, err));
  }

  addLights(out: Light[]): void {
    if (!this.alive || !this.live) return;
    const m = this.muzzle();
    const active = this.sec.alert;
    out.push({ x: m.x, y: m.y, dirX: Math.cos(this.aim), dirY: Math.sin(this.aim), cosHalf: Math.cos(SCAN_HALF), range: RANGE, intensity: 0.8, r: active ? 1 : 0.55, g: active ? 0.25 : 0.85, b: active ? 0.2 : 1 });
  }

  frameUpdate(): void {
    if (!this.alive) {
      this.barrel.hide();
      this.cone.hide();
      return;
    }
    const active = this.sec.alert && this.live;
    const len = HOUSING_R + 0.7;
    this.barrel.set(this.x, this.y, this.x + Math.cos(this.aim) * len, this.y + Math.sin(this.aim) * len, 0.32, active ? 0x6a2a2a : 0x2a2f3a, 1);
    if (!this.live) {
      this.cone.hide();
      return;
    }
    const m = this.muzzle();
    for (let i = 0; i <= RAYS; i++) {
      const a = this.aim - SCAN_HALF + (2 * SCAN_HALF * i) / RAYS;
      this.lengths[i] = this.sec.rayLength(m.x, m.y, a, RANGE);
    }
    const color = active ? 0xff3b30 : this.suspicion > 0.05 ? 0xff9a3a : 0x9ad8ff;
    this.cone.set(m.x, m.y, this.aim, SCAN_HALF, this.lengths, color, active ? 0.1 : 0.1 + this.suspicion * 0.12);
  }

  dispose(): void {
    this.barrel.dispose();
    this.cone.dispose();
  }
}
