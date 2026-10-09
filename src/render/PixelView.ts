// Draws a pixel grid's RGBA colors as textured quads, split into square tiles. Each tile has
// its own texture, so a change re-uploads only the tiles it touched, and off-screen tiles are
// frustum-culled. A grid that fits in one tile uses the color buffer directly (no copy).
//
// Local frame: origin at the grid's bottom-left corner, CELL meters per cell, +y up.

import * as THREE from 'three/webgpu';
import { CELL } from '../config';

interface Tile {
  tx: number;
  ty: number;
  w: number;
  h: number;
  data: Uint8Array;
  tex: THREE.DataTexture;
  mesh: THREE.Mesh;
  dirty: boolean;
}

export class PixelView {
  readonly object = new THREE.Group();
  private readonly tiles: Tile[] = [];
  private readonly cols: number;
  private readonly single: boolean;

  constructor(
    private pixels: Uint32Array,
    private readonly w: number,
    private readonly h: number,
    renderOrder: number,
    private readonly tileSize = 256,
  ) {
    this.single = w <= tileSize && h <= tileSize;
    this.cols = Math.ceil(w / tileSize);
    const rows = Math.ceil(h / tileSize);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const tw = Math.min(tileSize, w - tx * tileSize);
        const th = Math.min(tileSize, h - ty * tileSize);
        const data = this.single ? new Uint8Array(pixels.buffer, pixels.byteOffset, w * h * 4) : new Uint8Array(tw * th * 4);
        const tex = new THREE.DataTexture(data, tw, th, THREE.RGBAFormat);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        const geo = new THREE.PlaneGeometry(tw * CELL, th * CELL);
        geo.translate((tx * tileSize + tw / 2) * CELL, (ty * tileSize + th / 2) * CELL, 0);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = renderOrder;
        // big static grids benefit from culling; small moving bodies are cheap either way
        mesh.frustumCulled = !this.single;
        this.object.add(mesh);
        this.tiles.push({ tx, ty, w: tw, h: th, data, tex, mesh, dirty: true });
      }
    }
  }

  /** Marks the tiles overlapping a cell rect [x0,x1)×[y0,y1) for re-upload. */
  markDirty(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.tileSize;
    const cx0 = Math.max(0, Math.floor(x0 / s));
    const cy0 = Math.max(0, Math.floor(y0 / s));
    const cx1 = Math.min(this.cols - 1, Math.floor((x1 - 1) / s));
    const cy1 = Math.min(Math.ceil(this.h / s) - 1, Math.floor((y1 - 1) / s));
    for (let ty = cy0; ty <= cy1; ty++) for (let tx = cx0; tx <= cx1; tx++) this.tiles[ty * this.cols + tx].dirty = true;
  }

  /**
   * For static content: upload everything once and drop the full-size source buffer
   * (halves memory for world-sized layers). The view can no longer be repainted.
   */
  freeze(): void {
    for (const t of this.tiles) t.dirty = true;
    this.sync();
    if (!this.single) this.pixels = new Uint32Array(0);
  }

  /** Copies dirty tiles out of the color buffer and flags them for upload. */
  sync(): void {
    for (const t of this.tiles) {
      if (!t.dirty) continue;
      t.dirty = false;
      if (!this.single) {
        const dst = new Uint32Array(t.data.buffer);
        const x0 = t.tx * this.tileSize;
        const y0 = t.ty * this.tileSize;
        for (let y = 0; y < t.h; y++) {
          const src = (y0 + y) * this.w + x0;
          dst.set(this.pixels.subarray(src, src + t.w), y * t.w);
        }
      }
      t.tex.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const t of this.tiles) {
      t.tex.dispose();
      t.mesh.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
    }
    this.object.removeFromParent();
  }
}
