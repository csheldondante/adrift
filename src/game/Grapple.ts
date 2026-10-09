// Grapple tool. Firing spawns the whole rope coiled in loose loops at the nose, with a weighted
// head on the outer end. The head is launched and flies ballistically, dragging the coil open;
// because the rope is a chain of massive segments, tension propagates link by link, so the
// loops nearest the head straighten first and far coils lag. The head slows as more rope
// comes off the coil and comes to rest at full extension with a damped tug.
//
// The head bites whatever it touches (pixel raycast along its motion each step); a gentle
// auto-winch then takes up slack until the rope is taut and the rope's spring carries load.
// A miss hangs at full extension for a moment, then reels home.
//
// States: idle → flying → (bite) → attached [tightening → taut] → idle
//                       ↘ (stall) → hanging → retracting → idle
// Right mouse: fire (idle) / reel home (flying, hanging) / release (attached).
//
// The ship-side anchor is configurable (tune.grapple.pivot, P to toggle): at the center of
// mass the tether never torques the ship; at the nose, tension swings the ship's heading.
//
// Likely growth: different heads (magnetic, barbed), tying two objects together, rope cutting.

import { CELL, tune } from '../config';
import type { Body } from '../physics/Physics';
import { ROPE_GROUPS } from '../physics/Physics';
import type { PixelBody } from '../pixel/PixelBody';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import { Rope } from './Rope';
import { Ship } from './Ship';
import type { GameContext, Tool } from './types';

type State = 'idle' | 'flying' | 'hanging' | 'attached' | 'retracting';

const nose = { x: 0, y: 0 };
const tmp = { x: 0, y: 0 };
const HOOK_RADIUS = 0.12;

/**
 * Flat Archimedean spiral of `n` points, spaced `spacing` apart along the curve, centered at
 * (cx, cy) and rotated so the outermost point lies in direction (dx, dy). Returned outer
 * (head side) first, to match the Rope's target-first layout.
 */
function coilLayout(n: number, spacing: number, cx: number, cy: number, dx: number, dy: number): { x: number; y: number }[] {
  const r0 = 0.25;
  const pitch = 0.12 / (Math.PI * 2); // radial growth per radian: loops ~12 cm apart
  const local: { x: number; y: number }[] = [];
  let th = 0;
  for (let i = 0; i < n; i++) {
    const r = r0 + pitch * th;
    local.push({ x: Math.cos(th) * r, y: Math.sin(th) * r });
    th += spacing / r;
  }
  const last = local[n - 1];
  const rot = Math.atan2(dy, dx) - Math.atan2(last.y, last.x);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return local.reverse().map((p) => ({ x: cx + c * p.x - s * p.y, y: cy + s * p.x + c * p.y }));
}

export class Grapple implements Tool {
  readonly name = 'Grapple';
  state: State = 'idle';
  private target: PixelObject | null = null;
  private anchorCellX = 0; // local cell coords (fractional) on the target
  private anchorCellY = 0;
  private rope: Rope | null = null;
  private hook: Body | null = null;
  private timer = 0;
  private tightening = false;
  private tensionAvg = 0;
  private pivotMode = tune.grapple.pivot;
  private readonly ribbons: Ribbon[] = [];
  private readonly claw = [new Ribbon(0xe8f4ff, ORDER.fx + 1), new Ribbon(0xe8f4ff, ORDER.fx + 1)];
  private readonly pts: { x: number; y: number }[] = [];

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.claw[0].mesh, this.claw[1].mesh);
  }

  get attached(): boolean {
    return this.state === 'attached';
  }
  get targetObject(): PixelObject | null {
    return this.target;
  }
  get length(): number {
    return this.rope?.length ?? 0;
  }
  get tension(): number {
    return this.rope?.tension ?? 0;
  }
  get tautness(): number {
    return this.rope ? this.rope.tautness() : 0;
  }
  get endRatio(): number {
    return this.rope ? this.rope.endRatio() : 0;
  }
  /** Attached and the auto-winch has finished taking up slack. */
  get snug(): boolean {
    return this.state === 'attached' && !this.tightening;
  }
  /** Head position while flying/hanging/retracting (for tests and FX). */
  get headPosition(): { x: number; y: number } | null {
    return this.hook ? this.hook.translation() : null;
  }

  press(): void {
    if (this.state === 'idle') this.fire();
    else if (this.state === 'flying' || this.state === 'hanging') this.startRetract();
    else if (this.state === 'attached') this.detach();
  }

  release(): void {}

  private shipAnchor(): { x: number; y: number } {
    if (tune.grapple.pivot === 'nose') return { ...Ship.NOSE };
    const c = this.ctx.ship.body.localCom();
    return { x: c.x, y: c.y };
  }

  private fire(): void {
    const { ctx } = this;
    if (!ctx.ship.alive) return;
    const g = tune.grapple;
    ctx.ship.nose(nose);
    let dx = ctx.controls.aimX - nose.x;
    let dy = ctx.controls.aimY - nose.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    dx /= len;
    dy /= len;
    const R = ctx.physics.R;
    const sv = ctx.ship.body.linvel();

    // rope coiled just ahead of the nose; head sits on the outer end, facing the aim
    const n = Rope.segmentsFor(g.maxLength);
    const coil = coilLayout(n, g.segmentLength * 0.9, nose.x + dx * 0.6, nose.y + dy * 0.6, dx, dy);
    const head = { x: coil[0].x + dx * 0.15, y: coil[0].y + dy * 0.15 };
    this.hook = ctx.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(head.x, head.y)
        .setLinvel(sv.x + dx * g.hookSpeed, sv.y + dy * g.hookSpeed)
        .setCcdEnabled(true),
    );
    const area = Math.PI * HOOK_RADIUS * HOOK_RADIUS;
    ctx.physics.createCollider(R.ColliderDesc.ball(HOOK_RADIUS).setDensity(g.hookMass / area).setCollisionGroups(ROPE_GROUPS), this.hook, { kind: 'rope' });
    this.pivotMode = g.pivot;
    this.rope = new Rope(ctx.physics, { body: ctx.ship.body, local: this.shipAnchor() }, { body: this.hook, local: { x: 0, y: 0 } }, g.maxLength, coil);
    this.state = 'flying';
    this.timer = 0;
  }

  private startRetract(): void {
    this.state = 'retracting';
    this.timer = 0;
  }

  /** Finds the nearest solid cell center to (lx, ly) on `obj` within `r` cells. */
  private nearestSolid(obj: PixelObject, lx: number, ly: number, r: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (let y = Math.floor(ly - r); y <= Math.floor(ly + r); y++)
      for (let x = Math.floor(lx - r); x <= Math.floor(lx + r); x++) {
        if (!obj.grid.solid(x, y)) continue;
        const d = (x + 0.5 - lx) ** 2 + (y + 0.5 - ly) ** 2;
        if (d < bd && d <= r * r) [bd, best] = [d, { x: x + 0.5, y: y + 0.5 }];
      }
    return best;
  }

  /** One flight step: bite if the head is about to touch matter; detect stall at full extension. */
  private flyStep(dt: number): void {
    const hook = this.hook!;
    const p = hook.translation();
    const v = hook.linvel();
    const sp = Math.hypot(v.x, v.y);
    if (sp > 1e-3) {
      const hit = this.ctx.pixels.raycast(p.x, p.y, v.x / sp, v.y / sp, sp * dt * 1.5 + HOOK_RADIUS + 0.05);
      if (hit && this.bite(hit.target, hit.x, hit.y)) return;
    }
    // a head pressed against something it isn't moving into still grabs on
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const hit = this.ctx.pixels.raycast(p.x, p.y, Math.cos(a), Math.sin(a), HOOK_RADIUS + 0.06);
      if (hit && this.bite(hit.target, hit.x, hit.y)) return;
    }
    const sv = this.ctx.ship.body.linvel();
    const rel = Math.hypot(v.x - sv.x, v.y - sv.y);
    this.timer += dt;
    // stalled: at full extension, or dragged to a near-stop by the rope short of it
    if (this.timer > 0.3 && ((rel < 1.5 && this.rope!.endRatio() > 0.85) || rel < 1.0)) {
      this.state = 'hanging';
      this.timer = 0;
    }
  }

  private bite(target: PixelObject, px: number, py: number): boolean {
    const { ctx } = this;
    target.worldToLocal(px, py, tmp);
    const cell = this.nearestSolid(target, tmp.x, tmp.y, 2.5);
    if (!cell) return false;
    this.target = target;
    this.anchorCellX = cell.x;
    this.anchorCellY = cell.y;
    const body = target.kind === 'terrain' ? ctx.pixels.terrain.body : (target as PixelBody).body;
    this.rope!.setTarget({ body, local: { x: cell.x * CELL, y: cell.y * CELL } });
    ctx.physics.removeBody(this.hook!);
    this.hook = null;
    this.state = 'attached';
    this.tightening = true;
    this.tensionAvg = 0;
    for (let k = 0; k < 8; k++) ctx.particles.spark(px, py, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, 0.25, 0.08, 0.4);
    return true;
  }

  detach(): void {
    this.rope?.destroy();
    this.rope = null;
    if (this.hook) this.ctx.physics.removeBody(this.hook);
    this.hook = null;
    this.target = null;
    this.state = 'idle';
    this.tightening = false;
    for (const r of this.ribbons) r.hide();
    for (const c of this.claw) c.hide();
  }

  /** Must be called before a pixel body is removed from the physics world. */
  onBodyRemoved(b: PixelBody): void {
    if (this.target === b) this.detach();
  }

  fixedUpdate(dt: number): void {
    const rope = this.rope;
    if (!rope) return;
    if (!this.ctx.ship.alive) {
      this.detach();
      return;
    }
    if (this.pivotMode !== tune.grapple.pivot) {
      this.pivotMode = tune.grapple.pivot;
      rope.setShipAnchor(this.shipAnchor());
    }
    const g = tune.grapple;
    if (this.state === 'flying') this.flyStep(dt);
    if (this.state === 'hanging') {
      this.timer += dt;
      if (this.timer > g.hangTime) this.startRetract();
    }
    if (this.state === 'retracting') {
      this.timer += dt;
      const len = rope.length - g.retractSpeed * dt;
      if (len <= g.minLength || this.timer > 6) {
        this.detach();
        return;
      }
      rope.setLength(len);
    }
    if (this.state === 'attached' && !this.updateAttached(dt)) return;
    rope.applyTension(dt);
  }

  /** Returns false if the grapple let go. */
  private updateAttached(dt: number): boolean {
    const rope = this.rope!;
    const g = tune.grapple;
    const t = this.target!;
    const alive = t.kind === 'terrain' || (t as PixelBody).alive;
    if (!alive) {
      this.detach();
      return false;
    }
    if (!t.grid.solid(Math.floor(this.anchorCellX), Math.floor(this.anchorCellY))) {
      // the pixel it bit was cut away: re-seat on a neighbor if there is one, else let go
      const cell = this.nearestSolid(t, this.anchorCellX, this.anchorCellY, 2);
      if (!cell) {
        this.detach();
        return false;
      }
      this.anchorCellX = cell.x;
      this.anchorCellY = cell.y;
      const body = t.kind === 'terrain' ? this.ctx.pixels.terrain.body : (t as PixelBody).body;
      rope.setTarget({ body, local: { x: cell.x * CELL, y: cell.y * CELL } });
    }
    if (this.tightening) {
      // Gentle winch until the rope is straight (ends a full length apart) or starts to
      // stretch. Never reel past that point in one step, or the hard cap would yank.
      const slack = rope.length - rope.endRatio() * rope.length;
      // stop on straight, or on *sustained* tension (wrapped round a corner / hauling a load);
      // momentary spikes from the head's momentum stretching the front links don't count
      this.tensionAvg += (rope.tension - this.tensionAvg) * Math.min(1, dt / 0.3);
      if (slack <= rope.length * 0.01 || this.tensionAvg > g.snugTension || rope.length <= g.minLength) this.tightening = false;
      else rope.setLength(Math.max(g.minLength, rope.length - Math.min(g.tightenSpeed * dt, slack * 0.5)));
    }
    const reel = this.ctx.controls.reel;
    if (reel !== 0) {
      this.tightening = false;
      rope.setLength(Math.max(g.minLength, Math.min(g.maxLength, rope.length + reel * g.reelSpeed * dt)));
    }
    return true;
  }

  frameUpdate(): void {
    const rope = this.rope;
    if (!rope) return;
    const n = rope.points(this.pts);
    const strain = rope.tension > 0 ? Math.min(1, rope.extension() / rope.length / tune.grapple.maxStretch) : 0;
    const taut = rope.tension > 0;
    // slack: dim blue-grey; taut: bright, warming toward orange near the stretch limit
    const color = !taut ? 0x7f9db3 : strain > 0.6 ? 0xffc890 : 0xe4f4ff;
    const width = taut ? 0.08 + strain * 0.03 : 0.055;
    while (this.ribbons.length < n - 1) {
      const r = new Ribbon(color, ORDER.fx);
      this.ctx.fx.add(r.mesh);
      this.ribbons.push(r);
    }
    for (let i = 0; i < this.ribbons.length; i++) {
      if (i < n - 1) this.ribbons[i].set(this.pts[i].x, this.pts[i].y, this.pts[i + 1].x, this.pts[i + 1].y, width, color, 1);
      else this.ribbons[i].hide();
    }
    // claw on the head, opened along the rope direction (wider once it has bitten)
    const a = this.pts[0];
    const b = this.pts[1];
    const ang = Math.atan2(a.y - b.y, a.x - b.x);
    const spread = this.state === 'attached' ? 0.9 : 0.5;
    for (let k = 0; k < 2; k++) {
      const t = ang + (k ? spread : -spread);
      this.claw[k].set(a.x, a.y, a.x + Math.cos(t) * 0.35, a.y + Math.sin(t) * 0.35, 0.07);
    }
  }

  status(): string {
    const pivot = `pivot ${tune.grapple.pivot}`;
    switch (this.state) {
      case 'idle':
        return `ready · ${pivot}`;
      case 'flying':
        return `uncoiling · ${pivot}`;
      case 'hanging':
        return `missed · ${pivot}`;
      case 'retracting':
        return `reeling home · ${pivot}`;
      default:
        return `${this.length.toFixed(1)} m${this.tension > 0 ? ` · ${(this.tension / 1000).toFixed(1)} kN` : ' · slack'} · ${pivot}`;
    }
  }

  dispose(): void {
    for (const r of this.ribbons) r.dispose();
    for (const c of this.claw) c.dispose();
  }
}
