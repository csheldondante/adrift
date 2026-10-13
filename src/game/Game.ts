// One run of the game: builds the level and wires systems together, owns the fixed-step
// loop, and tears everything down on dispose. Long-lived services (renderer, GPU field,
// input, background) are passed in and survive restarts.
//
// Step order (per fixed step):
//   controls -> tools (cuts) -> hazards -> pixel flush (colliders/detach/split)
//   -> field forces -> physics step -> transform sync -> contact damage
// The gas field steps once per frame after physics; its readback is 1–2 frames latent.

import * as THREE from 'three/webgpu';
import type { AudioEngine } from '../audio/AudioEngine';
import { Soundscape, type Contact } from '../audio/Soundscape';
import { CELL, FIXED_DT, tune } from '../config';
import type { Input } from '../core/Input';
import type { FieldSample, GasField } from '../fields/GasField';
import { Physics, type Body } from '../physics/Physics';
import { MAT_RGB } from '../pixel/materials';
import type { PixelBody } from '../pixel/PixelBody';
import { PixelWorld } from '../pixel/PixelWorld';
import type { PixelObject } from '../pixel/PixelObject';
import { Welder } from '../pixel/Welder';
import { dragArea, dragForce } from '../fields/drag';
import { Scanner } from './Scanner';
import { Devices } from './systems/Devices';
import { PowerNet } from './systems/PowerNet';
import { rasterPixels, type InteriorMask } from '../pixel/lightRaster';
import type { Light, Lighting } from '../render/Lighting';
import { ORDER } from '../render/order';
import { Particles } from '../render/Particles';
import { PixelLayer } from '../render/PixelLayer';
import type { Stage } from '../render/Stage';
import { Arms } from './Arms';
import { Cutter } from './Cutter';
import { Grapple } from './Grapple';
import { Hazards } from './Hazards';
import { HullWalk } from './HullWalk';
import { Rng } from './level/rng';
import type { LevelSpec } from './level/types';
import { ExtractionObjective } from './Objective';
import { Machinery } from './Machinery';
import { Projectiles } from './Projectiles';
import { Security } from './security/Security';
import { Ship } from './Ship';
import type { Controls, GameContext, Tool } from './types';

export interface AppServices {
  stage: Stage;
  field: GasField;
  input: Input;
  lighting: Lighting;
  audio: AudioEngine;
}

/** A fixed light in the level (emergency lamps); flicker is per light. */
interface FixedLight extends Light {
  base: number;
  phase: number;
}

const sample: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const v2 = { x: 0, y: 0 };

export class Game {
  readonly physics: Physics;
  readonly pixels: PixelWorld;
  readonly welder: Welder;
  readonly power: PowerNet;
  readonly devices: Devices;
  readonly scanner = new Scanner();
  private footPingT = 0;
  private knockT = 0;
  readonly ship: Ship;
  readonly particles = new Particles();
  readonly hazards = new Hazards();
  readonly objective: ExtractionObjective;
  readonly machinery: Machinery;
  readonly projectiles: Projectiles;
  readonly security: Security;
  readonly cutter: Cutter;
  readonly grapple: Grapple;
  readonly controls: Controls = { thrust: 0, reel: 0, move: 0, aimX: 0, aimY: 0, weld: false };
  readonly walk: HullWalk;
  readonly arms: Arms;
  readonly sound: Soundscape;
  /** Contact pairs (collider handles) touching last step, so impacts sound once at onset. */
  private touchingPairs = new Set<string>();
  private shipTouchedLast = false;
  private lastRopeLength = 0;
  /** Camera roll (radians); follows the surface while hull-walking and keeps its angle after. */
  private roll = 0;
  readonly ctx: GameContext;
  /** Tool slots: [0] = left mouse, [1] = right mouse. Swap entries to rebind. */
  readonly slots: Tool[];
  private readonly fx = new THREE.Group();
  private readonly root = new THREE.Group();
  private readonly worldW: number;
  private readonly worldH: number;
  private acc = 0;
  time = 0;
  /** A short notice from the last action (a panel used), shown until noticeUntil (game time). */
  notice = '';
  noticeUntil = 0;
  zoom = 34;
  /** Debug/test: if set, the camera looks here instead of following the ship. */
  debugCamera: { x: number; y: number } | null = null;
  private camX: number;
  private camY: number;
  private deathHandled = false;
  private readonly preVel = { x: 0, y: 0 };
  /** Ship velocity change in its last contact step (m/s), for tests and tuning. */
  lastImpactSpeed = 0;
  private debugLines: THREE.LineSegments | null = null;
  private readonly backWall: PixelLayer | null;
  /** Back-wall coverage only (the rest of the backdrop grid is dropped), for interior ambient. */
  private readonly interior: InteriorMask | null;
  private readonly fixedLights: FixedLight[] = [];
  private readonly flashes: { x: number; y: number; t: number }[] = [];

  constructor(
    private readonly app: AppServices,
    level: LevelSpec,
  ) {
    const { stage, field } = app;
    this.physics = new Physics(FIXED_DT);
    this.pixels = new PixelWorld(this.physics, level.terrain);
    this.welder = new Welder(this.pixels);
    this.power = new PowerNet(this.pixels);
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
    this.machinery = new Machinery(this.pixels, this.fx, level.entities);

    this.backWall = level.backdrop ? new PixelLayer(level.backdrop, ORDER.backWall, tune.light.enabled ? [0.62, 0.66, 0.78] : [0.3, 0.33, 0.42]) : null;
    if (this.backWall) this.root.add(this.backWall.object);
    this.interior = level.backdrop ? { mat: level.backdrop.mat, w: level.backdrop.w, h: level.backdrop.h } : null;
    this.placeFixedLights(level);
    this.root.add(this.objective.mesh, this.pixels.group, this.ship.group, this.particles.group, this.fx);
    stage.world.add(this.root);

    this.sound = new Soundscape(app.audio, field, stage);
    this.ctx = {
      sound: this.sound,
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
    this.projectiles = new Projectiles(this.ctx);
    this.security = new Security(this.ctx, level.entities, level.doors, this.projectiles);
    this.cutter = new Cutter(this.ctx);
    this.grapple = new Grapple(this.ctx);
    this.slots = [this.cutter, this.grapple];
    this.walk = new HullWalk(this.ctx);
    this.arms = new Arms(this.ctx, this.walk);
    this.welder.onWeld = (x, y) => {
      for (let k = 0; k < 14; k++) this.particles.spark(x, y, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.3 + Math.random() * 0.4);
      this.sound.emit('weld', x, y, 1, [this.pixels.terrain, this.pixels.bodyAt(x, y) ?? undefined]);
    };
    this.machinery.onStop = (body, x, y, speed) => this.sound.emit('slam', x, y, Math.min(1, speed / 12), [body]);

    this.pixels.events = {
      cellDestroyed: (x, y, mat, shade, vx, vy) => {
        if (Math.random() > 0.5) return; // half become visible debris; keeps counts sane
        const k = 0.75 + (shade / 255) * 0.5;
        const sp = 1.5;
        this.particles.debris(x, y, vx + (Math.random() - 0.5) * sp, vy + (Math.random() - 0.5) * sp, MAT_RGB[mat * 3] * k, MAT_RGB[mat * 3 + 1] * k, MAT_RGB[mat * 3 + 2] * k);
      },
      explosiveDestroyed: (x, y) => this.hazards.trigger(x, y),
      terrainChanged: (r, breach) => {
        field.setSolidFromGrid(tg, r, breach);
        this.power.terrainChanged(r);
      },
      bodyRemoved: (b) => {
        this.grapple.onBodyRemoved(b);
        this.arms.onBodyRemoved(b);
      },
    };
    // after the events are wired: doors paint their slabs into the terrain
    this.devices = new Devices(this.ctx, this.power, level.devices ?? []);
    this.hazards.onExplode = (x, y) => {
      const d = Math.hypot(x - this.ship.x, y - this.ship.y);
      stage.shake(Math.max(0, 0.9 - d / 40));
      this.flashes.push({ x, y, t: 0 });
      // blasts happen in the hull's own matter (fuel cells) or right against it
      this.sound.emit('explosion', x, y, 1, [this.pixels.terrain, this.pixels.bodyAt(x, y) ?? undefined]);
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
    c.thrust = input.down('Space') ? 1 : 0;
    c.weld = input.down('ShiftLeft') || input.down('ShiftRight');
    c.reel = input.down('KeyQ') ? 1 : 0; // pay out slack (holding RMB winches in)
    c.move = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    // E: let go of what the arms hold, else clamp onto the nearest surface (or let go of it);
    // Space kicks off a surface
    const sh = this.ship;
    if (input.hit('KeyE')) {
      if (this.arms.release()) this.sound.emit('release', sh.x, sh.y, 1);
      else if (this.walk.attached) this.walk.detach();
      else if (this.walk.tryAttach()) this.sound.emit('clamp', sh.x, sh.y, 1);
    }
    // consume the press every frame: a Space tap made while flying must not linger and kick
    // you off the next surface you clamp to
    const spaceHit = input.hit('Space');
    if (this.walk.attached && spaceHit) {
      this.walk.detach(true);
      this.sound.emit('pushoff', sh.x, sh.y, 1);
    }
    if (input.hit('KeyM')) tune.audio.muted = !tune.audio.muted;
    stage.screenToWorld(input.mouseX, input.mouseY, v2);
    c.aimX = v2.x;
    c.aimY = v2.y;
    if (input.hit('Mouse0')) this.slots[0].press();
    if (input.hit('Mouse2')) this.slots[1].press();
    if (input.released('Mouse0')) this.slots[0].release();
    if (input.released('Mouse2')) this.slots[1].release();
    this.knockT -= dt;
    if (input.hit('KeyV')) this.knock();
    if (input.hit('KeyG')) {
      const msg = this.devices.use(sh.x, sh.y);
      if (msg) {
        this.notice = msg;
        this.noticeUntil = this.time + 2.5;
      }
    }
    if (input.hit('KeyN')) {
      this.notice = this.scanner.map.toggle() ? 'Scan map shown' : 'Scan map hidden';
      this.noticeUntil = this.time + 1.5;
    }
    if (input.hit('KeyF')) {
      sh.lampOn = !sh.lampOn;
      this.sound.emit('lamp', sh.x, sh.y, 1);
    }
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
    this.pixels.cool(dt);
    this.pixels.syncVisuals();
    this.ship.sync(this.time);
    this.arms.frameUpdate(dt, this.time);
    this.scanner.frameUpdate(dt);
    for (const t of this.slots) t.frameUpdate(dt);
    this.machinery.frameUpdate();
    this.security.frameUpdate();
    this.projectiles.frameUpdate();
    this.engineFx();
    this.particles.update(dt, field, this.pixels.terrain.grid);
    this.objective.update(dt);
    field.mesh.visible = tune.debug.showField;
    this.updateDebugLines();
    this.updateCamera(dt);
    this.updateLighting(dt);
    this.updateSound(dt);
  }

  /** What the ship is mechanically coupled to (sound conducts through these). */
  private listenerContacts(): Contact[] {
    const out: Contact[] = [];
    const sh = this.ship;
    if (!sh.alive) return out;
    if (this.walk.attached) out.push({ obj: this.walk.surfaceBody ?? this.pixels.terrain, w: 1 });
    if (this.arms.held) out.push({ obj: this.arms.held, w: 1 });
    const gt = this.grapple.targetObject;
    if (gt && this.grapple.state === 'clamped') out.push({ obj: gt, w: 1 });
    else if (gt && this.grapple.attached) out.push({ obj: gt, w: 0.2 + 0.8 * Math.min(1, this.grapple.tautness) }); // a slack line barely carries
    // resting against something (actual contact points, not just overlapping bounds)
    const { world } = this.physics;
    const cands: import('@dimforge/rapier2d-compat').Collider[] = [];
    world.contactPairsWith(sh.collider, (c2) => {
      cands.push(c2);
    });
    for (const c2 of cands) {
      const o = this.physics.ownerOf(c2);
      if (!o || o.kind === 'rope') continue;
      let touching = false;
      world.contactPair(sh.collider, c2, (m) => {
        if (m.numSolverContacts() > 0) touching = true;
      });
      if (touching) out.push({ obj: o, w: 0.9 });
    }
    return out;
  }

  private updateSound(dt: number): void {
    const sh = this.ship;
    const v = sh.body.linvel();
    const len = this.grapple.length;
    const winch = dt > 0 && this.lastRopeLength > 0 && len > 0 ? (len - this.lastRopeLength) / dt : 0;
    this.lastRopeLength = len;
    this.sound.update(sh.x, sh.y, this.listenerContacts(), {
      alive: sh.alive,
      thrust: sh.thrustLevel,
      rcs: sh.brake + Math.abs(sh.turnInput) * 0.6,
      cutter: this.cutter.firing,
      cutting: this.cutter.cutting,
      winch,
      servo: this.arms.motion,
      vx: v.x,
      vy: v.y,
    }, this.time);
  }

  /** Emergency lamps in a fraction of rooms: dim, warm, flickering pools in the dark. */
  private placeFixedLights(level: LevelSpec): void {
    const rng = new Rng(level.seed ^ 0x5eed);
    for (const r of level.rooms) {
      if (rng.next() > tune.light.roomLightChance) continue;
      const red = rng.next() < 0.4;
      const size = Math.max(r.x1 - r.x0, r.y1 - r.y0);
      const base = 0.5 + rng.next() * 0.3;
      this.fixedLights.push({
        x: (r.x0 + r.x1) / 2 + (rng.next() - 0.5) * (r.x1 - r.x0) * 0.5,
        y: r.y1 - 0.6,
        dirX: 0,
        dirY: -1,
        cosHalf: -2,
        range: Math.min(24, Math.max(9, size * 0.75)),
        intensity: base,
        base,
        phase: rng.next() * 100,
        r: 1,
        g: red ? 0.22 : 0.55,
        b: red ? 0.15 : 0.22,
      });
    }
  }

  /** How far sensors can see the ship: the lamp, the thruster and the cutter all give it away. */
  private updateConspicuity(): void {
    const sh = this.ship;
    if (!tune.light.enabled || sh.lampOn) sh.conspicuity = 1;
    else sh.conspicuity = Math.min(1, tune.light.darkVisibility + 0.35 * sh.thrustLevel + (this.cutter.firing ? 0.35 : 0));
  }

  private updateLighting(dt: number): void {
    const { lighting, stage } = this.app;
    const L = tune.light;
    if (!L.enabled) {
      lighting.disable();
      return;
    }
    lighting.setAmbient(L.ambientInterior, L.ambientSpace);
    const out = lighting.lights;
    const sh = this.ship;
    if (sh.alive) {
      const ca = Math.cos(sh.angle);
      const sa = Math.sin(sh.angle);
      if (sh.lampOn) {
        const n = sh.nose(v2);
        out.push({ x: n.x, y: n.y, dirX: ca, dirY: sa, cosHalf: Math.cos(L.lampHalf), range: L.lampRange, intensity: L.lampIntensity, r: 1, g: 0.94, b: 0.82 });
        out.push({ x: sh.x, y: sh.y, dirX: 0, dirY: 0, cosHalf: -2, range: 4.5, intensity: 0.4, r: 0.7, g: 0.8, b: 1 });
      } else out.push({ x: sh.x, y: sh.y, dirX: 0, dirY: 0, cosHalf: -2, range: 2.2, intensity: 0.25, r: 0.5, g: 0.7, b: 1 }); // instrument glow
      if (sh.thrustLevel > 0) out.push({ x: sh.x - ca * 1.8, y: sh.y - sa * 1.8, dirX: 0, dirY: 0, cosHalf: -2, range: 9, intensity: 1.1 * sh.thrustLevel, r: 1, g: 0.55, b: 0.2 });
      if (this.cutter.firing) {
        const e = this.cutter.beamEnd;
        out.push({ x: e.x, y: e.y, dirX: 0, dirY: 0, cosHalf: -2, range: 7, intensity: 1.3, r: 1, g: 0.6, b: 0.3, skin: 0.3 });
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = 1 - f.t / 0.9;
      if (k <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      out.push({ x: f.x, y: f.y, dirX: 0, dirY: 0, cosHalf: -2, range: 26, intensity: 2.2 * k * k, r: 1, g: 0.62, b: 0.3, skin: 1 });
    }
    const s = this.salvage;
    if (s.alive) {
      const c = s.body.worldCom();
      out.push({ x: c.x, y: c.y, dirX: 0, dirY: 0, cosHalf: -2, range: 14, intensity: 0.8 + 0.15 * Math.sin(this.time * 2.2), r: 0.3, g: 1, b: 0.95, skin: (Math.min(s.grid.w, s.grid.h) * CELL) / 2 });
    }
    const z = this.objective.zone;
    out.push({ x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2, dirX: 0, dirY: 0, cosHalf: -2, range: Math.max(z.x1 - z.x0, z.y1 - z.y0) * 0.8, intensity: 0.45, r: 0.35, g: 1, b: 0.5 });
    for (const l of this.power.lights) out.push(l);
    // dead sockets pulse a slow blue so you can find them in the dark
    const beat = 0.5 + 0.5 * Math.sin(this.time * 3);
    for (const sp of this.power.socketSpots()) if (!sp.live) out.push({ x: sp.x, y: sp.y, dirX: 0, dirY: 0, cosHalf: -2, range: 7, intensity: 0.2 + 0.5 * beat, r: 0.3, g: 0.6, b: 1, skin: 0.8 });
    for (const f of this.fixedLights) {
      // mostly steady with a slow wobble, and every so often a brief dropout
      const t = this.time + f.phase;
      const drop = Math.sin(t * 0.37) > 0.93 && Math.sin(t * 23) > -0.2 ? 0.15 : 1;
      f.intensity = f.base * (0.85 + 0.15 * Math.sin(t * 3.1)) * drop;
      out.push(f);
    }
    this.security.addLights(out);
    const vb = stage.viewBounds(v2);
    lighting.update(stage.camX, stage.camY, vb.x, vb.y, (o, gw, gh, ox, oy, ts) => rasterPixels(this.pixels, this.interior, o, gw, gh, ox, oy, ts));
  }

  private fixedStep(input: Input): void {
    const dt = FIXED_DT;
    // flight assist holds the ship still relative to the air (none in vacuum)
    this.ctx.field.sample(this.ship.x, this.ship.y, sample);
    const air = Math.min(1, sample.gas / 0.5);
    this.ship.refVx = sample.vx * air;
    this.ship.refVy = sample.vy * air;
    if (this.walk.attached) {
      this.ship.idleEngines();
      this.walk.fixedUpdate(dt, this.controls.move);
    } else this.ship.control(this.controls, dt);
    this.stepArms(dt);
    this.updateConspicuity();
    this.ship.updateShield(dt);
    this.slots[0].fixedUpdate(dt, input.down('Mouse0'));
    this.slots[1].fixedUpdate(dt, input.down('Mouse2'));
    this.hazards.update(dt);
    this.pixels.flush();
    this.welder.fixedUpdate();
    this.power.fixedUpdate();
    this.devices.fixedUpdate(dt);
    this.machinery.fixedUpdate(dt);
    this.security.fixedUpdate(dt);
    this.projectiles.step(dt);
    this.applyFieldForces(dt);
    this.cullFarBodies();
    const pv = this.ship.body.linvel();
    this.preVel.x = pv.x;
    this.preVel.y = pv.y;
    this.physics.step();
    this.pixels.syncTransforms();
    this.applyDamage(dt);
  }

  private stepArms(dt: number): void {
    const arms = this.arms;
    const before = arms.held;
    // the harpoon clamp already holds something: the arms stay out of it
    arms.fixedUpdate(dt, this.grapple.state !== 'clamped');
    if (arms.held && arms.held !== before) {
      // caught: the arms take over from the harpoon line if it was on the same body
      if (this.grapple.targetObject === arms.held) this.grapple.detach();
      const c = arms.held.body.worldCom();
      this.sound.emit('grab', c.x, c.y, 1);
    }
    for (const l of arms.landed) this.sound.emit('foot', l.x, l.y, l.e);
    // footfalls on a hull send small vibration pulses (see Scanner)
    this.footPingT -= dt;
    if (this.walk.attached && arms.landed.length && this.footPingT <= 0) {
      const l = arms.landed[0];
      this.scanner.ping(this.walk.surfaceBody ?? this.pixels.terrain, l.x, l.y, 6, 0.75);
      this.footPingT = 0.45;
    }
    arms.landed.length = 0;
  }

  /** V: knock on whatever the ship is touching (or standing on) and scan it. */
  private knock(): void {
    if (this.knockT > 0 || !this.ship.alive) return;
    const sh = this.ship;
    let obj: PixelObject | null = this.walk.attached ? (this.walk.surfaceBody ?? this.pixels.terrain) : null;
    let hx = sh.x;
    let hy = sh.y;
    if (obj) {
      hx = sh.x - this.walk.nx * this.walk.gap;
      hy = sh.y - this.walk.ny * this.walk.gap;
    } else {
      // nearest matter within arm's reach
      let best = 4;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const hit = this.pixels.raycast(sh.x, sh.y, Math.cos(a), Math.sin(a), best);
        if (hit) {
          best = hit.dist;
          obj = hit.target;
          hx = hit.x;
          hy = hit.y;
        }
      }
    }
    if (!obj) return;
    this.knockT = 0.8;
    this.scanner.ping(obj, hx, hy, 16, 1);
    this.sound.emit('clunk', hx, hy, 0.5);
  }

  /** Gas flow drags bodies toward its velocity, scaled by density and exposed area. */
  private applyFieldForces(dt: number): void {
    const { field } = this.ctx;
    const push = (body: Body, area: number) => {
      const c = body.worldCom();
      field.sample(c.x, c.y, sample);
      if (sample.gas < 0.01) return;
      const v = body.linvel();
      const f = dragForce(sample, v.x, v.y, area, v2);
      body.applyImpulse({ x: f.x * dt, y: f.y * dt }, true);
    };
    for (const b of this.pixels.bodies) push(b.body, dragArea(b.body.mass()));
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
      if (b.tags.salvage || this.grapple.targetObject === b || this.arms.held === b) continue;
      const t = b.body.translation();
      if (t.x < -far || t.y < -far || t.x > this.worldW + far || t.y > this.worldH + far) this.pixels.removeBody(b);
    }
  }

  private applyDamage(dt: number): void {
    const s = tune.ship;
    const imp = tune.impact;
    let shipTouched = false;
    const pairs = new Set<string>();
    for (const cf of this.physics.contactForces) {
      if (cf.a === this.ship || cf.b === this.ship) {
        const other = cf.a === this.ship ? cf.b : cf.a;
        // held debris is a cushion (in the arms or on the clamp): touching it never counts as a
        // crash, and if only it takes the hit, the jolt through the hold doesn't either. Terrain
        // you're anchored to gets no such pass.
        const held = this.grapple.heldBody;
        if (other?.kind !== 'rope' && !(held && other === held) && other !== this.arms.held) shipTouched = true;
        // a loose body that hit faster than the arms can catch bounces off, not into them
        if (other?.kind === 'pixelBody') {
          const ob = other as PixelBody;
          const m = Math.min(this.ship.body.mass(), ob.body.mass());
          if ((cf.force * dt) / m > tune.arms.grabSpeed) this.arms.knock(ob);
        }
        // pinned by a machine: instant death (a glancing knock is just normal impact damage)
        if (other?.kind === 'pixelBody' && (other as PixelBody).tags.machine && cf.force > s.crushForce) {
          this.ship.damage(Infinity, 'crushed');
          this.app.stage.shake(1);
          continue;
        }
        continue;
      }
      if (cf.a?.kind === 'rope' || cf.b?.kind === 'rope') continue;
      const j = cf.force * dt; // impulse this step (N·s)
      // collisions sound once, when contact starts (resting contact reports every step)
      const key = `${cf.h1}:${cf.h2}`;
      pairs.add(key);
      if (!this.touchingPairs.has(key) && j > 20) {
        const p = this.physics.contactPoint(cf.h1, cf.h2);
        if (p) this.sound.emit('impact', p.x, p.y, Math.min(1, j / 600), [cf.a, cf.b]);
      }
      // explosive bodies (barrels) go off when hit hard enough — whip them into things
      for (const o of [cf.a, cf.b]) {
        if (o?.kind !== 'pixelBody') continue;
        const b = o as PixelBody;
        if (b.alive && b.explosiveCells > 0 && j / b.body.mass() > imp.detonationDv) {
          const c = b.body.worldCom();
          this.hazards.trigger(c.x, c.y, 0);
        }
      }
      // heavy hits chip pixel matter at the contact point (both sides take it)
      if (j > imp.damageImpulse) {
        const p = this.physics.contactPoint(cf.h1, cf.h2);
        if (!p) continue;
        this.pixels.damageCircle(p.x, p.y, imp.damageRadius, (j - imp.damageImpulse) * imp.damageScale);
        for (let k = 0; k < 6; k++) this.particles.spark(p.x, p.y, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.25, 0.08, 0.3);
        const d = Math.hypot(p.x - this.ship.x, p.y - this.ship.y);
        this.app.stage.shake(Math.min(0.3, j / 20000) * Math.max(0, 1 - d / 40));
      }
    }
    // Crash damage comes from the physics, with no special cases: the ship's velocity change
    // over a step in which it touched something is the impact speed. Gentle contact (slow
    // winch docking, nudging crates) stays under the safe speed; slamming into anything hurts.
    this.touchingPairs = pairs;
    if (shipTouched && this.ship.alive) {
      const v = this.ship.body.linvel();
      const dv = Math.hypot(v.x - this.preVel.x, v.y - this.preVel.y);
      this.lastImpactSpeed = dv;
      // your own hull ringing: on first contact, or any real knock while scraping along
      if ((!this.shipTouchedLast && dv > 0.3) || dv > 1.5) this.sound.emit('clunk', this.ship.x, this.ship.y, Math.min(1, dv / 8));
      if (dv > s.safeImpactSpeed) {
        this.ship.damage((dv - s.safeImpactSpeed) * s.impactDamagePerSpeed, 'impact');
        this.app.stage.shake(Math.min(0.5, dv / 25));
      }
    }
    this.shipTouchedLast = shipTouched;
    if (this.ship.alive) {
      this.ctx.field.sample(this.ship.x, this.ship.y, sample);
      if (sample.heat > 0.3) this.ship.damage(s.heatDamage * sample.heat * dt, 'heat');
    }
    if (!this.ship.alive && !this.deathHandled) {
      this.deathHandled = true;
      this.grapple.detach();
      this.walk.detach();
      this.arms.detachAll();
      this.hazards.trigger(this.ship.x, this.ship.y, 0);
    }
  }

  private engineFx(): void {
    const sh = this.ship;
    if (!sh.alive) return;
    const a = sh.angle;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const v = sh.body.linvel();
    // RCS: braking jets fire on the side facing the drift, exhaust going with the drift
    if (sh.brake > 0.05 && Math.random() < 0.35 + sh.brake * 0.65) {
      const px = -sh.brakeDirY;
      const py = sh.brakeDirX;
      const off = (Math.random() - 0.5) * 1.2;
      const ox = sh.x + sh.brakeDirX * 0.9 + px * off;
      const oy = sh.y + sh.brakeDirY * 0.9 + py * off;
      const sp = 5 + Math.random() * 4;
      this.particles.glint(ox, oy, v.x + sh.brakeDirX * sp, v.y + sh.brakeDirY * sp, 0.75, 0.85, 1, 0.14 + Math.random() * 0.1, 0.09);
    }
    // RCS: turning jets at nose and tail, opposite sides
    if (sh.turnInput !== 0 && Math.random() < 0.7) {
      const t = sh.turnInput;
      for (const [along, side] of [
        [0.8, -t],
        [-1.1, t],
      ]) {
        const ox = sh.x + ca * along;
        const oy = sh.y + sa * along;
        const ex = -sa * side * 6;
        const ey = ca * side * 6;
        this.particles.glint(ox, oy, v.x + ex, v.y + ey, 0.75, 0.85, 1, 0.12, 0.08);
      }
    }
    if (sh.thrustLevel === 0) return;
    const dir = sh.thrustLevel > 0 ? -1 : 1;
    const ox = sh.x + ca * (dir < 0 ? -1.4 : 0.9);
    const oy = sh.y + sa * (dir < 0 ? -1.4 : 0.9);
    const sp = 6 + Math.random() * 4;
    const spread = (Math.random() - 0.5) * 2.5;
    const ex = ca * dir * sp - sa * spread + v.x;
    const ey = sa * dir * sp + ca * spread + v.y;
    if (dir < 0) this.particles.fire(ox, oy, ex, ey, 0.18, 0.18);
    else this.particles.spark(ox, oy, ex, ey, 0.15, 0.06, 0.2);
  }

  private updateCamera(dt: number): void {
    const sh = this.ship;
    const v = sh.body.linvel();
    const tx = this.debugCamera ? this.debugCamera.x : sh.x + v.x * 0.35 + (this.controls.aimX - sh.x) * 0.18;
    const ty = this.debugCamera ? this.debugCamera.y : sh.y + v.y * 0.35 + (this.controls.aimY - sh.y) * 0.18;
    const k = this.debugCamera ? 1 : 1 - Math.exp(-dt * 4);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    // roll so the walked-on surface is down; after letting go the camera keeps its angle
    // (there is no up in space)
    if (this.walk.attached && tune.camera.roll) {
      const target = Math.atan2(this.walk.ny, this.walk.nx) - Math.PI / 2;
      const err = Math.atan2(Math.sin(target - this.roll), Math.cos(target - this.roll));
      this.roll += err * (1 - Math.exp(-dt * tune.camera.rollRate));
    } else if (!tune.camera.roll) this.roll = 0;
    this.app.stage.setView(this.camX, this.camY, this.zoom, dt, this.roll);
    // gas/heat readback band: the view plus a margin (CPU coupling only matters near the player)
    const vb = this.app.stage.viewBounds(v2);
    this.app.field.setFocus(this.camY - vb.y - 25, this.camY + vb.y + 25);
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
    this.arms.dispose();
    this.scanner.dispose();
    this.app.audio.quiet();
    this.machinery.dispose();
    this.security.dispose();
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
