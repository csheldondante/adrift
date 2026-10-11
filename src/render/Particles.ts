// CPU particle pool rendered as instanced quads (one normal-blend pass for debris/smoke,
// one additive pass for sparks/fire). Particles drift with the gas field and bounce off
// terrain, so venting and blasts visibly carry them.
//
// Likely growth: move to GPU compute when counts go up (same spawn API), add per-kind
// behaviors via a small `kind` table rather than flags piling up.

import * as THREE from 'three/webgpu';
import { CELL } from '../config';
import type { FieldSample, GasField } from '../fields/GasField';
import type { PixelGrid } from '../pixel/PixelGrid';
import { ORDER } from './order';

const MAX = 6000;

class Pool {
  readonly mesh: THREE.InstancedMesh;
  n = 0;
  px = new Float32Array(MAX);
  py = new Float32Array(MAX);
  vx = new Float32Array(MAX);
  vy = new Float32Array(MAX);
  life = new Float32Array(MAX);
  maxLife = new Float32Array(MAX);
  size = new Float32Array(MAX);
  col = new Float32Array(MAX * 3);
  drag = new Float32Array(MAX); // how strongly gas flow carries it
  bounce = new Uint8Array(MAX);

  constructor(additive: boolean, order: number) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    if (additive) mat.blending = THREE.AdditiveBlending;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, MAX);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, r: number, g: number, b: number, drag: number, bounce: boolean): void {
    let i = this.n;
    if (i >= MAX) i = (Math.random() * MAX) | 0; // overwrite a random one when full
    else this.n++;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.drag[i] = drag;
    this.bounce[i] = bounce ? 1 : 0;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.life[i] = this.life[j];
    this.maxLife[i] = this.maxLife[j];
    this.size[i] = this.size[j];
    this.col[i * 3] = this.col[j * 3];
    this.col[i * 3 + 1] = this.col[j * 3 + 1];
    this.col[i * 3 + 2] = this.col[j * 3 + 2];
    this.drag[i] = this.drag[j];
    this.bounce[i] = this.bounce[j];
  }

  update(dt: number, field: GasField | null, grid: PixelGrid | null, s: FieldSample, fade: boolean): void {
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        i--;
        continue;
      }
      if (field && this.drag[i] > 0) {
        field.sample(this.px[i], this.py[i], s);
        if (s.gas > 0.01) {
          const k = Math.min(1, this.drag[i] * Math.min(1, s.gas) * dt);
          this.vx[i] += (s.vx - this.vx[i]) * k;
          this.vy[i] += (s.vy - this.vy[i]) * k;
        }
      }
      const nx = this.px[i] + this.vx[i] * dt;
      const ny = this.py[i] + this.vy[i] * dt;
      if (grid && this.bounce[i] && grid.solid(Math.floor(nx / CELL), Math.floor(ny / CELL))) {
        // reflect on the axis that entered the solid
        if (grid.solid(Math.floor(nx / CELL), Math.floor(this.py[i] / CELL))) this.vx[i] *= -0.35;
        if (grid.solid(Math.floor(this.px[i] / CELL), Math.floor(ny / CELL))) this.vy[i] *= -0.35;
      } else {
        this.px[i] = nx;
        this.py[i] = ny;
      }
    }
    // write instance data
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const c = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];
      const sz = this.size[i] * (fade ? 0.4 + 0.6 * t : 1);
      const o = i * 16;
      m[o] = sz;
      m[o + 1] = 0;
      m[o + 2] = 0;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = sz;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = 0;
      m[o + 9] = 0;
      m[o + 10] = 1;
      m[o + 11] = 0;
      m[o + 12] = this.px[i];
      m[o + 13] = this.py[i];
      m[o + 14] = 0;
      m[o + 15] = 1;
      const a = fade ? Math.min(1, t * 1.5) : 1;
      c[i * 3] = this.col[i * 3] * a;
      c[i * 3 + 1] = this.col[i * 3 + 1] * a;
      c[i * 3 + 2] = this.col[i * 3 + 2] * a;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private readonly solid = new Pool(false, ORDER.particles);
  private readonly glow = new Pool(true, ORDER.glow);
  private readonly s: FieldSample = { gas: 0, heat: 0, vx: 0, vy: 0 };

  constructor() {
    this.group.add(this.solid.mesh, this.glow.mesh);
  }

  /** A chunk of matter (debris pixel). Color in 0..255. */
  debris(x: number, y: number, vx: number, vy: number, r: number, g: number, b: number): void {
    this.solid.spawn(x, y, vx, vy, 2.5 + Math.random() * 3, CELL, r / 255, g / 255, b / 255, 2, true);
  }

  spark(x: number, y: number, vx: number, vy: number, life = 0.35, size = 0.09, hot = 1): void {
    this.glow.spawn(x, y, vx, vy, life, size, 1, 0.55 + 0.35 * hot, 0.15 + 0.4 * hot, 0.5, true);
  }

  fire(x: number, y: number, vx: number, vy: number, life = 0.6, size = 0.35): void {
    this.glow.spawn(x, y, vx, vy, life, size, 1, 0.45 + Math.random() * 0.3, 0.12, 3, false);
  }

  smoke(x: number, y: number, vx: number, vy: number, life = 1.6, size = 0.5): void {
    const v = 0.05 + Math.random() * 0.05;
    this.solid.spawn(x, y, vx, vy, life, size, v, v, v * 1.15, 4, false);
  }

  glint(x: number, y: number, vx: number, vy: number, r: number, g: number, b: number, life = 1, size = 0.12): void {
    this.glow.spawn(x, y, vx, vy, life, size, r, g, b, 0, false);
  }

  update(dt: number, field: GasField | null, grid: PixelGrid | null): void {
    this.solid.update(dt, field, grid, this.s, true);
    this.glow.update(dt, field, grid, this.s, true);
  }

  clear(): void {
    this.solid.clear();
    this.glow.clear();
  }

  dispose(): void {
    this.solid.dispose();
    this.glow.dispose();
    this.group.removeFromParent();
  }

  get count(): number {
    return this.solid.n + this.glow.n;
  }
}
