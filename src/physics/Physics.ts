// Thin wrapper over the Rapier world: owns the world + event queue and maps collider handles
// back to game objects. Game code talks to Rapier directly for body/collider details; this
// class only centralizes lifecycle and lookup so removal never leaves dangling handles.

import RAPIER from '@dimforge/rapier2d-compat';
import { tune } from '../config';

export type Body = RAPIER.RigidBody;
export type Collider = RAPIER.Collider;

/**
 * Collision groups (Rapier InteractionGroups: membership << 16 | filter). Colliders that
 * don't set groups are members of everything and collide with everything; only the
 * exceptions are listed here.
 */
export const GROUP = { SHIP: 0x0004, ROPE: 0x0008 } as const;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);
/** Ship: collides with everything except its own tether. */
export const SHIP_GROUPS = groups(GROUP.SHIP, 0xffff & ~GROUP.ROPE);
/** Rope segments: collide with world matter only (not the ship, not each other). */
export const ROPE_GROUPS = groups(GROUP.ROPE, 0xffff & ~(GROUP.ROPE | GROUP.SHIP));

/** Anything that owns colliders. `kind` lets queries filter without instanceof chains. */
export interface PhysOwner {
  readonly kind: 'terrain' | 'pixelBody' | 'ship' | 'rope';
}

export interface ContactForce {
  a: PhysOwner | undefined;
  b: PhysOwner | undefined;
  force: number;
  h1: number; // collider handles, for contact-point queries
  h2: number;
}

let initialized = false;
export async function initPhysics(): Promise<void> {
  if (initialized) return;
  await RAPIER.init();
  initialized = true;
}

export class Physics {
  readonly R = RAPIER;
  readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  private readonly owners = new Map<number, PhysOwner>();
  readonly contactForces: ContactForce[] = [];

  constructor(dt: number) {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = dt;
    this.events = new RAPIER.EventQueue(true);
    // extra iterations keep light rope segments from stretching under heavy loads
    this.world.numSolverIterations = tune.physics.solverIterations;
  }

  createCollider(desc: RAPIER.ColliderDesc, body: Body, owner: PhysOwner): Collider {
    const c = this.world.createCollider(desc, body);
    this.owners.set(c.handle, owner);
    return c;
  }

  removeCollider(c: Collider): void {
    this.owners.delete(c.handle);
    this.world.removeCollider(c, false);
  }

  removeBody(body: Body): void {
    for (let i = 0; i < body.numColliders(); i++) this.owners.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  ownerOf(c: Collider | number): PhysOwner | undefined {
    return this.owners.get(typeof c === 'number' ? c : c.handle);
  }


  /** First solver contact point (world) between two colliders this step, if any. */
  contactPoint(h1: number, h2: number): { x: number; y: number } | null {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    if (!c1 || !c2) return null;
    let p: { x: number; y: number } | null = null;
    this.world.contactPair(c1, c2, (m) => {
      if (!p && m.numSolverContacts() > 0) {
        const v = m.solverContactPoint(0);
        if (v) p = { x: v.x, y: v.y };
      }
    });
    return p;
  }
  step(): void {
    this.world.step(this.events);
    this.contactForces.length = 0;
    this.events.drainContactForceEvents((e) => {
      this.contactForces.push({
        a: this.owners.get(e.collider1()),
        b: this.owners.get(e.collider2()),
        force: e.totalForceMagnitude(),
        h1: e.collider1(),
        h2: e.collider2(),
      });
    });
    this.events.drainCollisionEvents(() => {});
  }

  dispose(): void {
    this.world.free();
    this.events.free();
    this.owners.clear();
  }
}
