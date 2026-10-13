// Auto-plug: carry a live power core (in the arms) up to a dead wall socket and the ship
// does the fiddly part. It's an assist on top of the real systems, not a shortcut past them:
//   fly     no surface underfoot: the thrusters ease the ship toward a stance beside the
//           socket until the hull-walk feet can clamp on to its wall
//   walk    the feet walk along the wall to the stance (beside the socket, so the core
//           reaches it)
//   insert  the arms let go of the rigid hold and place the core (Arms.guide: a force-
//           limited spring-damper): turned so a terminal (a live conductor on its edge)
//           faces the socket, pressed onto the socket's face
//   latch   when the socket goes live its latch grips the core (a fixed joint to the wall)
//           and the arms let go
// Any input of the player's (walking, thrust, push-off, E) takes over, and that socket is
// left alone until the core changes or the ship moves well away from it.
//
// Plugging a core in by hand still works the same way (PowerNet checks the contact); only
// the latch is specific to the assist.
//
// Likely growth: the same placement for other fittings (a patch plate over a breach, a fuse
// into a fuse box).

import type { ImpulseJoint } from '@dimforge/rapier2d-compat';
import { CELL, tune } from '../config';
import { F, MAT_FLAGS } from '../pixel/materials';
import type { PixelBody } from '../pixel/PixelBody';
import type { Arms } from './Arms';
import type { HullWalk } from './HullWalk';
import { hasPower, type PowerNet, type SocketSpot } from './systems/PowerNet';
import type { GameContext } from './types';

type Phase = 'idle' | 'fly' | 'walk' | 'insert';

const ENGAGE = 8; // m from the ship to a dead socket's face to start
const LEAVE = 14; // m: past this a declined socket may be tried again
const TIMEOUT = 15; // s for the whole manoeuvre
const INSERT_TIMEOUT = 6; // s for the placing alone
const FLY_SPEED = 2.5; // m/s cap while flying in
const FLY_ACCEL = 6; // m/s² the thrusters give the approach
const PRESS = 0.6; // cells: the terminal's center this far off the socket face (touching)

interface Terminal {
  /** Mean of the terminal's edge cells (local, cells). */
  x: number;
  y: number;
  /** Outward direction (local). */
  dx: number;
  dy: number;
}

const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

export class AutoPlug {
  phase: Phase = 'idle';
  /** One line for the HUD while working. */
  message = '';
  /** Cores plugged by the assist (tests). */
  plugs = 0;
  private spot: SocketSpot | null = null;
  private body: PixelBody | null = null;
  private t = 0;
  private tInsert = 0;
  private side = 1;
  private readonly declined = new Set<number>();
  private readonly latches = new Map<PixelBody, ImpulseJoint>();

  constructor(
    private readonly ctx: GameContext,
    private readonly arms: Arms,
    private readonly walk: HullWalk,
    private readonly power: PowerNet,
  ) {}

  /** Is this body held by a socket's latch? */
  latched(b: PixelBody): boolean {
    return this.latches.has(b);
  }

  /** Frees a body from its socket latch (grabbed again, or about to be removed). */
  unlatch(b: PixelBody): void {
    const j = this.latches.get(b);
    if (!j) return;
    this.latches.delete(b);
    if (this.ctx.physics.world.getImpulseJoint(j.handle)) this.ctx.physics.world.removeImpulseJoint(j, true);
  }

  /**
   * One physics step. Returns the walking input to use: the player's, or the assist's while
   * it is working. `takeover` is any input of the player's that should cancel it.
   */
  fixedUpdate(dt: number, playerMove: number, takeover: boolean): number {
    const b = this.arms.held;
    const sh = this.ctx.ship;
    if (!b || !b.alive || !sh.alive || !hasPower(b)) {
      this.stop();
      this.body = null;
      return playerMove;
    }
    if (b !== this.body) {
      this.body = b;
      this.declined.clear();
    }
    // forget declined sockets once well away from them
    for (const s of this.power.socketSpots()) if (this.declined.has(s.i) && Math.hypot(s.fx - sh.x, s.fy - sh.y) > LEAVE) this.declined.delete(s.i);
    if (this.phase !== 'idle' && (takeover || playerMove !== 0)) {
      this.decline();
      return playerMove;
    }
    if (this.phase === 'idle') {
      this.spot = this.pick();
      if (!this.spot) return playerMove;
      this.phase = this.walk.attached ? 'walk' : 'fly';
      this.t = 0;
      const s = this.spot;
      this.side = Math.sign((sh.x - s.fx) * -s.ny + (sh.y - s.fy) * s.nx) || 1;
    }
    const s = this.spot!;
    this.t += dt;
    if (s.live || this.t > TIMEOUT) {
      this.decline();
      return playerMove;
    }
    const term = this.terminal(b, s);
    if (!term) {
      this.decline();
      return playerMove;
    }
    // fly in with the core on the far side from the wall, so it doesn't wedge between the ship
    // and the wall (walking turns the nose, and the core, out from the wall anyway). Until the
    // ship has turned that way round, it hangs back far enough for the core to swing clear
    let turned = true;
    if (this.phase === 'fly') {
      const c = b.body.worldCom();
      const phi = Math.atan2(c.y - sh.y, c.x - sh.x) - sh.angle;
      const want = Math.atan2(s.ny, s.nx) - phi;
      turned = Math.abs(Math.atan2(Math.sin(want - sh.angle), Math.cos(want - sh.angle))) < 0.5;
      this.ctx.controls.aimX = sh.x + Math.cos(want) * 20;
      this.ctx.controls.aimY = sh.y + Math.sin(want) * 20;
    } else {
      // face the socket (lamp and tools on it)
      this.ctx.controls.aimX = s.fx;
      this.ctx.controls.aimY = s.fy;
    }
    // stance: beside the socket on its wall, clear of where the core goes
    const across = Math.abs(term.dx) > 0.5 ? b.grid.h : b.grid.w;
    const off = (across * CELL) / 2 + 1.4;
    const tx = -s.ny * this.side;
    const ty = s.nx * this.side;
    const out = turned ? tune.walk.standoff : Math.max(b.grid.w, b.grid.h) * CELL + 3;
    const stX = s.fx + s.nx * out + tx * off;
    const stY = s.fy + s.ny * out + ty * off;

    if (this.phase === 'fly') {
      this.message = 'Auto-plug: closing on the socket…';
      if (this.walk.attached) this.phase = 'walk';
      else {
        const dx = stX - sh.x;
        const dy = stY - sh.y;
        const d = Math.hypot(dx, dy);
        if (turned && d < tune.walk.reach + 0.5 && this.walk.tryAttach()) {
          this.ctx.sound.emit('clamp', sh.x, sh.y, 1);
          this.phase = 'walk';
        } else {
          const want = Math.min(FLY_SPEED, d * 0.8);
          const v = sh.body.linvel();
          let ax = ((d > 1e-3 ? (dx / d) * want : 0) - v.x) / dt;
          let ay = ((d > 1e-3 ? (dy / d) * want : 0) - v.y) / dt;
          const a = Math.hypot(ax, ay);
          if (a > FLY_ACCEL) {
            ax *= FLY_ACCEL / a;
            ay *= FLY_ACCEL / a;
          }
          const m = sh.body.mass() + b.body.mass(); // ship and core together
          sh.body.applyImpulse({ x: ax * m * dt, y: ay * m * dt }, true);
          return 0;
        }
      }
    }
    if (this.phase === 'walk') {
      this.message = 'Auto-plug: walking to the socket…';
      if (!this.walk.attached) {
        this.phase = 'fly';
        return 0;
      }
      // walk tangent (move +1) is (ny, -nx) of the surface under the feet
      const wtx = this.walk.ny;
      const wty = -this.walk.nx;
      const along = (stX - sh.x) * wtx + (stY - sh.y) * wty;
      const v = sh.body.linvel();
      if (Math.abs(along) < 0.3 && Math.abs(v.x * wtx + v.y * wty) < 0.4) {
        this.phase = 'insert';
        this.tInsert = 0;
      } else return Math.max(-1, Math.min(1, along * 0.8));
    }
    // insert: place the core so the terminal presses on the socket's face
    this.message = 'Auto-plug: plugging the core in…';
    this.tInsert += dt;
    if (this.tInsert > INSERT_TIMEOUT) {
      this.decline();
      return playerMove;
    }
    const angle = Math.atan2(-s.ny, -s.nx) - Math.atan2(term.dy, term.dx);
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    // center of mass relative to the terminal, in the body's frame (meters)
    const com = b.worldToLocal(b.body.worldCom().x, b.body.worldCom().y, { x: 0, y: 0 });
    const rx = (com.x - term.x) * CELL;
    const ry = (com.y - term.y) * CELL;
    const px = s.fx + s.nx * PRESS * CELL;
    const py = s.fy + s.ny * PRESS * CELL;
    this.arms.guide({ x: px + c * rx - sn * ry, y: py + sn * rx + c * ry, angle });
    if (this.power.socketSpots().some((p) => p.i === s.i && p.live)) this.latch(b);
    return 0;
  }

  /** The nearest dead socket in range that hasn't been declined. */
  private pick(): SocketSpot | null {
    const sh = this.ctx.ship;
    let best: SocketSpot | null = null;
    let bd = ENGAGE;
    for (const s of this.power.socketSpots()) {
      if (s.live || this.declined.has(s.i)) continue;
      const d = Math.hypot(s.fx - sh.x, s.fy - sh.y);
      if (d < bd) [bd, best] = [d, s];
    }
    return best;
  }

  /**
   * The core's terminal to present: live conductor cells that stick out (the body's
   * outermost cells on that side), grouped by the side they face; the group needing the
   * least turn to face the socket.
   */
  private terminal(b: PixelBody, s: SocketSpot): Terminal | null {
    const g = b.grid;
    const groups: { x: number; y: number; n: number; ext: number }[] = DIRS.map(() => ({ x: 0, y: 0, n: 0, ext: -Infinity }));
    const cells: [number, number, number][] = [];
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x;
        if (!g.powered[i] || !(MAT_FLAGS[g.mat[i]] & F.CONDUCTS)) continue;
        for (let d = 0; d < 4; d++) {
          if (g.solid(x + DIRS[d][0], y + DIRS[d][1])) continue;
          const e = (x + 0.5) * DIRS[d][0] + (y + 0.5) * DIRS[d][1];
          groups[d].ext = Math.max(groups[d].ext, e);
          cells.push([x, y, d]);
        }
      }
    // a terminal sticks out: its cells are the body's outermost on that side
    const solidExt = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++)
        if (g.solid(x, y)) for (let d = 0; d < 4; d++) solidExt[d] = Math.max(solidExt[d], (x + 0.5) * DIRS[d][0] + (y + 0.5) * DIRS[d][1]);
    for (let d = 0; d < 4; d++) if (groups[d].ext < solidExt[d] - 0.01) groups[d].ext = Infinity;
    for (const [x, y, d] of cells) {
      const e = (x + 0.5) * DIRS[d][0] + (y + 0.5) * DIRS[d][1];
      if (e < groups[d].ext - 1) continue; // outermost only
      groups[d].x += x + 0.5;
      groups[d].y += y + 0.5;
      groups[d].n++;
    }
    const want = Math.atan2(-s.ny, -s.nx);
    let best: Terminal | null = null;
    let bt = Infinity;
    for (let d = 0; d < 4; d++) {
      const q = groups[d];
      if (!q.n) continue;
      const turn = Math.abs(Math.atan2(Math.sin(want - Math.atan2(DIRS[d][1], DIRS[d][0]) - b.body.rotation()), Math.cos(want - Math.atan2(DIRS[d][1], DIRS[d][0]) - b.body.rotation())));
      if (turn < bt) {
        bt = turn;
        best = { x: q.x / q.n + DIRS[d][0] * 0.5, y: q.y / q.n + DIRS[d][1] * 0.5, dx: DIRS[d][0], dy: DIRS[d][1] };
        // the terminal point is on the cells' outer edge
        best.x -= DIRS[d][0] * 0.5;
        best.y -= DIRS[d][1] * 0.5;
      }
    }
    return best;
  }

  /** The socket's latch grips the core where it is; the arms let go. */
  private latch(b: PixelBody): void {
    const { ctx } = this;
    const tb = ctx.pixels.terrain.body;
    const body = b.body;
    const tt = tb.translation();
    const bt = body.translation();
    const ta = tb.rotation();
    const dx = bt.x - tt.x;
    const dy = bt.y - tt.y;
    const local = { x: Math.cos(ta) * dx + Math.sin(ta) * dy, y: -Math.sin(ta) * dx + Math.cos(ta) * dy };
    const params = ctx.physics.R.JointData.fixed(local, body.rotation() - ta, { x: 0, y: 0 }, 0);
    this.latches.set(b, ctx.physics.world.createImpulseJoint(params, tb, body, true));
    this.arms.release();
    this.plugs++;
    const s = this.spot!;
    ctx.sound.emit('clamp', s.fx, s.fy, 0.8);
    this.declined.add(s.i);
    this.stop();
  }

  /** Gives up on the current socket (the player took over, or it didn't work). */
  private decline(): void {
    if (this.spot) this.declined.add(this.spot.i);
    this.stop();
  }

  private stop(): void {
    if (this.phase === 'insert' && this.arms.held) this.arms.guide(null);
    this.phase = 'idle';
    this.spot = null;
    this.message = '';
  }
}
