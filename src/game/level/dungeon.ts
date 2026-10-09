// Dungeon-sized derelict generator (hybrid): a seeded room graph on a slot grid, carved out of
// a solid hull, with handmade room templates (rooms.ts) filling each room.
//
// Pipeline:
//   1. slots: a COLS×ROWS grid of S-cell squares inside the hull
//   2. graph: a spine from the entry to the far end, short side branches, a few loops; one
//      horizontal pair may merge into a long hall
//   3. kinds: entry = start, vault (core) = deepest by BFS, the rest from a weighted deck
//   4. paint: hull shell + structural bulk (plate with girder lattice), carve rooms and
//      corridors (lined with hull plating), record doorways, run room templates, back wall
//
// Likely growth: more room kinds and multi-slot shapes, decks with vertical shafts, loot
// tables, difficulty by depth. Keep the stages separate so each can change alone.

import { CELL, WORLD_H, WORLD_W } from '../../config';
import { M } from '../../pixel/materials';
import { PixelGrid } from '../../pixel/PixelGrid';
import { Painter } from './Painter';
import { Rng } from './rng';
import { addPatrolBot, ROOM_KINDS, SEALED_KINDS, type CellRect, type RoomCtx, type RoomKind } from './rooms';
import type { BodySpec, DoorSpec, EntitySpec, LevelSpec, RoomInfo } from './types';

const S = 256; // slot size, cells (32 m)
const COLS = 13;
const ROWS = 6;
const X0 = 448; // slot grid origin, cells (room left of the prow for the approach)
const Y0 = 256;
const CORRIDOR = 48; // corridor width, cells (6 m)
const LINING = 6; // hull plating lining rooms and corridors
const HULL_SKIN = 24; // outer hull thickness
const m = (c: number) => c * CELL;
const PATROLLED: ReadonlySet<RoomKind> = new Set(['cargo', 'machinery', 'fuel', 'crew', 'moverHall', 'droneBay', 'vault'] as RoomKind[]);

interface Room {
  id: number;
  slots: [number, number][];
  rect: CellRect;
  kind: RoomKind;
  depth: number;
}

const key = (c: number, r: number) => r * COLS + c;

export function buildDungeon(seed = (Math.random() * 2 ** 31) >>> 0): LevelSpec {
  const rng = new Rng(seed);

  // ---- 2. graph -----------------------------------------------------------------------
  const startRow = rng.int(2, 3);
  const slotRoom = new Map<number, number>(); // slot key -> room id
  const rooms: Room[] = [];
  const edges = new Set<string>(); // "a-b" room ids, a<b
  const addEdge = (a: number, b: number) => edges.add(a < b ? `${a}-${b}` : `${b}-${a}`);
  const newRoom = (c: number, r: number): number => {
    const id = rooms.length;
    rooms.push({ id, slots: [[c, r]], rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, kind: 'cargo', depth: 0 });
    slotRoom.set(key(c, r), id);
    return id;
  };
  newRoom(0, startRow);
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !slotRoom.has(key(x, y));
  // spine: a main route from the entry to the far end, mostly forward with vertical jogs
  let [sc, sr] = [0, startRow];
  let prev = 0;
  while (sc < COLS - 1) {
    let nc = sc + 1;
    let nr = sr;
    if (rng.chance(0.35)) {
      const dy = rng.chance(0.5) ? 1 : -1;
      if (free(sc, sr + dy)) [nc, nr] = [sc, sr + dy];
      else if (free(sc, sr - dy)) [nc, nr] = [sc, sr - dy];
    }
    const id = newRoom(nc, nr);
    addEdge(prev, id);
    prev = id;
    [sc, sr] = [nc, nr];
  }
  // branches: short side passages off random rooms, so there is somewhere to get lost
  const target = rng.int(30, 36);
  let guard = 0;
  while (rooms.length < target && guard++ < 500) {
    let from = rng.pick(rooms).id;
    for (let len = rng.int(1, 3); len > 0 && rooms.length < target; len--) {
      const [c, r] = rooms[from].slots[0];
      const opts = rng.shuffle(
        [
          [c, r + 1],
          [c, r - 1],
          [c + 1, r],
          [c - 1, r],
        ].filter(([x, y]) => free(x, y)),
      );
      if (!opts.length) break;
      const id = newRoom(opts[0][0], opts[0][1]);
      addEdge(from, id);
      from = id;
    }
  }
  // loops
  for (const room of rooms) {
    const [c, r] = room.slots[0];
    for (const [x, y] of [
      [c + 1, r],
      [c, r + 1],
    ]) {
      const o = slotRoom.get(key(x, y));
      if (o !== undefined && rng.chance(0.14)) addEdge(room.id, o);
    }
  }

  // ---- 3. depth + kinds ---------------------------------------------------------------
  const adj = rooms.map(() => [] as number[]);
  for (const e of edges) {
    const [a, b] = e.split('-').map(Number);
    adj[a].push(b);
    adj[b].push(a);
  }
  const queue = [0];
  const seen = new Set([0]);
  while (queue.length) {
    const a = queue.shift()!;
    for (const b of adj[a])
      if (!seen.has(b)) {
        seen.add(b);
        rooms[b].depth = rooms[a].depth + 1;
        queue.push(b);
      }
  }
  const vault = rooms.reduce((best, r) => (r.depth > best.depth ? r : best), rooms[0]);
  rooms[0].kind = 'entry';
  vault.kind = 'vault';
  // one long hall: a connected horizontal neighbor pair in the middle depths, merged
  const mid = rooms.filter((r) => r.kind === 'cargo' && r.depth >= 2 && r.depth < vault.depth - 1);
  for (const a of rng.shuffle(mid)) {
    const [c, r] = a.slots[0];
    const bId = slotRoom.get(key(c + 1, r));
    if (bId === undefined) continue;
    const b = rooms[bId];
    if (b.kind !== 'cargo' || b.slots.length > 1 || !adj[a.id].includes(bId)) continue;
    a.slots.push(b.slots[0]);
    a.kind = 'moverHall';
    b.kind = 'merged' as RoomKind; // marker: painted as part of `a`
    break;
  }
  const deck: RoomKind[] = rng.shuffle([
    ...Array(4).fill('security'),
    ...Array(3).fill('fuel'),
    ...Array(3).fill('crew'),
    ...Array(3).fill('crusher'),
    ...Array(2).fill('droneBay'),
    ...Array(4).fill('machinery'),
  ] as RoomKind[]);
  for (const room of rooms) if (room.kind === 'cargo' && room.depth > 0) room.kind = deck.pop() ?? 'cargo';

  // ---- 4. paint -----------------------------------------------------------------------
  const g = new PixelGrid(WORLD_W, WORLD_H);
  const p = new Painter(g);
  const back = new PixelGrid(WORLD_W, WORLD_H);
  const bp = new Painter(back);
  const hx0 = X0 - HULL_SKIN - 32;
  const hx1 = X0 + COLS * S + HULL_SKIN + 32;
  const hy0 = Y0 - HULL_SKIN - 32;
  const hy1 = Y0 + ROWS * S + HULL_SKIN + 32;
  const hcy = (hy0 + hy1) / 2;
  // hull silhouette: tapered prow left, engine block right
  p.poly(
    [
      [hx0 - 120, hcy],
      [hx0, hy0 + 140],
      [hx0 + 160, hy0],
      [hx1 - 120, hy0],
      [hx1, hy0 + 120],
      [hx1, hy1 - 120],
      [hx1 - 120, hy1],
      [hx0 + 160, hy1],
      [hx0, hy1 - 140],
    ],
    M.HULL,
  );
  // interior bulk: softer plate, with an indestructible girder lattice holding it up
  p.rect(hx0 + HULL_SKIN, hy0 + HULL_SKIN, hx1 - hx0 - 2 * HULL_SKIN, hy1 - hy0 - 2 * HULL_SKIN, M.PLATE);
  for (let x = X0; x <= X0 + COLS * S; x += 128) p.rect(x - 3, hy0 + HULL_SKIN, 6, hy1 - hy0 - 2 * HULL_SKIN, M.FRAME);
  for (let y = Y0; y <= Y0 + ROWS * S; y += 128) p.rect(hx0 + HULL_SKIN, y - 3, hx1 - hx0 - 2 * HULL_SKIN, 6, M.FRAME);

  // room rects
  for (const room of rooms) {
    if ((room.kind as string) === 'merged') continue;
    const xs = room.slots.map(([c]) => c);
    const ys = room.slots.map(([, r]) => r);
    const sx0 = X0 + Math.min(...xs) * S;
    const sx1 = X0 + (Math.max(...xs) + 1) * S;
    const sy0 = Y0 + Math.min(...ys) * S;
    const sy1 = Y0 + (Math.max(...ys) + 1) * S;
    room.rect = {
      x0: sx0 + rng.int(28, 56),
      x1: sx1 - rng.int(28, 56),
      y0: sy0 + rng.int(28, 56),
      y1: sy1 - rng.int(28, 56),
    };
  }
  const realRoom = (id: number): Room => {
    const r = rooms[id];
    if ((r.kind as string) !== 'merged') return r;
    const [c, row] = r.slots[0];
    return rooms[slotRoom.get(key(c - 1, row))!];
  };

  // carve rooms (lining first, then the hollow)
  for (const room of rooms) {
    if ((room.kind as string) === 'merged') continue;
    const r = room.rect;
    p.rect(r.x0 - LINING, r.y0 - LINING, r.x1 - r.x0 + 2 * LINING, r.y1 - r.y0 + 2 * LINING, M.HULL);
    p.clear(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    bp.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, M.PLATE).seams(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, M.PLATE, 32, 24, 40);
  }

  // corridors + doorways
  const doors: DoorSpec[] = [];
  const corridorRects: CellRect[] = [];
  const plugs: { rect: CellRect; room: Room }[] = [];
  for (const e of edges) {
    let [a, b] = e.split('-').map(Number).map(realRoom);
    if (a === b) continue;
    const ac = a.slots.map(([c]) => c);
    const bc = b.slots.map(([c]) => c);
    const horizontal = Math.max(...ac) < Math.min(...bc) || Math.max(...bc) < Math.min(...ac);
    if (horizontal) {
      if (a.rect.x0 > b.rect.x0) [a, b] = [b, a];
      const lo = Math.max(a.rect.y0, b.rect.y0) + 8;
      const hi = Math.min(a.rect.y1, b.rect.y1) - 8 - CORRIDOR;
      const y = Math.floor(hi > lo ? rng.range(lo, hi) : (Math.max(a.rect.y0, b.rect.y0) + Math.min(a.rect.y1, b.rect.y1) - CORRIDOR) / 2);
      const c: CellRect = { x0: a.rect.x1, x1: b.rect.x0, y0: y, y1: y + CORRIDOR };
      corridorRects.push(c);
      for (const [room, x] of [
        [a, a.rect.x1],
        [b, b.rect.x0],
      ] as const) {
        doors.push({ x0: m(x - 4), x1: m(x + 4), y0: m(c.y0), y1: m(c.y1), axis: 'v', roomId: room.id });
        if (SEALED_KINDS.has(room.kind)) plugs.push({ rect: { x0: x - (room === a ? 10 : 0), x1: x + (room === a ? 0 : 10), y0: c.y0, y1: c.y1 }, room });
      }
    } else {
      if (a.rect.y0 > b.rect.y0) [a, b] = [b, a];
      const lo = Math.max(a.rect.x0, b.rect.x0) + 8;
      const hi = Math.min(a.rect.x1, b.rect.x1) - 8 - CORRIDOR;
      const x = Math.floor(hi > lo ? rng.range(lo, hi) : (Math.max(a.rect.x0, b.rect.x0) + Math.min(a.rect.x1, b.rect.x1) - CORRIDOR) / 2);
      const c: CellRect = { x0: x, x1: x + CORRIDOR, y0: a.rect.y1, y1: b.rect.y0 };
      corridorRects.push(c);
      for (const [room, y] of [
        [a, a.rect.y1],
        [b, b.rect.y0],
      ] as const) {
        doors.push({ x0: m(c.x0), x1: m(c.x1), y0: m(y - 4), y1: m(y + 4), axis: 'h', roomId: room.id });
        if (SEALED_KINDS.has(room.kind)) plugs.push({ rect: { x0: c.x0, x1: c.x1, y0: y - (room === a ? 10 : 0), y1: y + (room === a ? 0 : 10) }, room });
      }
    }
  }
  for (const c of corridorRects) {
    const vertical = c.y1 - c.y0 > c.x1 - c.x0 && c.x1 - c.x0 === CORRIDOR;
    if (vertical) p.rect(c.x0 - LINING, c.y0, CORRIDOR + 2 * LINING, c.y1 - c.y0, M.HULL);
    else p.rect(c.x0, c.y0 - LINING, c.x1 - c.x0, CORRIDOR + 2 * LINING, M.HULL);
  }
  for (const c of corridorRects) {
    p.clear(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
    bp.rect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0, M.PLATE).seams(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0, M.PLATE, 16, 48, 40);
  }

  // entry: a corridor from the entry room out through the prow side, closed by an airlock plug
  const entry = rooms[0];
  const ey = Math.floor((entry.rect.y0 + entry.rect.y1 - CORRIDOR) / 2);
  const outsideX = hx0 - 60;
  p.rect(outsideX, ey - LINING, entry.rect.x0 - outsideX, CORRIDOR + 2 * LINING, M.HULL);
  p.clear(outsideX, ey, entry.rect.x0 - outsideX, CORRIDOR);
  // cut back the prow so the corridor opens to space, then seal it with an airlock door
  const airlockX = hx0 + 40;
  p.rect(airlockX, ey, 12, CORRIDOR, M.PLATE);
  p.clear(outsideX - 200, ey, airlockX - (outsideX - 200), CORRIDOR);
  doors.push({ x0: m(airlockX), x1: m(airlockX + 12), y0: m(ey), y1: m(ey + CORRIDOR), axis: 'v', roomId: entry.id });

  // ---- templates -----------------------------------------------------------------------
  const bodies: BodySpec[] = [];
  const entities: EntitySpec[] = [];
  const pressurized: LevelSpec['pressurized'] = [];
  let salvageIndex = -1;
  const placed: CellRect[] = [];
  const isFree = (r: CellRect): boolean => {
    for (const o of placed) if (r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) return false;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (g.solid(x, y)) return false;
    return true;
  };
  for (const room of rooms) {
    if ((room.kind as string) === 'merged') continue;
    const ctx: RoomCtx = {
      p,
      bp,
      rng,
      r: room.rect,
      id: room.id,
      addBody: (grid, cx, cy, extra = {}) => {
        // only into free space: a body spawned overlapping a wall or another body gets a
        // violent depenetration kick (and explosive ones detonate)
        const r = room.rect;
        for (let t = 0; t < 16; t++) {
          const px = t === 0 ? cx : rng.range(r.x0 + grid.w / 2 + 4, r.x1 - grid.w / 2 - 4);
          const py = t === 0 ? cy : rng.range(r.y0 + grid.h / 2 + 4, r.y1 - grid.h / 2 - 4);
          const fr = { x0: Math.floor(px - grid.w / 2) - 3, y0: Math.floor(py - grid.h / 2) - 3, x1: Math.ceil(px + grid.w / 2) + 3, y1: Math.ceil(py + grid.h / 2) + 3 };
          if (!isFree(fr)) continue;
          placed.push(fr);
          return bodies.push({ grid, x: m(px - grid.w / 2), y: m(py - grid.h / 2), angle: 0, ...extra }) - 1;
        }
        return -1;
      },
      addEntity: (e) => entities.push(e),
      addPressurized: (r, gas) => pressurized.push({ x0: m(r.x0), y0: m(r.y0), x1: m(r.x1), y1: m(r.y1), gas }),
      setCore: (i) => (salvageIndex = i),
    };
    ROOM_KINDS[room.kind](ctx);
    // roaming security beyond the first rooms, so stealth matters throughout the ship
    if (room.depth >= 2 && PATROLLED.has(room.kind) && rng.chance(0.45)) addPatrolBot(ctx);
  }
  // sealed rooms: plug their doorways after templates so the air stays in
  for (const { rect } of plugs) p.rect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0, M.PLATE);
  // corridor turrets at a few long corridors
  for (const c of corridorRects) {
    const len = Math.max(c.x1 - c.x0, c.y1 - c.y0);
    if (len < 70 || !rng.chance(0.3)) continue;
    const vertical = c.y1 - c.y0 > c.x1 - c.x0;
    if (vertical) entities.push({ type: 'turret', x: m(c.x0), y: m((c.y0 + c.y1) / 2), dir: 0, roomId: -1 });
    else entities.push({ type: 'turret', x: m((c.x0 + c.x1) / 2), y: m(c.y1), dir: -Math.PI / 2, roomId: -1 });
  }

  // exterior dressing
  p.seams(hx0 - 140, hy0 - 10, hx1 - hx0 + 160, hy1 - hy0 + 20, M.HULL, 24, 16);
  p.weather(hx0 + 160, hy1 - 8, hx1 - hx0 - 280, 10, 60, 2, 6, seed);
  p.weather(hx0 + 160, hy0 - 2, hx1 - hx0 - 280, 10, 60, 2, 6, seed + 1);

  const roomsOut: RoomInfo[] = rooms
    .filter((r) => (r.kind as string) !== 'merged')
    .map((r) => ({ id: r.id, kind: r.kind, depth: r.depth, x0: m(r.rect.x0), y0: m(r.rect.y0), x1: m(r.rect.x1), y1: m(r.rect.y1) }));

  const spawnX = m(outsideX - 160);
  const spawnY = m(ey + CORRIDOR / 2);
  return {
    name: 'Derelict (generated)',
    seed,
    terrain: g,
    backdrop: back,
    bodies,
    salvageIndex,
    shipSpawn: { x: spawnX, y: spawnY, angle: 0 },
    extraction: { x0: spawnX - 8, y0: spawnY + 10, x1: spawnX + 8, y1: spawnY + 22 },
    pressurized,
    center: { x: m((hx0 + hx1) / 2), y: m(hcy) },
    rooms: roomsOut,
    doors,
    entities,
  };
}
