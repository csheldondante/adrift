// Parallax background layers. Each layer has a depth factor p in [0,1): p=0 moves with the
// world, p→1 stays fixed to the camera. Layers are procedurally painted canvases so the art
// can be swapped for authored textures later without touching the parallax logic.
//
// Likely growth: per-level layer sets (data-driven), animated layers (rotating megastructure,
// passing ships), lighting from a distant star tinting foreground. Add Layer implementations.

import * as THREE from 'three/webgpu';
import { ORDER } from './order';
import type { Stage } from './Stage';

interface Layer {
  update(stage: Stage): void;
  readonly object: THREE.Object3D;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, pixelated = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (pixelated) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
  }
  return t;
}

function basicMat(map: THREE.Texture, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthTest: false, depthWrite: false });
  if (additive) m.blending = THREE.AdditiveBlending;
  return m;
}

/** Infinitely tiling star/nebula layer glued to the camera with a scrolling texture offset. */
class TiledLayer implements Layer {
  readonly object: THREE.Mesh;
  constructor(
    private readonly tex: THREE.Texture,
    private readonly tileMeters: number,
    private readonly p: number,
    order: number,
    additive: boolean,
  ) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat(tex, 1, additive));
    this.object.renderOrder = order;
    this.object.frustumCulled = false;
  }
  update(stage: Stage): void {
    const w = stage.viewWidth;
    const h = stage.viewHeight;
    this.object.position.set(stage.camX, stage.camY, -1);
    this.object.scale.set(w, h, 1);
    this.tex.repeat.set(w / this.tileMeters, h / this.tileMeters);
    const k = 1 - this.p;
    this.tex.offset.set(((stage.camX - w / 2) * k) / this.tileMeters, ((stage.camY - h / 2) * k) / this.tileMeters);
  }
}

/** Fixed set of large sprites living in a parallax-shifted group. */
class SpriteLayer implements Layer {
  readonly object = new THREE.Group();
  constructor(private readonly p: number) {}
  add(tex: THREE.Texture, x: number, y: number, w: number, h: number, order: number, opacity = 1, rot = 0, additive = false): this {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basicMat(tex, opacity, additive));
    m.position.set(x, y, 0);
    m.rotation.z = rot;
    m.renderOrder = order;
    m.frustumCulled = false;
    this.object.add(m);
    return this;
  }
  update(stage: Stage): void {
    this.object.position.set(stage.camX * this.p, stage.camY * this.p, -1);
  }
}

export class Background {
  private readonly layers: Layer[] = [];

  constructor(stage: Stage, center: { x: number; y: number }) {
    const r = rng(1337);

    const nebula = canvasTexture(512, 512, (g) => {
      for (let i = 0; i < 18; i++) {
        const x = r() * 512;
        const y = r() * 512;
        const rad = 80 + r() * 180;
        const hue = r() < 0.5 ? `${40 + r() * 40},${20 + r() * 30},${90 + r() * 80}` : `${90 + r() * 60},${30 + r() * 30},${60 + r() * 50}`;
        const grd = g.createRadialGradient(x, y, 0, x, y, rad);
        grd.addColorStop(0, `rgba(${hue},0.16)`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        // draw wrapped so the tile is seamless
        for (const ox of [-512, 0, 512]) for (const oy of [-512, 0, 512]) {
          g.save();
          g.translate(ox, oy);
          g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
          g.restore();
        }
      }
    });
    this.layers.push(new TiledLayer(nebula, 220, 0.97, ORDER.bgStars - 2, true));

    const stars = (seed: number, count: number, bright: number) => {
      const rr = rng(seed);
      return canvasTexture(
        1024,
        1024,
        (g) => {
          for (let i = 0; i < count; i++) {
            const a = (0.3 + rr() * 0.7) * bright;
            const tint = rr();
            g.fillStyle = tint < 0.15 ? `rgba(255,200,160,${a})` : tint < 0.3 ? `rgba(170,200,255,${a})` : `rgba(255,255,255,${a})`;
            const s = rr() < 0.06 ? 2 : 1;
            g.fillRect(Math.floor(rr() * 1024), Math.floor(rr() * 1024), s, s);
          }
        },
        true,
      );
    };
    this.layers.push(new TiledLayer(stars(1, 2200, 0.5), 110, 0.94, ORDER.bgStars, true));
    this.layers.push(new TiledLayer(stars(2, 500, 0.85), 90, 0.82, ORDER.bgStars + 1, true));

    // distant planet + moon
    const planet = canvasTexture(512, 512, (g) => {
      const cx = 256;
      const rad = 230;
      g.save();
      g.beginPath();
      g.arc(cx, cx, rad, 0, Math.PI * 2);
      g.clip();
      const base = g.createLinearGradient(0, 0, 512, 512);
      base.addColorStop(0, '#6b4a8a');
      base.addColorStop(1, '#1a1030');
      g.fillStyle = base;
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 26; i++) {
        g.fillStyle = `rgba(${150 + r() * 80},${90 + r() * 60},${120 + r() * 80},${0.06 + r() * 0.1})`;
        const y = r() * 512;
        g.fillRect(0, y, 512, 6 + r() * 26);
      }
      const shade = g.createRadialGradient(150, 150, 60, 300, 300, 330);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,8,0.92)');
      g.fillStyle = shade;
      g.fillRect(0, 0, 512, 512);
      g.restore();
      g.strokeStyle = 'rgba(190,150,255,0.35)';
      g.lineWidth = 5;
      g.beginPath();
      g.arc(cx, cx, rad, Math.PI * 0.95, Math.PI * 1.65);
      g.stroke();
    });
    const far = new SpriteLayer(0.9);
    far.add(planet, center.x * 0.1 + 70, center.y * 0.1 - 25, 120, 120, ORDER.bgPlanet, 0.9);
    this.layers.push(far);

    // giant derelict megastructure silhouette
    const giant = canvasTexture(
      1024,
      256,
      (g) => {
        const rr = rng(77);
        g.fillStyle = '#0d1220';
        g.fillRect(40, 90, 940, 80);
        for (let i = 0; i < 14; i++) {
          const x = 40 + rr() * 900;
          const w = 30 + rr() * 90;
          const h = 20 + rr() * 70;
          g.fillRect(x, 90 - h, w, h);
          g.fillRect(x + rr() * 20, 170, w * 0.7, 10 + rr() * 50);
        }
        g.fillStyle = '#121a2c';
        for (let x = 60; x < 960; x += 48) g.fillRect(x, 100, 4, 60);
        // ring segment
        g.strokeStyle = '#0f1526';
        g.lineWidth = 18;
        g.beginPath();
        g.arc(780, 128, 110, Math.PI * 0.6, Math.PI * 1.9);
        g.stroke();
        // tiny lit windows
        for (let i = 0; i < 160; i++) {
          g.fillStyle = rr() < 0.8 ? 'rgba(255,190,110,0.7)' : 'rgba(120,200,255,0.8)';
          g.fillRect(Math.floor(60 + rr() * 900), Math.floor(95 + rr() * 70), 2, 1);
        }
        // broken end
        g.clearRect(940, 60, 84, 140);
        for (let i = 0; i < 40; i++) g.clearRect(900 + rr() * 60, 80 + rr() * 100, 8 + rr() * 30, 3 + rr() * 8);
      },
      true,
    );
    const mid = new SpriteLayer(0.72);
    mid.add(giant, center.x * 0.28 - 20, center.y * 0.28 + 32, 220, 55, ORDER.bgGiant, 0.95, -0.12);
    this.layers.push(mid);

    // nearer floating junk silhouettes
    // jagged hull fragments with panel lines, a few lit windows
    const fragment = (seed: number) =>
      canvasTexture(
        96,
        64,
        (g) => {
          const rr = rng(seed);
          const pts: [number, number][] = [];
          const n = 7 + Math.floor(rr() * 5);
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const rad = 0.55 + rr() * 0.45;
            pts.push([48 + Math.cos(a) * 46 * rad, 32 + Math.sin(a) * 30 * rad]);
          }
          g.fillStyle = '#161d2c';
          g.beginPath();
          pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.closePath();
          g.fill();
          g.save();
          g.clip();
          g.fillStyle = '#10151f';
          for (let x = 4; x < 96; x += 12) g.fillRect(x, 0, 1, 64);
          for (let y = 6; y < 64; y += 10) g.fillRect(0, y, 96, 1);
          g.fillStyle = '#1f283a';
          g.fillRect(0, 26 + rr() * 10, 96, 3);
          for (let i = 0; i < 4; i++) {
            g.fillStyle = rr() < 0.7 ? 'rgba(255,180,100,0.55)' : 'rgba(110,190,255,0.6)';
            g.fillRect(Math.floor(16 + rr() * 64), Math.floor(14 + rr() * 36), 2, 1);
          }
          g.restore();
        },
        true,
      );
    const frags = [fragment(11), fragment(12), fragment(13), fragment(14)];
    const near = new SpriteLayer(0.45);
    for (let i = 0; i < 9; i++) {
      const size = 4 + r() * 7;
      near.add(frags[i % frags.length], center.x * 0.55 + (i - 4.5) * 26 + r() * 14, center.y * 0.55 + (r() - 0.5) * 70, size * 1.5, size, ORDER.bgMid, 0.6, r() * 6);
    }
    this.layers.push(near);

    for (const l of this.layers) stage.scene.add(l.object);
  }

  update(stage: Stage): void {
    for (const l of this.layers) l.update(stage);
  }
}
