// Scripted scenarios for headless smoke runs (?autotest=<mode>). They drive the real input
// path and log measurable outcomes so regressions show up without eyeballing.

import { CELL, tune } from '../config';
import type { Input } from '../core/Input';
import type { Game } from '../game/Game';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = (c: number) => c * CELL;

export async function runAutotest(mode: string, game: () => Game, input: Input, restart: () => void): Promise<void> {
  const log = (...a: unknown[]) => console.log('[autotest]', ...a);
  const place = (x: number, y: number, angle = 0) => {
    const b = game().ship.body;
    b.setTranslation({ x, y }, true);
    b.setLinvel({ x: 0, y: 0 }, true);
    b.setAngvel(0, true);
    b.setRotation(angle, true);
  };
  /** Aim at a world point by moving the virtual mouse. */
  const aim = (x: number, y: number) => {
    const g = game();
    const st = g.ctx.stage;
    const s = st.worldToScreen(x, y, { x: 0, y: 0 });
    input.mouseX = s.x;
    input.mouseY = s.y;
  };
  const hold = async (code: string, ms: number, tick?: () => void) => {
    input.simulateDown(code);
    const end = performance.now() + ms;
    while (performance.now() < end) {
      tick?.();
      await sleep(16);
    }
    input.simulateUp(code);
  };
  const solidCount = () => game().pixels.terrain.grid.countSolid();
  const shot = async (name: string) => {
    (window as unknown as { __shotReq: string | null }).__shotReq = name;
    await sleep(120);
  };
  /** Waits for the hook to bite and the auto-winch to finish (or timeout). */
  const waitTaut = async (ms = 6000) => {
    const end = performance.now() + ms;
    while (performance.now() < end && !game().grapple.snug) await sleep(16);
  };

  await sleep(800);
  const modes = mode === 'all' ? ['fly', 'turn', 'brake', 'drift', 'hook', 'impact', 'cut', 'vent', 'boom', 'grapple', 'rope'] : [mode];
  for (const md of modes) {
    restart();
    await sleep(300);
    if (md === 'fly') {
      const x0 = game().ship.x;
      await hold('KeyW', 800);
      await sleep(300);
      const v = game().ship.body.linvel();
      log('fly', { dx: +(game().ship.x - x0).toFixed(2), vx: +v.x.toFixed(2), vy: +v.y.toFixed(2) });
    }
    if (md === 'turn') {
      // time to reach 95% of turn rate, then time to brake to (almost) zero after release
      const b = game().ship.body;
      input.simulateDown('KeyA');
      const t0 = performance.now();
      let tUp = -1;
      while (performance.now() - t0 < 600) {
        if (tUp < 0 && b.angvel() >= tune.ship.turnRate * 0.95) tUp = performance.now() - t0;
        await sleep(5);
      }
      input.simulateUp('KeyA');
      const t1 = performance.now();
      let tDown = -1;
      while (performance.now() - t1 < 1500) {
        if (Math.abs(b.angvel()) < 0.1) {
          tDown = performance.now() - t1;
          break;
        }
        await sleep(5);
      }
      log('turn', { spinUpMs: Math.round(tUp), brakeMs: Math.round(tDown), rate: tune.ship.turnRate });
    }
    if (md === 'rope') {
      // tow the core sideways with each pivot; raw torque shows with rotation assist off
      const assist = tune.ship.rotationAssist;
      for (const pivot of ['com', 'nose'] as const) {
        restart();
        await sleep(300);
        tune.grapple.pivot = pivot;
        tune.ship.rotationAssist = false;
        const g = game();
        const core = g.salvage.body;
        core.setTranslation({ x: 25, y: 80 }, true); // open space: no walls to bump
        core.setLinvel({ x: 0, y: 0 }, true);
        core.setAngvel(0, true);
        await sleep(50);
        const c = core.worldCom();
        // face up-right before firing so no teleport-rotation jerks the anchored rope
        place(c.x + 7, c.y, Math.PI / 4);
        await sleep(150);
        aim(c.x, c.y);
        input.simulateDown('Mouse2');
        await sleep(40);
        input.simulateUp('Mouse2');
        await waitTaut();
        const a0 = g.ship.angle;
        let maxTaut = 0;
        let maxSpin = 0;
        let maxEnd = 0;
        await hold('KeyW', 2000, () => {
          maxTaut = Math.max(maxTaut, g.grapple.tautness);
          maxEnd = Math.max(maxEnd, g.grapple.endRatio);
          if (new URLSearchParams(location.search).has("trace") && Math.random() < 0.08) log("trace", pivot, +g.grapple.endRatio.toFixed(3), +g.ship.body.angvel().toFixed(2), +g.grapple.length.toFixed(2));
          maxSpin = Math.max(maxSpin, Math.abs(g.ship.body.angvel()));
        });
        const c1 = g.salvage.body.worldCom();
        log(`rope pivot=${pivot}`, {
          attached: g.grapple.attached,
          maxPath: +maxTaut.toFixed(3),
          maxEnds: +maxEnd.toFixed(3),
          maxSpin: +maxSpin.toFixed(2),
          headingChange: +(g.ship.angle - a0).toFixed(2),
          coreMoved: +Math.hypot(c1.x - c.x, c1.y - c.y).toFixed(2),
        });
      }
      tune.ship.rotationAssist = assist;
      tune.grapple.pivot = 'com';
    }
    if (md === 'drift') {
      // no boundary forces: a body thrown past the level edge must keep going
      const g = game();
      const b = g.pixels.bodies.find((x) => !x.tags.salvage)!;
      b.body.setTranslation({ x: 125, y: 40 }, true);
      b.body.setLinvel({ x: 8, y: 0 }, true);
      await sleep(1500);
      const v = b.body.linvel();
      log('drift', { x: +b.body.translation().x.toFixed(1), vx: +v.x.toFixed(2), alive: b.alive });
    }
    if (md === 'hook') {
      const g = game();
      const fireAt = (x: number, y: number) => {
        aim(x, y);
        input.simulateDown('Mouse2');
        setTimeout(() => input.simulateUp('Mouse2'), 20);
      };
      // 1) miss into open space: watch the coil unfurl (head distance over time)
      place(m(150), m(380), Math.PI);
      await sleep(100);
      const s0 = { x: g.ship.x, y: g.ship.y };
      fireAt(m(20), m(380));
      const dists: number[] = [];
      for (let i = 0; i < 12; i++) {
        await sleep(150);
        if (i === 1) shot('unfurl-0.3s');
        if (i === 4) shot('unfurl-0.75s');
        if (i === 8) shot('unfurl-1.35s');
        const h = g.grapple.headPosition;
        dists.push(h ? +Math.hypot(h.x - s0.x, h.y - s0.y).toFixed(1) : -1);
      }
      const v = g.ship.body.linvel();
      log('hook unfurl', { headDistEvery150ms: dists.join(' '), state: g.grapple.state, shipSpeed: +Math.hypot(v.x, v.y).toFixed(2) });
      await sleep(5000);
      log('hook miss', { stateAfter: g.grapple.state });
      // 2) bite the prow from ~11 m and snug up
      g.grapple.detach();
      place(m(150), m(380), 0);
      await sleep(100);
      const t0 = performance.now();
      fireAt(m(260), m(380));
      let tBite = -1;
      while (performance.now() - t0 < 5000) {
        if (tBite < 0 && g.grapple.attached) tBite = performance.now() - t0;
        if (tBite >= 0 && g.grapple.snug) break;
        await sleep(10);
      }
      const tTaut = performance.now() - t0;
      shot('hook-taut');
      const v2 = g.ship.body.linvel();
      log('hook bite', { biteMs: Math.round(tBite), snugMs: Math.round(tTaut), endRatio: +g.grapple.endRatio.toFixed(2), len: +g.grapple.length.toFixed(2), shipSpeed: +Math.hypot(v2.x, v2.y).toFixed(2), health: Math.round(g.ship.health) });
    }
    if (md === 'brake') {
      const g = game();
      await hold('KeyW', 700);
      const v0 = Math.hypot(g.ship.body.linvel().x, g.ship.body.linvel().y);
      await sleep(1000);
      const v1 = Math.hypot(g.ship.body.linvel().x, g.ship.body.linvel().y);
      log('brake', { v0: +v0.toFixed(2), after1s: +v1.toFixed(2) });
    }
    if (md === 'impact') {
      // whip-style hits: a barrel and a crate thrown into the hull
      const g = game();
      place(m(150), m(600), 0);
      const barrel = g.pixels.bodies.find((b) => b.explosiveCells > 0)!;
      barrel.body.setTranslation({ x: m(200), y: m(300) }, true);
      barrel.body.setLinvel({ x: 25, y: 0 }, true);
      const crate = g.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && b.body.mass() > 100)!;
      crate.body.setTranslation({ x: m(200), y: m(460) }, true);
      crate.body.setLinvel({ x: 22, y: 0 }, true);
      const before = solidCount();
      await sleep(1500);
      log('impact', { explosions: g.hazards.explosions, crateMass: Math.round(crate.body.mass()), removed: before - solidCount() });
    }
    if (md === 'cut') {
      // slice the hold roof at two x positions (from above) so the section between detaches
      const before = solidCount();
      const bodies0 = game().pixels.bodies.length;
      for (const cx of [622, 726]) {
        await hold('Mouse0', 2600, () => {
          place(m(cx), m(585), -Math.PI / 2);
          aim(m(cx) + Math.sin(performance.now() / 120) * 0.4, m(520));
        });
      }
      await sleep(600);
      const roof = game().pixels.bodies.find((b) => b.grid.w > 60);
      log('cut', { removed: before - solidCount(), bodiesBefore: bodies0, bodiesAfter: game().pixels.bodies.length, roofDetached: !!roof, roofMass: roof ? Math.round(roof.body.mass()) : 0 });
    }
    if (md === 'vent') {
      place(m(380), m(575), -Math.PI / 2);
      await sleep(300);
      const g = game();
      const s = { gas: 0, heat: 0, vx: 0, vy: 0 };
      g.ctx.field.sample(m(380), m(450), s);
      const gasBefore = s.gas;
      await hold('Mouse0', 1800, () => {
        place(m(380), m(575), -Math.PI / 2);
        aim(m(380) + Math.sin(performance.now() / 150) * 3, m(530));
      });
      // retreat and watch it vent
      place(m(300), m(640), 0);
      await sleep(1500);
      g.ctx.field.sample(m(380), m(450), s);
      const speeds = g.pixels.bodies.filter((b) => {
        const c = b.body.worldCom();
        return c.x > m(312) && c.x < m(440) && c.y > m(384);
      });
      const maxV = Math.max(0, ...g.pixels.bodies.map((b) => Math.hypot(b.body.linvel().x, b.body.linvel().y)));
      log('vent', { gasBefore: +gasBefore.toFixed(3), gasAfter: +s.gas.toFixed(3), bodiesStillInB: speeds.length, maxBodySpeed: +maxV.toFixed(2) });
    }
    if (md === 'boom') {
      place(m(520), m(150), Math.PI / 2);
      const g = game();
      const before = solidCount();
      g.hazards.detonateNearest(m(530), m(262));
      await sleep(2500);
      log('boom', { explosions: g.hazards.explosions, removed: before - solidCount(), bodies: g.pixels.bodies.length, health: Math.round(g.ship.health) });
    }
    if (md === 'grapple') {
      const g = game();
      const target = g.salvage;
      const c = target.body.worldCom();
      // put the ship inside the hold (as if a way in was cut), next to the core
      place(c.x - 5.25, c.y + 6, Math.PI / 2); // open hold space up-left of the core, clear of the pillar
      await sleep(200);
      aim(c.x, c.y);
      input.simulateDown('Mouse2');
      await sleep(50);
      input.simulateUp('Mouse2');
      await waitTaut();
      log('grapple attach', { health: Math.round(g.ship.health), attached: g.grapple.attached, toCore: g.grapple.targetObject === target, len: +g.grapple.length.toFixed(2) });
      const c0 = target.body.worldCom();
      aim(c.x - 5.25, c.y + 20);

      await hold('KeyW', 1500);
      const c1 = target.body.worldCom();
      log('grapple tow', { health: Math.round(g.ship.health), coreMoved: +Math.hypot(c1.x - c0.x, c1.y - c0.y).toFixed(2), coreMass: Math.round(target.body.mass()), shipMass: Math.round(g.ship.body.mass()) });
    }
  }
  log('done');
}
