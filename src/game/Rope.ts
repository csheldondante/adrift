// Physical tether: a chain of dynamic segments from a target end (whatever the harpoon stuck
// into) to an anchor on the ship. Segments collide with terrain and loose bodies, so the rope
// sags when slack and wraps around corners. It can start from any layout (the harpoon spawns
// it along a slack bow). Links are max-distance joints between massive segments, so tension
// propagates down the chain rather than instantly.
//
// Tension model ("a little spring"):
//   - Rest length L. Every joint is a hard max-distance limit at L·(1+maxStretch), plus a
//     hidden straight-line cap between the ends at the same limit.
//   - Beyond L, a one-sided spring acts on the rope's path length (works around corners):
//     T = k·(path − L) + c·(end separation speed), k = EA/L, clamped so the explicit spring
//     stays stable at the physics step. The ends are pulled along the rope at each end;
//     segments get the same tension (capped for stability) so a taut rope straightens.
//   - Slack rope (path ≤ L) carries no force. Segments are heavily damped so slack rope
//     drifts and settles instead of jittering.
//
// Reeling adds/removes segments at the ship end; the ship-end link carries the fractional
// remainder so length changes are continuous.
//
// Likely growth: cutting/snapping at a tension limit, tying two objects together. The target
// end is swappable (setTarget), which is what the hook uses when it bites.

import type RAPIER from '@dimforge/rapier2d-compat';
import { FIXED_DT, tune } from '../config';
import { ROPE_GROUPS, type Body, type PhysOwner, type Physics } from '../physics/Physics';

export interface RopeEnd {
  body: Body;
  /** Anchor in the body's local frame (meters). */
  local: { x: number; y: number };
}

type P = { x: number; y: number };

const SEG_RADIUS = 0.06;
const ROPE_OWNER: PhysOwner = { kind: 'rope' };
const ZERO = { x: 0, y: 0 };

export class Rope {
  /** segs[0] is next to the target; the last segment is next to the ship. */
  private readonly segs: Body[] = [];
  private readonly links: RAPIER.ImpulseJoint[] = []; // links[i] joins segs[i] -> segs[i+1]
  private targetJoint: RAPIER.ImpulseJoint | null = null;
  private shipJoint: RAPIER.ImpulseJoint | null = null;
  private capJoint: RAPIER.ImpulseJoint | null = null;
  private shipJointLen = 0;
  private capLen = 0;
  private readonly segLen: number;
  private readonly stretchMax: number;
  private readonly pts: P[] = [];
  length: number;
  /**
   * 1/s damping of segment motion toward the straight line between the ends. The owner
   * enables it only when the rope should be a straight line (taut, nothing in the way);
   * slack or wrapped rope keeps its natural sway.
   */
  chordDamping = 0;
  /** Current spring tension (N), for visuals/HUD. */
  tension = 0;

  /**
   * @param layout optional world positions for the segments, target side first; must have
   *   segmentsFor(length) entries spaced ≤ segmentLength apart. Defaults to a straight line.
   */
  constructor(
    private readonly physics: Physics,
    private ship: RopeEnd,
    private target: RopeEnd,
    length: number,
    layout?: P[],
  ) {
    this.segLen = tune.grapple.segmentLength;
    this.stretchMax = 1 + tune.grapple.maxStretch;
    this.length = length;
    const n = this.segmentsFor(length);
    const a = this.endWorld(target);
    const b = this.endWorld(ship);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = layout?.[i] ?? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      this.segs.push(this.makeSegment(p.x, p.y, ship.body));
    }
    for (let i = 0; i + 1 < n; i++) this.links.push(this.link(this.segs[i], this.segs[i + 1]));
    this.attachTargetJoint();
    this.rebuildShipJoint();
    this.rebuildCap();
  }

  /** Number of segments for a rest length: half-segment target link + (n-1) links + ship link. */
  static segmentsFor(len: number): number {
    const s = tune.grapple.segmentLength;
    return Math.max(1, Math.ceil((len - s * 0.5) / s));
  }

  private segmentsFor(len: number): number {
    return Rope.segmentsFor(len);
  }

  private link(a: Body, b: Body): RAPIER.ImpulseJoint {
    const { world, R } = this.physics;
    return world.createImpulseJoint(R.JointData.rope(this.segLen * this.stretchMax, ZERO, ZERO), a, b, true);
  }

  private endWorld(e: RopeEnd, out: P = { x: 0, y: 0 }): P {
    const t = e.body.translation();
    const a = e.body.rotation();
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.x = t.x + c * e.local.x - s * e.local.y;
    out.y = t.y + s * e.local.x + c * e.local.y;
    return out;
  }

  private makeSegment(x: number, y: number, velFrom: Body): Body {
    const R = this.physics.R;
    const v = velFrom.linvel();
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(v.x, v.y).setLinearDamping(tune.grapple.segmentDamping).setCcdEnabled(true),
    );
    const area = Math.PI * SEG_RADIUS * SEG_RADIUS;
    this.physics.createCollider(
      R.ColliderDesc.ball(SEG_RADIUS).setDensity(tune.grapple.segmentMass / area).setFriction(0.2).setRestitution(0).setCollisionGroups(ROPE_GROUPS),
      body,
      ROPE_OWNER,
    );
    return body;
  }

  /** Rest length of the ship-end link, in (0, segLen]. */
  private shipLinkLength(): number {
    const rest = this.length - this.segLen * 0.5 - (this.segs.length - 1) * this.segLen;
    return Math.max(0.05, rest);
  }

  private attachTargetJoint(): void {
    const { world, R } = this.physics;
    this.targetJoint = world.createImpulseJoint(R.JointData.rope(this.segLen * 0.5 * this.stretchMax, this.target.local, ZERO), this.target.body, this.segs[0], true);
  }

  private rebuildShipJoint(): void {
    const w = this.physics.world;
    if (this.shipJoint) w.removeImpulseJoint(this.shipJoint, true);
    this.shipJointLen = this.shipLinkLength();
    const last = this.segs[this.segs.length - 1];
    this.shipJoint = w.createImpulseJoint(this.physics.R.JointData.rope(this.shipJointLen * this.stretchMax, ZERO, this.ship.local), last, this.ship.body, true);
  }

  private rebuildCap(): void {
    const w = this.physics.world;
    if (this.capJoint) w.removeImpulseJoint(this.capJoint, true);
    this.capLen = this.length * this.stretchMax;
    this.capJoint = w.createImpulseJoint(this.physics.R.JointData.rope(this.capLen, this.target.local, this.ship.local), this.target.body, this.ship.body, true);
  }

  /** Re-anchors the target end (e.g. the hook bit into something). Old target body must still exist. */
  setTarget(end: RopeEnd): void {
    const w = this.physics.world;
    if (this.targetJoint) w.removeImpulseJoint(this.targetJoint, true);
    if (this.capJoint) w.removeImpulseJoint(this.capJoint, true);
    this.capJoint = null;
    this.target = end;
    this.attachTargetJoint();
    this.rebuildCap();
  }

  /** Moves the ship-side anchor (e.g. pivot mode changed). */
  setShipAnchor(local: P): void {
    this.ship = { body: this.ship.body, local };
    this.rebuildShipJoint();
    this.rebuildCap();
  }

  setLength(len: number): void {
    if (Math.abs(len - this.length) < 1e-4) return;
    this.length = len;
    const w = this.physics.world;
    const needed = this.segmentsFor(len);
    let changed = false;
    while (this.segs.length > needed) {
      // reel in: drop the ship-end segment (its joints go with it)
      const s = this.segs.pop()!;
      this.links.pop();
      this.shipJoint = null; // removed with the body
      this.physics.removeBody(s);
      changed = true;
    }
    while (this.segs.length < needed) {
      // pay out: new segment at the ship anchor
      const p = this.endWorld(this.ship);
      const last = this.segs[this.segs.length - 1];
      if (this.shipJoint) {
        w.removeImpulseJoint(this.shipJoint, true);
        this.shipJoint = null;
      }
      const s = this.makeSegment(p.x, p.y, this.ship.body);
      this.links.push(this.link(last, s));
      this.segs.push(s);
      changed = true;
    }
    if (changed || Math.abs(this.shipLinkLength() - this.shipJointLen) > 0.01) this.rebuildShipJoint();
    if (Math.abs(this.length * this.stretchMax - this.capLen) > 0.05) this.rebuildCap();
  }

  /** World points along the rope: target anchor, segments…, ship anchor. */
  points(out: P[]): number {
    let n = 0;
    const slot = () => (out[n] ??= { x: 0, y: 0 });
    this.endWorld(this.target, slot());
    n++;
    for (const s of this.segs) {
      const t = s.translation();
      const p = slot();
      p.x = t.x;
      p.y = t.y;
      n++;
    }
    this.endWorld(this.ship, slot());
    n++;
    return n;
  }

  pathLength(): number {
    const n = this.points(this.pts);
    let d = 0;
    for (let i = 1; i < n; i++) d += Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y);
    return d;
  }

  /**
   * Elastic extension = path length − rest length (≥ 0). This is the signed sum of link
   * stretch, so bunched links offset stretched ones and a slack cord carries no tension.
   * (A per-link "only count stretched links" measure was tried and rejected: the ship-end
   * link's rest bookkeeping doesn't always match geometry, and it read as stretched while
   * the cord was 15% slack.) Also refreshes this.pts for the caller.
   */
  extension(): number {
    return Math.max(0, this.pathLength() - this.length);
  }

  /** Path length / rest length (≥ 1 means taut, >1 stretched). */
  tautness(): number {
    return this.pathLength() / this.length;
  }

  /** Straight anchor-to-anchor distance / rest length. */
  endRatio(): number {
    const a = this.endWorld(this.target);
    const b = this.endWorld(this.ship);
    return Math.hypot(a.x - b.x, a.y - b.y) / this.length;
  }

  /** Separation speed of each end from its neighbor along the rope (damping input). */
  private endSeparationSpeed(pts: P[], n: number): number {
    const sep = (body: Body, p: P, nb: Body | null, q: P) => {
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-5) return 0;
      const v = body.velocityAtPoint(p);
      const w = nb ? nb.linvel() : { x: 0, y: 0 };
      return ((v.x - w.x) * dx + (v.y - w.y) * dy) / d;
    };
    const last = this.segs[this.segs.length - 1];
    return sep(this.ship.body, pts[n - 1], last, pts[n - 2]) + sep(this.target.body, pts[0], this.segs[0], pts[1]);
  }

  /** Applies the stretch spring for one physics step. Call before the world steps. */
  /**
   * Internal damping: pulls each segment's velocity toward the average of its neighbors'.
   * Kills transverse string vibration (the "noisy" wobble) without damping the rope's bulk
   * motion, which plain linear damping would drag on.
   */
  private dampInternal(dt: number): void {
    const k = Math.min(1, tune.grapple.internalDamping * dt);
    if (k <= 0) return;
    const vel = (b: Body, p: P) => b.velocityAtPoint(p);
    const n = this.segs.length + 2;
    const v: P[] = [];
    v.push(vel(this.target.body, this.pts[0]));
    for (const s of this.segs) v.push(s.linvel());
    v.push(vel(this.ship.body, this.pts[n - 1]));
    for (let i = 0; i < this.segs.length; i++) {
      const a = v[i];
      const c = v[i + 2];
      const me = v[i + 1];
      this.segs[i].setLinvel({ x: me.x + ((a.x + c.x) * 0.5 - me.x) * k, y: me.y + ((a.y + c.y) * 0.5 - me.y) * k }, true);
    }
    // taut: also pull motion toward the rigid line between the ends (kills the swinging bow)
    const kc = Math.min(1, this.chordDamping * dt);
    if (kc <= 0) return;
    const va = v[0];
    const vb = v[n - 1];
    for (let i = 0; i < this.segs.length; i++) {
      const t = (i + 1) / (n - 1);
      const me = this.segs[i].linvel();
      const rx = va.x + (vb.x - va.x) * t;
      const ry = va.y + (vb.y - va.y) * t;
      // only the component across the chord, so take-up along the rope isn't resisted
      const ex = this.pts[n - 1].x - this.pts[0].x;
      const ey = this.pts[n - 1].y - this.pts[0].y;
      const el = Math.hypot(ex, ey) || 1;
      const nx = -ey / el;
      const ny = ex / el;
      const across = ((me.x - rx) * nx + (me.y - ry) * ny) * kc;
      // plus a position nudge back toward the chord, scaled the same way
      const p = this.pts[i + 1];
      const off = ((p.x - this.pts[0].x) * nx + (p.y - this.pts[0].y) * ny) * kc;
      this.segs[i].setLinvel({ x: me.x - nx * (across + off / Math.max(dt, 1e-3) * 0.1), y: me.y - ny * (across + off / Math.max(dt, 1e-3) * 0.1) }, true);
    }
  }

  applyTension(dt = FIXED_DT): void {
    const stretch = this.extension(); // also refreshes this.pts
    this.dampInternal(dt);
    const pts = this.pts;
    const n = this.segs.length + 2;
    if (stretch <= 0) {
      this.tension = 0;
      return;
    }
    // damping from how fast the ends separate along the rope (not dE/dt, which jumps
    // whenever the winch shortens a link and would yank)
    const rate = this.endSeparationSpeed(pts, n);
    const g = tune.grapple;
    const mShip = this.ship.body.mass();
    const tb = this.target.body;
    const invT = tb.isDynamic() ? 1 / Math.max(1e-3, tb.mass()) : 0;
    const mRed = 1 / (1 / mShip + invT);
    // explicit spring stability: keep ω·dt ≤ 0.5
    const k = Math.min(g.stiffness / this.length, (0.25 / (dt * dt)) * mRed);
    const c = 2 * g.damping * Math.sqrt(k * mRed);
    const T = Math.max(0, k * stretch + c * rate);
    this.tension = T;
    if (T === 0) return;

    const pull = (body: Body, from: P, to: P, mag: number) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-5) return;
      body.applyImpulseAtPoint({ x: (dx / d) * mag * dt, y: (dy / d) * mag * dt }, from, true);
    };
    // ends: along the rope at each end
    pull(this.ship.body, pts[n - 1], pts[n - 2], T);
    if (tb.isDynamic()) pull(tb, pts[0], pts[1], T);
    // segments: string tension toward both neighbors, capped so light segments stay stable
    const segCap = (0.25 / (dt * dt)) * g.segmentMass * this.segLen * 0.5;
    const Ts = Math.min(T, segCap);
    for (let i = 0; i < this.segs.length; i++) {
      const p = pts[i + 1];
      const s = this.segs[i];
      pull(s, p, pts[i], Ts);
      pull(s, p, pts[i + 2], Ts);
    }
  }

  /** Removes the rope from the world. Call before the target body is removed. */
  destroy(): void {
    const w = this.physics.world;
    if (this.capJoint) w.removeImpulseJoint(this.capJoint, true);
    if (this.targetJoint) w.removeImpulseJoint(this.targetJoint, true);
    this.capJoint = this.targetJoint = this.shipJoint = null;
    // removing segment bodies also removes the links and the ship-end joint
    for (const s of this.segs) this.physics.removeBody(s);
    this.segs.length = 0;
    this.links.length = 0;
  }
}
