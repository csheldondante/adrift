// Bullets: swept segments each physics step. They hit pixel matter (chipping it, including
// robots, so turrets can hit drones and vice versa) and the ship (a circle test). Drawn as
// short glowing streaks through the particle system.
//
// Likely growth: per-weapon bullet types (explosive rounds, slugs that knock things around),
// player weapons for firefight modes. Keep the hit pipeline in step().

import type { GameContext } from './types';

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number; // hp to the ship
  pixelDamage: number; // hp to pixel cells
  color: [number, number, number];
  ignore?: unknown; // pixel body that fired it (don't hit yourself on the way out)
}

const SHIP_RADIUS = 1.0;

export class Projectiles {
  private readonly bullets: Bullet[] = [];

  constructor(private readonly ctx: GameContext) {}

  fire(x: number, y: number, vx: number, vy: number, opts: Partial<Bullet> = {}): void {
    this.bullets.push({ x, y, vx, vy, life: 2.5, damage: 7, pixelDamage: 45, color: [1, 0.35, 0.25], ...opts });
  }

  get count(): number {
    return this.bullets.length;
  }

  step(dt: number): void {
    const { ctx } = this;
    const ship = ctx.ship;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      const sp = Math.hypot(b.vx, b.vy);
      const step = sp * dt;
      const dx = b.vx / sp;
      const dy = b.vy / sp;
      // ship: closest approach of this step's segment to the ship center
      let hitShip = false;
      if (ship.alive) {
        const rx = ship.x - b.x;
        const ry = ship.y - b.y;
        const along = Math.max(0, Math.min(step, rx * dx + ry * dy));
        if ((rx - dx * along) ** 2 + (ry - dy * along) ** 2 < SHIP_RADIUS * SHIP_RADIUS) {
          hitShip = true;
          ship.damage(b.damage, 'shot');
          ship.body.applyImpulse({ x: dx * 8, y: dy * 8 }, true);
          this.sparks(b.x + dx * along, b.y + dy * along, -dx, -dy);
        }
      }
      if (!hitShip) {
        const hit = ctx.pixels.raycast(b.x, b.y, dx, dy, step, b.ignore as never);
        if (hit) {
          ctx.pixels.damageCircle(hit.x + dx * 0.1, hit.y + dy * 0.1, 0.3, b.pixelDamage);
          ctx.pixels.heatCircle(hit.x, hit.y, 0.35, 0.4);
          this.sparks(hit.x, hit.y, -dx, -dy);
          this.bullets.splice(i, 1);
          continue;
        }
      }
      if (hitShip || b.life <= 0) {
        this.bullets.splice(i, 1);
        continue;
      }
      b.x += dx * step;
      b.y += dy * step;
    }
  }

  /** Draws each bullet as a short glowing streak. */
  frameUpdate(): void {
    const p = this.ctx.particles;
    for (const b of this.bullets) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      for (let k = 0; k < 3; k++) {
        const t = k * 0.12;
        p.glint(b.x - (b.vx / sp) * t, b.y - (b.vy / sp) * t, 0, 0, b.color[0], b.color[1], b.color[2], 0.03, 0.16 - k * 0.04);
      }
    }
  }

  private sparks(x: number, y: number, nx: number, ny: number): void {
    for (let k = 0; k < 5; k++) {
      const s = 2 + Math.random() * 5;
      this.ctx.particles.spark(x, y, (nx + (Math.random() - 0.5) * 1.6) * s, (ny + (Math.random() - 0.5) * 1.6) * s, 0.2, 0.07, 0.5);
    }
  }

  clear(): void {
    this.bullets.length = 0;
  }
}
