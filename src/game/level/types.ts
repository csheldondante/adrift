// Level data contract: what a level builder produces and the Game consumes. Builders (the
// classic derelict, the dungeon generator, later file-based levels) only paint grids and
// describe entities; systems that bring entities to life read `entities` by type, so new
// kinds slot in without touching the builders' consumers.

import type { BodyInit } from '../../pixel/PixelBody';
import type { PixelGrid } from '../../pixel/PixelGrid';
import type { Zone } from '../Objective';

export interface BodySpec extends BodyInit {
  grid: PixelGrid;
}

export type P = { x: number; y: number };

/** A doorway between a room and a corridor (world meters). Alarms can seal these later. */
export interface DoorSpec {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 'v' = vertical opening in a left/right wall (corridor runs horizontally). */
  axis: 'v' | 'h';
  roomId: number;
}

/**
 * Ship systems in the walls (see game/systems/Devices.ts). Cells are terrain cell coords;
 * points are meters. Doors slide along their long axis.
 */
export type DeviceSpec =
  /** Opens while its motor cell (a conducting cell wired into the network) is powered. */
  | { type: 'door'; x0: number; y0: number; x1: number; y1: number; motor: P; mat: number }
  /** Opens while the gas at `sensor` (meters) is at least `open`; closes below `close`. */
  | { type: 'pressureDoor'; x0: number; y0: number; x1: number; y1: number; sensor: P; open: number; close: number }
  /** Pours air in at `outlet` (meters) while its pump cell is powered, up to `target` gas. */
  | { type: 'pump'; cell: P; outlet: P; rate: number; target: number };

/** Things systems spawn at load (meters). Consumed by machinery/security systems as they land. */
export type EntitySpec =
  | { type: 'securityBot'; x: number; y: number; patrol: P[]; roomId: number }
  | { type: 'turret'; x: number; y: number; dir: number; roomId: number }
  | { type: 'droneBay'; x: number; y: number; roomId: number }
  | { type: 'crusher'; x: number; y: number; w: number; h: number; dx: number; dy: number; period: number }
  | { type: 'mover'; path: P[]; w: number; h: number; speed: number };

export interface RoomInfo {
  id: number;
  kind: string;
  /** Interior rect, meters. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
}

export interface LevelSpec {
  name: string;
  seed: number;
  terrain: PixelGrid;
  backdrop?: PixelGrid;
  bodies: BodySpec[];
  salvageIndex: number;
  shipSpawn: { x: number; y: number; angle: number };
  extraction: Zone;
  pressurized: { x0: number; y0: number; x1: number; y1: number; gas: number }[];
  center: { x: number; y: number };
  rooms: RoomInfo[];
  doors: DoorSpec[];
  entities: EntitySpec[];
  devices?: DeviceSpec[];
}
