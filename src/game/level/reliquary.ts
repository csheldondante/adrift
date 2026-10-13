// "Reliquary": a generated derelict built as a lock-and-key dungeon.
//
// The hull is an armored box (only the dock mouth lets you in, and cutting through the skin
// takes the reactor a very long time). Inside, the space is partitioned recursively (BSP):
// each split puts an armored wall across a region and one doorway through it, so the rooms
// form a tree with exactly one way between any two. The reactor core sits in the deepest
// room against the skin (the vault), which has an exit hatch to space you can only open from
// inside.
//
// Doors are the locks; keys are anything that gets you past one:
//   - power door: a dead door. Its motor sits on its room's wall bus, with a socket on that
//     bus. Plug a battery in (found earlier: floating, or shut in a plate locker you cut
//     open) and the bus lights up: the room's lamps come on and every door on it opens.
//   - maglock: a door held shut while powered, by a security box on the wall with an exposed
//     cable to the door, and a camera on the same line. Cut the cable (or blow the box) and
//     it springs open; the camera goes dark with it.
//   - pressure door: opens when its room holds air (0.65 atm; leaking, it never gets there). The room has a live pump, but its
//     air whistles out through a crack in the skin. Patch the crack (a hull plate is left in
//     the room: hold it to the wall, weld the seam) and shut the hatch you came in by (G at
//     its panel: the pump won't run into an open hatch), and the room fills.
//   - open doorway.
// Locks are assigned while growing the reachable set out from the entry, and each key is put
// in a room that's already reachable, so every level can be solved.
//
// Wiring is real matter (see PowerNet): each room's bus runs round its walls a few cells in
// (a ring, broken at doorways), and NetPainter refuses any conductor that would touch another
// network's, so nothing is powered by accident. A layout that can't be wired is retried.
//
// Likely growth: airlocks and pressurized sections, drone bays as locks, multi-room power
// sections, loot by depth.

import { CELL, WORLD_H, WORLD_W } from '../../config';
import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { crate, hullPatch, powerCell, salvageCore, scrap } from './props';
import { Rng } from './rng';
import type { BodySpec, DeviceSpec, EntitySpec, LevelSpec, RoomInfo } from './types';

const m = (c: number) => c * CELL;

const HX0 = 560; // hull outer rect, cells
const HY0 = 440;
const HX1 = 2360;
const HY1 = 1440;
const SKIN = 40; // armored outer skin
const WALL = 16; // armored partition walls
const HALF = WALL / 2;
const DOOR = 32; // doorway width (4 m: the ship fits, with care)
const DOOR_MARGIN = 14; // doorway clear of the room's corners
const MIN = 180; // smallest partition cell (incl. walls)
const MAXW = 560;
const MAXH = 400;
const RING = 4; // bus depth into the wall (cells 4..5 out from the room)
const GAP = 3; // bus clearance either side of a doorway
const PUMP_RATE = 14; // most gas per second a pressure room's pump pours in

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type LockType = 'open' | 'power' | 'maglock' | 'pressure' | 'hatch';

interface Room {
  id: number;
  /** Partition cell (walls on its edges are shared, HALF each). */
  cell: Rect;
  /** Interior (empty), cells. */
  r: Rect;
  doors: number[];
  depth: number;
  kind: 'entry' | 'vault' | 'pressure' | 'room';
  /** Pressure rooms: a crack through the skin to space, too narrow to fly through. */
  breach?: Rect;
}

interface Door {
  id: number;
  a: number;
  b: number;
  /** Doorway cells through the wall. */
  r: Rect;
  /** 'v': the wall is vertical (you pass through horizontally). */
  wall: 'v' | 'h';
  type: LockType;
  parent: number;
  child: number;
  /** A maglock's motor cell (on its cable). */
  motor?: { x: number; y: number };
}

interface Node {
  r: Rect;
  kids?: [Node, Node];
  wall?: 'v' | 'h';
  at?: number;
}

/** Bodies to place, by room (key placement happens before painting). */
interface Stash {
  room: number;
  what: 'battery' | 'patch';
  locker: boolean;
}

export function buildReliquary(seed = (Math.random() * 2 ** 31) >>> 0): LevelSpec {
  for (let attempt = 0; attempt < 40; attempt++) {
    const spec = tryBuild(seed, attempt);
    if (spec) return spec;
  }
  throw new Error(`reliquary: no layout for seed ${seed}`);
}

function tryBuild(seed: number, attempt: number): LevelSpec | null {
  const rng = new Rng((seed + attempt * 7919) >>> 0);
  const inner: Rect = { x0: HX0 + SKIN, y0: HY0 + SKIN, x1: HX1 - SKIN, y1: HY1 - SKIN };

  // ---- 1. recursive partition --------------------------------------------------------------
  const split = (r: Rect, depth: number): Node => {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const must = w > MAXW || h > MAXH;
    if (!must && depth > 2 && !rng.chance(0.3)) return { r };
    let wall: 'v' | 'h' = w / MAXW >= h / MAXH ? 'v' : 'h';
    if ((wall === 'v' ? w : h) < MIN * 2) wall = wall === 'v' ? 'h' : 'v';
    const len = wall === 'v' ? w : h;
    if (len < MIN * 2) return { r };
    const at = (wall === 'v' ? r.x0 : r.y0) + rng.int(MIN, len - MIN);
    const a: Rect = wall === 'v' ? { ...r, x1: at } : { ...r, y1: at };
    const b: Rect = wall === 'v' ? { ...r, x0: at } : { ...r, y0: at };
    return { r, wall, at, kids: [split(a, depth + 1), split(b, depth + 1)] };
  };
  const root = split(inner, 0);
  const rooms: Room[] = [];
  const leafOf = new Map<Node, Room>();
  const collect = (n: Node) => {
    if (n.kids) return n.kids.forEach(collect);
    const c = n.r;
    const room: Room = {
      id: rooms.length,
      cell: c,
      r: { x0: c.x0 + HALF, y0: c.y0 + HALF, x1: c.x1 - HALF, y1: c.y1 - HALF }, // half a wall on every edge
      doors: [],
      depth: -1,
      kind: 'room',
    };
    rooms.push(room);
    leafOf.set(n, room);
  };
  collect(root);
  const leaves = (n: Node): Room[] => (n.kids ? [...leaves(n.kids[0]), ...leaves(n.kids[1])] : [leafOf.get(n)!]);

  // one doorway through each partition wall, between two rooms that face each other across it
  const doors: Door[] = [];
  const addDoors = (n: Node): boolean => {
    if (!n.kids) return true;
    const at = n.at!;
    const v = n.wall === 'v';
    const A = leaves(n.kids[0]).filter((q) => (v ? q.cell.x1 : q.cell.y1) === at);
    const B = leaves(n.kids[1]).filter((q) => (v ? q.cell.x0 : q.cell.y0) === at);
    const pairs: { a: Room; b: Room; lo: number; hi: number }[] = [];
    for (const a of A)
      for (const b of B) {
        const lo = Math.max(v ? a.r.y0 : a.r.x0, v ? b.r.y0 : b.r.x0) + DOOR_MARGIN;
        const hi = Math.min(v ? a.r.y1 : a.r.x1, v ? b.r.y1 : b.r.x1) - DOOR_MARGIN - DOOR;
        if (hi >= lo) pairs.push({ a, b, lo, hi });
      }
    if (!pairs.length) return false;
    const p = rng.pick(pairs);
    const s = rng.int(p.lo, p.hi);
    const r: Rect = v ? { x0: at - HALF, y0: s, x1: at + HALF, y1: s + DOOR } : { x0: s, y0: at - HALF, x1: s + DOOR, y1: at + HALF };
    const d: Door = { id: doors.length, a: p.a.id, b: p.b.id, r, wall: v ? 'v' : 'h', type: 'open', parent: -1, child: -1 };
    doors.push(d);
    p.a.doors.push(d.id);
    p.b.doors.push(d.id);
    return addDoors(n.kids[0]) && addDoors(n.kids[1]);
  };
  if (!addDoors(root) || rooms.length < 8) return null;

  // ---- 2. entry, depths, vault -------------------------------------------------------------
  const midY = (inner.y0 + inner.y1) / 2;
  const entry = rooms.filter((q) => q.cell.x0 === inner.x0).sort((a, b) => Math.abs((a.r.y0 + a.r.y1) / 2 - midY) - Math.abs((b.r.y0 + b.r.y1) / 2 - midY))[0];
  if (!entry) return null;
  entry.kind = 'entry';
  entry.depth = 0;
  const queue = [entry];
  while (queue.length) {
    const q = queue.shift()!;
    for (const di of q.doors) {
      const d = doors[di];
      const o = rooms[d.a === q.id ? d.b : d.a];
      if (o.depth >= 0) continue;
      o.depth = q.depth + 1;
      d.parent = q.id;
      d.child = o.id;
      queue.push(o);
    }
  }
  // the vault: deepest room on the skin (not on the dock's side), preferring the far end
  const onSkin = (q: Room) => q.cell.x1 === inner.x1 || q.cell.y0 === inner.y0 || q.cell.y1 === inner.y1;
  const maxDepth = Math.max(...rooms.map((q) => q.depth));
  const vault = rooms
    .filter((q) => onSkin(q) && q !== entry)
    .sort((a, b) => b.depth - a.depth + (b.cell.x1 === inner.x1 ? 0.5 : 0) - (a.cell.x1 === inner.x1 ? 0.5 : 0))[0];
  if (!vault || vault.depth < Math.max(3, maxDepth - 2)) return null;
  vault.kind = 'vault';
  const pathDoors = new Set<number>();
  for (let q = vault; q !== entry; ) {
    const d = doors.find((dd) => dd.child === q.id)!;
    pathDoors.add(d.id);
    q = rooms[d.parent];
  }

  // ---- 3. locks and keys -------------------------------------------------------------------
  // grow the reachable set from the entry one door at a time; each lock's key goes in a room
  // already reachable
  const stash: Stash[] = [];
  const reach: Room[] = [entry];
  const inReach = new Set([entry.id]);
  const entranceOf = (q: Room) => doors.find((d) => d.child === q.id);
  const pick = (wts: [LockType, number][]): LockType => {
    let t = rng.next() * wts.reduce((s, w) => s + w[1], 0);
    for (const [k, w] of wts) if ((t -= w) <= 0) return k;
    return wts[0][0];
  };
  const keyRoom = (): number => {
    // a recently reached room, not always the one you're standing in
    const recent = reach.slice(-3);
    return rng.pick(recent.length > 1 ? recent.slice(0, -1).concat(recent) : recent).id;
  };
  let first = true;
  while (true) {
    const frontier = doors.filter((d) => inReach.has(d.parent) && !inReach.has(d.child));
    if (!frontier.length) break;
    // finish side branches before the main path most of the time, so keys spread out
    const side = frontier.filter((d) => !pathDoors.has(d.id));
    const d = side.length && rng.chance(0.65) ? rng.pick(side) : rng.pick(frontier);
    const P = rooms[d.parent];
    const C = rooms[d.child];
    const onPath = pathDoors.has(d.id);
    const entrance = entranceOf(P);
    const crack = P.kind === 'room' && P.doors.length === 2 && !!entrance && entrance.type === 'open' ? skinCrack(P, inner) : null;
    const canPressure = !!crack;
    let type: LockType;
    if (first && d.parent === entry.id) {
      type = 'power'; // the first door out of the entry: find the battery, light the room
      first = false;
    } else if (P.kind === 'vault' || P.kind === 'pressure') type = rng.chance(0.5) ? 'maglock' : 'open';
    else if (C.kind === 'vault') type = rng.chance(0.6) ? 'power' : 'maglock';
    else if (onPath) type = pick([['power', 4], ['maglock', 3], ['pressure', canPressure ? 4 : 0], ['open', 1]]);
    else type = pick([['power', 2], ['maglock', 1.5], ['open', 6.5]]);
    if (type === 'pressure') {
      // the room's way in becomes a hatch you shut from inside, and the crack lets its air out
      P.kind = 'pressure';
      P.breach = crack!;
      entrance!.type = 'hatch';
      stash.push({ room: P.id, what: 'patch', locker: false });
    }
    if (type === 'power') stash.push({ room: d.parent === entry.id ? entry.id : keyRoom(), what: 'battery', locker: rng.chance(0.5) || d.parent === entry.id });
    d.type = type;
    reach.push(C);
    inReach.add(C.id);
  }
  if (!doors.some((d) => d.type === 'pressure')) {
    // every level has one patch-and-pump puzzle if the layout allows: none here, so try again
    if (attempt < 30) return null;
  }

  // ---- 4. paint ----------------------------------------------------------------------------
  const g = new PixelGrid(WORLD_W, WORLD_H);
  const p = new Painter(g);
  const net = new NetPainter(g);
  // armored box with chamfered corners, girders through the bulk
  const ch = 80;
  p.poly(
    [
      [HX0, HY0 + ch],
      [HX0 + ch, HY0],
      [HX1 - ch, HY0],
      [HX1, HY0 + ch],
      [HX1, HY1 - ch],
      [HX1 - ch, HY1],
      [HX0 + ch, HY1],
      [HX0, HY1 - ch],
    ],
    M.ARMOR,
  );
  p.seams(HX0, HY0, HX1 - HX0, HY1 - HY0, M.ARMOR, 32, 24, 30);
  for (let x = HX0 + 100; x < HX1 - 60; x += 200) p.rect(x, HY0 + 8, 6, HY1 - HY0 - 16, M.FRAME);
  for (const q of rooms) p.clear(q.r.x0, q.r.y0, q.r.x1 - q.r.x0, q.r.y1 - q.r.y0);
  for (const d of doors) p.clear(d.r.x0, d.r.y0, d.r.x1 - d.r.x0, d.r.y1 - d.r.y0);
  // dock mouth through the skin into the entry
  const ey = Math.round((entry.r.y0 + entry.r.y1) / 2);
  const dock: Rect = { x0: HX0 - 2, y0: ey - 28, x1: entry.r.x0, y1: ey + 28 };
  p.clear(dock.x0, dock.y0, dock.x1 - dock.x0, dock.y1 - dock.y0);
  // vault exit through the skin: a hatch, opened from the panel inside
  const vr = vault.r;
  let exit: Rect;
  let exitDir: [number, number];
  if (vault.cell.x1 === inner.x1) {
    const y = Math.round((vr.y0 + vr.y1) / 2);
    exit = { x0: vr.x1, y0: y - 24, x1: HX1 + 2, y1: y + 24 };
    exitDir = [1, 0];
  } else if (vault.cell.y1 === inner.y1) {
    const x = Math.round((vr.x0 + vr.x1) / 2);
    exit = { x0: x - 24, y0: vr.y1, x1: x + 24, y1: HY1 + 2 };
    exitDir = [0, 1];
  } else {
    const x = Math.round((vr.x0 + vr.x1) / 2);
    exit = { x0: x - 24, y0: HY0 - 2, x1: x + 24, y1: vr.y0 };
    exitDir = [0, -1];
  }
  p.clear(exit.x0, exit.y0, exit.x1 - exit.x0, exit.y1 - exit.y0);
  for (const q of rooms) if (q.breach) p.clear(q.breach.x0, q.breach.y0, q.breach.x1 - q.breach.x0, q.breach.y1 - q.breach.y0);

  const devices: DeviceSpec[] = [];
  const entities: EntitySpec[] = [];
  const bodies: BodySpec[] = [];
  const add = (grid: PixelGrid, cx: number, cy: number, extra: Partial<BodySpec> = {}) =>
    bodies.push({ grid, x: m(cx - grid.w / 2), y: m(cy - grid.h / 2), angle: 0, ...extra }) - 1;

  // -- wiring per room ------------------------------------------------------------------------
  let netId = 1;
  for (const q of rooms) {
    const powerDoors = doors.filter((d) => d.parent === q.id && d.type === 'power');
    const maglocks = doors.filter((d) => d.parent === q.id && d.type === 'maglock');
    const openings: Rect[] = q.doors.map((di) => doors[di].r);
    if (q === entry) openings.push(dock);
    if (q === vault) openings.push(exit);
    if (q.breach) openings.push(q.breach);
    const ring = new Ring(q.r, openings);
    if (powerDoors.length || q.kind === 'pressure' || q.kind === 'vault') {
      // the bus: the ring arc beside the first power door (or the longest arc)
      const id = netId++;
      const arcs = ring.arcs();
      let bus = arcs.sort((a, b) => b.length - a.length)[0];
      if (powerDoors.length) bus = arcs.reduce((best, a) => (ring.near(a, powerDoors[0].r) < ring.near(best, powerDoors[0].r) ? a : best), bus);
      if (!bus || !net.paint(bus.map((i) => [i % g.w, (i / g.w) | 0, M.CONDUIT] as Cell), id)) return null;
      for (const d of powerDoors) {
        const motor = ring.nearest(bus, d.r);
        if (!motor || ring.dist(motor, d.r) > GAP + 4) {
          d.type = 'open'; // its jamb isn't on the bus (the battery placed for it is a spare)
          continue;
        }
        devices.push({ type: 'door', x0: d.r.x0, y0: d.r.y0, x1: d.r.x1, y1: d.r.y1, motor: { x: motor % g.w, y: (motor / g.w) | 0 }, mat: M.PDOOR });
      }
      // lamps along the ceiling run of the bus (or any run if it has no ceiling)
      let lamps = 0;
      const lampAt = (cells: number[], horiz: boolean) => {
        for (const i of cells) {
          const x = i % g.w;
          const y = (i / g.w) | 0;
          const along = horiz ? x : y;
          if (along % 44 !== 22) continue;
          const face = ring.faceCells(x, y, horiz ? 10 : 3, horiz ? 3 : 10);
          if (face && net.fixture(face, M.LIGHT, id)) lamps++;
        }
      };
      lampAt(bus.filter((i) => ring.side(i) === 'top'), true);
      if (!lamps) lampAt(bus, true);
      if (q.kind !== 'vault' && powerDoors.some((d) => d.type === 'power')) {
        // the socket: on a side wall if the bus has one, near the door it opens
        const d0 = powerDoors.find((d) => d.type === 'power')!;
        const cand = bus.filter((i) => (ring.side(i) === 'left' || ring.side(i) === 'right') && ring.clearOfCorners(i, 16));
        const pool = cand.length ? cand : bus.filter((i) => ring.clearOfCorners(i, 16));
        pool.sort((a, b) => ring.dist(a, d0.r) - ring.dist(b, d0.r));
        let placed = false;
        for (const i of pool.filter((_, k) => k % 3 === 0).slice(4, 60)) {
          const s = ring.side(i);
          const face = ring.faceCells(i % g.w, (i / g.w) | 0, s === 'left' || s === 'right' ? 3 : 8, s === 'left' || s === 'right' ? 8 : 3);
          if (face && net.fixture(face, M.SOCKET, id)) {
            placed = true;
            break;
          }
        }
        if (!placed) return null;
      }
      if (q.kind === 'pressure' || q.kind === 'vault') {
        // a live core on the bus (lit room), and the pump or the exit panel
        const floor = bus.filter((i) => ring.side(i) === 'bottom' && ring.clearOfCorners(i, 20));
        const pool = floor.length ? floor : bus.filter((i) => ring.clearOfCorners(i, 20));
        let core = false;
        for (const i of pool.filter((_, k) => k % 5 === 0)) {
          const face = ring.faceCells(i % g.w, (i / g.w) | 0, 6, 3);
          if (face && net.fixture(face, M.POWER, id)) {
            core = true;
            break;
          }
        }
        if (!core) return null;
        if (q.kind === 'pressure') {
          let pump: { x: number; y: number } | null = null;
          let outlet = { x: 0, y: 0 };
          // the pump well away from the crack (its draft would blow the patch off)
          const far = pool.slice().sort((a, b) => ring.dist(b, q.breach!) - ring.dist(a, q.breach!));
          for (const i of far.filter((_, k) => k % 5 === 0)) {
            const face = ring.faceCells(i % g.w, (i / g.w) | 0, 14, 3);
            if (face && net.fixture(face, M.PUMP, id)) {
              pump = { x: face[0][0], y: face[0][1] };
              outlet = clampIn(q.r, face[7][0], face[7][1], 12);
              break;
            }
          }
          if (!pump) return null;
          // the hatch it's entered by: open, shut from the panel beside it
          const ent = doors.find((dd) => dd.child === q.id)!;
          const pc = panel(net, ring, bus, ent.r, id);
          if (!pc) return null;
          devices.push({ type: 'hatch', x0: ent.r.x0, y0: ent.r.y0, x1: ent.r.x1, y1: ent.r.y1, panel: pc, open: true });
          // through the crack it's a steady draft (it shows you the hole); sealed, it brings the
          // room up to the door's opening pressure in ~20 s. It won't pump into an open hatch
          const area = m(q.r.x1 - q.r.x0) * m(q.r.y1 - q.r.y0);
          devices.push({ type: 'pump', cell: pump, outlet: { x: m(outlet.x), y: m(outlet.y) }, rate: Math.min(PUMP_RATE, area / 60), target: 1, interlock: [ent.r.x0, ent.r.y0, ent.r.x1, ent.r.y1] });
        } else {
          // exit hatch, with its panel on the bus beside the exit
          const pc = panel(net, ring, bus, exit, id);
          if (!pc) return null;
          devices.push({ type: 'hatch', x0: exit.x0, y0: exit.y0, x1: exit.x1, y1: exit.y1, panel: pc });
        }
      }
    }
    // maglocks: a security box on the wall, an exposed cable along the face to the door, and
    // a camera on the line
    for (const d of maglocks) {
      const id = netId++;
      if (!maglock(net, ring, d, id, rng, q, entities)) d.type = 'open';
      else devices.push({ type: 'door', x0: d.r.x0, y0: d.r.y0, x1: d.r.x1, y1: d.r.y1, motor: { x: d.motor!.x, y: d.motor!.y }, mat: M.PDOOR, invert: true });
    }
    // pressure doors: the slab, opened by air in the room behind
    for (const d of doors.filter((dd) => dd.parent === q.id && dd.type === 'pressure')) {
      // the sensor reads the room 3 m in front of the door
      const sn = clampIn(q.r, (d.r.x0 + d.r.x1) / 2, (d.r.y0 + d.r.y1) / 2, 24);
      devices.push({ type: 'pressureDoor', x0: d.r.x0, y0: d.r.y0, x1: d.r.x1, y1: d.r.y1, sensor: { x: m(sn.x), y: m(sn.y) }, open: 0.65, close: 0.45 });
    }
  }

  // -- keys, junk, guards ---------------------------------------------------------------------
  const salvageIndex = add(salvageCore(), (vr.x0 + vr.x1) / 2, (vr.y0 + vr.y1) / 2, { tags: { salvage: true, label: 'Reactor core' } });
  // loose bodies never start overlapping (they'd blast each other apart on the first step)
  const taken: Rect[] = [{ x0: vr.x0 + (vr.x1 - vr.x0) / 2 - 30, y0: vr.y0 + (vr.y1 - vr.y0) / 2 - 22, x1: vr.x0 + (vr.x1 - vr.x0) / 2 + 30, y1: vr.y0 + (vr.y1 - vr.y0) / 2 + 22 }];
  const overlaps = (a: Rect) => taken.some((b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
  /** A free spot (center, cells) for a w×h body in room q: `pref` if it's clear, else random. */
  const spot = (q: Room, w: number, h: number, pref?: { x: number; y: number }) => {
    const pad = Math.max(w, h) / 2 + 6;
    for (let k = 0; k < 40; k++) {
      const c = clampIn(q.r, k === 0 && pref ? pref.x : rng.range(q.r.x0, q.r.x1), k === 0 && pref ? pref.y : rng.range(q.r.y0, q.r.y1), pad);
      const r = { x0: c.x - pad, y0: c.y - pad, x1: c.x + pad, y1: c.y + pad };
      if (overlaps(r)) continue;
      taken.push(r);
      return c;
    }
    return null;
  };
  for (const s of stash) {
    const q = rooms[s.room];
    if (s.what === 'patch') {
      // in the room, near the crack it seals
      const br = q.breach!;
      const bx = (br.x0 + br.x1) / 2;
      const by = (br.y0 + br.y1) / 2;
      const v = br.x1 - br.x0 > br.y1 - br.y0; // the crack runs through a vertical wall (left/right)
      const grid = hullPatch(v ? 12 : 40, v ? 40 : 12);
      const at = spot(q, grid.w, grid.h, { x: bx + (v ? 0 : 60), y: by + (v ? 60 : 0) });
      if (!at) return null;
      add(grid, at.x, at.y, { w: rng.range(-0.05, 0.05) });
      continue;
    }
    if (s.locker) {
      // a plate closet standing on the floor, shut: cut it open
      let placed = false;
      for (let k = 0; k < 20 && !placed; k++) {
        const lx = rng.int(q.r.x0 + 30, q.r.x1 - 70);
        const r = { x0: lx - 4, y0: q.r.y0, x1: lx + 44, y1: q.r.y0 + 30 };
        if (overlaps(r)) continue;
        taken.push(r);
        p.rect(lx, q.r.y0, 40, 24, M.PLATE).clear(lx + 3, q.r.y0 + 3, 34, 18);
        p.seams(lx, q.r.y0, 40, 24, M.PLATE, 10, 100, 50);
        add(powerCell(), lx + 20, q.r.y0 + 12);
        placed = true;
      }
      if (placed) continue;
    }
    const at = spot(q, 24, 12);
    if (!at) return null;
    add(powerCell(), at.x, at.y, { w: rng.range(-0.2, 0.2) });
  }
  for (const q of rooms) {
    const n = q.kind === 'vault' ? 0 : rng.int(1, 4);
    for (let k = 0; k < n; k++) {
      const big = rng.chance(0.55);
      const grid = big ? crate(rng.int(10, 20), rng.int(10, 16)) : scrap(rng.int(1, 999), rng.int(12, 22));
      const at = spot(q, grid.w, grid.h);
      if (at) add(grid, at.x, at.y, { w: rng.range(-0.15, 0.15) * (big ? 1 : 2) });
    }
    const cx = m((q.r.x0 + q.r.x1) / 2);
    const cy = m((q.r.y0 + q.r.y1) / 2);
    if (q.depth >= 2 && q.kind !== 'pressure' && rng.chance(0.45)) {
      const y = m(rng.range(q.r.y0 + 24, q.r.y1 - 24));
      entities.push({ type: 'securityBot', x: m(q.r.x0 + 24), y, patrol: [{ x: m(q.r.x0 + 24), y }, { x: m(q.r.x1 - 24), y }], roomId: q.id });
    }
    if (q.depth >= 3 && rng.chance(0.25)) entities.push({ type: 'drone', x: cx, y: cy, angle: rng.range(0, Math.PI * 2) });
  }
  // drifting junk outside the dock
  add(scrap(77, 22), HX0 - 90, ey + 60, { vx: 0.1, w: 0.08 });
  add(crate(14, 14), HX0 - 140, ey - 70, { vx: 0.05, vy: 0.08, w: -0.1 });

  // back wall over every room
  const back = new PixelGrid(WORLD_W, WORLD_H);
  const bp = new Painter(back);
  for (const r of [...rooms.map((q) => q.r), ...doors.map((d) => d.r), dock, exit]) {
    bp.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, M.PLATE);
    bp.seams(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, M.PLATE, 32, 24, 40);
  }

  const info: RoomInfo[] = rooms.map((q) => ({ id: q.id, kind: q.kind, x0: m(q.r.x0), y0: m(q.r.y0), x1: m(q.r.x1), y1: m(q.r.y1), depth: q.depth }));
  const ex = exitDir[0] ? (exitDir[0] > 0 ? HX1 + 100 : HX0 - 100) : (exit.x0 + exit.x1) / 2;
  const ezy = exitDir[1] ? (exitDir[1] > 0 ? HY1 + 100 : HY0 - 100) : (exit.y0 + exit.y1) / 2;
  return {
    name: 'Derelict "Reliquary"',
    seed,
    rooms: info,
    doors: [],
    entities,
    devices,
    terrain: g,
    backdrop: back,
    bodies,
    salvageIndex,
    shipSpawn: { x: m(HX0 - 110), y: m(ey), angle: 0 },
    extraction: { x0: m(ex - 60), y0: m(ezy - 60), x1: m(ex + 60), y1: m(ezy + 60) },
    pressurized: [],
    center: { x: m((HX0 + HX1) / 2), y: m((HY0 + HY1) / 2) },
    emergencyLights: 0.12,
    locks: {
      doors: [
        ...doors.map((d) => ({ id: d.id, type: d.type as string, parent: d.parent, child: d.child, x: m((d.r.x0 + d.r.x1) / 2), y: m((d.r.y0 + d.r.y1) / 2) })),
        ...rooms.filter((q) => q.breach).map((q) => ({ id: -1, type: 'breach', parent: q.id, child: -1, x: m((q.breach!.x0 + q.breach!.x1) / 2), y: m((q.breach!.y0 + q.breach!.y1) / 2) })),
      ],
      stash, entry: entry.id, vault: vault.id },
  };
}

/** A crack through the skin from room q to space (12 cells across), if q is on the skin. */
function skinCrack(q: Room, inner: Rect): Rect | null {
  const r = q.r;
  const cx = Math.round((r.x0 + r.x1) / 2);
  const cy = Math.round((r.y0 + r.y1) / 2);
  if (q.cell.x1 === inner.x1) return { x0: r.x1, y0: cy - 6, x1: HX1 + 2, y1: cy + 6 };
  if (q.cell.y1 === inner.y1) return { x0: cx - 6, y0: r.y1, x1: cx + 6, y1: HY1 + 2 };
  if (q.cell.y0 === inner.y0) return { x0: cx - 6, y0: HY0 - 2, x1: cx + 6, y1: r.y0 };
  return null;
}

/**
 * A door panel (Devices paints it 3×5, upright) on a side wall in front of the bus, as near
 * to `near` as it'll fit. Returns its cell.
 */
function panel(net: NetPainter, ring: Ring, bus: number[], near: Rect, id: number): { x: number; y: number } | null {
  const r = ring.r;
  const cand = bus.filter((i) => (ring.side(i) === 'left' || ring.side(i) === 'right') && ring.clearOfCorners(i, 8));
  cand.sort((a, b) => ring.dist(a, near) - ring.dist(b, near));
  for (const i of cand.slice(0, 80)) {
    const y = (i / WORLD_W) | 0;
    const pc = ring.side(i) === 'left' ? { x: r.x0 - 2, y } : { x: r.x1 + 1, y };
    const cells: [number, number][] = [];
    for (let yy = pc.y - 2; yy < pc.y + 3; yy++) for (let xx = pc.x - 1; xx < pc.x + 2; xx++) cells.push([xx, yy]);
    if (net.fixture(cells, M.PANEL, id)) return pc;
  }
  return null;
}

const clampIn = (r: Rect, x: number, y: number, pad: number) => ({
  x: Math.max(r.x0 + pad, Math.min(r.x1 - pad, x)),
  y: Math.max(r.y0 + pad, Math.min(r.y1 - pad, y)),
});

type Cell = [number, number, number];

/**
 * Paints conductors network by network, refusing any cell that would sit on or beside another
 * network's conductor (power floods through 4-neighbors, so touching would merge them).
 */
class NetPainter {
  private readonly owner = new Map<number, number>();
  /** Cells taken by fixtures (lamps, sockets, cores, pumps, panels): they never overlap. */
  private readonly fixtures = new Set<number>();
  constructor(private readonly g: PixelGrid) {}

  /** Paints a fixture of `mat` on network `id`, unless it overlaps or abuts another fixture. */
  fixture(cells: [number, number][], mat: number, id: number): boolean {
    const w = this.g.w;
    for (const [x, y] of cells) {
      const i = y * w + x;
      if ([i, i - 1, i + 1, i - w, i + w].some((j) => this.fixtures.has(j))) return false;
    }
    if (!this.paint(cells.map(([x, y]) => [x, y, mat] as Cell), id)) return false;
    for (const [x, y] of cells) this.fixtures.add(y * w + x);
    return true;
  }

  /**
   * Paints all of `cells` as network `id`, or none of them (returns false) on a clash, or if
   * any would fill open space (a doorway, a room).
   */
  paint(cells: Cell[], id: number): boolean {
    const g = this.g;
    for (const [x, y] of cells) {
      if (!g.inside(x, y)) return false;
      const i = y * g.w + x;
      if (!g.mat[i] && !this.owner.has(i)) return false;
      for (const j of [i, i - 1, i + 1, i - g.w, i + g.w]) {
        const o = this.owner.get(j);
        if (o !== undefined && o !== id) return false;
      }
    }
    for (const [x, y, mat] of cells) {
      const i = y * g.w + x;
      g.set(x, y, mat);
      this.owner.set(i, id);
    }
    return true;
  }
}

/**
 * The bus ring round a room: wall cells RING..RING+1 out from the interior, minus doorway
 * gaps. Its connected pieces are the arcs a bus can use.
 */
class Ring {
  readonly cells = new Set<number>();
  private readonly w = WORLD_W;
  constructor(
    readonly r: Rect,
    openings: Rect[],
  ) {
    const { x0, y0, x1, y1 } = r;
    const lo = RING;
    const hi = RING + 1;
    for (let y = y0 - hi - 1; y < y1 + hi + 1; y++)
      for (let x = x0 - hi - 1; x < x1 + hi + 1; x++) {
        const d = this.depth(x, y);
        if (d < lo || d > hi) continue;
        if (openings.some((o) => x >= o.x0 - GAP && x < o.x1 + GAP && y >= o.y0 - GAP && y < o.y1 + GAP)) continue;
        this.cells.add(y * this.w + x);
      }
  }

  /** Cells out from the interior (1 = the wall face). */
  depth(x: number, y: number): number {
    const r = this.r;
    const dx = x < r.x0 ? r.x0 - x : x >= r.x1 ? x - r.x1 + 1 : 0;
    const dy = y < r.y0 ? r.y0 - y : y >= r.y1 ? y - r.y1 + 1 : 0;
    return Math.max(dx, dy);
  }

  side(i: number): 'left' | 'right' | 'top' | 'bottom' | 'corner' {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    const r = this.r;
    const inX = x >= r.x0 && x < r.x1;
    const inY = y >= r.y0 && y < r.y1;
    if (inX && y >= r.y1) return 'top';
    if (inX && y < r.y0) return 'bottom';
    if (inY && x < r.x0) return 'left';
    if (inY && x >= r.x1) return 'right';
    return 'corner';
  }

  clearOfCorners(i: number, pad: number): boolean {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    const r = this.r;
    const s = this.side(i);
    if (s === 'top' || s === 'bottom') return x >= r.x0 + pad && x < r.x1 - pad;
    if (s === 'left' || s === 'right') return y >= r.y0 + pad && y < r.y1 - pad;
    return false;
  }

  /** Connected runs of ring cells. */
  arcs(): number[][] {
    const seen = new Set<number>();
    const out: number[][] = [];
    for (const s of this.cells) {
      if (seen.has(s)) continue;
      const arc: number[] = [];
      const st = [s];
      seen.add(s);
      while (st.length) {
        const i = st.pop()!;
        arc.push(i);
        for (const j of [i - 1, i + 1, i - this.w, i + this.w])
          if (this.cells.has(j) && !seen.has(j)) {
            seen.add(j);
            st.push(j);
          }
      }
      out.push(arc);
    }
    return out;
  }

  dist(i: number, o: Rect): number {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    const dx = x < o.x0 ? o.x0 - x : x >= o.x1 ? x - o.x1 + 1 : 0;
    const dy = y < o.y0 ? o.y0 - y : y >= o.y1 ? y - o.y1 + 1 : 0;
    return Math.max(dx, dy);
  }

  near(arc: number[], o: Rect): number {
    let b = Infinity;
    for (const i of arc) b = Math.min(b, this.dist(i, o));
    return b;
  }

  nearest(arc: number[], o: Rect): number | null {
    let b = Infinity;
    let best: number | null = null;
    for (const i of arc) {
      const d = this.dist(i, o);
      if (d < b) [b, best] = [d, i];
    }
    return best;
  }

  /**
   * The face cells (depth 1..3) in front of ring cell (x, y): a w×h patch on that wall,
   * centered along it, touching the ring behind. null at a corner.
   */
  faceCells(x: number, y: number, w: number, h: number): [number, number][] | null {
    const r = this.r;
    const s = this.side(y * this.w + x);
    const out: [number, number][] = [];
    if (s === 'top' || s === 'bottom') {
      const ya = s === 'top' ? r.y1 : r.y0 - 3;
      for (let yy = ya; yy < ya + 3; yy++) for (let xx = x - (w >> 1); xx < x - (w >> 1) + w; xx++) out.push([xx, yy]);
      if (x - (w >> 1) < r.x0 || x - (w >> 1) + w > r.x1) return null;
    } else if (s === 'left' || s === 'right') {
      const xa = s === 'right' ? r.x1 : r.x0 - 3;
      for (let xx = xa; xx < xa + 3; xx++) for (let yy = y - (h >> 1); yy < y - (h >> 1) + h; yy++) out.push([xx, yy]);
      if (y - (h >> 1) < r.y0 || y - (h >> 1) + h > r.y1) return null;
    } else return null;
    return out;
  }
}

/**
 * A maglock's wiring in room q: a cable along the wall face from the door's jamb to a
 * security box, a camera on the cable. Sets d.motor. Returns false if it can't be wired.
 */
function maglock(net: NetPainter, ring: Ring, d: Door, id: number, rng: Rng, q: Room, entities: EntitySpec[]): boolean {
  const r = q.r;
  const dr = d.r;
  // which wall of q the door is in, and the face line (depth 1..2) along it
  let wallSide: 'left' | 'right' | 'top' | 'bottom';
  if (d.wall === 'v') wallSide = dr.x1 <= r.x0 ? 'left' : 'right';
  else wallSide = dr.y1 <= r.y0 ? 'bottom' : 'top';
  const horiz = wallSide === 'top' || wallSide === 'bottom';
  const lo = horiz ? r.x0 + 12 : r.y0 + 12;
  const hi = horiz ? r.x1 - 12 : r.y1 - 12;
  const d0 = horiz ? dr.x0 : dr.y0;
  const d1 = horiz ? dr.x1 : dr.y1;
  // face rows: 2 cells deep into the wall
  const faceAt = (t: number): [number, number][] => {
    if (wallSide === 'top') return [[t, r.y1], [t, r.y1 + 1]];
    if (wallSide === 'bottom') return [[t, r.y0 - 1], [t, r.y0 - 2]];
    if (wallSide === 'left') return [[r.x0 - 1, t], [r.x0 - 2, t]];
    return [[r.x1, t], [r.x1 + 1, t]];
  };
  const dirs = rng.shuffle([-1, 1]);
  for (const dir of dirs) {
    const start = dir > 0 ? d1 : d0 - 1;
    const room = dir > 0 ? hi - start : start - lo;
    if (room < 50) continue;
    const len = rng.int(40, Math.min(150, room));
    const cells: Cell[] = [];
    for (let k = 0; k < len; k++) for (const [x, y] of faceAt(start + dir * k)) cells.push([x, y, M.CONDUIT]);
    // the security box at the far end: a power core, 3 deep, behind a hull lip
    const tEnd = start + dir * len;
    for (let k = 0; k < 6; k++)
      for (let dd = 0; dd < 3; dd++) {
        const t = tEnd + dir * k;
        const [fx, fy] = faceAt(t)[0];
        const [nx, ny] = wallSide === 'top' ? [0, 1] : wallSide === 'bottom' ? [0, -1] : wallSide === 'left' ? [-1, 0] : [1, 0];
        cells.push([fx + nx * dd, fy + ny * dd, M.POWER]);
      }
    // a camera on the cable, two thirds of the way out, looking into the room
    const tCam = start + dir * Math.floor(len * 0.6);
    const [cx, cy] = faceAt(tCam)[0];
    const camDir = wallSide === 'top' ? -Math.PI / 2 : wallSide === 'bottom' ? Math.PI / 2 : wallSide === 'left' ? 0 : Math.PI;
    // the housing disc (radius 8, half in the wall) is conducting too: reserve it
    const wx = wallSide === 'left' ? r.x0 : wallSide === 'right' ? r.x1 : cx + 0.5;
    const wy = wallSide === 'bottom' ? r.y0 : wallSide === 'top' ? r.y1 : cy + 0.5;
    for (let yy = Math.floor(wy - 9); yy <= Math.ceil(wy + 9); yy++)
      for (let xx = Math.floor(wx - 9); xx <= Math.ceil(wx + 9); xx++)
        if ((xx + 0.5 - wx) ** 2 + (yy + 0.5 - wy) ** 2 <= 9 * 9 && ring.depth(xx, yy) >= 1) cells.push([xx, yy, M.TURRET]);
    if (!net.paint(cells, id)) continue;
    const [mx, my] = faceAt(start)[0];
    d.motor = { x: mx, y: my };
    entities.push({ type: 'turret', x: m(wx), y: m(wy), dir: camDir, roomId: q.id, wired: true });
    return true;
  }
  return false;
}
