// lil-gui tuning panel bound directly to `tune`, plus debug actions.

import GUI from 'lil-gui';
import { tune } from '../config';

export interface DebugActions {
  restart(): void;
  detonateNearAim(): void;
}

export function createDebugPanel(actions: DebugActions): GUI {
  const gui = new GUI({ title: 'Tuning (` to toggle)', width: 300 });
  gui.add(actions, 'restart').name('Restart (R)');
  gui.add(actions, 'detonateNearAim').name('Detonate fuel nearest aim');

  const d = gui.addFolder('Debug');
  d.add(tune.debug, 'showColliders').name('collider outlines');
  d.add(tune.debug, 'showField').name('gas/heat field');

  const s = gui.addFolder('Ship');
  s.add(tune.ship, 'thrust', 0, 10000, 50);
  s.add(tune.ship, 'reverseThrust', 0, 10000, 50);
  s.add(tune.ship, 'turnRate', 0.5, 12, 0.1).name('turn rate (rad/s)');
  s.add(tune.ship, 'turnAccel', 2, 150, 1).name('turn accel (rad/s²)');
  s.add(tune.ship, 'density', 20, 600, 5).name('density (restart)');
  s.add(tune.ship, 'rotationAssist');
  s.add(tune.ship, 'flightAssist').name('flight assist (RCS brake)');
  s.add(tune.ship, 'brakeForce', 0, 4000, 10).name('RCS brake force (N)');

  const g = gui.addFolder('Grapple');
  g.add(tune.grapple, 'maxLength', 4, 60, 0.5);
  g.add(tune.grapple, 'reelSpeed', 0.5, 30, 0.5);
  g.add(tune.grapple, 'pivot', ['com', 'nose']).name('ship pivot (P)').listen();
  g.add(tune.grapple, 'segmentLength', 0.25, 3, 0.05).name('segment length (next grapple)');
  g.add(tune.grapple, 'segmentMass', 0.05, 10, 0.05).name('segment mass (next grapple)');
  g.add(tune.grapple, 'segmentDamping', 0, 8, 0.05).name('segment damping (next grapple)');
  g.add(tune.grapple, 'stiffness', 2000, 300000, 1000).name('stiffness EA (N)');
  g.add(tune.grapple, 'damping', 0, 3, 0.01).name('spring damping');
  g.add(tune.grapple, 'internalDamping', 0, 60, 0.5).name('rope wobble damping');
  g.add(tune.grapple, 'chordDamping', 0, 60, 0.5).name('taut straightening');
  g.add(tune.grapple, 'maxStretch', 0.01, 0.6, 0.01).name('max stretch (next grapple)');
  g.add(tune.grapple, 'hookSpeed', 10, 200, 1);
  g.add(tune.grapple, 'hookMass', 0.5, 40, 0.5).name('head mass (kg)');
  g.add(tune.grapple, 'recoil', 0, 1000, 10).name('recoil (N·s)');
  g.add(tune.grapple, 'biteSlack', 1, 1.6, 0.01).name('slack at impact');
  g.add(tune.grapple, 'retractSpeed', 5, 200, 1);
  g.add(tune.grapple, 'tightenSpeed', 1, 80, 1).name('impact winch speed');
  g.add(tune.grapple, 'autoTakeUp').name('auto take-up slack');
  g.add(tune.grapple, 'takeUpSpeed', 0.5, 20, 0.5).name('take-up speed');

  const c = gui.addFolder('Cutter');
  c.add(tune.cutter, 'radius', 0.15, 2.5, 0.05);
  c.add(tune.cutter, 'damagePerSecond', 20, 3000, 10);
  c.add(tune.cutter, 'range', 2, 40, 0.5);
  c.add(tune.cutter, 'heat', 0, 6, 0.05);

  const gs = gui.addFolder('Gas / heat');
  gs.add(tune.gas, 'stiffness', 50, 3000, 10);
  gs.add(tune.gas, 'damping', 0.9, 1, 0.001);
  gs.add(tune.gas, 'pushStrength', 0, 100, 0.5).name('vent push');
  gs.add(tune.gas, 'heatDiffusion', 0, 10, 0.1);
  gs.add(tune.gas, 'heatDecay', 0, 3, 0.01);

  const h = gui.addFolder('Hazard');
  h.add(tune.hazard, 'enabled');
  h.add(tune.hazard, 'explosionRadius', 0.5, 8, 0.1);
  h.add(tune.hazard, 'explosionDamage', 0, 3000, 10);
  h.add(tune.hazard, 'explosionImpulse', 0, 4000, 10);
  h.add(tune.hazard, 'explosionGas', 0, 20, 0.1);
  h.add(tune.hazard, 'explosionHeat', 0, 20, 0.1);
  h.add(tune.hazard, 'ignitionHeat', 0.2, 10, 0.05);

  const p = gui.addFolder('Pixels');
  p.add(tune.pixel, 'debrisMinCells', 1, 200, 1);
  p.add(tune.impact, 'damageImpulse', 10, 3000, 10).name('impact damage threshold (N·s)');
  p.add(tune.impact, 'damageScale', 0, 5, 0.05).name('impact damage per N·s');
  p.add(tune.impact, 'detonationDv', 1, 40, 0.5).name('barrel impact det. Δv');

  for (const f of [s, g, c, gs, h, p]) f.close();
  gui.hide();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') gui.show(gui._hidden);
  });
  return gui;
}
