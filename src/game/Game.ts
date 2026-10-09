// One run of the game: builds the level and wires systems together, owns the fixed-step
// loop, and tears everything down on dispose. Long-lived services (renderer, GPU field,
// input, background) are passed in and survive restarts.
//
// Step order (per fixed step):
//   controls -> tools (cuts) -> hazards -> pixel flush (colliders/detach/split)
//   -> field forces -> physics step -> transform sync -> contact damage
// The gas field steps once per frame after physics; its readback is 1–2 frames latent.

import * as THREE from 'three/webgpu';
import { CELL, FIXED_DT, tune } from '../config';
import type { Input } from '../core/Input';
import type { FieldSample, GasField } from '../fields/GasField';
import { Physics, type Body } from '../physics/Physics';
import { MAT_RGB } from '../pixel/materials';
import type { PixelBody } from '../pixel/PixelBody';
import { PixelWorld } from '../pixel/PixelWorld';
import { ORDER } from '../render/order';
import { Particles } from '../render/Particles';
import { PixelLayer } from '../render/PixelLayer';
import type { Stage } from '../render/Stage';
import { Cutter } from './Cutter';
import { Grapple } from './Grapple';
import { Hazards } from './Hazards';
import type { LevelSpec } from './level/derelict';
import { ExtractionObjective } from './Objective';
import { Ship } from './Ship';
import type { Controls, GameContext, Tool } from './types';

export interface AppServices {
  stage: Stage;
  field: GasField;
  input: Input;
}

const sample: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const v2 = { x: 0, y: 0 };

export class Game {
  readonly physics: Physics;
  readonly pixels: PixelWorld;
  readonly ship: Ship;
  readonly particles = new Particles();
  readonly hazards = new Hazards();
  readonly objective: ExtractionObjective;
  readonly cutter: Cutter;
  readonly grapple: Grapple;
  readonly controls: Controls = { thrust: 0, turn: 0, reel: 0, aimX: 0, aimY: 0 };
  readonly ctx: GameContext;
  /** Tool slots: [0] = left mouse, [1] = right mouse. Swap entries to rebind. */
  readonly slots: Tool[];
  private readonly fx = new THREE.Group();
  private readonly root = new THREE.Group();
  private readonly worldW: number;
  private readonly worldH: number;
  private acc = 0;
  time = 0;
  private zoom = 34;
  private camX: number;
  private camY: number;
  private deathHandled = false;
  private debugLines: THREE.LineSegments | null = null;
  private readonly backWall: PixelLayer | null;

  constructor(
    private readonly app: AppServices,
    level: LevelSpec,
  ) {
    const { stage, field } = app;
    this.physics = new Physics(FIXED_DT);
    this.pixels = new PixelWorld(this.physics, level.terrain);
    this.pixels.terrain.rebuildAllColliders();
    const tg = level.terrain;
    this.worldW = tg.w * CELL;
    this.worldH = tg.h * CELL;

    field.reset();
    field.setSolidFromGrid(tg, { x0: 0, y0: 0, x1: tg.w, y1: tg.h });
    for (const r of level.pressurized) field.fillRect(r.x0, r.y0, r.x1, r.y1, r.gas);

    const bodies = level.bodies.map((spec) => this.pixels.addBody(spec.grid, spec));
    const salvage = bodies[level.salvageIndex];

    const s = level.shipSpawn;
    this.ship = new Ship(this.physics, s.x, s.y, s.angle);
    this.camX = s.x;
    this.camY = s.y;

    this.objective = new ExtractionObjective(level.extraction, salvage);

    this.backWall = level.backdrop ? new PixelLayer(level.backdrop, ORDER.backWall, [0.3, 0.33, 0.42]) : null;
    if (this.backWall) this.root.add(this.backWall.mesh);
    this.root.add(this.objective.mesh, this.pixels.group, this.ship.group, this.particles.group, this.fx);
    stage.world.add(this.root);

    this.ctx = {
      physics: this.physics,
      pixels: this.pixels,
      field,
      particles: this.particles,
      stage,
      ship: this.ship,
      hazards: this.hazards,
      controls: this.controls,
      fx: this.fx,
    };
    this.hazards.bind(this.ctx);
    this.cutter = new Cutter(this.ctx);
    this.grapple = new Grapple(this.ctx);
    this.slots = [this.cutter, this.grapple];

    this.pixels.events = {
      cellDestroyed: (x, y, mat, shade, vx, vy) => {
        if (Math.random() > 0.5) return; // half become visible debris; keeps counts sane
        const k = 0.75 + (shade / 255) * 0.5;
        const sp = 1.5;
        this.particles.debris(x, y, vx + (Math.random() - 0.5) * sp, vy + (Math.random() - 0.5) * sp, MAT_RGB[mat * 3] * k, MAT_RGB[mat * 3 + 1] * k, MAT_RGB[mat * 3 + 2] * k);
      },
      explosiveDestroyed: (x, y) => this.hazards.trigger(x, y),
      terrainChanged: (r) => field.setSolidFromGrid(tg, r),
      bodyRemoved: (b) => this.grapple.onBodyRemoved(b),
    };
    this.hazards.onExplode = (x, y) => {
      const d = Math.hypot(x - this.ship.x, y - this.ship.y);
      stage.shake(Math.max(0, 0.9 - d / 40));
    };
  }

  get salvage(): PixelBody {
    return this.objective.salvage;
  }

  update(frameDt: number): void {
    const dt = Math.min(frameDt, 0.05);
    const { input, stage, field } = this.app;
    this.time += dt;

    // controls
    const c = this.controls;
    c.thrust = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    c.turn = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    c.reel = (input.down('KeyE') ? 1 : 0) - (input.down('KeyQ') ? 1 : 0);
    stage.screenToWorld(input.mouseX, input.mouseY, v2);
    c.aimX = v2.x;
    c.aimY = v2.y;
    if (input.hit('Mouse0')) this.slots[0].press();
    if (input.hit('Mouse2')) this.slots[1].press();
    if (input.hit('KeyP')) tune.grapple.pivot = tune.grapple.pivot === 'com' ? 'nose' : 'com';
    const wheel = input.takeWheel();
    if (wheel) this.zoom = Math.max(16, Math.min(90, this.zoom * Math.pow(1.12, wheel)));

    // fixed steps
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 4) {
      this.fixedStep(input);
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === 4) this.acc = 0;

    field.step(FIXED_DT);

    // visuals
    this.pixels.syncVisuals();
    this.ship.sync(this.time);
    for (const t of this.slots) t.frameUpdate(dt);
    this.engineFx();
    this.particles.update(dt, field, this.pixels.terrain.grid);
    this.objective.update(dt);
    field.mesh.visible = tune.debug.showField;
    this.updateDebugLines();
    this.updateCamera(dt);
  }

  private fixedStep(input: Input): void {
    const dt = FIXED_DT;
    this.ship.control(this.controls, dt);
    this.slots[0].fixedUpdate(dt, input.down('Mouse0'));
    this.slots[1].fixedUpdate(dt, input.down('Mouse2'));
    this.hazards.update(dt);
    this.pixels.flush();
    this.applyFieldForces(dt);
    this.cullFarBodies();
    this.physics.step();
    this.pixels.syncTransforms();
    this.applyDamage(dt);
  }

  /** Gas flow drags bodies toward its velocity, scaled by density and exposed area. */
  private applyFieldForces(dt: number): void {
    const { field } = this.ctx;
    const k = tune.gas.pushStrength;
    const push = (body: Body, area: number) => {
      const c = body.worldCom();
      field.sample(c.x, c.y, sample);
      if (sample.gas < 0.01) return;
      const v = body.linvel();
      const g = Math.min(sample.gas, 3);
      const fx = k * g * (sample.vx - v.x) * area;
      const fy = k * g * (sample.vy - v.y) * area;
      body.applyImpulse({ x: fx * dt, y: fy * dt }, true);
    };
    for (const b of this.pixels.bodies) push(b.body, Math.min(8, b.body.mass() / 60));
    if (this.ship.alive) push(this.ship.body, 1.8);
  }

  /**
   * No boundary forces: things that drift off keep drifting. Debris far outside the level
   * (and not salvage or on the tether) is deleted purely to save CPU; it could never
   * come back on its own anyway.
   */
  private cullFarBodies(): void {
    const far = 150; // m beyond the level rectangle
    for (const b of this.pixels.bodies.slice()) {
      if (b.tags.salvage || this.grapple.targetObject === b) continue;
      const t = b.body.translation();
      if (t.x < -far || t.y < -far || t.x > this.worldW + far || t.y > this.worldH + far) this.pixels.removeBody(b);
    }
  }

  private applyDamage(dt: number): void {
    const s = tune.ship;
    for (const cf of this.physics.contactForces) {
      if (cf.a !== this.ship && cf.b !== this.ship) continue;
      if (cf.force > s.impactDamageThreshold) {
        this.ship.damage((cf.force - s.impactDamageThreshold) * s.impactDamageScale);
        this.app.stage.shake(Math.min(0.4, cf.force / 400000));
      }
    }
    if (this.ship.alive) {
      this.ctx.field.sample(this.ship.x, this.ship.y, sample);
      if (sample.heat > 0.3) this.ship.damage(s.heatDamage * sample.heat * dt);
    }
    if (!this.ship.alive && !this.deathHandled) {
      this.deathHandled = true;
      this.grapple.detach();
      this.hazards.trigger(this.ship.x, this.ship.y, 0);
    }
  }

  private engineFx(): void {
    const sh = this.ship;
    if (!sh.alive || sh.thrustLevel === 0) return;
    const a = sh.angle;
    const dir = sh.thrustLevel > 0 ? -1 : 1;
    const ox = sh.x + Math.cos(a) * (dir < 0 ? -1.4 : 0.9);
    const oy = sh.y + Math.sin(a) * (dir < 0 ? -1.4 : 0.9);
    const v = sh.body.linvel();
    const sp = 6 + Math.random() * 4;
    const spread = (Math.random() - 0.5) * 2.5;
    const ex = Math.cos(a) * dir * sp - Math.sin(a) * spread + v.x;
    const ey = Math.sin(a) * dir * sp + Math.cos(a) * spread + v.y;
    if (dir < 0) this.particles.fire(ox, oy, ex, ey, 0.18, 0.18);
    else this.particles.spark(ox, oy, ex, ey, 0.15, 0.06, 0.2);
  }

  private updateCamera(dt: number): void {
    const sh = this.ship;
    const v = sh.body.linvel();
    const tx = sh.x + v.x * 0.35 + (this.controls.aimX - sh.x) * 0.18;
    const ty = sh.y + v.y * 0.35 + (this.controls.aimY - sh.y) * 0.18;
    const k = 1 - Math.exp(-dt * 4);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    this.app.stage.setView(this.camX, this.camY, this.zoom, dt);
  }

  private updateDebugLines(): void {
    if (!tune.debug.showColliders) {
      if (this.debugLines) this.debugLines.visible = false;
      return;
    }
    const { vertices, colors } = this.physics.world.debugRender();
    if (!this.debugLines) {
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
      this.debugLines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      this.debugLines.renderOrder = ORDER.debug;
      this.debugLines.frustumCulled = false;
      this.fx.add(this.debugLines);
    }
    const geo = this.debugLines.geometry;
    const n = vertices.length / 2;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = vertices[i * 2];
      pos[i * 3 + 1] = vertices[i * 2 + 1];
      col[i * 3] = colors[i * 4];
      col[i * 3 + 1] = colors[i * 4 + 1];
      col[i * 3 + 2] = colors[i * 4 + 2];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.debugLines.visible = true;
  }

  dispose(): void {
    for (const t of this.slots) t.dispose();
    this.objective.dispose();
    this.backWall?.dispose();
    this.pixels.dispose();
    this.ship.dispose();
    this.particles.dispose();
    if (this.debugLines) {
      this.debugLines.geometry.dispose();
      (this.debugLines.material as THREE.Material).dispose();
    }
    this.root.removeFromParent();
    this.physics.dispose();
  }
}
