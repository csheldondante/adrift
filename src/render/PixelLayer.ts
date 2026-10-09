// Non-colliding pixel layer (e.g. a derelict's interior back wall). Same PixelGrid format
// as the physical layer, painted darker with a tint so the foreground reads clearly. Drawn
// through a tiled PixelView so world-sized layers stay cheap.
//
// Likely growth: let damage/heat scorch it (blasts leave marks on the back wall) by routing
// PixelWorld damage events here at reduced strength and re-painting via view.markDirty.

import * as THREE from 'three/webgpu';
import { cellColor } from '../pixel/materials';
import type { PixelGrid } from '../pixel/PixelGrid';
import { PixelView } from './PixelView';

export class PixelLayer {
  private readonly view: PixelView;

  constructor(grid: PixelGrid, order: number, tint: [number, number, number]) {
    const px = new Uint32Array(grid.w * grid.h);
    for (let i = 0; i < grid.mat.length; i++) {
      const c = cellColor(grid.mat[i], grid.shade[i], 1);
      if (!c) continue;
      const r = (c & 255) * tint[0];
      const g = ((c >> 8) & 255) * tint[1];
      const b = ((c >> 16) & 255) * tint[2];
      px[i] = (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
    }
    this.view = new PixelView(px, grid.w, grid.h, order);
    this.view.freeze();
  }

  get object(): THREE.Object3D {
    return this.view.object;
  }

  dispose(): void {
    this.view.dispose();
  }
}
