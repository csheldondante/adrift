// Fitting: press a held piece against a wall and the arms set it there. Once the piece in the
// arms comes within reach of a surface, the hold turns into placement (Arms.guide): the piece
// is turned so its long side lies along the surface and pressed flush against it, and it
// slides along the wall as the ship moves along it (walk the wall to line a patch up over a
// breach). Then the weld beam (Shift + LMB) on the seam fuses it; the arms let go once it's
// part of the wall. Pull away and the arms take the piece back.
//
// Power cores are AutoPlug's business, and the salvage and robots aren't patch material.
//
// Likely growth: fitting pieces to other loose bodies (patching a hull you're towing), a
// "lock in place" toggle so it stays fitted while you fly round to the other side.

import { CELL, tune } from '../config';
import type { PixelBody } from '../pixel/PixelBody';
import type { Arms } from './Arms';
import { hasPower } from './systems/PowerNet';
import type { GameContext } from './types';

const ENGAGE = 0.7; // m between the piece's face and the wall at which the arms take over
const LEAVE = 2.2; // m: pulled this far off, the arms take it back
const ASPECT = 2.5; // long side / short side for a piece to count as a plate

export class Fitter {
  /** The piece is being held flush to a wall. */
  fitting = false;
  /** Gap from the piece's face to the wall last step, -1 for none (tests). */
  gap = -1;
  private body: PixelBody | null = null;
  /** Wall frame: a point on the surface, its outward normal, and the piece's offset along it from the ship. */
  private px = 0;
  private py = 0;
  private nx = 0;
  private ny = 1;
  private along = 0;
  private angle = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly arms: Arms,
  ) {}

  /** Arms-held piece that can be fitted, or null. */
  private piece(): PixelBody | null {
    const b = this.arms.held;
    if (!b || !b.alive || b.tags.salvage || b.tags.label || hasPower(b)) return null;
    // plates and slabs, not crates
    return Math.max(b.grid.w, b.grid.h) >= ASPECT * Math.min(b.grid.w, b.grid.h) ? b : null;
  }

  /**
   * The wall one of the piece's broad faces is up against: rays out of that face from points
   * along it (so a hole right in front, the breach itself, doesn't hide the wall around it).
   * Returns a point on the wall line, its normal (toward the piece) and the narrowest gap.
   */
  private wallBeside(b: PixelBody, range: number): { x: number; y: number; nx: number; ny: number; gap: number } | null {
    const px = this.ctx.pixels;
    const c = b.body.worldCom();
    const a = b.body.rotation() + (b.grid.w >= b.grid.h ? 0 : Math.PI / 2);
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    const long = Math.max(b.grid.w, b.grid.h) * CELL;
    const thick = (Math.min(b.grid.w, b.grid.h) * CELL) / 2;
    let best: { x: number; y: number; nx: number; ny: number; gap: number } | null = null;
    let bestN = 1;
    for (const side of [1, -1]) {
      const dx = -ay * side;
      const dy = ax * side;
      const hits: { x: number; y: number; d: number }[] = [];
      for (const f of [-0.45, -0.25, 0, 0.25, 0.45]) {
        const ox = c.x + ax * long * f;
        const oy = c.y + ay * long * f;
        const hit = px.raycast(ox, oy, dx, dy, thick + range, b);
        if (hit && hit.target.kind === 'terrain') hits.push({ x: hit.x, y: hit.y, d: hit.dist });
      }
      if (hits.length <= bestN) continue;
      // the wall's line through the outermost hits; normal back toward the piece
      const h0 = hits[0];
      const h1 = hits[hits.length - 1];
      let tx = h1.x - h0.x;
      let ty = h1.y - h0.y;
      const tl = Math.hypot(tx, ty);
      if (tl < 0.3) continue;
      tx /= tl;
      ty /= tl;
      let nx = -ty;
      let ny = tx;
      if (nx * dx + ny * dy > 0) [nx, ny] = [-nx, -ny];
      bestN = hits.length;
      const mx = hits.reduce((s2, h) => s2 + h.x, 0) / hits.length;
      const my = hits.reduce((s2, h) => s2 + h.y, 0) / hits.length;
      // gap from the piece's nearest corner to the wall line (it may be held at a slant)
      const sinT = Math.abs(ax * nx + ay * ny);
      const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
      const reach = thick * cosT + (long / 2) * sinT;
      best = { x: mx, y: my, nx, ny, gap: (c.x - mx) * nx + (c.y - my) * ny - reach };
    }
    return best;
  }

  /** Returns true while fitting (the arms are placing the piece). */
  fixedUpdate(): boolean {
    const b = this.piece();
    const sh = this.ctx.ship;
    this.gap = -2;
    if (!b || !sh.alive) return this.stop();
    const c = b.body.worldCom();
    const thick = (Math.min(b.grid.w, b.grid.h) * CELL) / 2;
    const long = Math.max(b.grid.w, b.grid.h) * CELL;
    if (!this.fitting) {
      // a broad face within reach of a wall
      const w = this.wallBeside(b, ENGAGE + 2);
      this.gap = w ? w.gap : -1;
      if (!w || w.gap > ENGAGE) return false;
      this.fitting = true;
      this.body = b;
      this.px = w.x;
      this.py = w.y;
      this.nx = w.nx;
      this.ny = w.ny;
      // keep the piece where it is along the wall, relative to the ship
      const tx = -w.ny;
      const ty = w.nx;
      this.along = (c.x - sh.x) * tx + (c.y - sh.y) * ty;
      // long side along the wall: of the two ways round, the nearer one
      const longAxis = b.body.rotation() + (b.grid.w >= b.grid.h ? 0 : Math.PI / 2);
      const wallA = Math.atan2(ty, tx);
      const diff = Math.atan2(Math.sin(wallA - longAxis), Math.cos(wallA - longAxis));
      const turn = Math.abs(diff) > Math.PI / 2 ? diff - Math.sign(diff) * Math.PI : diff;
      this.angle = b.body.rotation() + turn;
      this.ctx.sound.emit('clamp', c.x, c.y, 0.6);
    } else {
      if (b !== this.body) return this.stop();
      // pulled away: hand it back to the rigid hold
      const off = (c.x - this.px) * this.nx + (c.y - this.py) * this.ny - thick;
      if (off > LEAVE || Math.hypot(c.x - sh.x, c.y - sh.y) > tune.arms.upper + tune.arms.fore + long / 2 + 1.5) return this.stop();
    }
    // the target: flush on the wall (a hair into it, so it's pressed), at the ship's position
    // along the wall plus where it was when fitted
    const tx = -this.ny;
    const ty = this.nx;
    const s = (sh.x - this.px) * tx + (sh.y - this.py) * ty + this.along;
    const press = thick - 0.04;
    this.arms.guide({ x: this.px + tx * s + this.nx * press, y: this.py + ty * s + this.ny * press, angle: this.angle });
    return true;
  }

  private stop(): boolean {
    if (this.fitting) {
      this.fitting = false;
      if (this.body && this.arms.held === this.body) this.arms.guide(null);
      this.body = null;
    }
    return false;
  }
}
