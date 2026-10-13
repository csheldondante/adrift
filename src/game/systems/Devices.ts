// Ship systems built into the walls, brought to life from level DeviceSpecs:
//   - door: a slab that slides open while its motor cell is powered (and shut when it isn't)
//   - pressureDoor: a slab of the toughest cuttable material that opens while the chamber
//     at its sensor holds air, and shuts when it loses it (hysteresis between the two)
//   - pump: pours air in at its outlet while its pump cell is powered, up to a target
//
// Doors move by painting terrain (like the security bulkheads), so colliders, the gas wall
// mask, lighting and the vibration of the hull all follow from the matter. A door you've cut
// a hole in keeps the hole; closing only fills cells the slab sweeps back over.
//
// Likely growth: switches, airlock cycles, sensors that wake security when a section powers.

import type { FieldSample } from '../../fields/GasField';
import { M } from '../../pixel/materials';
import type { DeviceSpec } from '../level/types';
import type { GameContext } from '../types';
import type { PowerNet } from './PowerNet';

const s: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const DOOR_TIME = 1.4; // s to slide fully open or shut

interface Door {
  spec: Extract<DeviceSpec, { type: 'door' | 'pressureDoor' }>;
  mat: number;
  /** 0 = shut, 1 = open. */
  t: number;
  open: boolean;
  /** Slides along the long axis: vertical slabs rise, horizontal ones slide right. */
  vertical: boolean;
}

export class Devices {
  readonly doors: Door[] = [];
  private readonly pumps: Extract<DeviceSpec, { type: 'pump' }>[] = [];
  /** Pumps running this step (tests, sound). */
  pumping = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly power: PowerNet,
    specs: DeviceSpec[],
  ) {
    for (const d of specs) {
      if (d.type === 'pump') this.pumps.push(d);
      else {
        const mat = d.type === 'door' ? d.mat : M.PDOOR;
        const door: Door = { spec: d, mat, t: 0, open: false, vertical: d.y1 - d.y0 >= d.x1 - d.x0 };
        this.doors.push(door);
        ctx.pixels.paintTerrain(d.x0, d.y0, d.x1, d.y1, mat, false);
      }
    }
  }

  fixedUpdate(dt: number): void {
    const { field } = this.ctx;
    this.pumping = 0;
    for (const p of this.pumps) {
      if (!this.power.powered(p.cell.x, p.cell.y)) continue;
      field.sample(p.outlet.x, p.outlet.y, s);
      if (s.gas >= p.target) continue;
      this.pumping++;
      field.inject(p.outlet.x, p.outlet.y, 1.5, p.rate * dt, 0);
      if (Math.random() < 0.3) this.ctx.particles.smoke(p.outlet.x, p.outlet.y, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0.5, 0.12);
    }
    for (const d of this.doors) {
      const sp = d.spec;
      if (sp.type === 'door') d.open = this.power.powered(sp.motor.x, sp.motor.y);
      else {
        field.sample(sp.sensor.x, sp.sensor.y, s);
        if (s.gas >= sp.open) d.open = true;
        else if (s.gas < sp.close) d.open = false;
      }
      const prev = d.t;
      d.t = Math.max(0, Math.min(1, d.t + ((d.open ? 1 : -1) * dt) / DOOR_TIME));
      if (d.t !== prev) this.slide(d, prev);
    }
  }

  /** Repaints the band of the slab that moved between t = prev and d.t. */
  private slide(d: Door, prev: number): void {
    const { x0, y0, x1, y1 } = d.spec;
    const px = this.ctx.pixels;
    const lo = Math.min(prev, d.t);
    const hi = Math.max(prev, d.t);
    const opening = d.t > prev;
    // the open part grows from the low end, [y0, y0 + len·t) for vertical slabs (it retracts
    // upward into the wall) and [x0, x0 + len·t) for horizontal ones (it retracts right)
    if (d.vertical) {
      const a = Math.floor(y0 + (y1 - y0) * lo);
      const b = Math.ceil(y0 + (y1 - y0) * hi);
      if (opening) px.paintTerrain(x0, a, x1, b, M.EMPTY, false);
      else px.paintTerrain(x0, a, x1, b, d.mat, true);
    } else {
      const a = Math.floor(x0 + (x1 - x0) * lo);
      const b = Math.ceil(x0 + (x1 - x0) * hi);
      if (opening) px.paintTerrain(a, y0, b, y1, M.EMPTY, false);
      else px.paintTerrain(a, y0, b, y1, d.mat, true);
    }
  }
}
