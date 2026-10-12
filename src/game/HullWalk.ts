// Hull-walking: magnetic feet clamp the ship to a surface and it walks along it. The camera
// rolls so the surface is "down" (Game reads `nx, ny`).
//
// Each fixed step while attached:
//   - normal: from the solid matter around the ship. Rings of samples are summed into a
//     gradient that points away from mass, then smoothed. Jagged pixel steps don't jitter
//     the ship; it wraps around convex corners and blends into concave ones.
//   - standoff: a ray along -normal finds the surface. A speed-limited spring holds the ship
//     about a meter off it, relative to the surface's own velocity, so you can ride a moving
//     body. Reaction impulses push back on whatever you're clinging to.
//   - walk: A/D sets a tangential speed (screen left/right once the camera has rolled).
//     With no input the feet hold, matching the surface's velocity.
//   - heading: belly to the surface, nose out, turned toward the aim within walk.lookAngle.
//     The four arms (Arms) are the legs and animate the gait.
//
// The feet let go when the surface disappears (cut away under you) or on request (E, or
// Space to push off).
//
// Likely growth: footstep sounds conducted through the hull, walking on the inside of
// pressurized rooms, stance (crouch/lean) for peeking past sensor cones.

import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { RayHit } from '../pixel/PixelWorld';
import type { GameContext } from './types';

const RINGS = [1.0, 1.7, 2.5, 3.4]; // m; the outer ring matches walk.reach
const SPOKES = 20;
const FAN = [0, 0.6, -0.6]; // rad around -normal for the standoff gap
const circ = { x: 0, y: 0, r: 0 };

export class HullWalk {
  attached = false;
  /** Smoothed surface normal (unit, pointing away from the surface). */
  nx = 0;
  ny = 1;
  /** Distance to the surface along -normal (m), last step. */
  gap = 0;
  /** The body being walked on, if it isn't terrain. */
  surfaceBody: PixelBody | null = null;
  private lostFor = 0;
  private readonly near: PixelBody[] = [];

  constructor(private readonly ctx: GameContext) {}

  private solidAt(x: number, y: number): boolean {
    if (this.ctx.pixels.terrain.grid.solid(Math.floor(x / CELL), Math.floor(y / CELL))) return true;
    for (const b of this.near) {
      const l = b.worldToLocal(x, y, circ);
      if (b.grid.solid(Math.floor(l.x), Math.floor(l.y))) return true;
    }
    return false;
  }

  /** Surface normal from matter around (x, y); false when nothing solid is within reach. */
  private probe(x: number, y: number, out: { x: number; y: number }): boolean {
    this.near.length = 0;
    for (const b of this.ctx.pixels.bodies) {
      b.boundingCircle(circ);
      if (Math.hypot(circ.x - x, circ.y - y) < circ.r + RINGS[RINGS.length - 1]) this.near.push(b);
    }
    let gx = 0;
    let gy = 0;
    let hits = 0;
    for (const r of RINGS) {
      for (let k = 0; k < SPOKES; k++) {
        const a = ((k + (r === 1.7 ? 0.5 : 0)) / SPOKES) * Math.PI * 2;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        if (!this.solidAt(x + cx * r, y + cy * r)) continue;
        // nearer matter dominates the direction
        gx -= cx / r;
        gy -= cy / r;
        hits++;
      }
    }
    const len = Math.hypot(gx, gy);
    if (hits === 0 || len < 1e-6) return false;
    out.x = gx / len;
    out.y = gy / len;
    return true;
  }

  /** Clamps on if there's a surface within reach. */
  tryAttach(): boolean {
    const sh = this.ctx.ship;
    if (!sh.alive) return false;
    const n = { x: 0, y: 0 };
    if (!this.probe(sh.x, sh.y, n)) return false;
    const hit = this.ctx.pixels.raycast(sh.x, sh.y, -n.x, -n.y, tune.walk.reach);
    if (!hit) return false;
    this.attached = true;
    this.nx = n.x;
    this.ny = n.y;
    this.lostFor = 0;
    return true;
  }

  /** Lets go; with `push`, kicks off the surface. */
  detach(push = false): void {
    if (!this.attached) return;
    this.attached = false;
    this.surfaceBody = null;
    if (push) {
      const b = this.ctx.ship.body;
      const j = b.mass() * tune.walk.pushOff;
      b.applyImpulse({ x: this.nx * j, y: this.ny * j }, true);
    }
  }

  /** Drives the ship along the surface; `move` is -1..1 (screen left/right). */
  fixedUpdate(dt: number, move: number): void {
    if (!this.attached) return;
    const { ctx } = this;
    const sh = ctx.ship;
    if (!sh.alive) {
      this.detach();
      return;
    }
    const w = tune.walk;
    const n = { x: 0, y: 0 };
    if (this.probe(sh.x, sh.y, n)) {
      const k = 1 - Math.exp(-dt * w.normalSmoothing);
      const x = this.nx + (n.x - this.nx) * k;
      const y = this.ny + (n.y - this.ny) * k;
      const l = Math.hypot(x, y) || 1;
      this.nx = x / l;
      this.ny = y / l;
    }
    const nx = this.nx;
    const ny = this.ny;
    // the gap is the shortest of a small fan of rays around -normal: in a concave corner the
    // blended normal points at the corner, which is farther than either wall, and holding the
    // standoff along it would pin the ship into the corner
    let hit: RayHit | null = null;
    for (const off of FAN) {
      const c = Math.cos(off);
      const s = Math.sin(off);
      const h = ctx.pixels.raycast(sh.x, sh.y, -(nx * c - ny * s), -(nx * s + ny * c), w.reach + 1);
      if (h && (!hit || h.dist < hit.dist)) hit = h;
    }
    if (!hit) {
      // surface gone (cut away, or we slid off an edge): hold on briefly, then let go
      this.lostFor += dt;
      if (this.lostFor > 0.35) this.detach();
      return;
    }
    this.lostFor = 0;
    this.gap = hit.dist;

    // surface velocity at the contact (moving bodies carry you)
    let svx = 0;
    let svy = 0;
    const body = hit.target.kind === 'pixelBody' ? (hit.target as PixelBody) : null;
    this.surfaceBody = body;
    if (body) {
      const v = body.body.linvel();
      const om = body.body.angvel();
      const c = body.body.worldCom();
      svx = v.x - om * (hit.y - c.y);
      svy = v.y + om * (hit.x - c.x);
    }
    const sb = sh.body;
    const v = sb.linvel();
    const rvx = v.x - svx;
    const rvy = v.y - svy;
    const tx = ny;
    const ty = -nx;
    const vn = rvx * nx + rvy * ny;
    const vt = rvx * tx + rvy * ty;

    // standoff spring (speed-limited, so attaching from a distance is a gentle landing)
    const wantVn = Math.max(-w.landSpeed, Math.min(w.landSpeed, (w.standoff - hit.dist) * w.stiffness));
    const maxDn = w.footAccel * dt;
    const dvn = Math.max(-maxDn, Math.min(maxDn, wantVn - vn));
    // walking: tangential speed toward the input, feet hold when idle. Slow down for a wall
    // ahead (a concave corner) so the nose turns the corner instead of ramming it.
    let wantVt = move * w.speed;
    if (move !== 0) {
      const dir = move > 0 ? 1 : -1;
      const ahead = ctx.pixels.raycast(sh.x, sh.y, tx * dir, ty * dir, 3, body ?? undefined);
      if (ahead) wantVt = dir * Math.min(Math.abs(wantVt), Math.max(1.2, (ahead.dist - w.standoff) * 3));
    }
    const maxDt = (move !== 0 ? w.accel : w.footAccel) * dt;
    const dvt = Math.max(-maxDt, Math.min(maxDt, wantVt - vt));
    const m = sb.mass();
    const jx = (nx * dvn + tx * dvt) * m;
    const jy = (ny * dvn + ty * dvt) * m;
    sb.applyImpulse({ x: jx, y: jy }, true);
    // the feet push on what they hold (kinematic machines ignore it)
    if (body) body.body.applyImpulseAtPoint({ x: -jx, y: -jy }, { x: hit.x, y: hit.y }, true);

    // heading: belly to the surface, nose out (the arms are the legs), turned toward the aim
    // within a cone so the lamp and tools can look around
    const out = Math.atan2(ny, nx);
    const c = ctx.controls;
    const aim = Math.atan2(c.aimY - sh.y, c.aimX - sh.x);
    const look = Math.max(-w.lookAngle, Math.min(w.lookAngle, Math.atan2(Math.sin(aim - out), Math.cos(aim - out))));
    sh.steerTo(out + look, dt);
  }
}
