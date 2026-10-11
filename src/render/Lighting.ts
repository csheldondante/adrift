// 2D lighting: the derelict is dark, and light is something the player carries and restores.
//
// Each frame:
//   1. The game rasterizes occluders and emitters into a camera-centered grid on the CPU
//      (`occ`, one vec4 per texel: emitted rgb + flags). The pixel world is CPU-authoritative,
//      so this reads the same cells the physics uses.
//   2. A compute pass computes the lightmap: ambient (interior vs open space), self-emission
//      plus a little bloom from glowing cells, and every light with a shadow march through the
//      occluder grid.
//   3. A full-view overlay multiplies everything drawn before it (ORDER.light) by the lightmap.
//      Emissive things (sparks, flames, sensor cones) draw after it, at ORDER.glow.
//
// The grid has a fixed size; its texel size follows the zoom, so cost doesn't grow when zoomed
// out. Its origin snaps to whole texels so shadows don't shimmer while the camera moves.
//
// Likely growth: bounce/ambient propagation (a second, coarse pass), colored glass, light
// sources from powered machinery. Lights stay plain data (Light) so systems can add them
// without knowing about the GPU side.

import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop as TslLoop, clamp, float, floor, instanceIndex, int, ivec2, max, select, smoothstep, sqrt, storage, texture, textureStore, uniform, uv, vec3, vec4 } from 'three/tsl';
import { ORDER } from './order';

export interface Light {
  x: number;
  y: number;
  /** Unit direction for cone lights; ignored for omni lights (cosHalf <= -1). */
  dirX: number;
  dirY: number;
  /** Cosine of the cone half-angle; -2 for an omni light. */
  cosHalf: number;
  range: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  /** Meters at the light's end ignored by the shadow march (lights embedded in matter). */
  skin?: number;
}

/** Fills the occluder grid: per texel (er, eg, eb, flags) with flags = solid + 2·interior. */
export type OccluderRaster = (out: Float32Array, gw: number, gh: number, ox: number, oy: number, ts: number) => void;

export const LIGHT_GW = 384;
export const LIGHT_GH = 256;
const MAX_LIGHTS = 40;
// TSL's Loop typings don't know the `name` option
const Loop: any = TslLoop;
const MIN_TEXEL = 0.25; // m
const MARGIN = 10; // m beyond the view, so off-screen occluders still cast shadows in

export class Lighting {
  readonly mesh: THREE.Mesh;
  readonly occ: Float32Array;
  private readonly occAttr: THREE.StorageBufferAttribute;
  private readonly lightData = new Float32Array(MAX_LIGHTS * 12);
  private readonly lightAttr: THREE.StorageBufferAttribute;
  private readonly tex: THREE.StorageTexture;
  private readonly pass: THREE.ComputeNode;
  private readonly u = {
    ox: uniform(0),
    oy: uniform(0),
    ts: uniform(MIN_TEXEL),
    count: uniform(0, 'int'),
    ambIn: uniform(new THREE.Color(0.05, 0.05, 0.07)),
    ambOut: uniform(new THREE.Color(0.5, 0.5, 0.55)),
  };
  /** Lights for the coming frame; cleared by update(). */
  readonly lights: Light[] = [];
  /** Texel size and origin of the last update (meters), for tests. */
  ts = MIN_TEXEL;
  /** CPU time of the last occluder raster (ms), smoothed. */
  rasterMs = 0;
  ox = 0;
  oy = 0;

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    const n = LIGHT_GW * LIGHT_GH;
    this.occ = new Float32Array(n * 4);
    this.occAttr = new THREE.StorageBufferAttribute(this.occ, 4);
    this.lightAttr = new THREE.StorageBufferAttribute(this.lightData, 4);
    this.tex = new THREE.StorageTexture(LIGHT_GW, LIGHT_GH);
    this.tex.type = THREE.HalfFloatType;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.pass = this.buildPass(n);
    this.mesh = this.buildMesh();
  }

  setAmbient(interior: number, space: number): void {
    this.u.ambIn.value.setRGB(interior * 0.9, interior * 0.95, interior * 1.25);
    this.u.ambOut.value.setRGB(space * 0.92, space * 0.95, space);
  }

  private buildPass(n: number): THREE.ComputeNode {
    const u = this.u;
    const OCC: any = storage(this.occAttr, 'vec4', n);
    const LB: any = storage(this.lightAttr, 'vec4', MAX_LIGHTS * 3);
    const GW: any = int(LIGHT_GW);
    const GH: any = int(LIGHT_GH);
    const tex = this.tex;
    // bloom taps (texels): a ring at 2 and a ring at 5
    const taps: [number, number][] = [];
    for (const r of [2, 5]) for (let k = 0; k < 8; k++) taps.push([Math.round(Math.cos((k * Math.PI) / 4) * r), Math.round(Math.sin((k * Math.PI) / 4) * r)]);

    return Fn(() => {
      const i: any = int(instanceIndex);
      const x: any = i.mod(GW);
      const y: any = i.div(GW);
      const o: any = OCC.element(i);
      const interior = o.w.greaterThanEqual(1.5);
      const solid = o.w.mod(2.0).greaterThan(0.5);
      const glow: any = vec3(0).toVar();
      const open: any = float(0).toVar(); // taps in open space (starlit)
      for (const [dx, dy] of taps) {
        const xi: any = (clamp as any)(x.add(dx), int(0), GW.sub(1));
        const yi: any = (clamp as any)(y.add(dy), int(0), GH.sub(1));
        const q: any = OCC.element(yi.mul(GW).add(xi));
        glow.addAssign(q.xyz);
        open.addAssign(select(q.w.lessThan(0.5), float(1), float(0)));
      }
      // ambient: starlight in open space, near-dark inside; solid matter is starlit only on
      // its outer skin (within ~1 m of open space), so the hull's mass stays dark
      const skinLit: any = (vec3 as any)((select as any)(interior, u.ambIn, u.ambOut)).mix(u.ambOut, open.div(taps.length).mul(2).min(1));
      const amb: any = (select as any)(solid, (select as any)(open.greaterThan(0), skinLit, u.ambIn), (select as any)(interior, u.ambIn, u.ambOut));
      const col: any = (vec3 as any)(amb).toVar();
      col.addAssign(o.xyz.mul(1.4));
      col.addAssign(glow.mul(0.09));

      const ts: any = u.ts;
      const px: any = float(x).add(0.5).mul(ts).add(u.ox);
      const py: any = float(y).add(0.5).mul(ts).add(u.oy);
      // Loops are named: nested TSL loops otherwise both declare `i`, and expressions inlined into
      // the inner loop would silently read the inner counter.
      Loop({ start: int(0), end: u.count, type: 'int', condition: '<', name: 'li' }, ({ li: l }: any) => {
        const a: any = LB.element(l.mul(3)).toVar(); // x, y, range, intensity
        const b: any = LB.element(l.mul(3).add(1)).toVar(); // dirX, dirY, cosHalf, skin
        const c: any = LB.element(l.mul(3).add(2)).toVar(); // r, g, b, -
        const dx: any = px.sub(a.x);
        const dy: any = py.sub(a.y);
        const dist: any = max(sqrt(dx.mul(dx).add(dy.mul(dy))), float(1e-4));
        If(dist.lessThan(a.z), () => {
          const cosA: any = dx.mul(b.x).add(dy.mul(b.y)).div(dist);
          // full strength over the inner half of the cone, soft falloff to its edge
          const spot: any = select(b.z.lessThan(-1), float(1), smoothstep(b.z, b.z.add(float(1).sub(b.z).mul(0.5)), cosA));
          const f: any = float(1).sub(dist.div(a.z));
          const atten: any = f.mul(f).mul(a.w).mul(spot);
          If(atten.greaterThan(0.003), () => {
            // march from the light to this texel; skip the light's own skin and the last
            // ~0.35 m so the surface layer facing the light gets lit
            const sx: any = dx.div(dist).toVar();
            const sy: any = dy.div(dist).toVar();
            const vis: any = float(1).toVar();
            const steps: any = int(dist.div(ts));
            Loop({ start: int(0), end: steps, type: 'int', condition: '<', name: 'si' }, ({ si: k }: any) => {
              const t: any = float(k).add(0.5).mul(ts);
              If(t.greaterThan(b.w).and(t.lessThan(dist.sub(0.35))), () => {
                const qx: any = int(floor(a.x.add(sx.mul(t)).sub(u.ox).div(ts)));
                const qy: any = int(floor(a.y.add(sy.mul(t)).sub(u.oy).div(ts)));
                const inside = qx.greaterThanEqual(0).and(qy.greaterThanEqual(0)).and(qx.lessThan(GW)).and(qy.lessThan(GH));
                If(inside, () => {
                  const w: any = OCC.element(qy.mul(GW).add(qx)).w;
                  If(w.mod(2.0).greaterThan(0.5), () => {
                    vis.assign(0);
                    Break();
                  });
                });
              });
            });
            col.addAssign(c.xyz.mul(atten.mul(vis)));
          });
        });
      });
      textureStore(tex, ivec2(x, y), vec4(col, 1));
    })().compute(n);
  }

  private buildMesh(): THREE.Mesh {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    // 2× multiply: dst = dst·src + src·dst, so light up to 2 can brighten dark surfaces.
    // The output is sRGB-encoded before blending, so pre-decode light/2 to make the final
    // factor equal the light value (1 = unchanged).
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = THREE.SrcColorFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    const t: any = texture(this.tex, uv());
    mat.colorNode = vec4((clamp as any)(t.xyz.mul(0.5), float(0), float(1)).pow(2.2), 1);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0.5, 0.5, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = ORDER.light;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Covers a view of halfW×halfH meters (half-extents, already including any rotation)
   * around (cx, cy): rasterizes occluders, uploads lights, runs the light pass.
   */
  update(cx: number, cy: number, halfW: number, halfH: number, raster: OccluderRaster): void {
    this.mesh.visible = true;
    const ts = Math.max(MIN_TEXEL, (2 * (halfW + MARGIN)) / LIGHT_GW, (2 * (halfH + MARGIN)) / LIGHT_GH);
    const ox = Math.floor((cx - (LIGHT_GW * ts) / 2) / ts) * ts;
    const oy = Math.floor((cy - (LIGHT_GH * ts) / 2) / ts) * ts;
    this.ts = ts;
    this.ox = ox;
    this.oy = oy;
    this.occ.fill(0);
    const t0 = performance.now();
    raster(this.occ, LIGHT_GW, LIGHT_GH, ox, oy, ts);
    this.rasterMs += (performance.now() - t0 - this.rasterMs) * 0.1;
    this.occAttr.needsUpdate = true;

    const x1 = ox + LIGHT_GW * ts;
    const y1 = oy + LIGHT_GH * ts;
    let n = 0;
    const d = this.lightData;
    for (const L of this.lights) {
      if (n >= MAX_LIGHTS) break;
      if (L.intensity <= 0 || L.x + L.range < ox || L.x - L.range > x1 || L.y + L.range < oy || L.y - L.range > y1) continue;
      const k = n * 12;
      d[k] = L.x;
      d[k + 1] = L.y;
      d[k + 2] = L.range;
      d[k + 3] = L.intensity;
      d[k + 4] = L.dirX;
      d[k + 5] = L.dirY;
      d[k + 6] = L.cosHalf;
      d[k + 7] = L.skin ?? 0;
      d[k + 8] = L.r;
      d[k + 9] = L.g;
      d[k + 10] = L.b;
      n++;
    }
    this.lights.length = 0;
    this.lightAttr.needsUpdate = true;
    this.u.ox.value = ox;
    this.u.oy.value = oy;
    this.u.ts.value = ts;
    this.u.count.value = n;
    this.renderer.compute(this.pass);

    this.mesh.position.set(ox, oy, 0);
    this.mesh.scale.set(LIGHT_GW * ts, LIGHT_GH * ts, 1);
  }

  /** Lighting off: the overlay hides and the world renders fully lit. */
  disable(): void {
    this.mesh.visible = false;
    this.lights.length = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
  }
}
