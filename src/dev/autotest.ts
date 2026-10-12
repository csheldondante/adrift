// Scripted scenarios for headless smoke runs (?autotest=<mode>). They drive the real input
// path and log measurable outcomes so regressions show up without eyeballing.

import { CELL, tune } from '../config';
import type { Input } from '../core/Input';
import type { Game } from '../game/Game';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = (c: number) => c * CELL;

export async function runAutotest(mode: string, game: () => Game, input: Input, restart: () => void): Promise<void> {
  // stringify: the console preview truncates objects to their first few properties
  const log = (...a: unknown[]) => console.log('[autotest]', ...a.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)));
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
  const modes = mode === 'all' ? ['fly', 'turn', 'brake', 'drift', 'crash', 'laser', 'hook', 'clamp', 'glow', 'impact', 'cut', 'vent', 'boom', 'grapple', 'rope', 'walk', 'arms', 'sound'] : mode.split(',');
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
    if (md === 'walk') {
      // clamp onto a wall, walk along it (wrapping corners), check standoff and camera roll,
      // then push off
      const g = game();
      const grid = g.pixels.terrain.grid;
      const roomy = (x: number, y: number) => {
        for (let oy = -1.6; oy <= 1.6; oy += 0.4) for (let ox = -1.6; ox <= 1.6; ox += 0.4) if (grid.solid(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL))) return false;
        return true;
      };
      // the derelict's outer hull, 2 m off it on the line from the spawn point to the level center
      const ctr = (window as unknown as { __level: { center: { x: number; y: number } } }).__level.center;
      const sx = g.ship.x;
      const sy = g.ship.y;
      const dl = Math.hypot(ctr.x - sx, ctr.y - sy);
      const ux = (ctr.x - sx) / dl;
      const uy = (ctr.y - sy) / dl;
      const hull = g.pixels.raycast(sx, sy, ux, uy, dl);
      let spot: { x: number; y: number } | null = hull ? { x: hull.x - ux * 2, y: hull.y - uy * 2 } : null;
      if (spot && !roomy(spot.x, spot.y)) spot = null;
      if (!spot) {
        log(md, { skipped: 'no wall found' });
        continue;
      }
      place(spot.x, spot.y, Math.atan2(uy, ux) + Math.PI / 2);
      aim(spot.x - uy * 10, spot.y + ux * 10);
      await sleep(100);
      input.simulateDown('KeyE');
      await sleep(40);
      input.simulateUp('KeyE');
      const w = g.walk;
      const att: number[][] = [];
      for (let i = 0; i < 18; i++) {
        await sleep(50);
        const vv = g.ship.body.linvel();
        att.push([w.attached ? 1 : 0, +w.gap.toFixed(2), +vv.x.toFixed(2), +vv.y.toFixed(2), +g.ship.x.toFixed(2), +g.ship.y.toFixed(2)]);
      }
      log('walk-attach', att);
      const landed = { attached: w.attached, gap: +w.gap.toFixed(2), normal: [+w.nx.toFixed(2), +w.ny.toFixed(2)] };
      let minGap = 99;
      let maxGap = 0;
      const normals = new Set<number>();
      const p0 = { x: g.ship.x, y: g.ship.y };
      let path = 0;
      let last = { ...p0 };
      let shotTaken = false;
      const trace: number[][] = [];
      let nextT = performance.now();
      await hold('KeyD', 8000, () => {
        if (performance.now() > nextT) {
          nextT += 250;
          const vv = g.ship.body.linvel();
          trace.push([+g.ship.x.toFixed(1), +g.ship.y.toFixed(1), Math.round((Math.atan2(w.ny, w.nx) * 180) / Math.PI), +w.gap.toFixed(2), +Math.hypot(vv.x, vv.y).toFixed(1), w.attached ? 1 : 0, g.hazards.explosions, Math.round(g.ship.health + g.ship.shield)]);
        }
        if (!w.attached) return;
        minGap = Math.min(minGap, w.gap);
        maxGap = Math.max(maxGap, w.gap);
        normals.add(Math.round(Math.atan2(w.ny, w.nx) / (Math.PI / 4)));
        path += Math.hypot(g.ship.x - last.x, g.ship.y - last.y);
        last = { x: g.ship.x, y: g.ship.y };
        if (!shotTaken && path > 8) {
          shotTaken = true;
          shot('walk-mid');
        }
      });
      const roll = (g.ctx.stage as unknown as { roll: number }).roll;
      const out = Math.atan2(w.ny, w.nx);
      const arms = { planted: g.arms.arms.filter((a) => a.on).length, footfalls: g.sound.count.foot ?? 0, clunks: g.sound.count.clunk ?? 0, noseFromNormalDeg: Math.round((Math.atan2(Math.sin(g.ship.angle - out), Math.cos(g.ship.angle - out)) * 180) / Math.PI) };
      log('walk-arms', arms);
      const walked = { attached: w.attached, path: +path.toFixed(1), minGap: +minGap.toFixed(2), maxGap: +maxGap.toFixed(2), normalOctants: normals.size, rollDeg: Math.round((roll * 180) / Math.PI), surfaceDeg: Math.round((Math.atan2(w.ny, w.nx) * 180) / Math.PI) - 90, hp: Math.round(g.ship.health), shield: Math.round(g.ship.shield), cause: g.ship.deathCause, explosions: g.hazards.explosions };
      const idleTrace: number[][] = [];
      for (let i = 0; i < 8; i++) {
        await sleep(100);
        const vv = g.ship.body.linvel();
        idleTrace.push([+Math.hypot(vv.x, vv.y).toFixed(2), +g.ship.body.angvel().toFixed(2), +w.gap.toFixed(2), Math.round((Math.atan2(w.ny, w.nx) * 180) / Math.PI), w.attached ? 1 : 0, g.controls.move]);
      }
      log("walk-idle-trace", idleTrace);
      const v = g.ship.body.linvel();
      const idleSpeed = +Math.hypot(v.x, v.y).toFixed(2);
      const sb = w.surfaceBody;
      log('walk-surface', sb ? { body: true, mass: Math.round(sb.body.mass()), speed: +Math.hypot(sb.body.linvel().x, sb.body.linvel().y).toFixed(2) } : { body: false });
      await shot('walk-idle');
      const nx = w.nx;
      const ny = w.ny;
      input.simulateDown('Space');
      await sleep(40);
      input.simulateUp('Space');
      await sleep(300);
      const v2 = g.ship.body.linvel();
      log('walk-trace', trace);
      log(md, { landed, walked, idleSpeed, pushOff: { attached: w.attached, awaySpeed: +(v2.x * nx + v2.y * ny).toFixed(2) } });
    }
    if (md === 'arms') {
      // drift slowly into a crate: the arms catch it; carry it; E lets go with momentum; a fast
      // approach is not caught
      for (const approach of [1.2, 6]) {
        restart();
        await sleep(300);
        const g = game();
        const crate = g.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && !b.tags.machine && b.body.mass() > 100)!;
        place(32, 81, Math.PI);
        const circ = { x: 0, y: 0, r: 0 };
        crate.boundingCircle(circ);
        const t = crate.body.translation();
        const com = crate.body.worldCom();
        // crate center on the ship's flank, a bit beyond arm reach, drifting in
        const cy = 81 + 3.2 + circ.r * 0.6;
        crate.body.setTranslation({ x: t.x - com.x + 32, y: t.y - com.y + cy }, true);
        crate.body.setLinvel({ x: 0, y: -approach }, true);
        crate.body.setAngvel(0, true);
        aim(20, 81);
        const t0 = performance.now();
        while (performance.now() - t0 < 2500 && !g.arms.held) await sleep(16);
        const caught = { approach, held: !!g.arms.held, ms: Math.round(performance.now() - t0), hp: Math.round(g.ship.health + g.ship.shield), grips: g.arms.arms.filter((a) => a.on).length };
        if (!g.arms.held) {
          log('arms', { caught });
          continue;
        }
        await shot('arms-held');
        const gap0 = Math.hypot(crate.body.worldCom().x - g.ship.x, crate.body.worldCom().y - g.ship.y);
        await hold('Space', 1000);
        const gap1 = Math.hypot(crate.body.worldCom().x - g.ship.x, crate.body.worldCom().y - g.ship.y);
        const sv = g.ship.body.linvel();
        input.simulateDown('KeyE');
        await sleep(40);
        input.simulateUp('KeyE');
        await sleep(300);
        const cv = crate.body.linvel();
        const released = { held: !!g.arms.held, crateSpeed: +Math.hypot(cv.x, cv.y).toFixed(2), shipSpeedAtRelease: +Math.hypot(sv.x, sv.y).toFixed(2) };
        await sleep(1000);
        log('arms', { caught, carried: { gap0: +gap0.toFixed(2), gap1: +gap1.toFixed(2) }, released, regrabbed: !!g.arms.held });
      }
    }
    if (md === 'sound') {
      // which paths reach the listener: vacuum silence, own-hull clunks, conduction through a
      // hull you're clamped to
      const g = game();
      const audio = (g as unknown as { app: { audio: { running: boolean; played: object } } }).app.audio;
      const h = g.sound.heard;
      // 1) two crates collide far away while we float free in vacuum
      const crates = g.pixels.bodies.filter((b) => !b.explosiveCells && !b.tags.salvage && !b.tags.machine && b.body.mass() > 50).slice(0, 2);
      place(30, 60, 0);
      for (const [i, c] of crates.entries()) {
        c.body.setTranslation({ x: 30 + (i ? 8 : -8), y: 95 }, true);
        c.body.setLinvel({ x: i ? -6 : 6, y: 0 }, true);
        c.body.setAngvel(0, true);
      }
      const h0 = { ...h };
      await sleep(2000);
      const vacuum = { silent: h.silent - h0.silent, conduct: h.conduct - h0.conduct, air: h.air - h0.air };
      // 2) bump the hull: own clunk
      restart();
      await sleep(300);
      const g2 = game();
      const h2 = g2.sound.heard;
      const ctr = (window as unknown as { __level: { center: { x: number; y: number } } }).__level.center;
      const sx = g2.ship.x;
      const sy = g2.ship.y;
      const dl = Math.hypot(ctr.x - sx, ctr.y - sy);
      const ux = (ctr.x - sx) / dl;
      const uy = (ctr.y - sy) / dl;
      const hull = g2.pixels.raycast(sx, sy, ux, uy, dl);
      if (!hull) {
        log(md, { skipped: 'no hull' });
        continue;
      }
      place(hull.x - ux * 4, hull.y - uy * 4, Math.atan2(uy, ux));
      g2.ship.body.setLinvel({ x: ux * 5, y: uy * 5 }, true);
      const s0 = h2.self;
      await sleep(1500);
      const clunks = h2.self - s0;
      // 3) clamp on (E), then set off a blast on the hull 20 m away
      place(hull.x - ux * 2, hull.y - uy * 2, Math.atan2(uy, ux));
      await sleep(100);
      input.simulateDown('KeyE');
      await sleep(40);
      input.simulateUp('KeyE');
      await sleep(800);
      const c0 = { ...h2 };
      g2.hazards.trigger(hull.x - uy * 20 + ux * 1, hull.y + ux * 20 + uy * 1, 0);
      await sleep(400);
      const clamped = { attached: g2.walk.attached, conduct: h2.conduct - c0.conduct, silent: h2.silent - c0.silent };
      // 4) air: let go, puff gas around the ship with the ship moving through it
      input.simulateDown("KeyE");
      await sleep(40);
      input.simulateUp("KeyE");
      place(hull.x - ux * 6, hull.y - uy * 6, 0);
      g2.ship.body.setLinvel({ x: -uy * 4, y: ux * 4 }, true);
      const a0 = h2.air;
      let wind = 0;
      for (let i = 0; i < 20; i++) {
        g2.ctx.field.inject(g2.ship.x, g2.ship.y, 3, 0.15, 0);
        await sleep(30);
        wind = Math.max(wind, g2.sound.levels.wind);
      }
      g2.sound.emit("impact", g2.ship.x + 3, g2.ship.y, 0.8, []);
      const inAir = { wind: +wind.toFixed(3), room: +g2.sound.levels.room.toFixed(3), airEvents: h2.air - a0 };
      log(md, { audioRunning: audio.running, vacuum, clunks, clamped, inAir, played: audio.played });
    }
    if (md === 'dark') {
      // lighting look: headlamp, lamp off, cutter glow, and the light pass cost
      const g = game();
      // inside the derelict: a free spot in a security bot's room, facing away from it
      const grid = g.pixels.terrain.grid;
      const roomy = (x: number, y: number) => {
        for (let oy = -1.6; oy <= 1.6; oy += 0.4) for (let ox = -1.6; ox <= 1.6; ox += 0.4) if (grid.solid(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL))) return false;
        return true;
      };
      const bot = g.security.robots.find((r) => r.pb.tags.label === 'securityBot');
      if (bot) {
        const c = bot.pos;
        for (let k = 0; k < 24; k++) {
          const t = (k / 24) * Math.PI * 2;
          const x = c.x + Math.cos(t) * 9;
          const y = c.y + Math.sin(t) * 9;
          if (roomy(x, y)) {
            place(x, y, t);
            break;
          }
        }
      }
      aim(g.ship.x + Math.cos(g.ship.angle) * 12, g.ship.y + Math.sin(g.ship.angle) * 12);
      await sleep(700);
      await shot('dark-lamp');
      g.ship.lampOn = false;
      await sleep(300);
      await shot('dark-off');
      g.ship.lampOn = true;
      const s = g.ship;
      aim(s.x + Math.cos(s.angle) * 12, s.y + Math.sin(s.angle) * 12);
      const firing = hold('Mouse0', 1500);
      await sleep(1100);
      await shot('dark-cutter');
      await firing;
      const t0 = performance.now();
      let frames = 0;
      const f0 = (window as unknown as { __stats: { frames: number } }).__stats.frames;
      await sleep(2000);
      frames = (window as unknown as { __stats: { frames: number } }).__stats.frames - f0;
      log(md, { fps: Math.round((frames * 1000) / (performance.now() - t0)), rasterMs: +(g as unknown as { app: { lighting: { rasterMs: number } } }).app.lighting.rasterMs.toFixed(2), conspicuity: g.ship.conspicuity });
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
      // aim ahead (+x) and hold Space
      const g = game();
      aim(g.ship.x + 30, g.ship.y);
      await sleep(200);
      const x0 = g.ship.x;
      await hold('Space', 800, () => aim(g.ship.x + 30, g.ship.y));
      await sleep(300);
      const v = g.ship.body.linvel();
      log('fly', { dx: +(g.ship.x - x0).toFixed(2), vx: +v.x.toFixed(2), vy: +v.y.toFixed(2) });
    }
    if (md === 'turn') {
      // aim steering: swing the cursor 90° and 180° away; time to settle within 3°, and overshoot
      const g = game();
      const results: Record<string, unknown> = {};
      for (const deg of [90, 180]) {
        const a0 = g.ship.angle;
        const target = a0 + (deg * Math.PI) / 180 - (deg === 180 ? 0.01 : 0);
        const t0 = performance.now();
        let settled = -1;
        let maxErrPast = 0;
        while (performance.now() - t0 < 2000) {
          aim(g.ship.x + Math.cos(target) * 20, g.ship.y + Math.sin(target) * 20);
          const err = Math.atan2(Math.sin(target - g.ship.angle), Math.cos(target - g.ship.angle));
          if (err < 0) maxErrPast = Math.max(maxErrPast, -err); // went past the target
          if (settled < 0 && Math.abs(err) < 0.05 && Math.abs(g.ship.body.angvel()) < 0.3) settled = performance.now() - t0;
          await sleep(5);
        }
        results[`${deg}deg`] = { settleMs: Math.round(settled), overshootDeg: +((maxErrPast * 180) / Math.PI).toFixed(1) };
      }
      log('turn', results);
    }
    if (md === 'rope') {
      // tow the core while holding a heading: with the rope at the center of mass the tether
      // can't torque the ship, so heading error stays ~0; at the nose the steering has to fight it
      for (const pivot of ['com', 'nose'] as const) {
        restart();
        await sleep(300);
        tune.grapple.pivot = pivot;
        const g = game();
        const core = g.salvage.body;
        core.setTranslation({ x: 25, y: 80 }, true); // open space: no walls to bump
        core.setLinvel({ x: 0, y: 0 }, true);
        core.setAngvel(0, true);
        await sleep(50);
        const c = core.worldCom();
        place(c.x + 7, c.y, Math.PI);
        await sleep(150);
        aim(c.x, c.y);
        input.simulateDown('Mouse2');
        await sleep(40);
        input.simulateUp('Mouse2');
        await waitTaut();
        // now steer up-right (45°) and burn: the rope pulls from behind and to the side
        const heading = Math.PI / 4;
        const steer = () => aim(g.ship.x + Math.cos(heading) * 30, g.ship.y + Math.sin(heading) * 30);
        steer();
        await sleep(1200); // finish the 135° swing before measuring
        let maxTaut = 0;
        let maxEnd = 0;
        let maxErr = 0;
        await hold('Space', 2000, () => {
          steer();
          maxTaut = Math.max(maxTaut, g.grapple.tautness);
          maxEnd = Math.max(maxEnd, g.grapple.endRatio);
          maxErr = Math.max(maxErr, Math.abs(Math.atan2(Math.sin(heading - g.ship.angle), Math.cos(heading - g.ship.angle))));
        });
        const c1 = g.salvage.body.worldCom();
        log(`rope pivot=${pivot}`, {
          attached: g.grapple.attached,
          maxPath: +maxTaut.toFixed(3),
          maxEnds: +maxEnd.toFixed(3),
          maxHeadingErrDeg: +((maxErr * 180) / Math.PI).toFixed(1),
          coreMoved: +Math.hypot(c1.x - c.x, c1.y - c.y).toFixed(2),
        });
      }
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
      await hold('Space', 1000);
      if (!crate.alive) { log('clamp', { error: 'crate destroyed', health: Math.round(g.ship.health) }); continue; }
      const gap1 = Math.hypot(crate.body.worldCom().x - g.ship.x, crate.body.worldCom().y - g.ship.y);
      const v = g.ship.body.linvel();
      log('clamp', { health: Math.round(g.ship.health), state: g.grapple.state, clampMs: Math.round(tClamp), gapBefore: +gap0.toFixed(2), gapAfterThrust: +gap1.toFixed(2), speed: +Math.hypot(v.x, v.y).toFixed(2) });
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
    if (md === 'spot' || md === 'sneak' || md === 'lit') {
      // in front of a security bot's eye: alarm. Behind it, dark: no alarm. Behind it with the
      // headlamp shining on it: it notices the light and turns (alarm).
      const g = game();
      const bot = g.security.robots.find((r) => r.pb.tags.label === 'securityBot')!;
      const front = md === 'spot';
      g.ship.lampOn = md !== 'sneak';
      const t0 = performance.now();
      let tAlarm = -1;
      let maxSusp = 0;
      // park once on a free spot 7 m in front of (or behind) the eye, then keep hands off
      const c = bot.pos;
      const a = bot.pb.body.rotation() + (front ? 0 : Math.PI);
      // nearest angle to the preferred one with a clear line and an empty ship-sized footprint
      const grid = g.pixels.terrain.grid;
      const roomy = (x: number, y: number) => {
        for (let oy = -1.6; oy <= 1.6; oy += 0.4) for (let ox = -1.6; ox <= 1.6; ox += 0.4) if (grid.solid(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL))) return false;
        return true;
      };
      let ang = NaN;
      for (let k = 0; k < 48; k++) {
        const t = a + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.13;
        if (!g.pixels.raycast(c.x, c.y, Math.cos(t), Math.sin(t), 8.5, bot.pb) && roomy(c.x + Math.cos(t) * 7, c.y + Math.sin(t) * 7)) {
          ang = t;
          break;
        }
      }
      if (Number.isNaN(ang)) {
        log(md, { skipped: 'no free spot near the bot' });
        continue;
      }
      place(c.x + Math.cos(ang) * 7, c.y + Math.sin(ang) * 7, ang + Math.PI);
      aim(c.x, c.y); // the ship steers to face the cursor: keep it on the bot
      while (performance.now() - t0 < 3000) {
        maxSusp = Math.max(maxSusp, g.security.suspicion);
        if (g.security.alert && tAlarm < 0) {
          tAlarm = performance.now() - t0;
          shot('spotted');
        }
        await sleep(16);
      }
      const sealed = (g.security as unknown as { sealed: Set<unknown> }).sealed.size;
      log(md, { alert: g.security.alert, alarmMs: Math.round(tAlarm), maxSuspicion: +maxSusp.toFixed(2), sealedDoors: sealed, health: Math.round(g.ship.health), cause: g.ship.deathCause });
    }
    if (md === 'turret') {
      const g = game();
      const t = g.security.turrets[0];
      if (!t) {
        log('turret', { error: 'no turrets' });
        continue;
      }
      // sit 8 m off the wall along the turret's normal, then trip the alarm
      place(t.x + Math.cos(t.dir) * 8, t.y + Math.sin(t.dir) * 8, 0);
      g.security.raiseAlarm({ x: g.ship.x, y: g.ship.y });
      const h0 = g.ship.health;
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && g.ship.alive) {
        place(t.x + Math.cos(t.dir) * 8, t.y + Math.sin(t.dir) * 8, 0);
        await sleep(16);
      }
      shot('turret');
      log('turret', { hpLost: Math.round(h0 - g.ship.health), cause: g.ship.deathCause, bullets: g.projectiles.count });
    }
    if (md === 'drones') {
      const g = game();
      const bay = g.security as unknown as { bays: { x: number; y: number; launched: number }[] };
      const b = bay.bays[0];
      if (!b) {
        log('drones', { error: 'no bays' });
        continue;
      }
      place(b.x + 6, b.y, Math.PI);
      g.security.raiseAlarm({ x: g.ship.x, y: g.ship.y });
      const h0 = g.ship.health;
      await sleep(4000);
      shot('drones');
      const drones = g.security.robots.filter((r) => r.pb.tags.label === 'drone' && r.alive).length;
      log('drones', { launched: b.launched, alive: drones, hpLost: Math.round(h0 - g.ship.health), cause: g.ship.deathCause });
    }
    if (md === 'crash') {
      // classic level: fly into the prow's hull at different speeds
      const g = game();
      const results: Record<string, unknown> = {};
      for (const speed of [2, 6, 12]) {
        restart();
        await sleep(200);
        const gg = game();
        place(m(200), m(380), 0);
        gg.ship.body.setLinvel({ x: speed, y: 0 }, true);
        await sleep(Math.max(1200, (6 / speed) * 1000 + 600));
        results[`${speed}mps`] = { hp: Math.round(gg.ship.health), shield: Math.round(gg.ship.shield), impact: +gg.lastImpactSpeed.toFixed(1) };
      }
      log('crash', results);
      // tethered slam: harpoon a crate in open space, then ram it at speed (no exemption)
      restart();
      await sleep(200);
      const g2 = game();
      const crate = g2.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && b.body.mass() > 100)!;
      crate.body.setTranslation({ x: 20, y: 80 }, true);
      crate.body.setLinvel({ x: 0, y: 0 }, true);
      place(34, 81, Math.PI);
      await sleep(100);
      aim(crate.body.worldCom().x, crate.body.worldCom().y);
      input.simulateDown('Mouse2');
      await sleep(30);
      input.simulateUp('Mouse2');
      await sleep(700);
      const attached = g2.grapple.attached;
      const cc = crate.body.worldCom();
      log('pre-slam', { ship: [+g2.ship.x.toFixed(1), +g2.ship.y.toFixed(1)], crate: [+cc.x.toFixed(1), +cc.y.toFixed(1)], hp: Math.round(g2.ship.health) });
      let maxImpact = 0;
      const tw = setInterval(() => (maxImpact = Math.max(maxImpact, game().lastImpactSpeed)), 10);
      g2.ship.body.setLinvel({ x: -14, y: 0 }, true);
      await sleep(1500);
      clearInterval(tw);
      log('tethered slam', { attached, hp: Math.round(g2.ship.health), cause: g2.ship.deathCause, maxImpact: +maxImpact.toFixed(1) });
      // shield: clamp a crate on the nose, then ram the prow with the crate leading
      restart();
      await sleep(200);
      const g3 = game();
      const shield = g3.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && b.body.mass() > 100)!;
      shield.body.setTranslation({ x: m(150), y: m(378) }, true);
      shield.body.setLinvel({ x: 0, y: 0 }, true);
      shield.body.setAngvel(0, true);
      place(m(150) - 8, m(380), 0);
      await sleep(100);
      aim(shield.body.worldCom().x, shield.body.worldCom().y);
      input.simulateDown('Mouse2');
      const ts = performance.now();
      while (performance.now() - ts < 5000 && g3.grapple.state !== 'clamped') await sleep(16);
      input.simulateUp('Mouse2');
      const clamped = g3.grapple.state;
      const hpBefore = g3.ship.health;
      g3.ship.body.setLinvel({ x: 12, y: 0 }, true);
      shield.body.setLinvel({ x: 12, y: 0 }, true);
      await sleep(2000);
      shot('shield');
      log('shield ram', { clamped, hpBefore: Math.round(hpBefore), hpAfter: Math.round(g3.ship.health), cause: g3.ship.deathCause });
      void g;
    }
    if (md === 'sentry') {
      // stand in a turret's sweep with no alarm: it should spot, raise the alarm and fire
      const g = game();
      const t = g.security.turrets[0];
      if (!t) {
        log('sentry', { error: 'no turrets' });
        continue;
      }
      const h0 = g.ship.health;
      const t0 = performance.now();
      let tAlarm = -1;
      while (performance.now() - t0 < 9000 && g.ship.alive) {
        place(t.x + Math.cos(t.dir) * 10, t.y + Math.sin(t.dir) * 10, 0);
        if (tAlarm < 0 && g.security.alert) {
          tAlarm = performance.now() - t0;
          shot('sentry-alarm');
        }
        if (tAlarm > 0 && performance.now() - t0 > tAlarm + 2500) break;
        await sleep(16);
      }
      log('sentry', { alarmMs: Math.round(tAlarm), hpLost: Math.round(h0 - g.ship.health), cause: g.ship.deathCause });
    }
    if (md === 'laser') {
      const g = game();
      // push: a crate in open space shoved by the beam
      const crate = g.pixels.bodies.find((b) => !b.explosiveCells && !b.tags.salvage && b.body.mass() > 100)!;
      crate.body.setTranslation({ x: 20, y: 80 }, true);
      crate.body.setLinvel({ x: 0, y: 0 }, true);
      crate.body.setAngvel(0, true);
      place(36, 81, Math.PI);
      await sleep(100);
      await hold('Mouse0', 1500, () => {
        place(36, 81, Math.PI);
        aim(crate.body.worldCom().x, crate.body.worldCom().y);
      });
      const cv = crate.body.linvel();
      log('laser push', { crateVx: +cv.x.toFixed(2), mass: Math.round(crate.body.mass()), heat: +g.cutter.heat.toFixed(2) });
      // overheat: hold until it locks, then time the cooldown
      await sleep(3000); // cool down first
      const t0 = performance.now();
      let tOver = -1;
      input.simulateDown('Mouse0');
      while (performance.now() - t0 < 8000) {
        place(36, 81, Math.PI);
        aim(10, 81);
        if (g.cutter.overheated && tOver < 0) tOver = performance.now() - t0;
        if (tOver > 0) break;
        await sleep(16);
      }
      input.simulateUp('Mouse0');
      const t1 = performance.now();
      while (g.cutter.overheated && performance.now() - t1 < 6000) await sleep(16);
      log('laser heat', { overheatAfterMs: Math.round(tOver), cooldownMs: Math.round(performance.now() - t1) });
      // shield soaks damage, then recharges
      g.ship.damage(30, 'test');
      const after = { hull: Math.round(g.ship.health), shield: Math.round(g.ship.shield) };
      g.ship.damage(50, 'test');
      const after2 = { hull: Math.round(g.ship.health), shield: Math.round(g.ship.shield) };
      await sleep(5500);
      log('shield', { after30: after, after50more: after2, after5s: { hull: Math.round(g.ship.health), shield: Math.round(g.ship.shield) } });
    }
    if (md === 'brake') {
      const g = game();
      aim(g.ship.x + 30, g.ship.y);
      await sleep(200);
      await hold('Space', 700, () => aim(g.ship.x + 30, g.ship.y));
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
        await sleep(1400); // let the laser cool between cuts (heat meter)
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

      await hold('Space', 1500);
      const c1 = target.body.worldCom();
      log('grapple tow', { health: Math.round(g.ship.health), coreMoved: +Math.hypot(c1.x - c0.x, c1.y - c0.y).toFixed(2), coreMass: Math.round(target.body.mass()), shipMass: Math.round(g.ship.body.mass()) });
    }
  }
  log('done');
}
