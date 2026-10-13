// Material registry. Per-material properties are flattened into typed lookup tables so
// hot loops (damage, flood fill, painting) index by material id without object access.
// Adding a material = one entry in DEFS; behaviors keyed off flags, not ids, where possible.
//
// Thermal model (the cutter is a heat tool, not an eraser): a cell only gives way once it is
// hotter than its `burn` point; `heatCap` is how much beam energy a unit of heat takes;
// `cool` is how fast it radiates (1/s, low = glows longer); `spark` is spark output while the
// beam is on it; `load` is how hard it works the laser (heat-meter gain multiplier). Nothing
// structural is truly uncuttable: tough stuff just needs white heat and overheats the laser.

export const M = {
  EMPTY: 0,
  HULL: 1, // outer plating
  PLATE: 2, // interior bulkheads, softer
  FRAME: 3, // structural girders: very tough, anchors terrain in place
  FUEL: 4, // explosive tank contents
  CORE: 5, // salvage component casing: never cut (it's the prize)
  GLASS: 6, // windows, brittle
  SCRAP: 7, // loose junk
  LIGHT: 8, // emissive fixture (cosmetic), soft
  PISTON: 9, // machine steel: very tough
  STRIPE: 10, // machine hazard striping: very tough
  EYE: 11, // robot sensor: brittle, glowing; a robot dies when its eyes are gone
  BULKHEAD: 12, // emergency door slab: tough
  TURRET: 13, // wall turret / camera housing: works while powered (it conducts)
  ARMOR: 14, // refractory plating: must glow white before it burns, works the laser hard
  POWER: 15, // power cell / reactor core: the source of a power network (always energized)
  CONDUIT: 16, // power bus: carries power between cells that conduct
  THRUSTER: 17, // robot engine block: works while powered
  WEAPON: 18, // robot gun / shock prongs: works while powered
  SOCKET: 19, // wall power socket: live while a powered body's conductor touches it
  PDOOR: 20, // pressure door slab: the toughest cuttable material; opens on pressure
  PUMP: 21, // air pump housing: pressurizes its room while powered
  PANEL: 22, // door / airlock control panel: works (G) while powered
} as const;
export type MaterialId = (typeof M)[keyof typeof M];

export const F = {
  SOLID: 1,
  ANCHOR: 2, // terrain containing this cannot detach
  EXPLOSIVE: 4,
  EMISSIVE: 8, // glows while powered (POWER itself always glows)
  CONDUCTS: 16, // part of a power network (see pixel/power.ts)
  RUPTURES: 32, // explodes when destroyed (cut, blasted, crushed), but heat alone doesn't set it off
} as const;

interface MaterialDef {
  id: number;
  name: string;
  color: [number, number, number];
  variation: number; // shade noise amplitude 0..1
  hp: number; // hit points per cell
  armor: number; // damage multiplier: 0 = indestructible
  density: number; // kg/m²
  flags: number;
  burn?: number; // heat (0..MAX_HEAT) above which the beam damages the cell (default 0.45)
  heatCap?: number; // beam energy per unit heat (default 1)
  cool?: number; // 1/s radiative cooling (default 0.3)
  spark?: number; // sparks per beam step (default 1)
  load?: number; // laser heat-meter multiplier while the beam is on it (default 1)
}

const DEFS: MaterialDef[] = [
  { id: M.EMPTY, name: 'empty', color: [0, 0, 0], variation: 0, hp: 0, armor: 0, density: 0, flags: 0 },
  { id: M.HULL, name: 'hull', color: [112, 120, 134], variation: 0.12, hp: 180, armor: 1, density: 60, flags: F.SOLID, burn: 0.5, spark: 1.2 },
  { id: M.PLATE, name: 'plate', color: [86, 92, 104], variation: 0.1, hp: 55, armor: 1, density: 40, flags: F.SOLID, burn: 0.35, heatCap: 0.8, spark: 0.8 },
  { id: M.FRAME, name: 'frame', color: [58, 52, 48], variation: 0.08, hp: 800, armor: 1, density: 120, flags: F.SOLID | F.ANCHOR, burn: 0.85, heatCap: 2, cool: 0.18, spark: 2.5, load: 2.6 },
  { id: M.FUEL, name: 'fuel', color: [196, 84, 40], variation: 0.15, hp: 30, armor: 1, density: 50, flags: F.SOLID | F.EXPLOSIVE, burn: 0.3, spark: 0.3 },
  { id: M.CORE, name: 'core', color: [64, 200, 190], variation: 0.12, hp: 1, armor: 0, density: 80, flags: F.SOLID, heatCap: 3, spark: 0.5, load: 1.5 },
  { id: M.GLASS, name: 'glass', color: [120, 190, 230], variation: 0.06, hp: 12, armor: 1, density: 25, flags: F.SOLID, burn: 0.25, heatCap: 0.6, cool: 0.6, spark: 0 },
  { id: M.SCRAP, name: 'scrap', color: [128, 110, 92], variation: 0.2, hp: 40, armor: 1, density: 45, flags: F.SOLID, burn: 0.35, spark: 1 },
  { id: M.LIGHT, name: 'light', color: [255, 214, 140], variation: 0.05, hp: 20, armor: 1, density: 30, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS, burn: 0.3, spark: 0.5 },
  { id: M.PISTON, name: 'piston', color: [138, 142, 152], variation: 0.06, hp: 400, armor: 1, density: 200, flags: F.SOLID, burn: 1.05, heatCap: 2.6, cool: 0.18, spark: 2.5, load: 2.8 },
  { id: M.STRIPE, name: 'stripe', color: [214, 172, 40], variation: 0.05, hp: 400, armor: 1, density: 200, flags: F.SOLID, burn: 1.05, heatCap: 2.6, cool: 0.18, spark: 2.5, load: 2.8 },
  { id: M.EYE, name: 'eye', color: [255, 196, 90], variation: 0.08, hp: 10, armor: 1, density: 30, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS, burn: 0.3, spark: 0.5 },
  { id: M.BULKHEAD, name: 'bulkhead', color: [150, 132, 70], variation: 0.08, hp: 160, armor: 1, density: 90, flags: F.SOLID, burn: 0.85, heatCap: 1.6, cool: 0.22, spark: 2, load: 1.8 },
  { id: M.TURRET, name: 'turret', color: [70, 76, 92], variation: 0.1, hp: 70, armor: 1, density: 80, flags: F.SOLID | F.CONDUCTS, burn: 0.55, spark: 1.2 },
  { id: M.POWER, name: 'power core', color: [235, 30, 42], variation: 0.1, hp: 30, armor: 1, density: 70, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS | F.RUPTURES, burn: 0.35, spark: 0.6 },
  { id: M.CONDUIT, name: 'conduit', color: [196, 112, 52], variation: 0.08, hp: 18, armor: 1, density: 60, flags: F.SOLID | F.CONDUCTS, burn: 0.3, spark: 1.5 },
  { id: M.THRUSTER, name: 'thruster', color: [74, 92, 132], variation: 0.08, hp: 45, armor: 1, density: 70, flags: F.SOLID | F.CONDUCTS, burn: 0.45, spark: 1.2 },
  { id: M.WEAPON, name: 'weapon', color: [150, 64, 170], variation: 0.08, hp: 45, armor: 1, density: 70, flags: F.SOLID | F.CONDUCTS, burn: 0.45, spark: 1.2 },
  { id: M.SOCKET, name: 'socket', color: [70, 160, 255], variation: 0.06, hp: 120, armor: 1, density: 80, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS, burn: 0.8, heatCap: 1.5, spark: 1.5, load: 1.5 },
  { id: M.PDOOR, name: 'pressure door', color: [104, 112, 128], variation: 0.04, hp: 1000, armor: 1, density: 140, flags: F.SOLID, burn: 0.85, heatCap: 2, cool: 0.14, spark: 3, load: 3 },
  { id: M.PUMP, name: 'pump', color: [80, 200, 120], variation: 0.08, hp: 60, armor: 1, density: 80, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS, burn: 0.5, spark: 1 },
  { id: M.PANEL, name: 'door panel', color: [120, 230, 200], variation: 0.05, hp: 60, armor: 1, density: 70, flags: F.SOLID | F.EMISSIVE | F.CONDUCTS, burn: 0.5, spark: 1.2 },
  { id: M.ARMOR, name: 'armor', color: [52, 56, 66], variation: 0.05, hp: 800, armor: 1, density: 110, flags: F.SOLID, burn: 0.8, heatCap: 2, cool: 0.16, spark: 3, load: 2.5 },
];

/** Hottest a cell gets (white heat). Burn points must sit below it. */
export const MAX_HEAT = 1.2;

export const MAT_FLAGS = new Uint8Array(256);
export const MAT_HP = new Float32Array(256);
export const MAT_ARMOR = new Float32Array(256);
export const MAT_DENSITY = new Float32Array(256);
export const MAT_RGB = new Uint8Array(256 * 3);
export const MAT_VAR = new Float32Array(256);
export const MAT_NAME: string[] = [];
export const MAT_BURN = new Float32Array(256);
export const MAT_HEATCAP = new Float32Array(256).fill(1);
export const MAT_COOL = new Float32Array(256);
export const MAT_SPARK = new Float32Array(256);
export const MAT_LOAD = new Float32Array(256).fill(1);

for (const d of DEFS) {
  MAT_FLAGS[d.id] = d.flags;
  MAT_HP[d.id] = d.hp;
  MAT_ARMOR[d.id] = d.armor;
  MAT_DENSITY[d.id] = d.density;
  MAT_RGB.set(d.color, d.id * 3);
  MAT_VAR[d.id] = d.variation;
  MAT_NAME[d.id] = d.name;
  MAT_BURN[d.id] = d.burn ?? 0.45;
  MAT_HEATCAP[d.id] = d.heatCap ?? 1;
  MAT_COOL[d.id] = d.cool ?? 0.3;
  MAT_SPARK[d.id] = d.spark ?? 1;
  MAT_LOAD[d.id] = d.load ?? 1;
}

export const isSolidMat = (m: number) => (MAT_FLAGS[m] & F.SOLID) !== 0;

/** Does this cell emit light? Emissive materials glow only while powered; a power core always does. */
export const glows = (mat: number, powered: number) => (MAT_FLAGS[mat] & F.EMISSIVE) !== 0 && (powered !== 0 || mat === M.POWER);

/**
 * Packs a cell's display color (RGBA, little-endian ABGR uint32) from material, shade noise,
 * damage, heat, and power (unpowered emissive cells are dark).
 */
export function cellColor(mat: number, shade: number, hpFrac: number, heat = 0, powered = 0): number {
  if (mat === M.EMPTY) return 0;
  const v = MAT_VAR[mat];
  let k = 1 + (shade / 255 - 0.5) * 2 * v;
  if (MAT_FLAGS[mat] & F.EMISSIVE && !glows(mat, powered)) k *= 0.4;
  // damaged cells darken and pick up a scorched tint
  const dmg = 1 - Math.min(1, Math.max(0, hpFrac));
  k *= 1 - dmg * 0.45;
  let r = MAT_RGB[mat * 3] * k;
  let g = MAT_RGB[mat * 3 + 1] * k;
  let b = MAT_RGB[mat * 3 + 2] * k;
  if (dmg > 0) {
    r += dmg * 70;
    g += dmg * 18;
  }
  if (heat > 0.01) {
    // incandescence: dull red, then orange, then yellow, then white
    const h = Math.min(MAX_HEAT, heat);
    r += 255 * Math.min(1, h * 1.4);
    g += 200 * h * h;
    b += 150 * h * h * h * h;
  }
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
