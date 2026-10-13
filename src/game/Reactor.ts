// The probe's reactor: a red core behind the cockpit that powers the cutter and the main
// engine, and gets hot doing it. One heat budget for both, so a long burn and a long cut
// compete: the cutter heats it fast (faster on tough material), full thrust more slowly
// (harder with a load in the arms), and it sheds heat all the time. At full heat it
// overheats: the cutter locks out and the engine drops to a limp until the core has cooled
// to `recover`. The core glows through a window in the hull, dull red to orange to white.
//
// Likely growth: upgrades (capacity, cooling, a heat sink you can dump into a wall), heat
// damage to the hull when you push past overheat.

import * as THREE from 'three/webgpu';
import { tune } from '../config';
import { ORDER } from '../render/order';

const CORE_X = -0.62; // ship-local, behind the hazard ring
const CORE_R = 0.2;

export class Reactor {
  /** 0..capacity. */
  heat = 0;
  /** Locked out after overheating, until heat falls to the recover level. */
  overheated = false;
  readonly mesh: THREE.Group;
  private readonly coreMat = new THREE.MeshBasicMaterial({ color: 0x400808, depthTest: false, depthWrite: false });
  private readonly haloMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.2, depthTest: false, depthWrite: false });
  private readonly c = new THREE.Color();

  constructor() {
    this.haloMat.blending = THREE.AdditiveBlending;
    const rim = new THREE.Mesh(new THREE.CircleGeometry(CORE_R + 0.06, 20), new THREE.MeshBasicMaterial({ color: 0x1b1d22, depthTest: false, depthWrite: false }));
    const core = new THREE.Mesh(new THREE.CircleGeometry(CORE_R, 20), this.coreMat);
    const halo = new THREE.Mesh(new THREE.CircleGeometry(CORE_R * 2.6, 24), this.haloMat);
    for (const m of [rim, core, halo]) m.position.set(CORE_X, 0, 0);
    rim.renderOrder = ORDER.ship + 0.1;
    core.renderOrder = ORDER.ship + 0.2;
    halo.renderOrder = ORDER.glow;
    this.mesh = new THREE.Group();
    this.mesh.add(rim, core, halo);
  }

  /** Heat as a fraction of capacity (HUD, glow). */
  get level(): number {
    return this.heat / tune.reactor.capacity;
  }

  /** Engine power multiplier: a limp while overheated. */
  get thrustScale(): number {
    return this.overheated ? tune.reactor.limpThrust : 1;
  }

  /** Adds heat (already scaled by dt). */
  load(h: number): void {
    const r = tune.reactor;
    this.heat = Math.min(r.capacity, this.heat + h);
    if (this.heat >= r.capacity) this.overheated = true;
  }

  fixedUpdate(dt: number): void {
    const r = tune.reactor;
    this.heat = Math.max(0, this.heat - (this.overheated ? r.overheatCool : r.cool) * dt);
    if (this.overheated && this.heat <= r.recover * r.capacity) this.overheated = false;
  }

  /** Ship-local position of the core (for its light). */
  static readonly X = CORE_X;

  sync(time: number): void {
    const h = Math.min(1, this.level);
    const flick = this.overheated ? 0.75 + 0.25 * Math.sin(time * 30) : 1;
    // banked embers -> red -> orange -> white
    this.c.setRGB(0.3 + 0.7 * Math.min(1, h * 1.6), 0.03 + 0.75 * h * h, 0.03 + 0.6 * h ** 4);
    this.c.multiplyScalar(flick);
    this.coreMat.color.copy(this.c);
    this.haloMat.opacity = (0.15 + 0.55 * h) * flick;
  }

  dispose(): void {
    this.mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
