// Physical tether: a chain of small dynamic segments linked by rope (max-distance) joints,
// running from an anchor on a target body to an anchor on the ship. Segments collide with
// terrain and loose bodies, so the rope wraps around corners and sags with slack.
//
// A hidden straight-line rope joint (length × safetySlack) between the two ends caps
// stretch: light segments between heavy bodies stretch under iterative solvers. The cap
// never binds while the chain is wrapped (the path is longer than the straight line).
//
// Reeling adds/removes segments at the ship end; the ship-end link takes the fractional
// remainder so length changes are continuous.
//
// Likely growth: rope-rope interactions (tying objects together), tension-based snapping,
// cutting the rope with the cutter. Segments are plain bodies, so all of that is local here.

import type RAPIER from '@dimforge/rapier2d-compat';
import { tune } from '../config';
import { ROPE_GROUPS, type Body, type PhysOwner, type Physics } from '../physics/Physics';

export interface RopeEnd {
  body: Body;
  /** Anchor in the body's local frame (meters). */
  local: { x: number; y: number };
}

const SEG_RADIUS = 0.06;
const ROPE_OWNER: PhysOwner = { kind: 'rope' };

export class Rope {
  /** segs[0] is next to the target; the last segment is next to the ship. */
  private readonly segs: Body[] = [];
  private readonly links: RAPIER.ImpulseJoint[] = []; // links[i] joins segs[i] -> segs[i+1]
  private targetJoint: RAPIER.ImpulseJoint | null = null;
  private shipJoint: RAPIER.ImpulseJoint | null = null;
  private safetyJoint: RAPIER.ImpulseJoint | null = null;
  private shipJointLen = 0;
  private safetyLen = 0;
  private readonly segLen: number;
  length: number;

  constructor(
    private readonly physics: Physics,
    private ship: RopeEnd,
    private readonly target: RopeEnd,
    length: number,
  ) {
    this.segLen = tune.grapple.segmentLength;
    this.length = length;
    const a = this.endWorld(target);
    const b = this.endWorld(ship);
    const n = this.segmentsFor(length);
    // lay segments along the straight line from target to ship
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      this.segs.push(this.makeSegment(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, this.target.body));
    }
    const w = this.physics.world;
    const R = this.physics.R;
    for (let i = 0; i + 1 < n; i++) this.links.push(w.createImpulseJoint(R.JointData.rope(this.segLen, ZERO, ZERO), this.segs[i], this.segs[i + 1], true));
    this.targetJoint = w.createImpulseJoint(R.JointData.rope(this.segLen * 0.5, target.local, ZERO), target.body, this.segs[0], true);
    this.rebuildShipJoint();
    this.rebuildSafety();
  }

  private endWorld(e: RopeEnd): { x: number; y: number } {
    const t = e.body.translation();
    const a = e.body.rotation();
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { x: t.x + c * e.local.x - s * e.local.y, y: t.y + s * e.local.x + c * e.local.y };
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

  /** Length = half-segment target link + (n-1) full links + ship link in (0, segLen]. */
  private segmentsFor(len: number): number {
    return Math.max(1, Math.ceil((len - this.segLen * 0.5) / this.segLen));
  }

  /** Remainder of the length carried by the ship-end link, in (0, segLen]. */
  private shipLinkLength(): number {
    const rest = this.length - this.segLen * 0.5 - (this.segs.length - 1) * this.segLen;
    return Math.max(0.05, rest);
  }

  private rebuildShipJoint(): void {
    const w = this.physics.world;
    if (this.shipJoint) w.removeImpulseJoint(this.shipJoint, true);
    this.shipJointLen = this.shipLinkLength();
    const last = this.segs[this.segs.length - 1];
    this.shipJoint = w.createImpulseJoint(this.physics.R.JointData.rope(this.shipJointLen, ZERO, this.ship.local), last, this.ship.body, true);
  }

  private rebuildSafety(): void {
    const w = this.physics.world;
    if (this.safetyJoint) w.removeImpulseJoint(this.safetyJoint, true);
    this.safetyLen = this.length * tune.grapple.safetySlack;
    this.safetyJoint = w.createImpulseJoint(this.physics.R.JointData.rope(this.safetyLen, this.target.local, this.ship.local), this.target.body, this.ship.body, true);
  }

  /** Moves the ship-side anchor (e.g. pivot mode changed). */
  setShipAnchor(local: { x: number; y: number }): void {
    this.ship = { body: this.ship.body, local };
    this.rebuildShipJoint();
    this.rebuildSafety();
  }

  setLength(len: number): void {
    if (Math.abs(len - this.length) < 1e-4) return;
    this.length = len;
    const w = this.physics.world;
    const R = this.physics.R;
    const needed = this.segmentsFor(len);
    let changed = false;
    while (this.segs.length > needed) {
      // reel in: drop the ship-end segment (its joints go with it)
      const s = this.segs.pop()!;
      this.links.pop();
      if (this.shipJoint) this.shipJoint = null; // removed with the body
      this.physics.removeBody(s);
      changed = true;
    }
    while (this.segs.length < needed) {
      // reel out: new segment at the ship anchor
      const p = this.endWorld(this.ship);
      const last = this.segs[this.segs.length - 1];
      if (this.shipJoint) {
        w.removeImpulseJoint(this.shipJoint, true);
        this.shipJoint = null;
      }
      const s = this.makeSegment(p.x, p.y, this.ship.body);
      this.links.push(w.createImpulseJoint(R.JointData.rope(this.segLen, ZERO, ZERO), last, s, true));
      this.segs.push(s);
      changed = true;
    }
    if (changed || Math.abs(this.shipLinkLength() - this.shipJointLen) > 0.01) this.rebuildShipJoint();
    if (Math.abs(this.length * tune.grapple.safetySlack - this.safetyLen) > 0.05) this.rebuildSafety();
  }

  /** World points along the rope: target anchor, segments…, ship anchor. */
  points(out: { x: number; y: number }[]): number {
    let n = 0;
    const put = (x: number, y: number) => {
      if (!out[n]) out[n] = { x: 0, y: 0 };
      out[n].x = x;
      out[n].y = y;
      n++;
    };
    const a = this.endWorld(this.target);
    put(a.x, a.y);
    for (const s of this.segs) {
      const t = s.translation();
      put(t.x, t.y);
    }
    const b = this.endWorld(this.ship);
    put(b.x, b.y);
    return n;
  }

  /** Straight anchor-to-anchor distance / rest length. */
  endRatio(): number {
    const a = this.endWorld(this.target);
    const b = this.endWorld(this.ship);
    return Math.hypot(a.x - b.x, a.y - b.y) / this.length;
  }

  /** Current path length / rest length (≥ ~1 means taut). */
  tautness(): number {
    const pts: { x: number; y: number }[] = [];
    const n = this.points(pts);
    let d = 0;
    for (let i = 1; i < n; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d / this.length;
  }

  /**
   * Removes the rope from the world. Call before the target body is removed.
   */
  destroy(): void {
    const w = this.physics.world;
    if (this.safetyJoint) w.removeImpulseJoint(this.safetyJoint, true);
    if (this.targetJoint) w.removeImpulseJoint(this.targetJoint, true);
    this.safetyJoint = this.targetJoint = this.shipJoint = null;
    // removing segment bodies also removes the links and the ship-end joint
    for (const s of this.segs) this.physics.removeBody(s);
    this.segs.length = 0;
    this.links.length = 0;
  }
}

const ZERO = { x: 0, y: 0 };
