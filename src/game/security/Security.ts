// Ship security: owns the robots and turrets spawned from level entities, the alarm state,
// line-of-sight queries, the nav field hunters follow, and the alarm responses.
//
// Alarm: raised by a security bot reaching full suspicion. While alert, every sighting (bot,
// drone or turret) refreshes the timer and the last known position. Responses:
//   - bulkheads near the alarm seal (DOOR slabs painted into doorways over ~0.8 s; cut them,
//     blast them, or cut their edges and yank them out with the harpoon)
//   - turrets wake and fire
//   - drone bays near the alarm launch attack drones
//   - bots near the last known position hunt and shock
// The alert ends after ALERT_TIME without a sighting; sealed doors stay sealed.
//
// Likely growth: alarm zones/levels (local vs ship-wide), noise (explosions draw attention),
// disabling security by cutting power conduits or destroying a security core.

import { CELL, tune } from '../../config';
import { dragArea, dragForce } from '../../fields/drag';
import type { FieldSample } from '../../fields/GasField';
import { M } from '../../pixel/materials';
import type { PixelBody } from '../../pixel/PixelBody';
import type { DoorSpec, EntitySpec, P } from '../level/types';
import type { Light } from '../../render/Lighting';
import type { Projectiles } from '../Projectiles';
import type { GameContext } from '../types';
import { NavField } from './NavField';
import { Drone, droneGrid, Robot, SecurityBot, securityBotGrid } from './robots';
import { Turret } from './Turret';

const air: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const drag = { x: 0, y: 0 };
const ALERT_TIME = 28;
const SEAL_RADIUS = 48; // m from the alarm point
const BAY_RADIUS = 140;
const DRONES_PER_BAY = 3;
const MAX_DRONES = 12;
const BOT_CLEARANCE = 2.0; // m of free space around robot spawn and patrol points (body radius 1.25 + margin)

interface SealingDoor {
  d: DoorSpec;
  t: number; // 0..1 progress
}

export class Security {
  alert = false;
  alertTimer = 0;
  lastKnown: P = { x: 0, y: 0 };
  readonly nav: NavField;
  readonly robots: Robot[] = [];
  readonly turrets: Turret[] = [];
  private readonly bays: { x: number; y: number; launched: number; next: number }[] = [];
  private readonly doors: DoorSpec[];
  private readonly sealed = new Set<DoorSpec>();
  private readonly sealing: SealingDoor[] = [];
  alarms = 0;
  /**
   * How oddly each loose body is moving (m/s², smoothed). In zero-g, junk drifts in straight
   * lines; something that keeps accelerating is being carried, towed or pushed. Bots that
   * see it come and look (SecurityBot 'investigate').
   */
  private readonly motion = new WeakMap<PixelBody, { vx: number; vy: number; odd: number }>();

  constructor(
    readonly ctx: GameContext,
    entities: EntitySpec[],
    doors: DoorSpec[],
    readonly projectiles: Projectiles,
  ) {
    this.doors = doors;
    for (const e of entities) {
      if (e.type === 'securityBot') {
        const grid = securityBotGrid();
        // the generator places patrols by room rect; furniture can sit on those points
        const patrol = e.patrol.map((p) => this.freeSpot(p.x, p.y, BOT_CLEARANCE));
        const at = patrol[0];
        const pb = ctx.pixels.addBody(grid, { x: at.x - (grid.w * CELL) / 2, y: at.y - (grid.h * CELL) / 2, tags: { label: 'securityBot' } });
        this.robots.push(new SecurityBot(this, pb, patrol));
      } else if (e.type === 'turret') {
        this.turrets.push(new Turret(this, e.x, e.y, e.dir));
      } else if (e.type === 'drone') {
        const at = this.freeSpot(e.x, e.y, BOT_CLEARANCE);
        this.spawnDrone(at.x, at.y, e.angle);
      } else if (e.type === 'droneBay') {
        this.bays.push({ x: e.x, y: e.y, launched: 0, next: 0 });
      }
    }
    this.nav = new NavField(ctx.pixels.terrain.grid);
  }

  /**
   * Nearest point to (x, y), searching outward up to 10 m, with no matter (terrain or loose
   * bodies: a bot spawned on a fuel barrel sets it off) within radius r.
   */
  freeSpot(x: number, y: number, r: number): P {
    const px = this.ctx.pixels;
    const clear = (cx: number, cy: number) => {
      for (let dy = -r; dy <= r; dy += 0.25)
        for (let dx = -r; dx <= r; dx += 0.25) if (dx * dx + dy * dy <= r * r && px.objectAt(cx + dx, cy + dy)) return false;
      return true;
    };
    if (clear(x, y)) return { x, y };
    for (let d = 0.5; d <= 10; d += 0.5)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        if (clear(px, py)) return { x: px, y: py };
      }
    return { x, y };
  }

  /** Highest suspicion among bots and sentry turrets (for the HUD's "being watched" meter). */
  get suspicion(): number {
    let s = 0;
    for (const r of this.robots) if (r instanceof SecurityBot && r.alive && r.state !== 'hunt') s = Math.max(s, r.suspicion);
    for (const t of this.turrets) if (t.alive) s = Math.max(s, t.suspicion);
    return s;
  }

  raiseAlarm(at: P): void {
    if (!this.alert) {
      this.alarms++;
      this.nav.rebuild(); // pick up anything cut since the last alarm
      for (const d of this.doors) {
        if (this.sealed.has(d)) continue;
        const cx = (d.x0 + d.x1) / 2;
        const cy = (d.y0 + d.y1) / 2;
        if (Math.hypot(cx - at.x, cy - at.y) < SEAL_RADIUS) {
          this.sealed.add(d);
          this.sealing.push({ d, t: 0 });
        }
      }
      for (const b of this.bays) if (Math.hypot(b.x - at.x, b.y - at.y) < BAY_RADIUS) b.next = 0.3;
    }
    this.alert = true;
    this.spotted(at);
  }

  /** A sighting during an alert: refresh the timer and the hunters' target. */
  spotted(at: P): void {
    if (!this.alert) return;
    this.alertTimer = ALERT_TIME;
    this.lastKnown = { x: at.x, y: at.y };
    this.nav.setTarget(at.x, at.y);
  }

  /** Is the ship visible from (x, y) within a cone (angle ± half) and range? Matter blocks sight. */
  canSee(x: number, y: number, angle: number, half: number, range: number, self?: PixelBody): boolean {
    const ship = this.ctx.ship;
    range *= ship.conspicuity; // dark and quiet ships are seen only up close
    const dx = ship.x - x;
    const dy = ship.y - y;
    const d = Math.hypot(dx, dy);
    if (d > range || d < 1e-3) return d < 1e-3;
    const a = Math.atan2(dy, dx);
    if (Math.abs(Math.atan2(Math.sin(a - angle), Math.cos(a - angle))) > half) return false;
    return !this.ctx.pixels.raycast(x, y, dx / d, dy / d, Math.max(0, d - 1.0), self);
  }

  /** Is (x, y) inside the ship's headlamp beam with a clear line to it? The light gives you away. */
  litByLamp(x: number, y: number, self?: PixelBody): boolean {
    const ship = this.ctx.ship;
    const L = tune.light;
    if (!ship.alive || !ship.lampOn || !L.enabled) return false;
    const dx = x - ship.x;
    const dy = y - ship.y;
    const d = Math.hypot(dx, dy);
    if (d > L.lampRange || d < 1e-3) return false;
    const a = Math.atan2(dy, dx) - ship.angle;
    if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) > L.lampHalf) return false;
    return !this.ctx.pixels.raycast(ship.x, ship.y, dx / d, dy / d, Math.max(0, d - 1.0), self);
  }

  /** Sensor beams and running lights. */
  addLights(out: Light[]): void {
    for (const r of this.robots) r.addLights(out);
    for (const t of this.turrets) t.addLights(out);
  }

  /** Distance along a ray until matter, capped at max (vision cone clipping). */
  rayLength(x: number, y: number, angle: number, max: number, self?: PixelBody): number {
    const hit = this.ctx.pixels.raycast(x, y, Math.cos(angle), Math.sin(angle), max, self);
    return hit ? hit.dist : max;
  }

  /** Smoothed unexplained acceleration of a body (m/s²); 0 for bodies not tracked yet. */
  oddness(b: PixelBody): number {
    return this.motion.get(b)?.odd ?? 0;
  }

  private trackMotion(dt: number): void {
    for (const b of this.ctx.pixels.bodies) {
      if (b.tags.machine || b.tags.label === 'securityBot' || b.tags.label === 'drone') continue;
      const v = b.body.linvel();
      const m = this.motion.get(b);
      if (!m) {
        this.motion.set(b, { vx: v.x, vy: v.y, odd: 0 });
        continue;
      }
      // what the air did to it is explained: subtract the drag the physics applied
      const mass = b.body.mass();
      const c = b.body.worldCom();
      this.ctx.field.sample(c.x, c.y, air);
      const f = dragForce(air, m.vx, m.vy, dragArea(mass), drag);
      const a = Math.hypot(v.x - m.vx - (f.x / mass) * dt, v.y - m.vy - (f.y / mass) * dt) / dt;
      // clamped and smoothed (~0.5 s): sustained acceleration counts, a collision spike barely does
      m.odd += (Math.min(a, 6) - m.odd) * Math.min(1, dt * 2);
      m.vx = v.x;
      m.vy = v.y;
    }
  }

  fixedUpdate(dt: number): void {
    this.trackMotion(dt);
    if (this.alert) {
      this.alertTimer -= dt;
      if (this.alertTimer <= 0) this.alert = false;
    }
    for (const r of this.robots) r.update(dt);
    for (const t of this.turrets) t.update(dt);
    this.updateDoors(dt);
    if (this.alert) this.launchDrones(dt);
  }

  private updateDoors(dt: number): void {
    const px = this.ctx.pixels;
    for (let i = this.sealing.length - 1; i >= 0; i--) {
      const s = this.sealing[i];
      const prev = s.t;
      s.t = Math.min(1, s.t + dt / 0.8);
      const d = s.d;
      const x0 = d.x0 / CELL;
      const x1 = d.x1 / CELL;
      const y0 = d.y0 / CELL;
      const y1 = d.y1 / CELL;
      // slide in: rows from the top for doorways in vertical walls, columns from the left otherwise
      if (d.axis === 'v') px.paintTerrain(x0, y1 - (y1 - y0) * s.t, x1, y1 - (y1 - y0) * prev, M.BULKHEAD);
      else px.paintTerrain(x0 + (x1 - x0) * prev, y0, x0 + (x1 - x0) * s.t, y1, M.BULKHEAD);
      if (s.t >= 1) this.sealing.splice(i, 1);
    }
  }

  private launchDrones(dt: number): void {
    const live = this.robots.filter((r) => r instanceof Drone && r.alive).length;
    for (const b of this.bays) {
      if (b.next <= 0 || b.launched >= DRONES_PER_BAY || live >= MAX_DRONES) continue;
      b.next -= dt;
      if (b.next > 0) continue;
      this.spawnDrone(b.x, b.y);
      b.launched++;
      b.next = b.launched < DRONES_PER_BAY ? 0.7 : 0;
      for (let k = 0; k < 8; k++) this.ctx.particles.glint(b.x, b.y, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 1, 0.4, 0.3, 0.3, 0.1);
    }
  }

  /** Launches an attack drone centered at (x, y), facing `angle`. */
  spawnDrone(x: number, y: number, angle = 0): Drone {
    const grid = droneGrid();
    const hw = (grid.w * CELL) / 2;
    const hh = (grid.h * CELL) / 2;
    // the body origin is the grid corner: rotate the half extents so the center lands on (x, y)
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const pb = this.ctx.pixels.addBody(grid, { x: x - (c * hw - s * hh), y: y - (s * hw + c * hh), angle, tags: { label: 'drone' } });
    const d = new Drone(this, pb);
    this.robots.push(d);
    return d;
  }

  frameUpdate(): void {
    for (const r of this.robots) r.frameUpdate();
    for (const t of this.turrets) t.frameUpdate();
  }

  dispose(): void {
    for (const r of this.robots) r.dispose();
    for (const t of this.turrets) t.dispose();
  }
}
