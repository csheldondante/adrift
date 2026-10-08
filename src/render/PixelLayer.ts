// Non-colliding pixel layer (e.g. a derelict's interior back wall). Same PixelGrid format
// as the physical layer, painted darker with a tint so the foreground reads clearly.
//
// Likely growth: let damage/heat scorch it (blasts leave marks on the back wall) by routing
// PixelWorld damage events here at reduced strength.

import * as THREE from 'three/webgpu';
import { CELL } from '../config';
import { cellColor } from '../pixel/materials';
import type { PixelGrid } from '../pixel/PixelGrid';

export class PixelLayer {
  readonly mesh: THREE.Mesh;
  private readonly texture: THREE.DataTexture;

  constructor(grid: PixelGrid, order: number, tint: [number, number, number]) {
    const data = new Uint8Array(grid.w * grid.h * 4);
    const px = new Uint32Array(data.buffer);
    for (let i = 0; i < grid.mat.length; i++) {
      const c = cellColor(grid.mat[i], grid.shade[i], 1);
      if (!c) continue;
      const r = (c & 255) * tint[0];
      const g = ((c >> 8) & 255) * tint[1];
      const b = ((c >> 16) & 255) * tint[2];
      px[i] = (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
    }
    this.texture = new THREE.DataTexture(data, grid.w, grid.h, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(grid.w * CELL, grid.h * CELL);
    geo.translate((grid.w * CELL) / 2, (grid.h * CELL) / 2, 0);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
