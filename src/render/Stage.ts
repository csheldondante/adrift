// Renderer, scene and 2D orthographic camera. World units are meters, +y up.
// Persistent across game restarts; per-run content attaches to `world` and is removed on
// dispose, while background layers live in `scene` directly.

import * as THREE from 'three/webgpu';

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
  /** Per-run content root. */
  readonly world = new THREE.Group();
  viewHeight = 36; // meters visible vertically
  camX = 0;
  camY = 0;
  private shakeAmp = 0;
  private shakeT = 0;

  private constructor(readonly renderer: THREE.WebGPURenderer) {
    this.scene.background = new THREE.Color(0x030409);
    this.scene.add(this.world);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  static async create(container: HTMLElement): Promise<Stage> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    return new Stage(renderer);
  }

  get viewWidth(): number {
    return this.viewHeight * (window.innerWidth / window.innerHeight);
  }

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.updateProjection();
  }

  private updateProjection(): void {
    const hw = this.viewWidth / 2;
    const hh = this.viewHeight / 2;
    const c = this.camera;
    c.left = -hw;
    c.right = hw;
    c.top = hh;
    c.bottom = -hh;
    c.updateProjectionMatrix();
  }

  shake(amount: number): void {
    this.shakeAmp = Math.min(1.5, this.shakeAmp + amount);
  }

  setView(x: number, y: number, viewHeight: number, dt: number): void {
    this.camX = x;
    this.camY = y;
    if (viewHeight !== this.viewHeight) {
      this.viewHeight = viewHeight;
      this.updateProjection();
    }
    this.shakeT += dt;
    this.shakeAmp *= Math.exp(-dt * 6);
    const sx = Math.sin(this.shakeT * 71) * this.shakeAmp;
    const sy = Math.cos(this.shakeT * 53) * this.shakeAmp;
    this.camera.position.set(x + sx, y + sy, 10);
  }

  screenToWorld(px: number, py: number, out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.camX + (px / window.innerWidth - 0.5) * this.viewWidth;
    out.y = this.camY - (py / window.innerHeight - 0.5) * this.viewHeight;
    return out;
  }

  worldToScreen(wx: number, wy: number, out: { x: number; y: number }): { x: number; y: number } {
    out.x = ((wx - this.camX) / this.viewWidth + 0.5) * window.innerWidth;
    out.y = (0.5 - (wy - this.camY) / this.viewHeight) * window.innerHeight;
    return out;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
