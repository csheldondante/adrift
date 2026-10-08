// Grapple tether: hitscan hook that attaches to terrain or a pixel body, held by a Rapier rope
// joint (max-distance constraint) so swinging, towing and flinging fall out of the solver.
// Reeling recreates the joint with a new length. The hook lets go if the pixel it bit into
// is destroyed or its body goes away.
//
// Likely growth: visual rope sag/segments, tension-based snapping, multiple tethers
// (e.g. tie two objects together). Keep the joint lifecycle in attach()/detach().

import type RAPIER from '@dimforge/rapier2d-compat';
import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import type { GameContext, Tool } from './types';

const nose = { x: 0, y: 0 };
const tmp = { x: 0, y: 0 };

export class Grapple implements Tool {
  readonly name = 'Grapple';
  private target: PixelObject | null = null;
  private anchorCellX = 0; // local cell coords (fractional) on the target
  private anchorCellY = 0;
  private joint: RAPIER.ImpulseJoint | null = null;
  private jointLength = 0;
  length = 0;
  private readonly rope = new Ribbon(0xbfe8ff, ORDER.fx);
  private missTimer = 0;
  private missX = 0;
  private missY = 0;

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.rope.mesh);
  }

  get attached(): boolean {
    return this.target !== null;
  }

  get targetObject(): PixelObject | null {
    return this.target;
  }

  press(): void {
    if (this.target) this.detach();
    else this.fire();
  }

  release(): void {}

  private fire(): void {
    const { ctx } = this;
    if (!ctx.ship.alive) return;
    ctx.ship.nose(nose);
    let dx = ctx.controls.aimX - nose.x;
    let dy = ctx.controls.aimY - nose.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    dx /= len;
    dy /= len;
    const max = tune.grapple.maxLength;
    const hit = ctx.pixels.raycast(nose.x, nose.y, dx, dy, max);
    if (!hit) {
      this.missTimer = 0.15;
      this.missX = nose.x + dx * max;
      this.missY = nose.y + dy * max;
      return;
    }
    // bite slightly into the surface so the anchor cell is solid
    const px = hit.x + dx * CELL * 0.5;
    const py = hit.y + dy * CELL * 0.5;
    this.target = hit.target;
    hit.target.worldToLocal(px, py, tmp);
    this.anchorCellX = tmp.x;
    this.anchorCellY = tmp.y;
    this.length = Math.max(tune.grapple.minLength, Math.min(max, Math.hypot(px - ctx.ship.x, py - ctx.ship.y)));
    this.createJoint();
    for (let k = 0; k < 6; k++) ctx.particles.spark(px, py, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 0.2, 0.08, 0.3);
  }

  private targetBody(): RAPIER.RigidBody {
    const t = this.target!;
    return t.kind === 'terrain' ? this.ctx.pixels.terrain.body : (t as PixelBody).body;
  }

  private createJoint(): void {
    const { world, R } = this.ctx.physics;
    if (this.joint) world.removeImpulseJoint(this.joint, true);
    const anchor = { x: this.anchorCellX * CELL, y: this.anchorCellY * CELL };
    const params = R.JointData.rope(this.length, { x: 0, y: 0 }, anchor);
    this.joint = world.createImpulseJoint(params, this.ctx.ship.body, this.targetBody(), true);
    this.jointLength = this.length;
  }

  detach(): void {
    if (this.joint) this.ctx.physics.world.removeImpulseJoint(this.joint, true);
    this.joint = null;
    this.target = null;
    this.rope.hide();
  }

  /** Must be called before a pixel body is removed from the physics world. */
  onBodyRemoved(b: PixelBody): void {
    if (this.target === b) this.detach();
  }

  fixedUpdate(dt: number): void {
    const t = this.target;
    if (!t) return;
    const alive = t.kind === 'terrain' || (t as PixelBody).alive;
    if (!alive || !t.grid.solid(Math.floor(this.anchorCellX), Math.floor(this.anchorCellY)) || !this.ctx.ship.alive) {
      this.detach();
      return;
    }
    const reel = this.ctx.controls.reel;
    if (reel !== 0) {
      const g = tune.grapple;
      this.length = Math.max(g.minLength, Math.min(g.maxLength, this.length + reel * g.reelSpeed * dt));
      if (Math.abs(this.length - this.jointLength) > 0.02) this.createJoint();
    }
  }

  anchorWorld(out: { x: number; y: number }): { x: number; y: number } {
    return this.target!.localToWorld(this.anchorCellX, this.anchorCellY, out);
  }

  frameUpdate(dt: number): void {
    const { ship } = this.ctx;
    if (this.target) {
      this.anchorWorld(tmp);
      const dist = Math.hypot(tmp.x - ship.x, tmp.y - ship.y);
      const taut = dist >= this.length - 0.08;
      this.rope.set(ship.x, ship.y, tmp.x, tmp.y, taut ? 0.09 : 0.06, taut ? 0xdff4ff : 0x6f8fa8, taut ? 1 : 0.7);
    } else if (this.missTimer > 0) {
      this.missTimer -= dt;
      this.rope.set(ship.x, ship.y, this.missX, this.missY, 0.04, 0x6f8fa8, 0.5);
    } else {
      this.rope.hide();
    }
  }

  status(): string {
    return this.target ? `${this.length.toFixed(1)} m` : 'ready';
  }

  dispose(): void {
    this.rope.dispose();
  }
}
