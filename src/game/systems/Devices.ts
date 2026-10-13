// Ship systems built into the walls, brought to life from level DeviceSpecs:
//   - door: a slab that slides open while its motor cell is powered (and shut when it isn't)
//   - pressureDoor: a slab of the toughest cuttable material that opens while the chamber
//     at its sensor holds air, and shuts when it loses it (hysteresis between the two)
//   - pump: pours air in at its outlet while its pump cell is powered, up to a target
//   - hatch: a door you open and shut yourself (G at its panel) while the panel is powered
//   - airlock: two interlocked doors around a chamber, plus a vent valve. Using a panel
//     cycles it: shut the open door, vent the chamber (going out) or pump it up (going in)
//     until it matches the far side, then open the far door. Both doors are never open at
//     once, so the pressure behind it stays put.
//
// Doors move by painting terrain (like the security bulkheads), so colliders, the gas wall
// mask, lighting and the vibration of the hull all follow from the matter. A door you've cut
// a hole in keeps the hole; closing only fills cells the slab sweeps back over. Venting is a
// real slot opening to the outside, so the gas field does the rest (wind, sound, pushing).
//
// Likely growth: switches, sensors that wake security when a section powers, panels you can
// hotwire with the cutter.

import { CELL } from '../../config';
import type { FieldSample } from '../../fields/GasField';
import { M } from '../../pixel/materials';
import type { DeviceSpec, P, Rect4 } from '../level/types';
import type { GameContext } from '../types';
import type { PowerNet } from './PowerNet';

const s: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const DOOR_TIME = 1.4; // s to slide fully open or shut
const USE_RANGE = 4.5; // m from the ship to a panel
const MATCH = 0.1; // gas difference at which an airlock counts as equalized
const CYCLE_MAX = 9; // s an airlock vents or pumps before opening anyway

type DoorSpec = Extract<DeviceSpec, { type: 'door' | 'pressureDoor' | 'hatch' }> | { type: 'lock' | 'valve'; x0: number; y0: number; x1: number; y1: number };

interface Door {
  spec: DoorSpec;
  mat: number;
  /** 0 = shut, 1 = open. */
  t: number;
  open: boolean;
  /** Slides along the long axis: vertical slabs rise, horizontal ones slide right. */
  vertical: boolean;
  /** Moves only while this motor cell is powered (hatches and airlocks); null = always. */
  power: P | null;
}

export interface Airlock {
  spec: Extract<DeviceSpec, { type: 'airlock' }>;
  inner: Door;
  outer: Door;
  valve: Door;
  state: 'in' | 'out' | 'toIn' | 'toOut';
  timer: number;
}

const rectSpec = (type: 'lock' | 'valve', r: Rect4) => ({ type, x0: r[0], y0: r[1], x1: r[2], y1: r[3] });

export class Devices {
  readonly doors: Door[] = [];
  readonly airlocks: Airlock[] = [];
  private readonly pumps: Extract<DeviceSpec, { type: 'pump' }>[] = [];
  /** Panels you can use: the door or airlock each one works. */
  private readonly panels: { cell: P; door?: Door; lock?: Airlock }[] = [];
  /** Pumps running this step (tests, sound). */
  pumping = 0;
  /** Panel uses so far (tests). */
  uses = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly power: PowerNet,
    specs: DeviceSpec[],
  ) {
    for (const d of specs) {
      if (d.type === 'pump') this.pumps.push(d);
      else if (d.type === 'airlock') {
        const p = d.panels[0];
        const inner = this.addDoor(rectSpec('lock', d.inner), M.PDOOR, true, d.motors?.inner ?? p);
        const outer = this.addDoor(rectSpec('lock', d.outer), M.PDOOR, false, d.motors?.outer ?? p);
        const valve = this.addDoor(rectSpec('valve', d.valve), M.HULL, false, d.motors?.valve ?? p);
        const lock: Airlock = { spec: d, inner, outer, valve, state: 'in', timer: 0 };
        this.airlocks.push(lock);
        for (const c of d.panels) {
          ctx.pixels.paintTerrain(c.x - 1, c.y - 2, c.x + 2, c.y + 3, M.PANEL, false);
          this.panels.push({ cell: c, lock });
        }
      } else if (d.type === 'hatch') {
        const door = this.addDoor(d, M.PDOOR, d.open ?? false, d.motor ?? d.panel);
        ctx.pixels.paintTerrain(d.panel.x - 1, d.panel.y - 2, d.panel.x + 2, d.panel.y + 3, M.PANEL, false);
        this.panels.push({ cell: d.panel, door });
      } else this.addDoor(d, d.type === 'door' ? d.mat : M.PDOOR, false, null);
    }
  }

  private addDoor(spec: DoorSpec, mat: number, open: boolean, power: P | null): Door {
    const door: Door = { spec, mat, t: open ? 1 : 0, open, vertical: spec.y1 - spec.y0 >= spec.x1 - spec.x0, power };
    this.doors.push(door);
    if (!open) this.ctx.pixels.paintTerrain(spec.x0, spec.y0, spec.x1, spec.y1, mat, false);
    else this.ctx.pixels.paintTerrain(spec.x0, spec.y0, spec.x1, spec.y1, M.EMPTY, false);
    return door;
  }

  /** The panel within reach of (x, y) meters, nearest first, or null. */
  panelNear(x: number, y: number): { cell: P; door?: Door; lock?: Airlock; powered: boolean } | null {
    let best: (typeof this.panels)[number] | null = null;
    let bd = USE_RANGE * USE_RANGE;
    for (const p of this.panels) {
      const d = ((p.cell.x + 0.5) * CELL - x) ** 2 + ((p.cell.y + 0.5) * CELL - y) ** 2;
      if (d < bd) [bd, best] = [d, p];
    }
    return best && { ...best, powered: this.power.powered(best.cell.x, best.cell.y) };
  }

  /** G: works the nearest panel. Returns what happened, for the HUD. */
  use(x: number, y: number): string {
    const p = this.panelNear(x, y);
    if (!p) return '';
    if (!p.powered) return 'The panel is dead: no power on its line';
    this.uses++;
    const c = { x: (p.cell.x + 0.5) * CELL, y: (p.cell.y + 0.5) * CELL };
    this.ctx.sound.emit('clunk', c.x, c.y, 0.35);
    if (p.door) {
      p.door.open = !p.door.open;
      return p.door.open ? 'Opening' : 'Closing';
    }
    const l = p.lock!;
    if (l.state === 'toIn' || l.state === 'toOut') return 'Airlock is cycling';
    l.state = l.state === 'in' ? 'toOut' : 'toIn';
    l.timer = 0;
    return l.state === 'toOut' ? 'Cycling out: closing, venting' : 'Cycling in: closing, pressurizing';
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
    for (const l of this.airlocks) this.cycle(l, dt);
    for (const d of this.doors) {
      const sp = d.spec;
      if (sp.type === 'door') d.open = this.power.powered(sp.motor.x, sp.motor.y);
      else if (sp.type === 'pressureDoor') {
        field.sample(sp.sensor.x, sp.sensor.y, s);
        if (s.gas >= sp.open) d.open = true;
        else if (s.gas < sp.close) d.open = false;
      }
      if (d.power && !this.power.powered(d.power.x, d.power.y)) continue; // no power: stuck
      const prev = d.t;
      d.t = Math.max(0, Math.min(1, d.t + ((d.open ? 1 : -1) * dt) / DOOR_TIME));
      if (d.t !== prev) this.slide(d, prev);
    }
  }

  /** One airlock's cycle: shut both, equalize with the far side, open the far door. */
  private cycle(l: Airlock, dt: number): void {
    if (l.state === 'in' || l.state === 'out') return;
    const sp = l.spec;
    const out = l.state === 'toOut';
    l.inner.open = false;
    l.outer.open = false;
    if (l.inner.t > 0 || l.outer.t > 0) return; // still shutting
    if (!this.power.powered(sp.panels[0].x, sp.panels[0].y)) return;
    l.timer += dt;
    const field = this.ctx.field;
    const chamber = field.sample(sp.chamber.x, sp.chamber.y, s).gas;
    const far = field.sample(out ? sp.outside.x : sp.inside.x, out ? sp.outside.y : sp.inside.y, s).gas;
    let done = Math.abs(chamber - far) < MATCH || l.timer > CYCLE_MAX;
    if (out) l.valve.open = !done;
    else if (!done) {
      if (chamber < far) {
        field.inject(sp.chamber.x, sp.chamber.y, 1.5, sp.rate * dt, 0);
        this.pumping++;
      } else done = true;
    }
    if (done && l.valve.t === 0) {
      l.state = out ? 'out' : 'in';
      (out ? l.outer : l.inner).open = true;
      this.ctx.sound.emit('clunk', sp.chamber.x, sp.chamber.y, 0.5);
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
