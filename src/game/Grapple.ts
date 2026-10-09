// Grapple tool: hitscan hook that bites into terrain or a pixel body, then hangs a physical
// Rope (segmented, collides, wraps corners) between the hook and the ship. Swinging, towing
// and flinging fall out of the solver. The hook lets go if the pixel it bit into is
// destroyed or its body goes away.
//
// The ship-side anchor is configurable (tune.grapple.pivot, P to toggle): at the center of
// mass the tether never torques the ship, so aiming stays independent of the load; at the
// nose, tension swings the ship's heading toward the load.
//
// Likely growth: hook travel time, multiple tethers, cutting/snapping the rope.

import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { PixelObject } from '../pixel/PixelObject';
import { ORDER } from '../render/order';
import { Ribbon } from '../render/Ribbon';
import { Rope } from './Rope';
import { Ship } from './Ship';
import type { GameContext, Tool } from './types';

const nose = { x: 0, y: 0 };
const tmp = { x: 0, y: 0 };

export class Grapple implements Tool {
  readonly name = 'Grapple';
  private target: PixelObject | null = null;
  private anchorCellX = 0; // local cell coords (fractional) on the target
  private anchorCellY = 0;
  private rope: Rope | null = null;
  private pivotMode = tune.grapple.pivot;
  length = 0;
  private readonly ribbons: Ribbon[] = [];
  private readonly pts: { x: number; y: number }[] = [];
  private readonly miss = new Ribbon(0x6f8fa8, ORDER.fx);
  private missTimer = 0;
  private missX = 0;
  private missY = 0;

  constructor(private readonly ctx: GameContext) {
    ctx.fx.add(this.miss.mesh);
  }

  get attached(): boolean {
    return this.target !== null;
  }

  /** Path length / rest length of the rope (0 when detached). */
  get endRatio(): number {
    return this.rope ? this.rope.endRatio() : 0;
  }

  get tautness(): number {
    return this.rope ? this.rope.tautness() : 0;
  }

  get targetObject(): PixelObject | null {
    return this.target;
  }

  press(): void {
    if (this.target) this.detach();
    else this.fire();
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
    this.pivotMode = tune.grapple.pivot;
    const anchor = this.shipAnchor();
    const sb = ctx.ship.body;
    const a = sb.rotation();
    const t = sb.translation();
    const ax = t.x + Math.cos(a) * anchor.x - Math.sin(a) * anchor.y;
    const ay = t.y + Math.sin(a) * anchor.x + Math.cos(a) * anchor.y;
    this.length = Math.max(tune.grapple.minLength, Math.min(max, Math.hypot(px - ax, py - ay)));
    this.rope = new Rope(
      ctx.physics,
      { body: sb, local: anchor },
      { body: this.targetBody(), local: { x: this.anchorCellX * CELL, y: this.anchorCellY * CELL } },
      this.length,
    );
    for (let k = 0; k < 6; k++) ctx.particles.spark(px, py, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 0.2, 0.08, 0.3);
  }

  private targetBody() {
    const t = this.target!;
    return t.kind === 'terrain' ? this.ctx.pixels.terrain.body : (t as PixelBody).body;
  }

  detach(): void {
    this.rope?.destroy();
    this.rope = null;
    this.target = null;
    for (const r of this.ribbons) r.hide();
  }

  /** Must be called before a pixel body is removed from the physics world. */
  onBodyRemoved(b: PixelBody): void {
    if (this.target === b) this.detach();
  }

  fixedUpdate(dt: number): void {
    const t = this.target;
    if (!t || !this.rope) return;
    const alive = t.kind === 'terrain' || (t as PixelBody).alive;
    if (!alive || !t.grid.solid(Math.floor(this.anchorCellX), Math.floor(this.anchorCellY)) || !this.ctx.ship.alive) {
      this.detach();
      return;
    }
    if (this.pivotMode !== tune.grapple.pivot) {
      this.pivotMode = tune.grapple.pivot;
      this.rope.setShipAnchor(this.shipAnchor());
    }
    const reel = this.ctx.controls.reel;
    if (reel !== 0) {
      const g = tune.grapple;
      this.length = Math.max(g.minLength, Math.min(g.maxLength, this.length + reel * g.reelSpeed * dt));
      this.rope.setLength(this.length);
    }
  }

  frameUpdate(dt: number): void {
    const { ship } = this.ctx;
    if (this.rope) {
      const n = this.rope.points(this.pts);
      const taut = this.rope.tautness() > 0.97;
      const color = taut ? 0xdff4ff : 0x8fb4cc;
      while (this.ribbons.length < n - 1) {
        const r = new Ribbon(color, ORDER.fx);
        this.ctx.fx.add(r.mesh);
        this.ribbons.push(r);
      }
      for (let i = 0; i < this.ribbons.length; i++) {
        if (i < n - 1) {
          const a = this.pts[i];
          const b = this.pts[i + 1];
          // overlap ends slightly so joints don't show gaps
          this.ribbons[i].set(a.x, a.y, b.x, b.y, taut ? 0.08 : 0.06, color, 1);
        } else this.ribbons[i].hide();
      }
    }
    if (this.missTimer > 0) {
      this.missTimer -= dt;
      this.miss.set(ship.x, ship.y, this.missX, this.missY, 0.04, 0x6f8fa8, 0.5);
    } else this.miss.hide();
  }

  status(): string {
    if (!this.rope) return `ready · pivot ${tune.grapple.pivot}`;
    return `${this.length.toFixed(1)} m · pivot ${tune.grapple.pivot}`;
  }

  dispose(): void {
    for (const r of this.ribbons) r.dispose();
    this.miss.dispose();
  }
}
