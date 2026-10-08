// Thin wrapper over the Rapier world: owns the world + event queue and maps collider handles
// back to game objects. Game code talks to Rapier directly for body/collider details; this
// class only centralizes lifecycle and lookup so removal never leaves dangling handles.

import RAPIER from '@dimforge/rapier2d-compat';

export type Body = RAPIER.RigidBody;
export type Collider = RAPIER.Collider;

/** Anything that owns colliders. `kind` lets queries filter without instanceof chains. */
export interface PhysOwner {
  readonly kind: 'terrain' | 'pixelBody' | 'ship';
}

export interface ContactForce {
  a: PhysOwner | undefined;
  b: PhysOwner | undefined;
  force: number;
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

  step(): void {
    this.world.step(this.events);
    this.contactForces.length = 0;
    this.events.drainContactForceEvents((e) => {
      this.contactForces.push({
        a: this.owners.get(e.collider1()),
        b: this.owners.get(e.collider2()),
        force: e.totalForceMagnitude(),
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
