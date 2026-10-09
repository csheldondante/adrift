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
  const modes = mode === 'all' ? ['fly', 'turn', 'brake', 'drift', 'hook', 'clamp', 'glow', 'impact', 'cut', 'vent', 'boom', 'grapple', 'rope'] : [mode];
  for (const md of modes) {
    restart();
    await sleep(300);
    if (md === 'overview') {
      const g = game();
      g.zoom = Number(new URLSearchParams(location.search).get('zoom') ?? 300);
      g.debugCamera = (window as unknown as { __level: { center: { x: number; y: number } } }).__level.center;
      const focus = new URLSearchParams(location.search).get('focus');
      if (focus) {
        const mc = g.machinery.machines.find((x) => (focus === 'crusher' ? x.shaft : !x.shaft));
        if (mc) g.debugCamera = mc.center(0);
      }
      await sleep(800);
      await shot('overview');
      await sleep(700);
      await shot('overview2');
    }
    if (md === 'soak') {
      for (let i = 0; i < 8; i++) {
        const t = performance.now();
        restart();
        if (i === 0) log('restart ms', Math.round(performance.now() - t));
        await sleep(300);
      }
      await sleep(1500);
      (window as unknown as { gc?: () => void }).gc?.();
      await sleep(200);
      log('soak', { fps: (window as unknown as { __stats: { fps: number } }).__stats.fps, heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6) });
    }
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
      (window as unknown as { gc?: () => void }).gc?.();
      await sleep(200);
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
      // 1) harpoon the prow from ~11 m: flight, thunk with slack, winch snaps taut
      place(m(150), m(380), 0);
      await sleep(100);
      const t0 = performance.now();
      fireAt(m(260), m(380));
      let tThunk = -1;
      let slackAtThunk = 0;
      while (performance.now() - t0 < 4000) {
        if (tThunk < 0 && g.grapple.attached) {
          tThunk = performance.now() - t0;
          slackAtThunk = 1 - g.grapple.endRatio;
          shot('harpoon-thunk');
          setTimeout(() => shot('harpoon-snap'), 90);
        }
        if (tThunk >= 0 && g.grapple.snug) break;
        await sleep(5);
      }
      const tSnug = performance.now() - t0;
      for (let i = 0; i < 16 && new URLSearchParams(location.search).has('trace'); i++) {
        log('tr', Math.round(performance.now() - t0), +g.grapple.length.toFixed(2), +g.grapple.endRatio.toFixed(3), +g.grapple.tautness.toFixed(3), Math.round(g.grapple.tension), +g.grapple.maxDeviation.toFixed(2), g.grapple.snug);
        await sleep(80);
      }
      await sleep(300);
      shot('harpoon-taut');
      const v = g.ship.body.linvel();
      log('harpoon', {
        thunkMs: Math.round(tThunk),
        slackAtThunk: +slackAtThunk.toFixed(2),
        snugMs: Math.round(tSnug),
        endRatio: +g.grapple.endRatio.toFixed(3),
        maxDeviationM: +g.grapple.maxDeviation.toFixed(3),
        shipSpeed: +Math.hypot(v.x, v.y).toFixed(2),
      });
      // 2) miss into open space: head flies to range, zips back
      g.grapple.detach();
      place(m(150), m(380), Math.PI);
      await sleep(100);
      fireAt(m(20), m(380));
      await sleep(150);
      shot('harpoon-flying');
      await sleep(1200);
      log('harpoon miss', { stateAfter: g.grapple.state });
    }
    if (md === 'clamp') {
      // harpoon a crate in open space, hold RMB to winch it in and clamp, carry it, click to let go
      const g = game();
      const crate = g.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && b.body.mass() > 100)!;
      crate.body.setTranslation({ x: 20, y: 80 }, true);
      crate.body.setLinvel({ x: 0, y: 0 }, true);
      crate.body.setAngvel(0, true);
      place(32, 81, Math.PI);
      await sleep(150);
      const cc = crate.body.worldCom();
      aim(cc.x, cc.y);
      input.simulateDown('Mouse2');
      const t0 = performance.now();
      while (performance.now() - t0 < 4000 && g.grapple.state !== 'clamped') await sleep(16);
      const tClamp = performance.now() - t0;
      input.simulateUp('Mouse2');
      shot('clamped');
      const gap0 = Math.hypot(crate.body.worldCom().x - g.ship.x, crate.body.worldCom().y - g.ship.y);
      await hold('KeyW', 1000);
      if (!crate.alive) { log('clamp', { error: 'crate destroyed', health: Math.round(g.ship.health) }); continue; }
      const gap1 = Math.hypot(crate.body.worldCom().x - g.ship.x, crate.body.worldCom().y - g.ship.y);
      const v = g.ship.body.linvel();
      log('clamp', { state: g.grapple.state, clampMs: Math.round(tClamp), gapBefore: +gap0.toFixed(2), gapAfterThrust: +gap1.toFixed(2), speed: +Math.hypot(v.x, v.y).toFixed(2) });
      input.simulateDown('Mouse2');
      await sleep(40);
      input.simulateUp('Mouse2');
      await sleep(100);
      log('clamp release', { state: g.grapple.state });
      // short click on an attached line releases it
      place(32, 81, Math.PI);
      await sleep(100);
      aim(crate.body.worldCom().x, crate.body.worldCom().y);
      input.simulateDown('Mouse2');
      await sleep(40);
      input.simulateUp('Mouse2');
      await sleep(600);
      const st = g.grapple.state;
      input.simulateDown('Mouse2');
      await sleep(40);
      input.simulateUp('Mouse2');
      await sleep(100);
      log('click release', { attachedBefore: st, after: g.grapple.state });
    }
    if (md === 'glow') {
      // cutter on an uncuttable girder (antenna mast): it should glow but not lose pixels
      const g = game();
      const grid = g.pixels.terrain.grid;
      const frameCells = () => {
        let n = 0;
        for (let y = 540; y < 610; y++) for (let x = 500; x < 503; x++) if (grid.mat[y * grid.w + x] === 3) n++;
        return n;
      };
      const before = frameCells();
      place(m(470), m(580), 0);
      await sleep(100);
      await hold('Mouse0', 1500, () => {
        place(m(470), m(580), 0);
        aim(m(501.5), m(580));
      });
      let maxHeat = 0;
      for (let y = 570; y < 590; y++) for (let x = 498; x < 506; x++) maxHeat = Math.max(maxHeat, grid.heat[y * grid.w + x]);
      shot('glow');
      await sleep(2500);
      let after = 0;
      for (let y = 570; y < 590; y++) for (let x = 498; x < 506; x++) after = Math.max(after, grid.heat[y * grid.w + x]);
      log('glow', { frameCellsBefore: before, frameCellsAfter: frameCells(), maxHeat: +maxHeat.toFixed(2), heatAfter2_5s: +after.toFixed(2) });
    }
    if (md === 'crush') {
      // park the ship where a crusher's ram ends up; it should die by crushing within a cycle
      const g = game();
      const mc = g.machinery.machines.find((x) => x.shaft);
      if (!mc) {
        log('crush', { error: 'no crusher in level' });
        continue;
      }
      let far = mc.center(0);
      let farD = 0;
      const c0 = mc.center(0);
      for (let t = 0; t < 4; t += 0.05) {
        const c = mc.center(t);
        const d = Math.hypot(c.x - c0.x, c.y - c0.y);
        if (d > farD) [far, farD] = [c, d];
      }
      // wait for the ram to be retracted, park the ship once at the end of its stroke, hands off
      while (Math.hypot(mc.center(g.machinery.time).x - c0.x, mc.center(g.machinery.time).y - c0.y) > 0.3) await sleep(10);
      place(far.x, far.y, 0);
      const t0 = performance.now();
      while (performance.now() - t0 < 6000 && g.ship.alive) await sleep(16);
      log('crush', { dead: !g.ship.alive, cause: g.ship.deathCause, ms: Math.round(performance.now() - t0) });
    }
    if (md === 'ride') {
      // harpoon a mover, winch in until clamped, and check the ship travels with it
      const g = game();
      const mc = g.machinery.machines.find((x) => !x.shaft);
      if (!mc) {
        log('ride', { error: 'no mover in level' });
        continue;
      }
      const b = mc.body.body.translation();
      const gw = mc.body.grid.w * CELL;
      const gh = mc.body.grid.h * CELL;
      place(b.x + gw / 2, b.y + gh + 5, -Math.PI / 2);
      await sleep(50);
      aim(b.x + gw / 2, b.y + gh / 2);
      input.simulateDown('Mouse2');
      const t0 = performance.now();
      while (performance.now() - t0 < 5000 && g.grapple.state !== 'clamped') await sleep(16);
      input.simulateUp('Mouse2');
      const s0 = { x: g.ship.x, y: g.ship.y };
      const m0 = mc.body.body.translation();
      await sleep(1500);
      const m1 = mc.body.body.translation();
      log('ride', {
        state: g.grapple.state,
        shipMoved: +Math.hypot(g.ship.x - s0.x, g.ship.y - s0.y).toFixed(2),
        moverMoved: +Math.hypot(m1.x - m0.x, m1.y - m0.y).toFixed(2),
        health: Math.round(g.ship.health),
      });
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
      (window as unknown as { gc?: () => void }).gc?.();
      await sleep(200);
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
      (window as unknown as { gc?: () => void }).gc?.();
      await sleep(200);
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
      aim(c.x - 2, c.y); // near side of the core; the line to its center clips the cradle plate
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
