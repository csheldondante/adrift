// Robots are pixel bodies with a controller: they fly with bounded thrust (so the ship can
// out-muscle them on a tether) and are built from organs wired to a red POWER core by
// CONDUIT (see pixel/power.ts). What still has power still works:
//   - EYE cells: sight (vision cone, noticing the lamp, aiming)
//   - THRUSTER cells: movement and turning, in proportion to how many are left
//   - WEAPON cells: the gun or shock prongs
// Armor covers the side that faces you; the back is soft. So: get behind it and drill the
// core, or make a precision cut: sever the eye's conduit to blind it, the engine bus to strand
// it, or the main bus to switch it off with its core intact (a battery worth stealing).
// A robot is disabled (wreck, drifts) when its core is mostly gone, nothing works any more,
// the body is broken up, or it's mostly cut away.
//
// SecurityBot: patrols its room with a vision cone; suspicion builds while it sees you and
//   raises the alarm at full. Then it hunts (nav field) and shocks you on contact.
// Drone: launched from bays during an alarm; keeps its distance, strafes, and shoots.
//
// Likely growth: more archetypes (shield bots, welders that repair bulkheads), stun from the
// cutter, hacking. Shared movement/sensing lives in Robot so archetypes stay small.

import type { FieldSample } from '../../fields/GasField';
import { M } from '../../pixel/materials';
import type { PixelBody } from '../../pixel/PixelBody';
import { PixelGrid } from '../../pixel/PixelGrid';
import { countPowered, energize } from '../../pixel/power';
import { VisionCone } from '../../render/VisionCone';
import type { P } from '../level/types';
import type { Light } from '../../render/Lighting';
import type { Security } from './Security';

const tmp = { x: 0, y: 0 };
const air: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };

/** Builds a grid from rows of art, top row first (grid y is up). Unknown chars are empty. */
export function gridFromArt(rows: string[], legend: Record<string, number>): PixelGrid {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const g = new PixelGrid(w, h);
  rows.forEach((row, r) => {
    for (let x = 0; x < row.length; x++) {
      const m = legend[row[x]];
      if (m) g.set(x, h - 1 - r, m);
    }
  });
  return g;
}

const LEGEND: Record<string, number> = { A: M.ARMOR, H: M.HULL, S: M.PLATE, P: M.POWER, C: M.CONDUIT, T: M.THRUSTER, W: M.WEAPON, E: M.EYE };

/**
 * Security bot, 2.5 m, facing +x. Armored face and flanks; the eye sits in an armor plug
 * with its bus routed around it; thrusters across the back; the core sits rear of center
 * behind soft plate. Conduits: core -> eye, core -> each shock prong, core -> thrusters.
 */
export function securityBotGrid(): PixelGrid {
  const top = [
    '.......AAAAAA.......',
    '.....AAAAAAAAAA.....',
    '...HHAAAAAAAAAAAA...',
    '..HHSSSSSSSSSSWWAA..',
    '.HHSSSSSSSSSCCWWWAA.',
    '.HSSSSSSSSSCCSSSSAA.',
    'TTSSSSSSSSCCSSSSSSAA',
    'TTSSSSSPPPCSSSSSSSAA',
    'TTCSSSPPPPPCCCCCCCAA',
    'TTCCCCPPPPPAAAAAACCE',
  ];
  return gridFromArt(
    [...top, ...top.slice().reverse()],
    LEGEND,
  );
}

/**
 * Attack drone, 2.5 × 1.5 m, facing +x. A solid armor nose with the eye set in its tip; the
 * eye and gun bus runs back under the top armor. Thrusters and the main power bus sit at the
 * open rear, so the engines (and then the core) are exposed from behind; cutting through the
 * top armor into the bus blinds and disarms it.
 */
export function droneGrid(): PixelGrid {
  return gridFromArt(
    [
      '....AAAAAAAAAAAA....',
      '..AAAAAAAAAAAAAAAA..',
      'TTCHHHHCCCCCCCCCCCCW',
      'TTCHHHHCHHHHAAAAAACW',
      '..CHHPPPPHHHAAAAAAC.',
      '..CCPPPPPPHHAAAAAAEE',
      '..CCPPPPPPHHAAAAAAEE',
      '..CHHPPPPHHHAAAAAAA.',
      'TTCHHHHHHHHHAAAAAA..',
      'TTHHHHHHHHHHHAAAA...',
      '..AAAAAAAAAAAAAAAA..',
      '....AAAAAAAAAAAA....',
    ],
    LEGEND,
  );
}

interface Organs {
  power: number;
  eye: number;
  thruster: number;
  weapon: number;
}

export abstract class Robot {
  alive = true;
  private readonly cellsTotal: number;
  /** Facing angle the controller turns toward (radians, world). */
  heading = 0;
  /** Working systems, from the power network. */
  sees = true;
  /** Fraction of thrusters still powered (scales acceleration and turning). */
  thrust = 1;
  armed = true;
  /** Why it was disabled (tests, HUD). */
  cause = '';
  /** Where it started (tests). */
  readonly spawn: P;
  private readonly organs0: Organs;
  private sysTick = 0;

  constructor(
    protected readonly sec: Security,
    readonly pb: PixelBody,
  ) {
    this.cellsTotal = pb.grid.countSolid();
    this.heading = pb.body.rotation();
    this.spawn = { ...pb.body.worldCom() };
    energize(pb.grid);
    pb.paint({ x0: 0, y0: 0, x1: pb.grid.w, y1: pb.grid.h });
    this.organs0 = this.organs();
  }

  private organs(): Organs {
    const g = this.pb.grid;
    let power = 0;
    for (let i = 0; i < g.mat.length; i++) if (g.mat[i] === M.POWER) power++;
    return { power, eye: countPowered(g, M.EYE), thruster: countPowered(g, M.THRUSTER), weapon: countPowered(g, M.WEAPON) };
  }

  /** Re-floods the power network and updates what still works. */
  private systems(): Organs {
    const g = this.pb.grid;
    if (energize(g)) this.pb.paint({ x0: 0, y0: 0, x1: g.w, y1: g.h });
    const o = this.organs();
    const o0 = this.organs0;
    const lost = (this.sees && o.eye === 0) || (this.armed && o.weapon === 0) || (this.thrust > 0 && o.thruster === 0);
    this.sees = o.eye > 0;
    this.armed = o.weapon > 0;
    this.thrust = o0.thruster ? o.thruster / o0.thruster : 0;
    if (lost) {
      // a system shorting out
      const c = this.pos;
      for (let k = 0; k < 6; k++) this.sec.ctx.particles.glint(c.x, c.y, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, 0.6, 0.8, 1, 0.07, 0.25);
    }
    return o;
  }

  get pos(): P {
    return this.pb.body.worldCom();
  }

  /**
   * Flies toward a desired velocity with bounded acceleration (thrusters, not teleporting).
   * Going somewhere (patrol, hunt) is world-relative: the thrusters fight any wind. Idle
   * station-keeping (airRelative) holds still relative to the air instead, like the ship's
   * flight assist: in a decompression that means going with the wind, so venting a room
   * takes its idle robots with it.
   */
  protected steer(vx: number, vy: number, accel: number, dt: number, airRelative = false): void {
    const b = this.pb.body;
    if (airRelative) {
      const c = this.pos;
      this.sec.ctx.field.sample(c.x, c.y, air);
      const k = Math.min(1, air.gas / 0.5);
      vx += air.vx * k;
      vy += air.vy * k;
    }
    const v = b.linvel();
    let ax = (vx - v.x) / dt;
    let ay = (vy - v.y) / dt;
    const a = Math.hypot(ax, ay);
    if (a > accel) {
      ax = (ax / a) * accel;
      ay = (ay / a) * accel;
    }
    const m = b.mass() * this.thrust;
    b.applyImpulse({ x: ax * m * dt, y: ay * m * dt }, true);
  }

  /**
   * Steers a desired direction around loose bodies in the way (barrels, crates): looks a
   * couple of meters ahead and sidesteps toward the side with room. Unit vectors in and out.
   */
  protected avoid(dx: number, dy: number, out: P): P {
    out.x = dx;
    out.y = dy;
    const c = this.pos;
    const px = this.sec.ctx.pixels;
    const hit = px.raycast(c.x, c.y, dx, dy, 3.5, this.pb);
    if (!hit || hit.target.kind !== 'pixelBody') return out;
    // try both sides; prefer the one whose way is clear
    for (const s of [1, -1]) {
      const sx = dx * 0.5 - dy * s * 0.87;
      const sy = dy * 0.5 + dx * s * 0.87;
      if (!px.raycast(c.x, c.y, sx, sy, 3.5, this.pb)) {
        out.x = sx;
        out.y = sy;
        return out;
      }
    }
    return out;
  }

  /** Turns the body (eye side, local +x) toward `heading` with a rate controller. */
  protected face(dt: number, rate = 4, accel = 25): void {
    const b = this.pb.body;
    let err = this.heading - b.rotation();
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const target = Math.max(-rate, Math.min(rate, err * 6));
    const a = accel * this.thrust;
    const dw = Math.max(-a * dt, Math.min(a * dt, target - b.angvel()));
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
    if (!this.pb.alive) {
      this.cause = 'destroyed';
      this.die();
      return false;
    }
    if (++this.sysTick % 4) return true;
    const o = this.systems();
    if (o.power < this.organs0.power * 0.4) this.cause = 'core';
    else if (!this.sees && !this.armed && this.thrust === 0) this.cause = 'unpowered';
    else if (this.pb.grid.countSolid() < this.cellsTotal * 0.4) this.cause = 'broken';
    if (this.cause) this.die();
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

/** Unexplained acceleration (m/s², smoothed) that makes a bot come and look at a body. */
const ODD = 1.5; // m/s²: carried or towed junk is well above (thrust ≈ 5); jostling junk isn't
const INVESTIGATE_TIME = 7; // s circling a suspicious body
const ORBIT = 5.5; // m from it

export class SecurityBot extends Robot {
  state: 'patrol' | 'hunt' | 'return' | 'investigate' = 'patrol';
  /** The body it's circling, while investigating. */
  looking: PixelBody | null = null;
  private lookT = 0;
  private orbitA = 0;
  private orbitDir = 1;
  private oddScanT = 0;
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
    const seeing = this.sees && ship.alive && sec.canSee(eye.x, eye.y, look, SecurityBot.HALF, SecurityBot.RANGE, this.pb);
    // the headlamp shining on the bot gives you away even from outside its cone
    const lit = this.sees && !seeing && this.state !== 'hunt' && sec.litByLamp(eye.x, eye.y, this.pb);
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

    // curiosity: debris that moves by itself gets a closer look (from all sides)
    if (this.state === 'patrol' || this.state === 'return') {
      this.oddScanT -= dt;
      if (this.sees && this.oddScanT <= 0) {
        this.oddScanT = 0.25;
        const odd = this.spotOdd(eye.x, eye.y, look);
        if (odd) {
          this.state = 'investigate';
          this.looking = odd;
          this.lookT = INVESTIGATE_TIME;
          const c = odd.body.worldCom();
          this.orbitA = Math.atan2(me.y - c.y, me.x - c.x);
          this.orbitDir = Math.random() < 0.5 ? 1 : -1;
        }
      }
    }
    if (this.state === 'investigate') {
      const b = this.looking;
      this.lookT -= dt;
      if (!b || !b.alive || this.lookT <= 0 || !this.sees) {
        this.looking = null;
        this.state = 'return';
      } else {
        // keep moving round it, eye on it: whatever hides behind it gets seen
        if (sec.oddness(b) > ODD) this.lookT = Math.max(this.lookT, 3);
        const c = b.body.worldCom();
        this.orbitA += this.orbitDir * 0.55 * dt;
        const tx = c.x + Math.cos(this.orbitA) * ORBIT;
        const ty = c.y + Math.sin(this.orbitA) * ORBIT;
        const dx = tx - me.x;
        const dy = ty - me.y;
        const d = Math.hypot(dx, dy) || 1;
        const sp = Math.min(3.5, d * 1.2);
        this.steer((dx / d) * sp, (dy / d) * sp, 5, dt);
        if (!seeing && !lit) this.heading = Math.atan2(c.y - me.y, c.x - me.x);
      }
    }

    if (this.state === 'hunt') {
      if (seeing) sec.spotted({ x: ship.x, y: ship.y });
      if (!sec.alert) this.state = 'return';
      const dir = seeing ? { x: Math.cos(toShip), y: Math.sin(toShip) } : sec.nav.direction(me.x, me.y, tmp);
      if (dir) this.steer(dir.x * 7, dir.y * 7, 7, dt);
      else this.steer(0, 0, 4, dt);
      this.heading = seeing ? toShip : dir ? Math.atan2(dir.y, dir.x) : this.heading;
      // shock on contact
      if (this.armed && ship.alive && dShip < 2.7) {
        ship.damage(18 * dt, 'shocked');
        if (Math.random() < 0.5) {
          const k = Math.random();
          sec.ctx.particles.glint(me.x + (ship.x - me.x) * k, me.y + (ship.y - me.y) * k, 0, 0, 0.6, 0.8, 1, 0.08, 0.14);
        }
      }
    } else if (this.state !== 'investigate') {
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
      const nav = this.state === 'return' && d > 12 ? sec.nav.direction(me.x, me.y, tmp) : null;
      const dir = this.avoid(nav ? nav.x : dx / (d || 1), nav ? nav.y : dy / (d || 1), tmp);
      this.steer(dir.x * sp, dir.y * sp, 4, dt);
      if (!seeing && !lit) this.heading = Math.atan2(dy, dx) + Math.sin(this.t * 1.3) * 0.55; // sweep while walking
    }
    this.face(dt);
  }

  /** A body in view that is moving oddly (being carried, towed, pushed), if any. */
  private spotOdd(ex: number, ey: number, look: number): PixelBody | null {
    const sec = this.sec;
    for (const b of sec.ctx.pixels.bodies) {
      if (b === this.pb || b.body.mass() < 20 || sec.oddness(b) < ODD) continue;
      const c = b.body.worldCom();
      const dx = c.x - ex;
      const dy = c.y - ey;
      const d = Math.hypot(dx, dy);
      if (d > SecurityBot.RANGE || d < 0.5) continue;
      const a = Math.atan2(dy, dx);
      if (Math.abs(Math.atan2(Math.sin(a - look), Math.cos(a - look))) > SecurityBot.HALF) continue;
      const hit = sec.ctx.pixels.raycast(ex, ey, dx / d, dy / d, d, this.pb);
      if (hit && hit.target !== b) continue; // something else is in the way
      return b;
    }
    return null;
  }

  frameUpdate(): void {
    // the body can be destroyed between physics steps (smashed, culled): don't touch it then
    if (!this.alive || !this.sees || !this.pb.alive) {
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
    // red hunting, orange suspicious, pale gold curious (circling something), warm white idle
    const color = hunting ? 0xff3b30 : this.suspicion > 0.05 ? 0xff9a3a : this.state === 'investigate' ? 0xffe066 : 0xffd27a;
    const opacity = hunting ? 0.12 : 0.1 + this.suspicion * 0.1;
    this.cone.set(eye.x, eye.y, look, SecurityBot.HALF, this.lengths, color, opacity);
  }

  addLights(out: Light[]): void {
    if (!this.alive || !this.sees || !this.pb.alive) return;
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
    const los = this.sees && ship.alive && d < 30 && sec.canSee(me.x, me.y, Math.atan2(dy, dx), Math.PI, 30, this.pb);
    if (los) sec.spotted({ x: ship.x, y: ship.y });
    if (!sec.alert) {
      this.steer(0, 0, 4, dt, true); // idle hover, holding still relative to the air
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
      if (this.armed && this.cooldown <= 0 && Math.abs(Math.atan2(Math.sin(this.heading - this.lookAngle()), Math.cos(this.heading - this.lookAngle()))) < 0.25) {
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
    if (!this.alive || !this.pb.alive) return;
    const c = this.pos;
    out.push({ x: c.x, y: c.y, dirX: 1, dirY: 0, cosHalf: -2, range: 6, intensity: 0.7, r: 1, g: 0.2, b: 0.35, skin: 0.8 });
  }
}
