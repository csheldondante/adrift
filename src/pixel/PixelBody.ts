// A dynamic rigid body made of pixel cells. Stays cuttable; PixelWorld splits it when cuts
// disconnect it. Mass/inertia come from per-rect material densities via Rapier.
//
// Likely growth: large bodies may want chunked collider rebuilds like Terrain; gameplay
// tags (salvage, explosive barrel, enemy hull) live in `tags` rather than subclasses so a
// body keeps its identity across splits where that makes sense.

import { CELL, tune } from '../config';
import { F, MAT_DENSITY, MAT_FLAGS } from './materials';
import { PixelGrid } from './PixelGrid';
import { PixelObject } from './PixelObject';
import type { Body, Collider, Physics } from '../physics/Physics';

export interface BodyTags {
  salvage?: boolean;
  /** Scripted machine (crusher, mover): kinematic, driven by the Machinery system. */
  machine?: boolean;
  label?: string;
}

export interface BodyInit {
  x: number; // world position of grid origin (bottom-left), meters
  y: number;
  angle?: number;
  vx?: number;
  vy?: number;
  w?: number; // angular velocity
  tags?: BodyTags;
  /** Position-driven by script (machines); unaffected by forces, pushes everything. */
  kinematic?: boolean;
}

export class PixelBody extends PixelObject {
  readonly kind = 'pixelBody' as const;
  readonly body: Body;
  readonly tags: BodyTags;
  private colliders: Collider[] = [];
  alive = true;
  /** Set when cells were removed; PixelWorld re-checks connectivity at flush. */
  needsSplitCheck = false;
  explosiveCells = 0;

  constructor(
    private readonly physics: Physics,
    grid: PixelGrid,
    init: BodyInit,
    renderOrder: number,
  ) {
    super(grid, renderOrder);
    const R = physics.R;
    const desc = (init.kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic())
      .setTranslation(init.x, init.y)
      .setRotation(init.angle ?? 0)
      .setLinvel(init.vx ?? 0, init.vy ?? 0)
      .setAngvel(init.w ?? 0)
      .setCcdEnabled(true);
    this.body = physics.world.createRigidBody(desc);
    this.tags = init.tags ?? {};
    this.rebuildColliders();
    this.syncTransform();
  }

  syncTransform(): void {
    const t = this.body.translation();
    this.setTransform(t.x, t.y, this.body.rotation());
  }

  rebuildColliders(): void {
    const { physics, grid } = this;
    for (const c of this.colliders) physics.removeCollider(c);
    this.colliders = [];
    const rects: number[] = [];
    grid.greedyRects(0, 0, grid.w, grid.h, rects);
    for (let k = 0; k < rects.length; k += 4) {
      const [x, y, w, h] = [rects[k], rects[k + 1], rects[k + 2], rects[k + 3]];
      let dens = 0;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) dens += MAT_DENSITY[grid.mat[yy * grid.w + xx]];
      const desc = physics.R.ColliderDesc.cuboid((w * CELL) / 2, (h * CELL) / 2)
        .setTranslation((x + w / 2) * CELL, (y + h / 2) * CELL)
        .setDensity(dens / (w * h))
        .setFriction(0.5)
        .setRestitution(0.15)
        .setActiveEvents(physics.R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(tune.impact.eventThreshold);
      this.colliders.push(physics.createCollider(desc, this.body, this));
    }
    let explosive = 0;
    for (let i = 0; i < grid.mat.length; i++) if (MAT_FLAGS[grid.mat[i]] & F.EXPLOSIVE) explosive++;
    this.explosiveCells = explosive;
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.physics.removeBody(this.body);
    this.colliders = [];
    this.dispose();
  }
}
