// Grapple tool: a harpoon. The head is fired at high speed as a swept projectile with a thin
// cord trailing straight behind it (no rope physics in flight). When it thunks into matter it
// sticks: its momentum is delivered to the target, a physical Rope is spawned along a slack
// bow between ship and head, and a fast winch snaps the slack taut. From then on the rope is
// real physics (wraps corners, stretches a little, tows, whips things around).
//
// States: idle → flying → (thunk) → attached [tightening → snug] → idle
//                       ↘ (out of range) → retracting → idle
// Right mouse: fire (idle) / release (attached). Q/E reel in/out.
//
// Rendering: a taut rope with a clear line of sight between its ends is drawn as a straight
// line (physics segments always wobble a bit); slack or wrapped rope is drawn through the
// smoothed segment positions.
//
// The ship-side anchor is configurable (tune.grapple.pivot, P to toggle): at the center of
// mass the tether never torques the ship; at the nose, tension swings the ship's heading.
//
// Likely growth: different heads (magnetic, barbed), tying two objects together, rope cutting.

import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import { Rope } from './Rope';
import { Ship } from './Ship';
import type { GameContext, Tool } from './types';

type State = 'idle' | 'flying' | 'attached' | 'retracting';
type P = { x: number; y: number };

const nose = { x: 0, y: 0 };
const tmp = { x: 0, y: 0 };

/**
 * Points along a slack bow (parabola) from a to b whose arc length ≈ `len`, spaced evenly,
 * excluding the endpoints. `side` (±1) picks which way it bows.
 */
function bowLayout(a: P, b: P, len: number, n: number, side: number): P[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.max(1e-3, Math.hypot(dx, dy));
  // parabola arc length ≈ d + 8h²/(3d)  →  h for the requested slack
  const h = side * Math.sqrt(Math.max(0, (3 * d * (len - d)) / 8));
  const nx = -dy / d;
  const ny = dx / d;
  const pts: P[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const off = 4 * h * t * (1 - t);
    pts.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
  }
  return pts;
}

/** One pass of Chaikin corner cutting (keeps endpoints). */
function chaikin(src: P[], n: number, out: P[]): number {
  let k = 0;
  const put = (x: number, y: number) => {
    const p = (out[k] ??= { x: 0, y: 0 });
    p.x = x;
    p.y = y;
    k++;
  };
  put(src[0].x, src[0].y);
  for (let i = 0; i + 1 < n; i++) {
    const a = src[i];
    const b = src[i + 1];
    put(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25);
    put(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75);
  }
  put(src[n - 1].x, src[n - 1].y);
  return k;
}

export class Grapple implements Tool {
  readonly name = 'Grapple';
  state: State = 'idle';
  private target: PixelObject | null = null;
  private anchorCellX = 0; // local cell coords (fractional) on the target
  private anchorCellY = 0;
  private rope: Rope | null = null;
  // harpoon head in flight / returning (pure kinematics, no physics body)
  private hx = 0;
  private hy = 0;
  private hvx = 0;
  private hvy = 0;
  private flown = 0;
  private tightening = false;
  private tensionAvg = 0;
  private reelHold = 0;
  private pivotMode = tune.grapple.pivot;
  private readonly ribbons: Ribbon[] = [];
  private readonly claw = [new Ribbon(0xe8f4ff, ORDER.fx + 1), new Ribbon(0xe8f4ff, ORDER.fx + 1)];
  private readonly pts: P[] = [];
  private readonly smoothA: P[] = [];
  private readonly smoothB: P[] = [];

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.claw[0].mesh, this.claw[1].mesh);
  }

  get attached(): boolean {
    return this.state === 'attached';
  }
  /** Attached and the winch has finished taking up slack. */
  get snug(): boolean {
    return this.state === 'attached' && !this.tightening;
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
  /** Max distance of physical rope points from the straight line between its ends (m). */
  get maxDeviation(): number {
    if (!this.rope) return 0;
    const n = this.rope.points(this.pts);
    const a = this.pts[0];
    const b = this.pts[n - 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let m = 0;
    for (let i = 1; i < n - 1; i++) m = Math.max(m, Math.abs(((this.pts[i].x - a.x) * (b.y - a.y) - (this.pts[i].y - a.y) * (b.x - a.x)) / d));
    return m;
  }

  press(): void {
    if (this.state === 'idle') this.fire();
    else if (this.state === 'attached') this.detach();
  }

  release(): void {}

  private shipAnchor(): P {
    if (tune.grapple.pivot === 'nose') return { ...Ship.NOSE };
    const c = this.ctx.ship.body.localCom();
    return { x: c.x, y: c.y };
  }

  private shipAnchorWorld(out: P): P {
    const b = this.ctx.ship.body;
    const t = b.translation();
    const a = b.rotation();
    const l = this.shipAnchor();
    out.x = t.x + Math.cos(a) * l.x - Math.sin(a) * l.y;
    out.y = t.y + Math.sin(a) * l.x + Math.cos(a) * l.y;
    return out;
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
    const sv = ctx.ship.body.linvel();
    this.hx = nose.x;
    this.hy = nose.y;
    this.hvx = sv.x + dx * g.hookSpeed;
    this.hvy = sv.y + dy * g.hookSpeed;
    this.flown = 0;
    ctx.ship.body.applyImpulse({ x: -dx * g.recoil, y: -dy * g.recoil }, true);
    for (let k = 0; k < 6; k++) ctx.particles.glint(nose.x, nose.y, sv.x + dx * 4 + (Math.random() - 0.5) * 3, sv.y + dy * 4 + (Math.random() - 0.5) * 3, 0.8, 0.9, 1, 0.12, 0.08);
    this.state = 'flying';
  }

  /** Nearest solid cell center to (lx, ly) on `obj` within `r` cells. */
  private nearestSolid(obj: PixelObject, lx: number, ly: number, r: number): P | null {
    let best: P | null = null;
    let bd = Infinity;
    for (let y = Math.floor(ly - r); y <= Math.floor(ly + r); y++)
      for (let x = Math.floor(lx - r); x <= Math.floor(lx + r); x++) {
        if (!obj.grid.solid(x, y)) continue;
        const d = (x + 0.5 - lx) ** 2 + (y + 0.5 - ly) ** 2;
        if (d < bd && d <= r * r) [bd, best] = [d, { x: x + 0.5, y: y + 0.5 }];
      }
    return best;
  }

  /** Swept harpoon flight: thunk into the first matter along the step, or give up at range. */
  private flyStep(dt: number): void {
    const sp = Math.hypot(this.hvx, this.hvy);
    const dx = this.hvx / sp;
    const dy = this.hvy / sp;
    const step = sp * dt;
    const hit = this.ctx.pixels.raycast(this.hx, this.hy, dx, dy, step);
    if (hit && this.thunk(hit.target, hit.x, hit.y, dx, dy)) return;
    this.hx += dx * step;
    this.hy += dy * step;
    this.flown += step;
    if (this.flown >= tune.grapple.maxLength) this.state = 'retracting';
  }

  private thunk(target: PixelObject, px: number, py: number, dx: number, dy: number): boolean {
    const { ctx } = this;
    const g = tune.grapple;
    target.worldToLocal(px + dx * CELL, py + dy * CELL, tmp);
    const cell = this.nearestSolid(target, tmp.x, tmp.y, 2.5);
    if (!cell) return false;
    this.target = target;
    this.anchorCellX = cell.x;
    this.anchorCellY = cell.y;
    const isBody = target.kind === 'pixelBody';
    const body = isBody ? (target as PixelBody).body : ctx.pixels.terrain.body;
    // the head's momentum goes into what it hit
    if (isBody) {
      const sv = ctx.ship.body.linvel();
      const rel = Math.hypot(this.hvx - sv.x, this.hvy - sv.y);
      body.applyImpulseAtPoint({ x: dx * g.hookMass * rel, y: dy * g.hookMass * rel }, { x: px, y: py }, true);
    }
    // rope spawns with a slack bow, then the winch snaps it taut
    const a = target.localToWorld(cell.x, cell.y, { x: 0, y: 0 });
    const b = this.shipAnchorWorld({ x: 0, y: 0 });
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const len = Math.max(g.minLength, Math.min(g.maxLength, dist * g.biteSlack));
    const side = Math.random() < 0.5 ? -1 : 1;
    const layout = bowLayout(a, b, len, Rope.segmentsFor(len), side);
    this.pivotMode = g.pivot;
    this.rope = new Rope(ctx.physics, { body: ctx.ship.body, local: this.shipAnchor() }, { body, local: { x: cell.x * CELL, y: cell.y * CELL } }, len, layout);
    this.state = 'attached';
    this.tightening = true;
    this.tensionAvg = 0;
    // thunk FX
    for (let k = 0; k < 10; k++) {
      const s = 2 + Math.random() * 6;
      const t = (Math.random() - 0.5) * 2.4;
      ctx.particles.spark(px, py, (-dx * Math.cos(t) + dy * Math.sin(t)) * s, (-dy * Math.cos(t) - dx * Math.sin(t)) * s, 0.25, 0.08, 0.4);
    }
    const d = Math.hypot(px - ctx.ship.x, py - ctx.ship.y);
    ctx.stage.shake(0.12 * Math.max(0, 1 - d / 40));
    return true;
  }

  detach(): void {
    this.rope?.destroy();
    this.rope = null;
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
    if (!this.ctx.ship.alive) {
      if (this.state !== 'idle') this.detach();
      return;
    }
    if (this.state === 'flying') this.flyStep(dt);
    if (this.state === 'retracting') {
      // head zips back along the cord
      const b = this.shipAnchorWorld(tmp);
      const dx = b.x - this.hx;
      const dy = b.y - this.hy;
      const d = Math.hypot(dx, dy);
      const step = tune.grapple.retractSpeed * dt;
      if (d <= step) {
        this.detach();
        return;
      }
      this.hx += (dx / d) * step;
      this.hy += (dy / d) * step;
    }
    const rope = this.rope;
    if (!rope) return;
    if (this.pivotMode !== tune.grapple.pivot) {
      this.pivotMode = tune.grapple.pivot;
      rope.setShipAnchor(this.shipAnchor());
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
    const reel = this.ctx.controls.reel;
    if (reel !== 0) {
      // manual reel overrides the winch (E pays out slack on purpose)
      rope.chordDamping = 0;
      this.tightening = false;
      this.reelHold = 0.4;
      rope.setLength(Math.max(g.minLength, Math.min(g.maxLength, rope.length + reel * g.reelSpeed * dt)));
      return true;
    }
    this.reelHold = Math.max(0, this.reelHold - dt);
    if (!this.tightening && (!g.autoTakeUp || this.reelHold > 0)) return true;
    // Winch: fast right after impact (tightening), then a gentle take-up that keeps the rope
    // straight as the ship drifts toward the anchor. With a clear line between the ends,
    // "straight" is geometric (end distance ≈ length); a swinging slack bow spikes tension
    // mid-swing, so tension alone isn't trusted. When wrapped round a corner, sustained
    // tension is the only signal. Never reel past the target in one step (no jerks).
    const n = rope.points(this.pts);
    const endDist = Math.hypot(this.pts[0].x - this.pts[n - 1].x, this.pts[0].y - this.pts[n - 1].y);
    const clear = this.clearLine(this.pts[0], this.pts[n - 1]);
    const slack = clear ? rope.length - endDist : rope.length - rope.pathLength();
    this.tensionAvg += (rope.tension - this.tensionAvg) * Math.min(1, dt / 0.15);
    const straight = !clear || endDist >= rope.length * 0.985;
    rope.chordDamping = clear && endDist >= rope.length * 0.95 ? g.chordDamping : 0;
    if (this.tightening && ((straight && this.tensionAvg > g.snugTension) || rope.length <= g.minLength)) this.tightening = false;
    const speed = this.tightening ? g.tightenSpeed : g.takeUpSpeed;
    if (rope.length > g.minLength && (this.tightening || (slack > rope.length * 0.01 && rope.tension < g.snugTension))) {
      const step = slack > 0 ? Math.min(speed * dt, Math.max(0.005, slack * 0.35)) : this.tightening ? 0.01 : 0;
      if (step > 0) rope.setLength(Math.max(g.minLength, rope.length - step));
    }
    return true;
  }

  /** True if nothing solid blocks the straight line between the rope's ends. */
  private clearLine(a: P, b: P): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.6) return true;
    const ignore = this.target?.kind === 'pixelBody' ? (this.target as PixelBody) : undefined;
    // start/stop short of both ends so the anchor surface itself doesn't count
    const hit = this.ctx.pixels.raycast(b.x, b.y, -dx / d, -dy / d, d - 0.4, ignore);
    return !hit;
  }

  private drawPolyline(pts: P[], n: number, width: number, color: number): void {
    while (this.ribbons.length < n - 1) {
      const r = new Ribbon(color, ORDER.fx);
      this.ctx.fx.add(r.mesh);
      this.ribbons.push(r);
    }
    for (let i = 0; i < this.ribbons.length; i++) {
      if (i < n - 1) this.ribbons[i].set(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, width, color, 1);
      else this.ribbons[i].hide();
    }
  }

  private drawClaw(a: P, dirX: number, dirY: number, open: boolean): void {
    const ang = Math.atan2(dirY, dirX);
    const spread = open ? 0.9 : 0.45;
    for (let k = 0; k < 2; k++) {
      const t = ang + Math.PI + (k ? spread : -spread);
      this.claw[k].set(a.x, a.y, a.x + Math.cos(t) * 0.35, a.y + Math.sin(t) * 0.35, 0.07);
    }
  }

  frameUpdate(): void {
    const b = this.shipAnchorWorld({ x: 0, y: 0 });
    if (this.state === 'flying' || this.state === 'retracting') {
      // thin straight cord trailing the head
      this.pts[0] = { x: this.hx, y: this.hy };
      this.pts[1] = b;
      this.drawPolyline(this.pts, 2, 0.045, 0x9fbfd6);
      const sp = Math.hypot(this.hvx, this.hvy) || 1;
      this.drawClaw({ x: this.hx, y: this.hy }, this.hvx / sp, this.hvy / sp, false);
      return;
    }
    const rope = this.rope;
    if (!rope) return;
    let n = rope.points(this.pts);
    const a = this.pts[0];
    const end = this.pts[n - 1];
    const taut = rope.tension > 0 || this.snug;
    const strain = rope.tension > 0 ? Math.min(1, rope.extension() / rope.length / tune.grapple.maxStretch) : 0;
    const color = !taut ? 0x8fb0c6 : strain > 0.6 ? 0xffc890 : 0xe4f4ff;
    const width = taut ? 0.075 + strain * 0.03 : 0.055;
    if (this.snug && rope.tension >= 0 && this.clearLine(a, end)) {
      // snug with clear line of sight: a clean straight line (the impact snap stays visible)
      this.pts[1] = end;
      n = 2;
      this.drawPolyline(this.pts, n, width, color);
    } else {
      // slack or wrapped: smooth curve through the segments
      let m = chaikin(this.pts, n, this.smoothA);
      m = chaikin(this.smoothA, m, this.smoothB);
      this.drawPolyline(this.smoothB, m, width, color);
    }
    const nx = this.pts[1].x - a.x;
    const ny = this.pts[1].y - a.y;
    this.drawClaw(a, -nx, -ny, true);
  }

  status(): string {
    const pivot = `pivot ${tune.grapple.pivot}`;
    switch (this.state) {
      case 'idle':
        return `ready · ${pivot}`;
      case 'flying':
        return `firing · ${pivot}`;
      case 'retracting':
        return `missed · ${pivot}`;
      default:
        return `${this.length.toFixed(1)} m${this.tension > 0 ? ` · ${(this.tension / 1000).toFixed(1)} kN` : ' · slack'} · ${pivot}`;
    }
  }

  dispose(): void {
    for (const r of this.ribbons) r.dispose();
    for (const c of this.claw) c.dispose();
  }
}
