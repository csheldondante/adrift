// Material registry. Per-material properties are flattened into typed lookup tables so
// hot loops (damage, flood fill, painting) index by material id without object access.
// Adding a material = one entry in DEFS; behaviors keyed off flags, not ids, where possible.

export const M = {
  EMPTY: 0,
  HULL: 1, // outer plating, cuttable
  PLATE: 2, // interior bulkheads, softer
  FRAME: 3, // structural girders: indestructible, anchors terrain in place
  FUEL: 4, // explosive tank contents
  CORE: 5, // salvage component casing, indestructible
  GLASS: 6, // windows, brittle
  SCRAP: 7, // loose junk
  LIGHT: 8, // emissive fixture (cosmetic), soft
} as const;
export type MaterialId = (typeof M)[keyof typeof M];

export const F = {
  SOLID: 1,
  ANCHOR: 2, // terrain containing this cannot detach
  EXPLOSIVE: 4,
  EMISSIVE: 8,
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
}

const DEFS: MaterialDef[] = [
  { id: M.EMPTY, name: 'empty', color: [0, 0, 0], variation: 0, hp: 0, armor: 0, density: 0, flags: 0 },
  { id: M.HULL, name: 'hull', color: [112, 120, 134], variation: 0.12, hp: 100, armor: 1, density: 60, flags: F.SOLID },
  { id: M.PLATE, name: 'plate', color: [86, 92, 104], variation: 0.1, hp: 55, armor: 1, density: 40, flags: F.SOLID },
  { id: M.FRAME, name: 'frame', color: [58, 52, 48], variation: 0.08, hp: 1, armor: 0, density: 120, flags: F.SOLID | F.ANCHOR },
  { id: M.FUEL, name: 'fuel', color: [196, 84, 40], variation: 0.15, hp: 30, armor: 1, density: 50, flags: F.SOLID | F.EXPLOSIVE },
  { id: M.CORE, name: 'core', color: [64, 200, 190], variation: 0.12, hp: 1, armor: 0, density: 80, flags: F.SOLID },
  { id: M.GLASS, name: 'glass', color: [120, 190, 230], variation: 0.06, hp: 12, armor: 1, density: 25, flags: F.SOLID },
  { id: M.SCRAP, name: 'scrap', color: [128, 110, 92], variation: 0.2, hp: 40, armor: 1, density: 45, flags: F.SOLID },
  { id: M.LIGHT, name: 'light', color: [255, 214, 140], variation: 0.05, hp: 20, armor: 1, density: 30, flags: F.SOLID | F.EMISSIVE },
];

export const MAT_FLAGS = new Uint8Array(256);
export const MAT_HP = new Float32Array(256);
export const MAT_ARMOR = new Float32Array(256);
export const MAT_DENSITY = new Float32Array(256);
export const MAT_RGB = new Uint8Array(256 * 3);
export const MAT_VAR = new Float32Array(256);
export const MAT_NAME: string[] = [];

for (const d of DEFS) {
  MAT_FLAGS[d.id] = d.flags;
  MAT_HP[d.id] = d.hp;
  MAT_ARMOR[d.id] = d.armor;
  MAT_DENSITY[d.id] = d.density;
  MAT_RGB.set(d.color, d.id * 3);
  MAT_VAR[d.id] = d.variation;
  MAT_NAME[d.id] = d.name;
}

export const isSolidMat = (m: number) => (MAT_FLAGS[m] & F.SOLID) !== 0;

/** Packs a cell's display color (RGBA, little-endian ABGR uint32) from material, shade noise, and damage. */
export function cellColor(mat: number, shade: number, hpFrac: number): number {
  if (mat === M.EMPTY) return 0;
  const v = MAT_VAR[mat];
  let k = 1 + (shade / 255 - 0.5) * 2 * v;
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
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
