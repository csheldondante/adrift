// URL tunable overrides for quick experiments and smoke runs, e.g.
//   ?grapple.segmentMass=12&physics.solverIterations=16
// Only keys that already exist in `tune` are accepted; values keep their original type.

import { tune } from '../config';

export function applyTuneOverrides(search: string): string[] {
  const applied: string[] = [];
  const t = tune as unknown as Record<string, Record<string, unknown>>;
  for (const [k, v] of new URLSearchParams(search)) {
    const [group, key] = k.split('.');
    if (!key || !t[group] || !(key in t[group])) continue;
    const cur = t[group][key];
    t[group][key] = typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === 'true' || v === '1' : v;
    applied.push(`${k}=${v}`);
  }
  return applied;
}
