// Player ship: a Newtonian rigid body driven by thrust and torque. No linear drag; optional
// rotation assist damps spin when no turn input is held (a tunable testing aid).
//
// Likely growth: enemy/AI ships reuse this with a different Controls source; damage
// model may become pixel-based (ship as PixelBody) — keep health logic in one place.

import * as THREE from 'three/webgpu';
import { CELL, tune } from '../config';
import { SHIP_GROUPS, type Body, type Collider, type PhysOwner, type Physics } from '../physics/Physics';
import { ORDER } from '../render/order';
import type { Controls } from './types';

// The probe: a round deep-sea-style hull (see the concept art in IDEAS), drawn procedurally
// at the world's pixel scale (8 px/m) so it matches the pixel matter around it. Facing +x.
//   off-white plates with grime, a yellow/black hazard ring band around the middle with the
//   harpoon winch drum at its hub (the line pays out from the center), a cockpit window and
//   lamp at the nose, twin thrusters at the back, orange running lights.
const RX = 1.15; // m, hull half-length
const RY = 0.95; // m, hull half-height
const PPM = 8; // sprite pixels per meter (= 1 / CELL)

function probeTexture(): { tex: THREE.CanvasTexture; w: number; h: number } {
  const w = Math.ceil((RX + 0.35) * 2 * PPM);
  const h = Math.ceil(RY * 2 * PPM) + 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const px = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };
  const cx = w / 2;
  const cy = h / 2;
  // meters (ship frame, y up) at a pixel center
  const at = (x: number, y: number) => ({ mx: (x + 0.5 - cx) / PPM, my: (cy - y - 0.5) / PPM });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const { mx, my } = at(x, y);
      // twin thrusters behind the hull
      if (mx < -RX + 0.15 && mx > -RX - 0.3 && Math.abs(Math.abs(my) - 0.42) < 0.17) {
        px(x, y, mx < -RX - 0.18 ? '#20232a' : '#5a6270');
        continue;
      }
      const e = (mx / RX) ** 2 + (my / RY) ** 2;
      if (e > 1) continue;
      let col = '#e2ddd0';
      if (e > 0.8) col = '#2b2e36'; // rim
      else if (my < -0.25 + mx * 0.1) col = '#b9b4a6'; // shadowed lower plates
      if (e <= 0.8 && (Math.abs(mx - 0.38) < 0.04 || Math.abs(my) < 0.03)) col = '#6d6a62'; // panel seams
      // grime flecks
      if (e <= 0.8 && ((x * 7 + y * 13) % 17 === 0)) col = '#9a968a';
      // hazard ring band (the rotating ring) around the middle
      if (Math.abs(mx + 0.12) < 0.13 && e <= 0.97) col = Math.floor((my + 2) * 4) % 2 ? '#e8a524' : '#1b1d22';
      // winch drum at the hub
      const dr = Math.hypot(mx + 0.12, my);
      if (dr < 0.27) col = dr < 0.12 ? '#e8a524' : '#1b1d22';
      // cockpit window
      const wr = Math.hypot((mx - 0.6) / 1.2, my - 0.3);
      if (wr < 0.22) col = wr < 0.16 ? (my > 0.36 ? '#bff0ff' : '#4fb8e0') : '#2b2e36';
      // orange running lights top and bottom
      if (Math.abs(mx - 0.2) < 0.07 && Math.abs(Math.abs(my) - 0.82) < 0.07) col = '#ff8a3a';
      px(x, y, col);
    }
  // headlamp at the nose
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const { mx, my } = at(x, y);
      if (Math.abs(mx - RX + 0.05) < 0.1 && Math.abs(my + 0.05) < 0.12) px(x, y, '#fff3c4');
    }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return { tex: t, w, h };
}

export class Ship implements PhysOwner {
  readonly kind = 'ship' as const;
  readonly body: Body;
  readonly collider: Collider;
  readonly group = new THREE.Group();
  private readonly flame: THREE.Mesh;
  private readonly bubble: THREE.Mesh;
  private readonly bubbleMat: THREE.MeshBasicMaterial;
  health = tune.ship.maxHealth;
  shield = tune.ship.shieldMax;
  /** 0..1 visual pulse of the shield bubble (hits, recharge complete). */
  shieldFlash = 0;
  private sinceHit = 99;
  thrustLevel = 0;
  /** RCS braking this step, 0..1, and the drift direction it opposes (for jet visuals). */
  brake = 0;
  brakeDirX = 0;
  brakeDirY = 0;
  turnInput = 0;
  /**
   * Velocity the flight assist holds the ship at when idle: zero in vacuum, the local air's
   * velocity in atmosphere (set by the game each step from the gas field). So a transit tube
   * carries you, and a decompression takes you with it unless you're anchored.
   */
  refVx = 0;
  refVy = 0;
  alive = true;
  /** Headlamp on (F). You need it to see; sensors can see it too. */
  lampOn = true;
  /** 0..1 how noticeable the ship is to sensors (range multiplier), set by the game each step. */
  conspicuity = 1;

  /** Ship-local nose position in meters (+x forward). */
  static readonly NOSE = { x: RX, y: 0 };
  /** Hull half-extents (m). */
  static readonly RX = RX;
  static readonly RY = RY;

  constructor(
    private readonly physics: Physics,
    x: number,
    y: number,
    angle: number,
  ) {
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setCcdEnabled(true));
    // the round hull as a 12-gon
    const pts: number[] = [];
    for (let k = 0; k < 12; k++) pts.push(Math.cos((k / 12) * Math.PI * 2) * RX, Math.sin((k / 12) * Math.PI * 2) * RY);
    const desc = R.ColliderDesc.convexHull(new Float32Array(pts))!
      .setDensity(tune.ship.density)
      .setFriction(0.3)
      .setRestitution(0.2)
      .setCollisionGroups(SHIP_GROUPS)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(tune.ship.contactEventThreshold);
    this.collider = physics.createCollider(desc, this.body, this);

    const art = probeTexture();
    const sprite = new THREE.Mesh(
      new THREE.PlaneGeometry(art.w * CELL, art.h * CELL),
      new THREE.MeshBasicMaterial({ map: art.tex, transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false }),
    );
    sprite.renderOrder = ORDER.ship;
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthTest: false, depthWrite: false });
    flameMat.blending = THREE.AdditiveBlending;
    // twin thruster plumes (one mesh, two quads)
    const a = new THREE.PlaneGeometry(1, 0.24);
    a.translate(-0.5, 0.42, 0);
    const b = new THREE.PlaneGeometry(1, 0.24);
    b.translate(-0.5, -0.42, 0);
    const flameGeo = mergeQuads(a, b);
    this.flame = new THREE.Mesh(flameGeo, flameMat);
    this.flame.position.set(-RX - 0.3, 0, 0);
    this.flame.renderOrder = ORDER.glow;
    // shield bubble: invisible until it soaks a hit
    this.bubbleMat = new THREE.MeshBasicMaterial({ color: 0x6fd8ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.bubbleMat.blending = THREE.AdditiveBlending;
    this.bubble = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.8, 40), this.bubbleMat);
    this.bubble.renderOrder = ORDER.glow;
    this.group.add(sprite, this.flame);
    this.group.add(this.bubble);
  }

  get x(): number {
    return this.body.translation().x;
  }
  get y(): number {
    return this.body.translation().y;
  }
  get angle(): number {
    return this.body.rotation();
  }

  nose(out: { x: number; y: number }): { x: number; y: number } {
    const t = this.body.translation();
    const a = this.body.rotation();
    out.x = t.x + Math.cos(a) * Ship.NOSE.x;
    out.y = t.y + Math.sin(a) * Ship.NOSE.x;
    return out;
  }

  control(c: Controls, dt: number): void {
    if (!this.alive) return;
    const s = tune.ship;
    const a = this.body.rotation();
    const f = Math.max(0, c.thrust) * s.thrust;
    this.thrustLevel = c.thrust;
    if (f !== 0) this.body.applyImpulse({ x: Math.cos(a) * f * dt, y: Math.sin(a) * f * dt }, true);
    // Flight assist: when not thrusting, RCS jets push against drift (relative to the air
    // around the ship, see refVx) with a bounded force. It's a real force on the ship (towed
    // loads slow far less), shown as jet puffs.
    this.brake = 0;
    if (c.thrust === 0 && s.flightAssist && s.brakeForce > 0) {
      const lv = this.body.linvel();
      const v = { x: lv.x - this.refVx, y: lv.y - this.refVy };
      const speed = Math.hypot(v.x, v.y);
      if (speed > 0.03) {
        const j = Math.min(s.brakeForce * dt, this.body.mass() * speed);
        this.body.applyImpulse({ x: (-v.x / speed) * j, y: (-v.y / speed) * j }, true);
        this.brake = j / (s.brakeForce * dt);
        this.brakeDirX = v.x / speed;
        this.brakeDirY = v.y / speed;
      }
    }
    // Aim steering: the ship always turns to face the aim point. Desired spin is the fastest
    // rate that can still brake to zero by the target angle (√(2·accel·err)), capped by
    // turnRate, with a linear tail near zero so it settles without chatter. Applied through
    // bounded torque, so impacts and loads still knock the ship around and it recovers.
    const p = this.body.translation();
    const dx = c.aimX - p.x;
    const dy = c.aimY - p.y;
    if (dx * dx + dy * dy > 1.5 * 1.5) this.steerTo(Math.atan2(dy, dx), dt);
    else this.steerByError(null, dt);
  }

  /** Turns toward a world angle with the stopping-aware rate controller (also used by hull-walking). */
  steerTo(angle: number, dt: number): void {
    const a = this.body.rotation();
    this.steerByError(Math.atan2(Math.sin(angle - a), Math.cos(angle - a)), dt);
  }

  /** Not thrusting or braking (e.g. while the feet hold a surface). */
  idleEngines(): void {
    this.thrustLevel = 0;
    this.brake = 0;
  }

  private steerByError(err: number | null, dt: number): void {
    const s = tune.ship;
    let wantW = 0;
    if (err !== null) {
      const mag = Math.min(s.turnRate, Math.sqrt(2 * s.turnAccel * Math.abs(err)) * 0.85, Math.abs(err) * 14);
      wantW = Math.sign(err) * mag;
    }
    const maxDw = s.turnAccel * dt;
    const dw = Math.max(-maxDw, Math.min(maxDw, wantW - this.body.angvel()));
    if (dw !== 0) this.body.applyTorqueImpulse(dw * this.body.principalInertia(), true);
    // RCS turning puffs only for real steering effort, not settling
    this.turnInput = Math.abs(dw) > maxDw * 0.3 ? Math.sign(dw) : 0;
  }

  /** What finished the ship off (for the death banner and tests). */
  deathCause = '';

  /**
   * Applies damage: the recharging shield soaks it first, the hull takes the rest. Infinite
   * damage (crushing) bypasses the shield.
   */
  damage(amount: number, cause = 'damage'): void {
    if (!this.alive || amount <= 0) return;
    this.sinceHit = 0;
    if (Number.isFinite(amount) && this.shield > 0) {
      const soaked = Math.min(this.shield, amount);
      this.shield -= soaked;
      amount -= soaked;
      this.shieldFlash = Math.min(1, this.shieldFlash + 0.25 + soaked / 30);
      if (amount <= 0) return;
    }
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.alive = false;
      this.deathCause = cause;
    }
  }

  /** Shield recharge after a quiet period; call each physics step. */
  updateShield(dt: number): void {
    const s = tune.ship;
    this.sinceHit += dt;
    if (this.alive && this.sinceHit > s.shieldDelay && this.shield < s.shieldMax) {
      const before = this.shield;
      this.shield = Math.min(s.shieldMax, this.shield + s.shieldRegen * dt);
      if (before < s.shieldMax && this.shield >= s.shieldMax) this.shieldFlash = Math.max(this.shieldFlash, 0.35); // "fully charged" blip
    }
  }

  sync(time: number): void {
    const t = this.body.translation();
    this.group.position.set(t.x, t.y, 0);
    this.group.rotation.z = this.body.rotation();
    const thrust = Math.max(0, this.thrustLevel);
    this.flame.visible = this.alive && thrust > 0;
    this.flame.scale.set(0.6 + thrust * 0.9 + Math.sin(time * 60) * 0.12, 1 + Math.sin(time * 37) * 0.15, 1);
    this.shieldFlash *= 0.9;
    this.bubbleMat.opacity = this.shieldFlash * 0.8;
    this.bubble.visible = this.shieldFlash > 0.02;
    this.group.visible = this.alive;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.MeshBasicMaterial;
        m.map?.dispose();
        m.dispose();
      }
    });
    this.group.removeFromParent();
    this.physics.removeBody(this.body);
  }
}

/** Two quads as one geometry (positions only, plus uvs). */
function mergeQuads(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pa = a.getAttribute('position').array as Float32Array;
  const pb = b.getAttribute('position').array as Float32Array;
  const ua = a.getAttribute('uv').array as Float32Array;
  const ub = b.getAttribute('uv').array as Float32Array;
  const ia = Array.from(a.getIndex()!.array);
  const ib = Array.from(b.getIndex()!.array).map((i) => i + pa.length / 3);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...pa, ...pb]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([...ua, ...ub]), 2));
  g.setIndex([...ia, ...ib]);
  a.dispose();
  b.dispose();
  return g;
}
