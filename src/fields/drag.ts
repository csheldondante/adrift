// Gas drag on bodies: the one formula both the physics push (Game.applyFieldForces) and
// anything that needs to predict it (security telling wind-blown junk from carried junk) use,
// so the two can't disagree.

import { tune } from '../config';
import type { FieldSample } from './GasField';

/** Effective drag area (m²) of a pixel body of this mass. */
export const dragArea = (mass: number) => Math.min(8, mass / 60);

/** Drag force (N) on a body moving at (vx, vy) through the sampled gas, written into out. */
export function dragForce(s: FieldSample, vx: number, vy: number, area: number, out: { x: number; y: number }): { x: number; y: number } {
  if (s.gas < 0.01) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const k = tune.gas.pushStrength * Math.min(s.gas, 3) * area;
  out.x = k * (s.vx - vx);
  out.y = k * (s.vy - vy);
  return out;
}
