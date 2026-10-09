// GPU gas + heat field on a coarse grid (FIELD_SCALE pixel cells per field cell).
//
// Model (cheap, stable, "fun not CFD"): a compressible-ish staggered grid. Each cell stores
// gas density (= pressure) and heat. Face velocities accelerate down the pressure gradient,
// are blocked by solid cells, and move gas/heat with upwind fluxes. The field's outer border
// is a vacuum sink, so breached rooms vent into space. Heat also diffuses through solids
// (conduction), so cutting near a tank can cook it off.
//
// CPU interface: setSolidFromGrid() when terrain changes, inject() for sources, sample() to
// read back gas/heat/flow (one or two frames latent) for forces and ignition.
//
// Likely growth: more channels (smoke, toxic gas, plasma) -> widen state to more vec4s and
// add a per-channel render palette; moving bodies as obstacles -> rasterize body masks into
// `solid` each frame; true pixel-rule fluids would be a separate cellular sim sharing the
// wall mask. Keep all of that behind this class's interface.

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  max,
  min,
  clamp,
  select,
  storage,
  textureStore,
  uniform,
  vec4,
  texture,
  uv,
  vec3,
  mix,
  smoothstep,
} from 'three/tsl';
import { CELL, FIELD_SCALE, tune } from '../config';
import type { PixelGrid, Rect } from '../pixel/PixelGrid';
import { F, MAT_FLAGS } from '../pixel/materials';

export interface FieldSample {
  gas: number;
  heat: number;
  vx: number; // m/s
  vy: number;
}

const SUBSTEPS = 2;

export class GasField {
  readonly w: number;
  readonly h: number;
  readonly cellMeters = CELL * FIELD_SCALE;
  readonly displayTexture: THREE.StorageTexture;
  readonly mesh: THREE.Mesh;

  private readonly n: number;
  private readonly stateAttr: THREE.StorageBufferAttribute;
  private readonly facesAttr: THREE.StorageBufferAttribute;
  private readonly solidAttr: THREE.StorageBufferAttribute;
  private readonly injectAttr: THREE.StorageBufferAttribute;
  private readonly solidCpu: Float32Array;
  private readonly injectCpu: Float32Array;
  private solidRows: [number, number] | null = null; // field rows needing upload
  private injRows: [number, number] | null = null;
  private focus0 = 0;
  private focus1 = 0;
  private readRow0 = 0;
  private readRows = 0;
  private readonly passes: THREE.ComputeNode[];
  private readonly u = {
    dt: uniform(1 / 120),
    stiffness: uniform(tune.gas.stiffness),
    damping: uniform(tune.gas.damping),
    heatDiffusion: uniform(tune.gas.heatDiffusion),
    heatKeep: uniform(1),
  };

  private readState: Float32Array | null = null;
  private readFaces: Float32Array | null = null;
  private readPending = false;
  private generation = 0;
  disposed = false;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    pixelW: number,
    pixelH: number,
    renderOrder: number,
  ) {
    this.w = Math.ceil(pixelW / FIELD_SCALE);
    this.h = Math.ceil(pixelH / FIELD_SCALE);
    const n = (this.n = this.w * this.h);
    this.stateAttr = new THREE.StorageBufferAttribute(new Float32Array(n * 4), 4);
    const nextAttr = new THREE.StorageBufferAttribute(new Float32Array(n * 4), 4);
    this.facesAttr = new THREE.StorageBufferAttribute(new Float32Array(n * 4), 4);
    this.solidCpu = new Float32Array(n);
    this.solidAttr = new THREE.StorageBufferAttribute(this.solidCpu, 1);
    this.injectCpu = new Float32Array(n * 4);
    this.injectAttr = new THREE.StorageBufferAttribute(this.injectCpu, 4);

    this.displayTexture = new THREE.StorageTexture(this.w, this.h);
    this.displayTexture.type = THREE.HalfFloatType;
    this.displayTexture.minFilter = THREE.LinearFilter;
    this.displayTexture.magFilter = THREE.LinearFilter;

    this.passes = this.buildPasses(nextAttr);
    this.mesh = this.buildMesh(renderOrder);
  }

  private buildPasses(nextAttr: THREE.StorageBufferAttribute): THREE.ComputeNode[] {
    const { n, u } = this;
    // TSL's TS typings are stricter than the runtime graph; nodes are typed loosely here.
    const S: any = storage(this.stateAttr, 'vec4', n);
    const B: any = storage(nextAttr, 'vec4', n);
    const FA: any = storage(this.facesAttr, 'vec4', n);
    const SOL: any = storage(this.solidAttr, 'float', n);
    const INJ: any = storage(this.injectAttr, 'vec4', n);
    const W: any = int(this.w);
    const H: any = int(this.h);

    const coords = () => {
      const i: any = int(instanceIndex);
      const x: any = i.mod(W);
      const y: any = i.div(W);
      const xl = (max as any)(x.sub(1), int(0));
      const xr = (min as any)(x.add(1), W.sub(1));
      const yd = (max as any)(y.sub(1), int(0));
      const yu = (min as any)(y.add(1), H.sub(1));
      return { i, x, y, iL: y.mul(W).add(xl), iR: y.mul(W).add(xr), iD: yd.mul(W).add(x), iU: yu.mul(W).add(x) };
    };

    // 1) face velocities: u = right face, v = top face (cells/s)
    const faces = Fn(() => {
      const { i, x, y, iR, iU } = coords();
      const s0 = SOL.element(i);
      const g0 = S.element(i).x;
      const f = FA.element(i);
      const edgeR = select(x.equal(W.sub(1)), float(1), float(0));
      const edgeU = select(y.equal(H.sub(1)), float(1), float(0));
      const openR = float(1).sub(min(max(max(s0, SOL.element(iR)), edgeR), float(1)));
      const openU = float(1).sub(min(max(max(s0, SOL.element(iU)), edgeU), float(1)));
      const lim = float(0.24).div(u.dt);
      const fu = f.x.add(g0.sub(S.element(iR).x).mul(u.stiffness).mul(u.dt)).mul(u.damping).mul(openR);
      const fv = f.y.add(g0.sub(S.element(iU).x).mul(u.stiffness).mul(u.dt)).mul(u.damping).mul(openU);
      FA.element(i).assign(vec4(clamp(fu, lim.negate(), lim), clamp(fv, lim.negate(), lim), 0, 0));
    })().compute(n);

    // 2) advect gas + heat with upwind fluxes, diffuse heat, write to B
    const advect = Fn(() => {
      const { i, x, y, iL, iR, iD, iU } = coords();
      const st = S.element(i);
      const g = st.x;
      const h = st.y;
      const sL = S.element(iL);
      const sR = S.element(iR);
      const sD = S.element(iD);
      const sU = S.element(iU);
      const uR = FA.element(i).x;
      const uL = FA.element(iL).x;
      const vT = FA.element(i).y;
      const vB = FA.element(iD).y;
      const dt = u.dt;
      const gIn = uL
        .mul(select(uL.greaterThan(0), sL.x, g))
        .sub(uR.mul(select(uR.greaterThan(0), g, sR.x)))
        .add(vB.mul(select(vB.greaterThan(0), sD.x, g)))
        .sub(vT.mul(select(vT.greaterThan(0), g, sU.x)));
      const hIn = uL
        .mul(select(uL.greaterThan(0), sL.y, h))
        .sub(uR.mul(select(uR.greaterThan(0), h, sR.y)))
        .add(vB.mul(select(vB.greaterThan(0), sD.y, h)))
        .sub(vT.mul(select(vT.greaterThan(0), h, sU.y)));
      const lap = sL.y.add(sR.y).add(sD.y).add(sU.y).sub(h.mul(4));
      const gN = max(g.add(gIn.mul(dt)), float(0));
      const hN = max(h.add(hIn.mul(dt)).add(lap.mul(u.heatDiffusion).mul(dt)), float(0)).mul(u.heatKeep);
      const border = x.equal(0).or(y.equal(0)).or(x.equal(W.sub(1))).or(y.equal(H.sub(1)));
      B.element(i).assign(select(border, vec4(0, 0, 0, 0), vec4(gN, hN, 0, 0)));
    })().compute(n);

    // 3) commit B -> S, add injections, zero walls, write display texture
    const tex = this.displayTexture;
    const commit = Fn(() => {
      const { i, x, y } = coords();
      const b = B.element(i);
      const inj = INJ.element(i);
      const s = SOL.element(i);
      const gas = select(s.greaterThan(0.5), float(0), b.x.add(inj.x));
      const heat = b.y.add(inj.y);
      S.element(i).assign(vec4(gas, heat, 0, 0));
      INJ.element(i).assign(vec4(0, 0, 0, 0));
      textureStore(tex, ivec2(x, y), vec4(gas, heat, s, 1));
    })().compute(n);

    return [faces, advect, commit];
  }

  private buildMesh(renderOrder: number): THREE.Mesh {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    mat.blending = THREE.AdditiveBlending;
    const t = texture(this.displayTexture, uv());
    const gas = t.x;
    const heat = t.y;
    // output is sRGB-encoded after blending, so keep linear values small for a subtle haze
    const gasCol = vec3(0.012, 0.026, 0.06).mul(min(gas, float(2.5)));
    // heat tone-maps toward (never quite) white so stacked blasts glow instead of clipping
    const heatAmt = float(1).sub((heat.mul(-0.55) as any).exp());
    const heatGlow = mix(vec3(0.5, 0.04, 0.0), vec3(0.9, 0.32, 0.06), smoothstep(0.5, 0.95, heatAmt));
    const heatCol = heatGlow.mul(heatAmt).mul(smoothstep(0.02, 0.3, heat)).mul(0.22);
    mat.colorNode = vec4(gasCol.add(heatCol), 1);
    const wM = this.w * this.cellMeters;
    const hM = this.h * this.cellMeters;
    const geo = new THREE.PlaneGeometry(wM, hM);
    geo.translate(wM / 2, hM / 2, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Clears gas, heat and flow (GPU buffers are reused across runs). */
  reset(): void {
    (this.stateAttr.array as Float32Array).fill(0);
    (this.facesAttr.array as Float32Array).fill(0);
    this.stateAttr.needsUpdate = true;
    this.facesAttr.needsUpdate = true;
    this.injectCpu.fill(0);
    this.solidCpu.fill(0);
    this.injRows = [0, this.h - 1];
    this.solidRows = [0, this.h - 1];
    this.readState = null;
    this.readFaces = null;
    this.generation++;
  }

  private static grow(r: [number, number] | null, y0: number, y1: number): [number, number] {
    return r ? [Math.min(r[0], y0), Math.max(r[1], y1)] : [y0, y1];
  }

  /** Recomputes the wall mask for field cells overlapping a pixel-cell rect. */
  setSolidFromGrid(grid: PixelGrid, r: Rect): void {
    const fx0 = Math.max(0, Math.floor(r.x0 / FIELD_SCALE));
    const fy0 = Math.max(0, Math.floor(r.y0 / FIELD_SCALE));
    const fx1 = Math.min(this.w, Math.ceil(r.x1 / FIELD_SCALE));
    const fy1 = Math.min(this.h, Math.ceil(r.y1 / FIELD_SCALE));
    if (fx1 <= fx0 || fy1 <= fy0) return;
    const half = (FIELD_SCALE * FIELD_SCALE) / 2;
    for (let fy = fy0; fy < fy1; fy++) {
      for (let fx = fx0; fx < fx1; fx++) {
        let solid = 0;
        for (let y = fy * FIELD_SCALE; y < (fy + 1) * FIELD_SCALE && y < grid.h; y++)
          for (let x = fx * FIELD_SCALE; x < (fx + 1) * FIELD_SCALE && x < grid.w; x++)
            if (MAT_FLAGS[grid.mat[y * grid.w + x]] & F.SOLID) solid++;
        // a field cell stays a wall until more than half its pixels are open
        this.solidCpu[fy * this.w + fx] = solid >= half ? 1 : 0;
      }
    }
    this.solidRows = GasField.grow(this.solidRows, fy0, fy1 - 1);
  }

  /** Adds gas/heat in a world-space disc (amounts are per-cell at the center, soft falloff). */
  inject(wx: number, wy: number, radius: number, gas: number, heat: number): void {
    const cx = wx / this.cellMeters;
    const cy = wy / this.cellMeters;
    const r = Math.max(0.75, radius / this.cellMeters);
    const x0 = Math.max(1, Math.floor(cx - r));
    const y0 = Math.max(1, Math.floor(cy - r));
    const x1 = Math.min(this.w - 2, Math.ceil(cx + r));
    const y1 = Math.min(this.h - 2, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d > 1) continue;
        const k = 1 - d * d;
        const i = (y * this.w + x) * 4;
        this.injectCpu[i] += gas * k;
        this.injectCpu[i + 1] += heat * k;
      }
    }
    this.injRows = GasField.grow(this.injRows, y0, y1);
  }

  /** Fills a world-space rectangle with gas (e.g. initial room pressure). */
  fillRect(x0: number, y0: number, x1: number, y1: number, gas: number): void {
    const m = this.cellMeters;
    const ry0 = Math.max(1, Math.floor(y0 / m));
    const ry1 = Math.min(this.h - 2, Math.ceil(y1 / m) - 1);
    if (ry1 < ry0) return;
    for (let y = ry0; y <= ry1; y++)
      for (let x = Math.floor(x0 / m); x < Math.ceil(x1 / m); x++) {
        if (x < 1 || x >= this.w - 1) continue;
        this.injectCpu[(y * this.w + x) * 4] += gas;
      }
    this.injRows = GasField.grow(this.injRows, ry0, ry1);
  }

  /**
   * Sets the world-space vertical band (meters) that is read back for CPU sampling. Reading
   * the whole field every frame is too much bandwidth at dungeon scale, and CPU coupling
   * (forces, ignition, damage) only matters near the player. Off-band, sample() returns 0.
   */
  setFocus(y0: number, y1: number): void {
    this.focus0 = Math.max(0, Math.floor(y0 / this.cellMeters));
    this.focus1 = Math.min(this.h, Math.ceil(y1 / this.cellMeters));
  }

  step(dt: number): void {
    const { u, w } = this;
    u.stiffness.value = tune.gas.stiffness;
    u.damping.value = tune.gas.damping;
    u.heatDiffusion.value = tune.gas.heatDiffusion;
    const sub = dt / SUBSTEPS;
    u.dt.value = sub;
    u.heatKeep.value = Math.exp(-tune.gas.heatDecay * sub);
    // upload only the rows that changed
    if (this.solidRows) {
      const [r0, r1] = this.solidRows;
      this.solidAttr.addUpdateRange(r0 * w, (r1 - r0 + 1) * w);
      this.solidAttr.needsUpdate = true;
      this.solidRows = null;
    }
    const inj = this.injRows;
    if (inj) {
      this.injectAttr.addUpdateRange(inj[0] * w * 4, (inj[1] - inj[0] + 1) * w * 4);
      this.injectAttr.needsUpdate = true;
    }
    for (let s = 0; s < SUBSTEPS; s++) this.renderer.compute(this.passes);
    if (inj) {
      // the upload happened inside compute(); the GPU zeroes its copy in the commit pass
      this.injectCpu.fill(0, inj[0] * w * 4, (inj[1] + 1) * w * 4);
      this.injRows = null;
    }
    this.requestReadback();
  }

  private requestReadback(): void {
    if (this.readPending) return;
    const row0 = this.focus0;
    const rows = this.focus1 - this.focus0;
    if (rows <= 2) return;
    this.readPending = true;
    const gen = this.generation;
    const offset = row0 * this.w * 16; // bytes (vec4 of f32 per cell)
    const count = rows * this.w * 16;
    Promise.all([this.renderer.getArrayBufferAsync(this.stateAttr, null, offset, count), this.renderer.getArrayBufferAsync(this.facesAttr, null, offset, count)])
      .then(([s, f]) => {
        if (this.disposed || gen !== this.generation) return;
        this.readState = new Float32Array(s as ArrayBuffer);
        this.readFaces = new Float32Array(f as ArrayBuffer);
        this.readRow0 = row0;
        this.readRows = rows;
      })
      .catch((e) => console.warn('field readback failed', e))
      .finally(() => {
        this.readPending = false;
      });
  }

  /** Samples the latest readback at a world position (nearest cell); 0 outside the focus band. */
  sample(wx: number, wy: number, out: FieldSample): FieldSample {
    out.gas = out.heat = out.vx = out.vy = 0;
    const s = this.readState;
    const f = this.readFaces;
    if (!s || !f) return out;
    const x = Math.floor(wx / this.cellMeters);
    const y = Math.floor(wy / this.cellMeters);
    if (x < 1 || x >= this.w - 1 || y < this.readRow0 + 1 || y >= this.readRow0 + this.readRows) return out;
    const i = (y - this.readRow0) * this.w + x;
    out.gas = s[i * 4];
    out.heat = s[i * 4 + 1];
    // cell-centered velocity = average of the two faces on each axis
    out.vx = 0.5 * (f[i * 4] + f[(i - 1) * 4]) * this.cellMeters;
    out.vy = 0.5 * (f[i * 4 + 1] + f[(i - this.w) * 4 + 1]) * this.cellMeters;
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.displayTexture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
