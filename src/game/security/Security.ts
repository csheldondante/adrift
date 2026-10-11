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
import { M } from '../../pixel/materials';
import type { PixelBody } from '../../pixel/PixelBody';
import type { DoorSpec, EntitySpec, P } from '../level/types';
import type { Light } from '../../render/Lighting';
import type { Projectiles } from '../Projectiles';
import type { GameContext } from '../types';
import { NavField } from './NavField';
import { Drone, droneGrid, Robot, SecurityBot, securityBotGrid } from './robots';
import { Turret } from './Turret';

const ALERT_TIME = 28;
const SEAL_RADIUS = 48; // m from the alarm point
const BAY_RADIUS = 140;
const DRONES_PER_BAY = 3;
const MAX_DRONES = 12;

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
        const pb = ctx.pixels.addBody(grid, { x: e.x - (grid.w * CELL) / 2, y: e.y - (grid.h * CELL) / 2, tags: { label: 'securityBot' } });
        this.robots.push(new SecurityBot(this, pb, e.patrol));
      } else if (e.type === 'turret') {
        this.turrets.push(new Turret(this, e.x, e.y, e.dir));
      } else if (e.type === 'droneBay') {
        this.bays.push({ x: e.x, y: e.y, launched: 0, next: 0 });
      }
    }
    this.nav = new NavField(ctx.pixels.terrain.grid);
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

  fixedUpdate(dt: number): void {
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
      const grid = droneGrid();
      const pb = this.ctx.pixels.addBody(grid, { x: b.x - (grid.w * CELL) / 2, y: b.y - (grid.h * CELL) / 2, tags: { label: 'drone' } });
      this.robots.push(new Drone(this, pb));
      b.launched++;
      b.next = b.launched < DRONES_PER_BAY ? 0.7 : 0;
      for (let k = 0; k < 8; k++) this.ctx.particles.glint(b.x, b.y, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 1, 0.4, 0.3, 0.3, 0.1);
    }
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
