// Corner minimap with fog of war: a downsampled terrain image, revealed around the ship as you
// explore, with markers for the ship, the core and the extraction zone. Redrawn on a throttle;
// reads game state only.
//
// Likely growth: alarm/security overlays (bot positions once spotted, sealed doors), room labels.

import type { Game } from '../game/Game';
import { CELL } from '../config';

const SAMPLE = 16; // pixel cells per minimap pixel
const REVEAL_M = 34; // reveal radius around the ship, meters
const W = 256; // canvas size (CSS scales it)
const H = 128;

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly img: ImageData;
  private seen = new Uint8Array(0);
  private gw = 0;
  private gh = 0;
  private timer = 0;
  private game: Game | null = null;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-minimap';
    this.canvas.width = W;
    this.canvas.height = H;
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.img = this.g.createImageData(W, H);
  }

  update(game: Game, dt: number): void {
    const grid = game.pixels.terrain.grid;
    if (game !== this.game) {
      // new run: reset fog
      this.game = game;
      this.gw = Math.ceil(grid.w / SAMPLE);
      this.gh = Math.ceil(grid.h / SAMPLE);
      this.seen = new Uint8Array(this.gw * this.gh);
    }
    this.reveal(game);
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.draw(game);
  }

  private reveal(game: Game): void {
    const sx = game.ship.x / CELL / SAMPLE;
    const sy = game.ship.y / CELL / SAMPLE;
    const r = REVEAL_M / CELL / SAMPLE;
    for (let y = Math.max(0, Math.floor(sy - r)); y <= Math.min(this.gh - 1, Math.ceil(sy + r)); y++)
      for (let x = Math.max(0, Math.floor(sx - r)); x <= Math.min(this.gw - 1, Math.ceil(sx + r)); x++)
        if ((x - sx) ** 2 + (y - sy) ** 2 <= r * r) this.seen[y * this.gw + x] = 1;
  }

  private draw(game: Game): void {
    const grid = game.pixels.terrain.grid;
    const d = this.img.data;
    // map the grid's sample lattice onto the canvas (letterboxed by aspect)
    const scale = Math.min(W / this.gw, H / this.gh);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 4;
        const gx = Math.floor(px / scale);
        const gy = Math.floor((H - 1 - py) / scale);
        if (gx >= this.gw || gy >= this.gh) {
          d[o + 3] = 0;
          continue;
        }
        const seen = this.seen[gy * this.gw + gx];
        const solid = grid.solid(gx * SAMPLE + SAMPLE / 2, gy * SAMPLE + SAMPLE / 2);
        if (!seen) {
          d[o] = 10;
          d[o + 1] = 14;
          d[o + 2] = 24;
          d[o + 3] = 170;
        } else if (solid) {
          d[o] = 92;
          d[o + 1] = 100;
          d[o + 2] = 116;
          d[o + 3] = 230;
        } else {
          d[o] = 16;
          d[o + 1] = 22;
          d[o + 2] = 36;
          d[o + 3] = 200;
        }
      }
    }
    this.g.putImageData(this.img, 0, 0);
    const toCanvas = (x: number, y: number) => [(x / CELL / SAMPLE) * scale, H - (y / CELL / SAMPLE) * scale] as const;
    const dot = (x: number, y: number, color: string, r: number) => {
      const [cx, cy] = toCanvas(x, y);
      this.g.fillStyle = color;
      this.g.fillRect(Math.round(cx - r), Math.round(cy - r), r * 2, r * 2);
    };
    const z = game.objective.zone;
    const [zx0, zy0] = toCanvas(z.x0, z.y1);
    const [zx1, zy1] = toCanvas(z.x1, z.y0);
    this.g.strokeStyle = '#2bd4a0';
    this.g.strokeRect(zx0, zy0, Math.max(2, zx1 - zx0), Math.max(2, zy1 - zy0));
    if (game.salvage.alive) {
      const c = game.salvage.body.worldCom();
      dot(c.x, c.y, '#4fe3d6', 2);
    }
    dot(game.ship.x, game.ship.y, '#ffffff', 2);
  }
}
