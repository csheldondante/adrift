// Contextual hints: one line saying what the thing in front of you is for, picked from game
// state (what's on the line or in the arms, what's nearby). Reads the game; never mutates it.
//
// Likely growth: hints that retire once you've done the thing; per-level hint text.

import { CELL } from '../config';
import type { Game } from '../game/Game';
import { hasPower } from '../game/systems/PowerNet';
import type { PixelBody } from '../pixel/PixelBody';

const near = (ax: number, ay: number, bx: number, by: number, r: number) => (ax - bx) ** 2 + (ay - by) ** 2 <= r * r;

export function hintFor(game: Game): string {
  const sh = game.ship;
  if (!sh.alive) return '';
  const x = sh.x;
  const y = sh.y;
  if (game.time < game.noticeUntil) return game.notice;
  if (game.autoPlug.phase !== 'idle') return `${game.autoPlug.message} (any move key takes over)`;
  const g = game.grapple;
  if (g.coreHooked) return 'Harpoon is in a power core: <b>hold RMB</b> to winch and tear it out';

  const panel = game.devices.panelNear(x, y);
  if (panel) {
    if (!panel.powered) return 'Door panel, dead: no power on its line';
    if (panel.door) return `<b>G</b>: ${panel.door.open ? 'close' : 'open'} the hatch`;
    const l = panel.lock!;
    if (l.state === 'toIn' || l.state === 'toOut') return `Airlock cycling: ${l.state === 'toOut' ? 'venting' : 'pressurizing'}…`;
    return `Airlock (${l.state === 'in' ? 'open to the inside' : 'open to the outside'}): <b>G</b> to cycle it`;
  }

  const robots = game.security.robots;
  const isRobot = (b: PixelBody) => robots.some((r) => r.pb === b && r.alive);
  const lineBody = g.targetObject?.kind === 'pixelBody' ? (g.targetObject as PixelBody) : null;
  const carried = [game.arms.held, lineBody].find((b) => b && b.alive && !b.tags.salvage && !isRobot(b) && hasPower(b));
  const dead = game.power.socketSpots().filter((s) => !s.live);
  const deadNear = dead.find((s) => near(s.x, s.y, x, y, 8));
  if (carried) {
    if (deadNear) return game.arms.held === carried ? 'Bring it close: the ship plugs it in by itself' : 'Grab it (<b>E</b>) and bring it close, or press it against the <b>blue socket</b>: red or copper has to touch its face';
    return dead.length
      ? 'Live power core: carry it (<b>E</b> to grab) to a <b>dead blue socket</b> (they pulse in the dark) and the ship plugs it in'
      : 'Live power core in tow';
  }
  const held = game.arms.held;
  if (held && held.alive && !held.tags.salvage && !isRobot(held))
    return 'Holding a piece: press it where it goes, then <b>Shift + LMB</b> on the seam (the weld beam) until it glows and fuses';
  if (deadNear) return 'Dead power socket: it needs a <b>power core</b> (a battery from a locker, or a drone\'s core: harpoon near it and winch)';

  for (const r of robots) {
    if (r.alive || !r.pb.alive || !hasPower(r.pb)) continue;
    const c = r.pb.body.worldCom();
    if (near(c.x, c.y, x, y, 9)) return 'Wrecked robot, core still live: harpoon <b>near the red core</b> and winch to tear it out';
  }
  for (const d of game.devices.doors) {
    if (d.spec.type !== 'pressureDoor' || d.open) continue;
    const s = d.spec;
    if (near(((s.x0 + s.x1) / 2) * CELL, ((s.y0 + s.y1) / 2) * CELL, x, y, 10))
      return 'Pressure door: opens when the room behind it holds air. Seal its breach (lay a plate over it, <b>Shift + LMB</b> the seam to weld it) and power its pump';
  }
  return '';
}
