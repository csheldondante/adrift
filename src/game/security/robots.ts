// Robots are pixel bodies with a controller: they fly with bounded thrust (so the ship can
// out-muscle them on a tether), see through glowing EYE cells, and die when their eyes are
// destroyed, the body is broken up, or it is mostly cut away. Dead robots stay as wreckage.
//
// SecurityBot: patrols its room with a vision cone; suspicion builds while it sees you and
//   raises the alarm at full. Then it hunts (nav field) and shocks you on contact.
// Drone: launched from bays during an alarm; keeps its distance, strafes, and shoots.
//
// Likely growth: more archetypes (shield bots, welders that repair bulkheads), stun from the
// cutter, hacking. Shared movement/sensing lives in Robot so archetypes stay small.

import { M } from '../../pixel/materials';
import type { PixelBody } from '../../pixel/PixelBody';
import { PixelGrid } from '../../pixel/PixelGrid';
import { VisionCone } from '../../render/VisionCone';
import type { P } from '../level/types';
import type { Light } from '../../render/Lighting';
import type { Security } from './Security';

const tmp = { x: 0, y: 0 };

export function securityBotGrid(): PixelGrid {
  const g = new PixelGrid(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d <= 8) g.set(x, y, d > 6 ? M.HULL : M.PLATE);
    }
  for (let y = 7; y < 9; y++) for (let x = 12; x < 16; x++) g.set(x, y, M.EYE); // eye faces +x
  return g;
}

export function droneGrid(): PixelGrid {
  const g = new PixelGrid(12, 8);
  for (let y = 1; y < 7; y++) for (let x = 1; x < 11; x++) g.set(x, y, M.SCRAP);
  for (let x = 0; x < 4; x++) {
    g.set(x, 0, M.HULL);
    g.set(x, 7, M.HULL); // fins
  }
  for (let y = 3; y < 5; y++) for (let x = 10; x < 12; x++) g.set(x, y, M.EYE);
  return g;
}

export abstract class Robot {
  alive = true;
  private readonly cellsTotal: number;
  /** Facing angle the controller turns toward (radians, world). */
  heading = 0;

  constructor(
    protected readonly sec: Security,
    readonly pb: PixelBody,
  ) {
    this.cellsTotal = pb.grid.countSolid();
    this.heading = pb.body.rotation();
  }

  get pos(): P {
    return this.pb.body.worldCom();
  }

  private eyes(): number {
    const g = this.pb.grid;
    let n = 0;
    for (let i = 0; i < g.mat.length; i++) if (g.mat[i] === M.EYE) n++;
    return n;
  }

  /** Flies toward a desired velocity with bounded acceleration (thrusters, not teleporting). */
  protected steer(vx: number, vy: number, accel: number, dt: number): void {
    const b = this.pb.body;
    const v = b.linvel();
    let ax = (vx - v.x) / dt;
    let ay = (vy - v.y) / dt;
    const a = Math.hypot(ax, ay);
    if (a > accel) {
      ax = (ax / a) * accel;
      ay = (ay / a) * accel;
    }
    const m = b.mass();
    b.applyImpulse({ x: ax * m * dt, y: ay * m * dt }, true);
  }

  /** Turns the body (eye side, local +x) toward `heading` with a rate controller. */
  protected face(dt: number, rate = 4, accel = 25): void {
    const b = this.pb.body;
    let err = this.heading - b.rotation();
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const target = Math.max(-rate, Math.min(rate, err * 6));
    const dw = Math.max(-accel * dt, Math.min(accel * dt, target - b.angvel()));
    b.applyTorqueImpulse(dw * b.principalInertia(), true);
  }

  /** The eye's world position and the direction it looks (body local +x). */
  protected eye(out: P): P {
    const g = this.pb.grid;
    return this.pb.localToWorld(g.w, g.h / 2, out);
  }

  protected lookAngle(): number {
    return this.pb.body.rotation();
  }

  /** Checks for death; returns false when the robot has just died or is dead. */
  checkAlive(): boolean {
    if (!this.alive) return false;
    const broken = !this.pb.alive || this.eyes() === 0 || this.pb.grid.countSolid() < this.cellsTotal * 0.4;
    if (broken) this.die();
    return this.alive;
  }

  protected die(): void {
    this.alive = false;
    if (!this.pb.alive) return;
    const c = this.pos;
    for (let k = 0; k < 14; k++) this.sec.ctx.particles.spark(c.x, c.y, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, 0.4, 0.09, 0.6);
    this.pb.tags.label = 'wreck';
  }

  abstract update(dt: number): void;
  frameUpdate(): void {}
  /** Lights this robot emits (sensor beams, running lights). */
  addLights(_out: Light[]): void {}
  dispose(): void {}
}

const RAYS = 14;

export class SecurityBot extends Robot {
  state: 'patrol' | 'hunt' | 'return' = 'patrol';
  suspicion = 0;
  private idx = 1;
  private t = Math.random() * 10;
  private readonly cone = new VisionCone(RAYS);
  private readonly lengths = new Float32Array(RAYS + 1);
  static readonly RANGE = 18;
  static readonly HALF = 0.6;

  constructor(
    sec: Security,
    pb: PixelBody,
    private readonly patrol: P[],
  ) {
    super(sec, pb);
    sec.ctx.fx.add(this.cone.mesh);
  }

  update(dt: number): void {
    if (!this.checkAlive()) {
      this.cone.hide();
      return;
    }
    this.t += dt;
    const { sec } = this;
    const ship = sec.ctx.ship;
    const me = this.pos;
    const eye = this.eye({ x: 0, y: 0 });
    const look = this.lookAngle();
    const seeing = ship.alive && sec.canSee(eye.x, eye.y, look, SecurityBot.HALF, SecurityBot.RANGE, this.pb);
    // the headlamp shining on the bot gives you away even from outside its cone
    const lit = !seeing && this.state !== 'hunt' && sec.litByLamp(eye.x, eye.y, this.pb);
    const toShip = Math.atan2(ship.y - me.y, ship.x - me.x);
    const dShip = Math.hypot(ship.x - me.x, ship.y - me.y);

    if (this.state !== 'hunt') {
      if (seeing || lit) {
        // ~0.6 s to alarm point-blank, ~2 s at the edge of the cone: time to break line of sight.
        // Being lit is slower (~2.2 s): it turns to look, which usually turns into seeing.
        this.suspicion = Math.min(1, this.suspicion + dt * (seeing ? 0.5 + 1.2 * Math.max(0, 1 - dShip / SecurityBot.RANGE) : 0.45));
        this.heading = toShip;
        if (this.suspicion >= 1) {
          sec.raiseAlarm({ x: ship.x, y: ship.y });
          this.state = 'hunt';
        }
      } else this.suspicion = Math.max(0, this.suspicion - dt * 0.35);
      if (sec.alert && Math.hypot(sec.lastKnown.x - me.x, sec.lastKnown.y - me.y) < 70) this.state = 'hunt';
    }

    if (this.state === 'hunt') {
      if (seeing) sec.spotted({ x: ship.x, y: ship.y });
      if (!sec.alert) this.state = 'return';
      const dir = seeing ? { x: Math.cos(toShip), y: Math.sin(toShip) } : sec.nav.direction(me.x, me.y, tmp);
      if (dir) this.steer(dir.x * 7, dir.y * 7, 7, dt);
      else this.steer(0, 0, 4, dt);
      this.heading = seeing ? toShip : dir ? Math.atan2(dir.y, dir.x) : this.heading;
      // shock on contact
      if (ship.alive && dShip < 2.3) {
        ship.damage(18 * dt, 'shocked');
        if (Math.random() < 0.5) {
          const k = Math.random();
          sec.ctx.particles.glint(me.x + (ship.x - me.x) * k, me.y + (ship.y - me.y) * k, 0, 0, 0.6, 0.8, 1, 0.08, 0.14);
        }
      }
    } else {
      // patrol (or return to it)
      const p = this.patrol[this.idx % this.patrol.length];
      const dx = p.x - me.x;
      const dy = p.y - me.y;
      const d = Math.hypot(dx, dy);
      if (d < 1.5) {
        this.idx++;
        if (this.state === 'return') this.state = 'patrol';
      }
      const sp = this.state === 'return' ? 4 : 2.6;
      const dir = this.state === 'return' && d > 12 ? sec.nav.direction(me.x, me.y, tmp) : null;
      if (dir) this.steer(dir.x * sp, dir.y * sp, 4, dt);
      else this.steer((dx / (d || 1)) * sp, (dy / (d || 1)) * sp, 4, dt);
      if (!seeing && !lit) this.heading = Math.atan2(dy, dx) + Math.sin(this.t * 1.3) * 0.55; // sweep while walking
    }
    this.face(dt);
  }

  frameUpdate(): void {
    if (!this.alive) {
      this.cone.hide();
      return;
    }
    const eye = this.eye({ x: 0, y: 0 });
    const look = this.lookAngle();
    for (let i = 0; i <= RAYS; i++) {
      const a = look - SecurityBot.HALF + (2 * SecurityBot.HALF * i) / RAYS;
      this.lengths[i] = this.sec.rayLength(eye.x, eye.y, a, SecurityBot.RANGE, this.pb);
    }
    const hunting = this.state === 'hunt';
    const color = hunting ? 0xff3b30 : this.suspicion > 0.05 ? 0xff9a3a : 0xffd27a;
    const opacity = hunting ? 0.12 : 0.1 + this.suspicion * 0.1;
    this.cone.set(eye.x, eye.y, look, SecurityBot.HALF, this.lengths, color, opacity);
  }

  addLights(out: Light[]): void {
    if (!this.alive) return;
    const eye = this.eye({ x: 0, y: 0 });
    const look = this.lookAngle();
    const hunting = this.state === 'hunt';
    const warm = this.suspicion > 0.05;
    out.push({ x: eye.x, y: eye.y, dirX: Math.cos(look), dirY: Math.sin(look), cosHalf: Math.cos(SecurityBot.HALF), range: SecurityBot.RANGE, intensity: 0.55, r: 1, g: hunting ? 0.25 : warm ? 0.55 : 0.8, b: hunting ? 0.2 : warm ? 0.25 : 0.45, skin: 0.3 });
  }

  dispose(): void {
    this.cone.dispose();
  }
}

export class Drone extends Robot {
  private cooldown = 1 + Math.random();
  private orbit = Math.random() < 0.5 ? 1 : -1;
  private t = Math.random() * 10;

  update(dt: number): void {
    if (!this.checkAlive()) return;
    this.t += dt;
    const { sec } = this;
    const ship = sec.ctx.ship;
    const me = this.pos;
    const dx = ship.x - me.x;
    const dy = ship.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    const los = ship.alive && d < 30 && sec.canSee(me.x, me.y, Math.atan2(dy, dx), Math.PI, 30, this.pb);
    if (los) sec.spotted({ x: ship.x, y: ship.y });
    if (!sec.alert) {
      this.steer(0, 0, 4, dt); // idle hover
      this.face(dt);
      return;
    }
    if (los) {
      // hold ~10 m, strafe around the ship
      const radial = (d - 10) * 1.2;
      const tx = (dx / d) * radial + (-dy / d) * this.orbit * 5;
      const ty = (dy / d) * radial + (dx / d) * this.orbit * 5;
      this.steer(tx, ty, 9, dt);
      this.heading = Math.atan2(dy, dx);
      this.cooldown -= dt;
      if (this.cooldown <= 0 && Math.abs(Math.atan2(Math.sin(this.heading - this.lookAngle()), Math.cos(this.heading - this.lookAngle()))) < 0.25) {
        this.cooldown = 0.9 + Math.random() * 0.4;
        const eye = this.eye({ x: 0, y: 0 });
        // lead the target a little
        const sv = ship.body.linvel();
        const bs = 30;
        const tLead = d / bs;
        const ax = ship.x + sv.x * tLead - eye.x;
        const ay = ship.y + sv.y * tLead - eye.y;
        const al = Math.hypot(ax, ay) || 1;
        sec.projectiles.fire(eye.x, eye.y, (ax / al) * bs, (ay / al) * bs, { ignore: this.pb, color: [1, 0.3, 0.6], damage: 6 });
      }
      if (Math.random() < 0.02) this.orbit = -this.orbit;
    } else {
      const dir = sec.nav.direction(me.x, me.y, tmp);
      if (dir) {
        this.steer(dir.x * 9, dir.y * 9, 9, dt);
        this.heading = Math.atan2(dir.y, dir.x);
      } else this.steer(0, 0, 5, dt);
    }
    this.face(dt, 6, 40);
  }

  addLights(out: Light[]): void {
    if (!this.alive) return;
    const c = this.pos;
    out.push({ x: c.x, y: c.y, dirX: 1, dirY: 0, cosHalf: -2, range: 6, intensity: 0.7, r: 1, g: 0.2, b: 0.35, skin: 0.8 });
  }
}
