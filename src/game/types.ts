// Shared contracts between the game composition root and its systems. Systems receive a
// GameContext instead of the Game class so they stay testable and don't import each other.

import type * as THREE from 'three/webgpu';
import type { GasField } from '../fields/GasField';
import type { Physics } from '../physics/Physics';
import type { PixelWorld } from '../pixel/PixelWorld';
import type { Particles } from '../render/Particles';
import type { Stage } from '../render/Stage';
import type { Ship } from './Ship';
import type { Hazards } from './Hazards';

/** Per-step control intents, decoupled from devices so AI/replays can drive them later. */
export interface Controls {
  thrust: number; // 0..1 forward (Space)
  reel: number; // -1 reel in .. 1 reel out
  move: number; // -1..1 walking along a surface (A/D, screen left/right)
  aimX: number; // world meters; the ship steers to face this point
  aimY: number;
}

export interface GameContext {
  readonly physics: Physics;
  readonly pixels: PixelWorld;
  readonly field: GasField;
  readonly particles: Particles;
  readonly stage: Stage;
  readonly ship: Ship;
  readonly hazards: Hazards;
  readonly controls: Controls;
  /** Root for per-run transient visuals (beams, ropes, markers). */
  readonly fx: THREE.Group;
}

/** A ship tool slot (cutter, grapple, later weapons). Slots are swappable. */
export interface Tool {
  readonly name: string;
  press(): void;
  release(): void;
  fixedUpdate(dt: number, held: boolean): void;
  frameUpdate(dt: number): void;
  status(): string;
  dispose(): void;
}
