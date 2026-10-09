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

const SPRITE = [
  'DD....................',
  'DWWD..................',
  '.DWWWD................',
  '..DWWWWDD.............',
  '..DGWWWWWWDD..........',
  '.OGGWWWWCCWWWDD.......',
  'OOGGWWWWCCCCWWWWWWD...',
  'OOGGWWWWCCCCWWWWWWD...',
  '.OGGWWWWCCWWWDD.......',
  '..DGWWWWWWDD..........',
  '..DWWWWDD.............',
  '.DWWWD................',
  'DWWD..................',
  'DD....................',
];
const PALETTE: Record<string, string> = { W: '#e6ebf2', G: '#97a2b3', D: '#384051', C: '#4fd3ff', O: '#ff8a3a' };

function spriteTexture(): THREE.CanvasTexture {
  const h = SPRITE.length;
  const w = SPRITE[0].length;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  SPRITE.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (PALETTE[ch]) {
        g.fillStyle = PALETTE[ch];
        g.fillRect(x, y, 1, 1);
      }
    }),
  );
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Ship implements PhysOwner {
  readonly kind = 'ship' as const;
  readonly body: Body;
  readonly collider: Collider;
  readonly group = new THREE.Group();
  private readonly flame: THREE.Mesh;
  health = tune.ship.maxHealth;
  thrustLevel = 0;
  /** RCS braking this step, 0..1, and the drift direction it opposes (for jet visuals). */
  brake = 0;
  brakeDirX = 0;
  brakeDirY = 0;
  turnInput = 0;
  alive = true;

  /** Ship-local nose position in meters (+x forward). */
  static readonly NOSE = { x: 0.95, y: 0 };

  constructor(
    private readonly physics: Physics,
    x: number,
    y: number,
    angle: number,
  ) {
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setCcdEnabled(true));
    const hull = new Float32Array([0.95, 0, -1.3, 0.85, -1.3, -0.85]);
    const desc = R.ColliderDesc.convexHull(hull)!
      .setDensity(tune.ship.density)
      .setFriction(0.3)
      .setRestitution(0.2)
      .setCollisionGroups(SHIP_GROUPS)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(tune.ship.contactEventThreshold);
    this.collider = physics.createCollider(desc, this.body, this);

    const w = SPRITE[0].length * CELL;
    const h = SPRITE.length * CELL;
    const sprite = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: spriteTexture(), transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false }),
    );
    // sprite pixel column 11 / row 7 sits at the body origin
    sprite.position.set(w / 2 - 11 * CELL, 0, 0);
    sprite.renderOrder = ORDER.ship;
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthTest: false, depthWrite: false });
    flameMat.blending = THREE.AdditiveBlending;
    const flameGeo = new THREE.PlaneGeometry(1, 0.32);
    flameGeo.translate(-0.5, 0, 0);
    this.flame = new THREE.Mesh(flameGeo, flameMat);
    this.flame.position.set(-1.35, 0, 0);
    this.flame.renderOrder = ORDER.ship - 1;
    this.group.add(sprite, this.flame);
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
    const f = c.thrust > 0 ? c.thrust * s.thrust : c.thrust * s.reverseThrust;
    this.thrustLevel = c.thrust;
    if (f !== 0) this.body.applyImpulse({ x: Math.cos(a) * f * dt, y: Math.sin(a) * f * dt }, true);
    // Flight assist: when not thrusting, RCS jets push against drift with a bounded force.
    // It's a real force on the ship (towed loads slow far less), shown as jet puffs.
    this.brake = 0;
    if (c.thrust === 0 && s.flightAssist && s.brakeForce > 0) {
      const v = this.body.linvel();
      const speed = Math.hypot(v.x, v.y);
      if (speed > 0.03) {
        const j = Math.min(s.brakeForce * dt, this.body.mass() * speed);
        this.body.applyImpulse({ x: (-v.x / speed) * j, y: (-v.y / speed) * j }, true);
        this.brake = j / (s.brakeForce * dt);
        this.brakeDirX = v.x / speed;
        this.brakeDirY = v.y / speed;
      }
    }
    this.turnInput = c.turn;
    // Turning is a rate controller with bounded angular acceleration: A/D drive spin toward
    // ±turnRate, release brakes to zero (if assist is on). It still acts through torque, so
    // impacts and off-center loads can knock the ship around and it has to recover.
    const target = c.turn !== 0 ? c.turn * s.turnRate : s.rotationAssist ? 0 : null;
    if (target !== null) {
      const maxDw = s.turnAccel * dt;
      const dw = Math.max(-maxDw, Math.min(maxDw, target - this.body.angvel()));
      if (dw !== 0) this.body.applyTorqueImpulse(dw * this.body.principalInertia(), true);
    }
  }

  /** What finished the ship off (for the death banner and tests). */
  deathCause = '';

  damage(amount: number, cause = 'damage'): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.alive = false;
      this.deathCause = cause;
    }
  }

  sync(time: number): void {
    const t = this.body.translation();
    this.group.position.set(t.x, t.y, 0);
    this.group.rotation.z = this.body.rotation();
    const thrust = Math.max(0, this.thrustLevel);
    this.flame.visible = this.alive && thrust > 0;
    this.flame.scale.set(0.6 + thrust * 0.9 + Math.sin(time * 60) * 0.12, 1 + Math.sin(time * 37) * 0.15, 1);
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
