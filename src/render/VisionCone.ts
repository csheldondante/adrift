// A translucent vision-cone fan, clipped against matter by per-ray distances supplied by the
// caller (so walls and crates visibly block sight). Color shows the watcher's mood.

import * as THREE from 'three/webgpu';
import { ORDER } from './order';

export class VisionCone {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(readonly rays: number) {
    // center + rays+1 rim vertices, rays triangles
    this.pos = new Float32Array((rays + 2) * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx: number[] = [];
    for (let i = 0; i < rays; i++) idx.push(0, i + 1, i + 2);
    geo.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.12, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.mat.blending = THREE.AdditiveBlending;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = ORDER.particles - 1;
    this.mesh.frustumCulled = false;
  }

  /** Rebuilds the fan: origin, facing angle, half-angle, and the clipped length of each ray. */
  set(x: number, y: number, angle: number, half: number, lengths: ArrayLike<number>, color: number, opacity: number): void {
    const p = this.pos;
    p[0] = x;
    p[1] = y;
    p[2] = 0;
    for (let i = 0; i <= this.rays; i++) {
      const a = angle - half + (2 * half * i) / this.rays;
      const l = lengths[i];
      p[(i + 1) * 3] = x + Math.cos(a) * l;
      p[(i + 1) * 3 + 1] = y + Math.sin(a) * l;
      p[(i + 1) * 3 + 2] = 0;
    }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mat.color.setHex(color);
    this.mat.opacity = opacity;
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
  }
}
