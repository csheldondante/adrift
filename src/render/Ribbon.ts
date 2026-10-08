// A thick line segment drawn as a stretched quad (WebGPU has no wide lines).

import * as THREE from 'three/webgpu';

export class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(color: number, order: number, additive = false) {
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    if (additive) this.mat.blending = THREE.AdditiveBlending;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  set(x0: number, y0: number, x1: number, y1: number, width: number, color?: number, opacity = 1): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    this.mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    this.mesh.rotation.z = Math.atan2(dy, dx);
    this.mesh.scale.set(Math.max(1e-4, Math.hypot(dx, dy)), width, 1);
    if (color !== undefined) this.mat.color.setHex(color);
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
