// Entry: creates long-lived services (renderer, GPU field, input, HUD, background), then
// runs Game instances; R tears the current run down and builds a fresh one.

import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { WORLD_H, WORLD_W } from './config';
import { Input } from './core/Input';
import { GasField } from './fields/GasField';
import { initPhysics } from './physics/Physics';
import { Background } from './render/Background';
import { Lighting } from './render/Lighting';
import { ORDER } from './render/order';
import { Stage } from './render/Stage';
import { Game } from './game/Game';
import { buildDerelict } from './game/level/derelict';
import { buildDungeon } from './game/level/dungeon';
import { buildLab } from './game/level/lab';
import { buildLantern } from './game/level/lantern';
import { Hud } from './ui/Hud';
import { createDebugPanel } from './ui/DebugPanel';
import { Minimap } from './ui/Minimap';
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
  const minimap = new Minimap(container);
  const lighting = new Lighting(stage.renderer);
  stage.scene.add(lighting.mesh);
  const audio = new AudioEngine();
  const app = { stage, field, input, lighting, audio };

  // The hand-built "Lantern" derelict by default. ?level=classic for the original small
  // derelict (autotests default to it), ?level=lab for the systems test station (power,
  // pressure, welding), ?level=dungeon for the generator (?seed=N pins it)
  const params = new URLSearchParams(location.search);
  const levelName = params.get('level') ?? (params.has('autotest') ? 'classic' : 'lantern');
  const seedParam = params.get('seed');
  const buildLevel = () => {
    if (levelName === 'classic') return buildDerelict();
    if (levelName === 'lab') return buildLab();
    if (levelName === 'dungeon') return buildDungeon(seedParam ? Number(seedParam) : undefined);
    return buildLantern();
  };
  // level specs aren't kept around: their world-sized grids are only needed to build a run
  const first = buildLevel();
  (window as unknown as { __level: { center: { x: number; y: number } } }).__level = { center: first.center };
  if (params.has('dumpRooms')) console.log('ROOMS', JSON.stringify(first.rooms.map((r) => [r.id, r.kind, Math.round(r.x0), Math.round(r.y0), Math.round(r.x1), Math.round(r.y1)])));
  console.log(`level: ${first.name} seed ${first.seed} rooms ${first.rooms.length} entities ${first.entities.length}`);
  const background = new Background(stage, first.center);
  let game = new Game(app, first);
  document.getElementById('loading')?.remove();

  const restart = () => {
    game.dispose();
    game = new Game(app, buildLevel());
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
    // the first frame's timestamp can predate `last` (taken at init): never step backwards
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    if (input.hit('KeyR')) restart();
    game.update(dt);
    background.update(stage);
    hud.update(game, stage);
    minimap.update(game, dt);
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
