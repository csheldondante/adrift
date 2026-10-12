// What the player hears in one run: turns game events into sound on the right bus.
//
//   - Your own ship is always audible (self bus): power hum, thruster, jets, cutter, winch,
//     arm servos, clunks against your hull, footfalls, the lamp relay.
//   - Anything else reaches you only through a path:
//       conduction: the event is on an object you're in contact with: the surface you're
//                   walking on or touching, the body your arms hold, what the harpoon has bitten
//                   (weighted by how taut the line is). Machines count as part of the hull.
//                   Falls off slowly with distance (big hulls carry sound).
//       air:        atmosphere at both ends (gas field), falling off quickly with distance.
//     In open vacuum with nothing touching, the derelict is silent.
//   - Wind is air moving past the ship (gas density × relative speed), on the air bus.
//
// The game refreshes the listener once per frame (contacts, position, ship noise), and
// systems call emit() whenever something happens.
//
// Likely growth: a vibration field diffused through solid cells (like heat) instead of the
// "same object" test, so a wall cut between you and a machine actually muffles it; sensors
// that hear you through the hull.

import { tune } from '../config';
import type { FieldSample, GasField } from '../fields/GasField';
import type { PhysOwner } from '../physics/Physics';
import type { Stage } from '../render/Stage';
import type { AudioEngine, Bus } from './AudioEngine';

/** Something the ship is in mechanical contact with, and how well it carries sound (0..1). */
export interface Contact {
  obj: PhysOwner;
  w: number;
}

/** The ship's own running machinery this frame. */
export interface ShipNoise {
  alive: boolean;
  thrust: number; // 0..1
  rcs: number; // 0..1 jets firing
  cutter: boolean;
  cutting: boolean; // beam is on matter
  winch: number; // m/s line speed (+/-)
  servo: number; // m/s mean arm-tip speed
  vx: number;
  vy: number;
}

export type SoundKind =
  | 'clunk' // the ship's hull hit something (energy = impact speed / 8)
  | 'foot' // an arm planted or gripped
  | 'grab' // the arms caught something
  | 'release'
  | 'clamp' // hull-walk feet locked on
  | 'pushoff'
  | 'lamp'
  | 'fire' // harpoon launched
  | 'thunk' // harpoon bit into matter (heard up the line)
  | 'impact' // two things collided (not the ship)
  | 'slam' // a machine hit its stop
  | 'explosion';

/** Who receives emit(): systems depend on this, not on the audio engine. */
export interface SoundSink {
  emit(kind: SoundKind, x: number, y: number, energy: number, on?: readonly (PhysOwner | undefined)[]): void;
}

const s: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };
const sp = { x: 0, y: 0 };

export class Soundscape implements SoundSink {
  private x = 0;
  private y = 0;
  private air = 0;
  private contacts: Contact[] = [];
  /** Events heard per path (tests, tuning). `silent` = happened but no path reached you. */
  readonly heard = { self: 0, conduct: 0, air: 0, silent: 0 };
  /** Wind and room-tone levels last frame (tests, tuning). */
  readonly levels = { wind: 0, room: 0 };
  /** Events emitted per kind. */
  readonly count: Partial<Record<SoundKind, number>> = {};

  constructor(
    private readonly engine: AudioEngine,
    private readonly field: GasField,
    private readonly stage: Stage,
  ) {}

  /** Gas density as "how much air" 0..1. */
  private airAt(x: number, y: number): number {
    this.field.sample(x, y, s);
    return Math.min(1, s.gas / 0.6);
  }

  private pan(x: number, y: number, k = 0.8): number {
    this.stage.worldToScreen(x, y, sp);
    return Math.max(-1, Math.min(1, (sp.x / window.innerWidth - 0.5) * 2)) * k;
  }

  /** Per frame: where the listener is, what it touches, and what its own machinery is doing. */
  update(x: number, y: number, contacts: Contact[], n: ShipNoise, time: number): void {
    this.x = x;
    this.y = y;
    this.contacts = contacts;
    this.field.sample(x, y, s);
    const gas = s.gas;
    this.air = Math.min(1, gas / 0.6);
    const e = this.engine;
    e.update(this.air);
    if (!e.ready) return;
    if (!n.alive) {
      e.quiet();
      return;
    }
    const load = Math.min(1, n.thrust * 0.6 + (n.cutter ? 0.5 : 0) + Math.min(1, Math.abs(n.winch) / 6) * 0.3);
    e.hum.set(0.07 + load * 0.06, 1 + load * 0.18 + Math.sin(time * 0.7) * 0.01);
    e.thrust.set(n.thrust * 0.5, 0.9 + n.thrust * 0.3);
    e.rcs.set(Math.min(1, n.rcs) * 0.09);
    e.cutter.set(n.cutter ? 0.09 : 0, n.cutting ? 0.92 : 1);
    e.sizzle.set(n.cutting ? 0.07 + Math.random() * 0.04 : 0);
    const ws = Math.abs(n.winch);
    e.winch.set(ws > 0.15 ? Math.min(0.08, 0.03 + ws * 0.01) : 0, 90 + ws * 28);
    e.servo.set(Math.min(0.06, Math.max(0, n.servo - 0.3) * 0.012), 200 + Math.min(400, n.servo * 40));
    // wind: air moving past the hull; room tone: being in air at all
    const rel = Math.hypot(s.vx - n.vx, s.vy - n.vy);
    const g = Math.min(2, gas);
    this.levels.wind = Math.min(0.5, g * rel * 0.035);
    this.levels.room = this.air * 0.05;
    e.wind.set(Math.min(0.5, g * rel * 0.035), 220 + Math.min(2600, rel * 90));
    e.room.set(this.air * 0.05);
  }

  /** How well an event on `on` conducts to the listener (0..1) at distance d. */
  private conduction(on: readonly (PhysOwner | undefined)[], d: number): number {
    let best = 0;
    for (const c of this.contacts) {
      for (const o of on) {
        if (!o) continue;
        // machines are bolted into the hull: touching the hull you hear them, and vice versa
        const same = o === c.obj || (isHull(o) && isHull(c.obj));
        if (same) best = Math.max(best, c.w);
      }
    }
    return best / (1 + d / tune.audio.conductRange);
  }

  emit(kind: SoundKind, x: number, y: number, energy: number, on: readonly (PhysOwner | undefined)[] = []): void {
    this.count[kind] = (this.count[kind] ?? 0) + 1;
    const e = this.engine;
    const k = Math.max(0, Math.min(1, energy));
    const pan = this.pan(x, y);
    // ------- the ship's own sounds: always heard
    switch (kind) {
      case 'clunk':
        this.heard.self++;
        if (!e.ready) return;
        e.metal('self', 0.25 + k * 0.75, 140 + Math.random() * 40, 0.5 + k * 0.9, pan * 0.4, 0.8);
        e.thump('self', 0.4 + k * 0.6, pan * 0.4);
        return;
      case 'foot':
        this.heard.self++;
        if (e.ready) e.metal('self', 0.08 + k * 0.12, 600 + Math.random() * 200, 0.12, pan * 0.5, 0.5);
        return;
      case 'grab':
        this.heard.self++;
        if (!e.ready) return;
        e.metal('self', 0.35, 330, 0.5, pan * 0.5, 0.7);
        e.click('self', 0.3);
        return;
      case 'release':
        this.heard.self++;
        if (e.ready) e.click('self', 0.35);
        return;
      case 'clamp':
        this.heard.self++;
        if (!e.ready) return;
        e.thump('self', 0.45, pan * 0.4);
        e.click('self', 0.4);
        return;
      case 'pushoff':
        this.heard.self++;
        if (e.ready) e.thump('self', 0.55);
        return;
      case 'lamp':
        this.heard.self++;
        if (e.ready) e.click('self', 0.5);
        return;
      case 'fire':
        this.heard.self++;
        if (!e.ready) return;
        e.thump('self', 0.6);
        e.zip('self', 0.25, 2600, 700, 0.35, pan * 0.3);
        return;
    }
    // ------- everything else needs a path to the listener
    const d = Math.hypot(x - this.x, y - this.y);
    let cond = this.conduction(on, d);
    if (kind === 'thunk') cond = Math.max(cond, 1 / (1 + d / tune.audio.conductRange)); // straight up the line
    const air = this.air * this.airAt(x, y) / (1 + d / tune.audio.airRange);
    if (cond < 0.01 && air < 0.01) {
      this.heard.silent++;
      return;
    }
    if (cond >= 0.01) this.heard.conduct++;
    if (air >= 0.01) this.heard.air++;
    if (!e.ready) return;
    const play = (bus: Bus, g: number, p: number) => {
      if (g < 0.01) return;
      switch (kind) {
        case 'explosion':
          e.boom(bus, g * (0.6 + k * 0.4), p);
          break;
        case 'slam':
          e.metal(bus, g * (0.4 + k * 0.6), 70 + Math.random() * 15, 1.6, p, 0.9);
          e.thump(bus, g * k, p);
          break;
        case 'thunk':
          e.metal(bus, g * (0.4 + k * 0.4), 260 + Math.random() * 60, 0.7, p, 0.8);
          break;
        default: // impact
          e.metal(bus, g * (0.15 + k * 0.7), 110 + Math.random() * 180, 0.4 + k * 0.9, p, 0.85);
          if (k > 0.4) e.thump(bus, g * k * 0.7, p);
      }
    };
    play('conduct', cond, pan * 0.3);
    play('air', air, pan);
  }
}

/** Terrain and kinematic machines are one structure as far as sound is concerned. */
function isHull(o: PhysOwner): boolean {
  return o.kind === 'terrain' || (o.kind === 'pixelBody' && !!(o as unknown as { tags: { machine?: boolean } }).tags.machine);
}
