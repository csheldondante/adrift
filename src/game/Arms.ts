// Four articulated arms on the ship's flanks. Two jobs:
//   - grab: drift up to a loose body slowly enough (relative speed under arms.grabSpeed) and
//     close enough that an arm can reach it, and the arms catch it. The hold is a fixed joint
//     at the current relative pose, like the harpoon clamp, so the held body is a shield or a
//     battering ram, and letting go (E) leaves it with its momentum (tow it, then throw it).
//   - walk: while the hull-walk feet are clamped on (HullWalk does the physics), the arms are
//     the feet. Each foot stays planted until it falls too far behind its stance point, then
//     steps there in an arc. Diagonal pairs alternate so two feet are always down.
//
// Free arms tuck in against the hull. Arm tips are animated, IK is two-bone and visual only.
//
// Likely growth: arms as tools (hold a power cell to a socket, turn a valve), a carry limit
// by mass, per-arm grips so a cut cell under one hand loosens the hold.

import type { ImpulseJoint } from '@dimforge/rapier2d-compat';
import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import type { HullWalk } from './HullWalk';
import type { GameContext } from './types';

type P = { x: number; y: number };

interface Arm {
  /** Ship-local mount point (m). */
  mount: P;
  /** Ship-local side (+1 left, -1 right). */
  side: number;
  /** Walking stance: how far out along the surface from under the mount the foot plants (m). */
  spread: number;
  /** Gait group: diagonal pairs step together. */
  group: number;
  /** Free (tucked/reaching) tip in ship-local coordinates. */
  local: P;
  /** Planted on / gripping this object at cell coordinates (lx, ly); null when free. */
  on: PixelObject | null;
  lx: number;
  ly: number;
  /** Step in progress: 0..1, or -1. Steps go from `from` (world) to the planted point. */
  step: number;
  stepDur: number;
  from: P;
  /** World tip last frame (for servo speed). */
  last: P;
  upper: Ribbon;
  fore: Ribbon;
  claw: [Ribbon, Ribbon];
}

const w0 = { x: 0, y: 0 };
const w1 = { x: 0, y: 0 };
const circ = { x: 0, y: 0, r: 0 };

export class Arms {
  readonly arms: Arm[] = [];
  /** The loose body the arms are holding, if any. */
  held: PixelBody | null = null;
  private joint: ImpulseJoint | null = null;
  /** Bodies just let go of: ignored until they drift out of reach (no instant re-grab). */
  private readonly ignore = new Set<PixelBody>();
  /** Mean arm-tip speed this frame (m/s), for the servo sound. */
  motion = 0;
  /** A foot or hand landed this step (world point, strength 0..1); read and cleared by the game. */
  readonly landed: { x: number; y: number; e: number }[] = [];

  constructor(
    private readonly ctx: GameContext,
    private readonly walk: HullWalk,
  ) {
    const L = tune.arms;
    const defs = [
      { mount: { x: -0.15, y: 0.42 }, side: 1, spread: L.frontSpread, group: 0 },
      { mount: { x: -0.15, y: -0.42 }, side: -1, spread: L.frontSpread, group: 1 },
      { mount: { x: -0.95, y: 0.65 }, side: 1, spread: L.rearSpread, group: 1 },
      { mount: { x: -0.95, y: -0.65 }, side: -1, spread: L.rearSpread, group: 0 },
    ];
    for (const d of defs) {
      const arm: Arm = {
        ...d,
        local: this.tuckPoint(d.mount, d.side, 0),
        on: null,
        lx: 0,
        ly: 0,
        step: -1,
        stepDur: 0.15,
        from: { x: 0, y: 0 },
        last: { x: 0, y: 0 },
        upper: new Ribbon(0xa3adbd, ORDER.ship - 1),
        fore: new Ribbon(0xc3cbd8, ORDER.ship - 1),
        claw: [new Ribbon(0xb8c2d0, ORDER.ship - 1), new Ribbon(0xb8c2d0, ORDER.ship - 1)],
      };
      this.arms.push(arm);
      ctx.fx.add(arm.upper.mesh, arm.fore.mesh, arm.claw[0].mesh, arm.claw[1].mesh);
    }
  }

  private get reach(): number {
    return tune.arms.upper + tune.arms.fore;
  }

  /** Folded-in rest position for a free arm (ship-local). */
  private tuckPoint(mount: P, side: number, t: number): P {
    const sway = Math.sin(t * 1.3 + mount.x * 3 + side) * 0.05;
    return { x: mount.x - 0.75 + sway, y: mount.y + side * 0.3 };
  }

  private shipToWorld(lx: number, ly: number, out: P): P {
    const sh = this.ctx.ship;
    const a = sh.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.x = sh.x + c * lx - s * ly;
    out.y = sh.y + s * lx + c * ly;
    return out;
  }

  private worldToShip(wx: number, wy: number, out: P): P {
    const sh = this.ctx.ship;
    const a = sh.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = wx - sh.x;
    const dy = wy - sh.y;
    out.x = c * dx + s * dy;
    out.y = -s * dx + c * dy;
    return out;
  }

  /** Current world tip of an arm (planted, stepping or free). */
  private tip(arm: Arm, out: P): P {
    if (!arm.on) return this.shipToWorld(arm.local.x, arm.local.y, out);
    arm.on.localToWorld(arm.lx, arm.ly, out);
    if (arm.step >= 0) {
      // eased arc from where the foot lifted to where it lands
      const u = arm.step;
      const e = u * u * (3 - 2 * u);
      const lift = Math.sin(Math.PI * u) * tune.arms.stepLift;
      out.x = arm.from.x + (out.x - arm.from.x) * e + (this.walk.attached ? this.walk.nx : 0) * lift;
      out.y = arm.from.y + (out.y - arm.from.y) * e + (this.walk.attached ? this.walk.ny : 0) * lift;
    }
    return out;
  }

  /** Starts a step (or reach) of `arm` to world point (x, y) on `obj`. */
  private plant(arm: Arm, obj: PixelObject, x: number, y: number, dur: number): void {
    this.tip(arm, arm.from);
    obj.worldToLocal(x, y, w0);
    arm.on = obj;
    arm.lx = w0.x;
    arm.ly = w0.y;
    arm.step = 0;
    arm.stepDur = dur;
  }

  /** Lets an arm go free, keeping its tip where it is (it eases back to the tuck). */
  private free(arm: Arm): void {
    if (!arm.on) return;
    this.tip(arm, w0);
    this.worldToShip(w0.x, w0.y, arm.local);
    arm.on = null;
    arm.step = -1;
  }

  private alive(o: PixelObject | null): boolean {
    return !!o && (o.kind === 'terrain' || (o as PixelBody).alive);
  }

  /** E with something in hand: let go. Returns true if something was released. */
  release(): boolean {
    if (!this.held) return false;
    const b = this.held;
    this.drop();
    this.ignore.add(b);
    return true;
  }

  /** Something slammed into the hull too fast to catch: it isn't caught on the rebound either. */
  knock(b: PixelBody): void {
    if (b !== this.held) this.ignore.add(b);
  }

  private drop(): void {
    if (this.joint) this.ctx.physics.world.removeImpulseJoint(this.joint, true);
    this.joint = null;
    this.held = null;
    for (const a of this.arms) this.free(a);
  }

  /** Must be called before a pixel body is removed from the physics world. */
  onBodyRemoved(b: PixelBody): void {
    if (this.held === b) this.drop();
    this.ignore.delete(b);
    for (const a of this.arms) if (a.on === b) this.free(a);
  }

  detachAll(): void {
    if (this.held) this.drop();
    for (const a of this.arms) this.free(a);
  }

  fixedUpdate(dt: number, canGrab: boolean): void {
    const sh = this.ctx.ship;
    if (!sh.alive) {
      this.detachAll();
      return;
    }
    if (this.held && !this.held.alive) this.drop();
    for (const a of this.arms) {
      if (a.on && !this.alive(a.on)) this.free(a);
      if (a.step >= 0) {
        a.step += dt / a.stepDur;
        if (a.step >= 1) {
          a.step = -1;
          this.tip(a, w0);
          this.landed.push({ x: w0.x, y: w0.y, e: this.walk.attached ? 0.35 : 0.6 });
        }
      }
    }
    this.pruneIgnored();
    if (this.walk.attached) {
      if (this.held) this.drop();
      this.gait();
    } else {
      // feet that were walking come off the surface (but a hold keeps its grips)
      if (!this.held) for (const a of this.arms) this.free(a);
      if (canGrab && !this.held) this.tryGrab();
    }
  }

  private pruneIgnored(): void {
    const sh = this.ctx.ship;
    for (const b of this.ignore) {
      b.boundingCircle(circ);
      if (!b.alive || Math.hypot(circ.x - sh.x, circ.y - sh.y) - circ.r > this.reach + 2) this.ignore.delete(b);
    }
  }

  /** Catches a nearby loose body that is drifting slowly enough relative to the ship. */
  private tryGrab(): void {
    const { ctx } = this;
    const sh = ctx.ship;
    const L = tune.arms;
    const sv = sh.body.linvel();
    const reach = this.reach;
    for (const b of ctx.pixels.bodies) {
      if (!b.alive || b.tags.machine || this.ignore.has(b) || b.body.mass() < L.minMass) continue;
      b.boundingCircle(circ);
      if (Math.hypot(circ.x - sh.x, circ.y - sh.y) - circ.r > reach + 1.5) continue;
      // each arm looks for the body along a few rays from its mount toward the body's center
      const c = b.body.worldCom();
      const grips: { arm: Arm; x: number; y: number }[] = [];
      let slow = false;
      for (const a of this.arms) {
        const m = this.shipToWorld(a.mount.x, a.mount.y, w1);
        const base = Math.atan2(c.y - m.y, c.x - m.x);
        let best: { x: number; y: number; d: number } | null = null;
        for (const off of [0, 0.45, -0.45]) {
          const dx = Math.cos(base + off);
          const dy = Math.sin(base + off);
          const hit = ctx.pixels.raycast(m.x, m.y, dx, dy, reach);
          if (hit && hit.target === b && (!best || hit.dist < best.d)) best = { x: hit.x + dx * CELL * 0.5, y: hit.y + dy * CELL * 0.5, d: hit.dist };
        }
        if (!best) continue;
        grips.push({ arm: a, x: best.x, y: best.y });
        const v = b.body.velocityAtPoint(best);
        if (Math.hypot(v.x - sv.x, v.y - sv.y) < L.grabSpeed) slow = true;
      }
      if (!grips.length || !slow) continue;
      this.grab(b, grips);
      return;
    }
  }

  private grab(b: PixelBody, grips: { arm: Arm; x: number; y: number }[]): void {
    const { ctx } = this;
    const sb = ctx.ship.body;
    const body = b.body;
    // lock at the current relative pose (same construction as the harpoon clamp)
    const st = sb.translation();
    const bt = body.translation();
    const ba = body.rotation();
    const dx = st.x - bt.x;
    const dy = st.y - bt.y;
    const local = { x: Math.cos(ba) * dx + Math.sin(ba) * dy, y: -Math.sin(ba) * dx + Math.cos(ba) * dy };
    const params = ctx.physics.R.JointData.fixed({ x: 0, y: 0 }, 0, local, sb.rotation() - ba);
    this.joint = ctx.physics.world.createImpulseJoint(params, sb, body, true);
    this.held = b;
    for (const g of grips) this.plant(g.arm, b, g.x, g.y, 0.1);
  }

  /** Walking gait: feet stay planted until they lag their stance point, then step to it. */
  private gait(): void {
    const { ctx, walk } = this;
    const sh = ctx.ship;
    const L = tune.arms;
    const nx = walk.nx;
    const ny = walk.ny;
    const tx = ny;
    const ty = -nx;
    const v = sh.body.linvel();
    const vt = v.x * tx + v.y * ty;
    const speed = Math.abs(vt);
    const stepping = [false, false];
    for (const a of this.arms) if (a.step >= 0) stepping[a.group] = true;
    for (const a of this.arms) {
      if (a.step >= 0) continue;
      const m = this.shipToWorld(a.mount.x, a.mount.y, w1);
      const mx = m.x;
      const my = m.y;
      // stance point: out along the surface on the mount's side, led by the walking speed
      const sideT = Math.sign((mx - sh.x) * tx + (my - sh.y) * ty) || a.side;
      const lead = Math.max(-L.maxLead, Math.min(L.maxLead, vt * L.strideLead));
      const bx = mx + tx * (sideT * a.spread + lead) + nx * 1.2;
      const by = my + ty * (sideT * a.spread + lead) + ny * 1.2;
      const hit = ctx.pixels.raycast(bx, by, -nx, -ny, 4.5);
      if (!hit) continue;
      const hx = hit.x - nx * CELL * 0.5;
      const hy = hit.y - ny * CELL * 0.5;
      // lag is measured from the stance point without the lead, so a step lands ahead of it
      // and the stride is lead + threshold (long, unhurried strides at speed)
      let lag = Infinity;
      let overReach = true;
      if (a.on) {
        this.tip(a, w0);
        lag = Math.hypot(w0.x - (hx - tx * lead), w0.y - (hy - ty * lead));
        overReach = Math.hypot(w0.x - mx, w0.y - my) > this.reach * 0.98;
      }
      const due = lag > Math.max(L.stepDistance, speed * 0.15) && !stepping[1 - a.group];
      if (!a.on || overReach || due) {
        this.plant(a, hit.target, hx, hy, Math.max(0.09, L.stepTime - speed * 0.012));
        stepping[a.group] = true;
      }
    }
  }

  /** Draws the arms (two-bone IK from mount to tip). */
  frameUpdate(dt: number, time: number): void {
    const sh = this.ctx.ship;
    const L = tune.arms;
    let moved = 0;
    for (const a of this.arms) {
      const show = sh.alive;
      if (!show) {
        a.upper.hide();
        a.fore.hide();
        a.claw[0].hide();
        a.claw[1].hide();
        continue;
      }
      if (!a.on) {
        // free arms ease toward the tuck (in ship space, so they never trail behind a fast ship)
        const t = this.tuckPoint(a.mount, a.side, time);
        const k = 1 - Math.exp(-dt * 10);
        a.local.x += (t.x - a.local.x) * k;
        a.local.y += (t.y - a.local.y) * k;
      }
      const m = this.shipToWorld(a.mount.x, a.mount.y, w1);
      const mx = m.x;
      const my = m.y;
      const tp = this.tip(a, w0);
      let tx = tp.x;
      let ty = tp.y;
      if (dt > 0) moved += Math.hypot(tx - a.last.x, ty - a.last.y) / dt;
      a.last.x = tx;
      a.last.y = ty;
      // knee bends away from the surface when walking, else outward from the hull
      let hx: number;
      let hy: number;
      if (this.walk.attached) {
        hx = this.walk.nx;
        hy = this.walk.ny;
      } else {
        const c = Math.cos(sh.angle);
        const s = Math.sin(sh.angle);
        hx = -s * a.side;
        hy = c * a.side;
      }
      let dx = tx - mx;
      let dy = ty - my;
      let d = Math.hypot(dx, dy) || 1e-4;
      const L1 = L.upper;
      const L2 = L.fore;
      const dMax = L1 + L2 - 1e-3;
      if (d > dMax) {
        // out of reach (a fast drift): the arm points at the target, fully extended
        tx = mx + (dx / d) * dMax;
        ty = my + (dy / d) * dMax;
        dx = tx - mx;
        dy = ty - my;
        d = dMax;
      }
      d = Math.max(d, Math.abs(L1 - L2) + 1e-3);
      const ux = dx / d;
      const uy = dy / d;
      const along = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
      // of the two knee solutions, the one on the hint side
      let px = -uy;
      let py = ux;
      if (px * hx + py * hy < 0) {
        px = -px;
        py = -py;
      }
      const kx = mx + ux * along + px * h;
      const ky = my + uy * along + py * h;
      a.upper.set(mx, my, kx, ky, 0.2);
      a.fore.set(kx, ky, tx, ty, 0.14);
      // two-finger claw: open while free/reaching, closed on a grip or foothold
      const fa = Math.atan2(ty - ky, tx - kx);
      const spread = a.on && a.step < 0 ? 0.35 : 0.8;
      for (let k = 0; k < 2; k++) {
        const t = fa + (k ? spread : -spread);
        a.claw[k].set(tx, ty, tx + Math.cos(t) * 0.28, ty + Math.sin(t) * 0.28, 0.07);
      }
    }
    this.motion = moved / this.arms.length;
  }

  status(): string {
    if (this.held) return `holding ${Math.round(this.held.body.mass())} kg · E let go`;
    return this.walk.attached ? 'walking' : 'ready';
  }

  dispose(): void {
    this.detachAll();
    for (const a of this.arms) {
      a.upper.dispose();
      a.fore.dispose();
      a.claw[0].dispose();
      a.claw[1].dispose();
    }
  }
}
