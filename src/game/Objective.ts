// Extraction objective: get the salvage body's center of mass into the zone and keep it there
// briefly. Pure rules + a zone visual; the HUD reads its state.
//
// Likely growth: multiple salvage items with values, timed runs, firefight objectives.
// Those become further Objective implementations sharing this shape (update/state).

import * as THREE from 'three/webgpu';
import type { PixelBody } from '../pixel/PixelBody';
import { ORDER } from '../render/order';

export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ObjectiveState = 'active' | 'complete' | 'lost';

const HOLD_TIME = 1.0;

export class ExtractionObjective {
  readonly mesh: THREE.Group;
  state: ObjectiveState = 'active';
  progress = 0; // 0..1 hold progress
  elapsed = 0;
  completedAt = 0;
  private readonly fill: THREE.MeshBasicMaterial;
  private readonly edge: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(
    readonly zone: Zone,
    readonly salvage: PixelBody,
  ) {
    const w = zone.x1 - zone.x0;
    const h = zone.y1 - zone.y0;
    this.mesh = new THREE.Group();
    this.mesh.position.set((zone.x0 + zone.x1) / 2, (zone.y0 + zone.y1) / 2, 0);
    this.fill = new THREE.MeshBasicMaterial({ color: 0x2bd4a0, transparent: true, opacity: 0.08, depthTest: false, depthWrite: false });
    const fillMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.fill);
    fillMesh.renderOrder = ORDER.zone;
    this.edge = new THREE.MeshBasicMaterial({ color: 0x2bd4a0, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
    this.edge.blending = THREE.AdditiveBlending;
    const t = 0.15;
    for (const [x, y, ew, eh] of [
      [0, h / 2, w, t],
      [0, -h / 2, w, t],
      [w / 2, 0, t, h],
      [-w / 2, 0, t, h],
    ]) {
      const e = new THREE.Mesh(new THREE.PlaneGeometry(ew, eh), this.edge);
      e.position.set(x, y, 0);
      e.renderOrder = ORDER.zone + 1;
      this.mesh.add(e);
    }
    this.mesh.add(fillMesh);
  }

  contains(x: number, y: number): boolean {
    const z = this.zone;
    return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  }

  update(dt: number): void {
    this.t += dt;
    if (this.state === 'active') {
      this.elapsed += dt;
      if (!this.salvage.alive) {
        this.state = 'lost';
      } else {
        const c = this.salvage.body.worldCom();
        this.progress = this.contains(c.x, c.y) ? Math.min(1, this.progress + dt / HOLD_TIME) : Math.max(0, this.progress - dt * 2);
        if (this.progress >= 1) {
          this.state = 'complete';
          this.completedAt = this.elapsed;
        }
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3);
    const done = this.state === 'complete';
    this.fill.opacity = done ? 0.25 + 0.1 * pulse : 0.06 + 0.12 * this.progress + 0.03 * pulse;
    this.edge.opacity = 0.4 + 0.4 * pulse + 0.3 * this.progress;
    if (done) this.edge.color.setHex(0x9dffcf);
  }

  dispose(): void {
    this.mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.fill.dispose();
    this.edge.dispose();
    this.mesh.removeFromParent();
  }
}
