// Entry: creates long-lived services (renderer, GPU field, input, HUD, background), then
// runs Game instances; R tears the current run down and builds a fresh one.

import './style.css';
import { WORLD_H, WORLD_W } from './config';
import { Input } from './core/Input';
import { GasField } from './fields/GasField';
import { initPhysics } from './physics/Physics';
import { Background } from './render/Background';
import { ORDER } from './render/order';
import { Stage } from './render/Stage';
import { Game } from './game/Game';
import { buildDerelict } from './game/level/derelict';
import { Hud } from './ui/Hud';
import { createDebugPanel } from './ui/DebugPanel';
import { runAutotest } from './dev/autotest';
import { applyTuneOverrides } from './dev/overrides';

async function boot(): Promise<void> {
  const overrides = applyTuneOverrides(location.search);
  if (overrides.length) console.log('tune overrides', overrides.join(' '));
  const container = document.getElementById('app')!;
  let stage: Stage;
  try {
    stage = await Stage.create(container);
  } catch (e) {
    container.innerHTML = `<div class="fatal">This game needs WebGPU (Chrome or Edge 113+).<br><small>${String(e)}</small></div>`;
    throw e;
  }
  await initPhysics();

  const input = new Input(stage.renderer.domElement);
  const field = new GasField(stage.renderer, WORLD_W, WORLD_H, ORDER.field);
  stage.scene.add(field.mesh);
  const hud = new Hud(container);
  const app = { stage, field, input };

  // level specs aren't kept around: their world-sized grids are only needed to build a run
  const first = buildDerelict();
  const background = new Background(stage, first.center);
  let game = new Game(app, first);

  const restart = () => {
    game.dispose();
    game = new Game(app, buildDerelict());
  };
  createDebugPanel({
    restart,
    detonateNearAim: () => game.hazards.detonateNearest(game.controls.aimX, game.controls.aimY),
  });

  const stats = { frames: 0, fps: 0, bodies: 0, particles: 0, explosions: 0, health: 0, objective: '' };
  (window as unknown as { __stats: typeof stats; __game: () => Game }).__stats = stats;
  (window as unknown as { __game: () => Game }).__game = () => game;

  let last = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    if (input.hit('KeyR')) restart();
    game.update(dt);
    background.update(stage);
    hud.update(game, stage);
    stage.render();

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) {
      stats.fps = Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0;
      fpsFrames = 0;
    }
    stats.frames++;
    stats.bodies = game.pixels.bodies.length;
    stats.particles = game.particles.count;
    stats.explosions = game.hazards.explosions;
    stats.health = Math.round(game.ship.health);
    stats.objective = game.objective.state;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const mode = new URLSearchParams(location.search).get('autotest');
  if (mode) runAutotest(mode, () => game, input, restart);
}

boot();
