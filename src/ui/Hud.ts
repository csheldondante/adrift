// DOM HUD: objective, health, velocity, tool status, off-screen markers and banners.
// Reads game state each frame; never mutates it.

import { tune } from '../config';
import type { Game } from '../game/Game';
import type { Stage } from '../render/Stage';

const tmp = { x: 0, y: 0 };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly objective: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly tools: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly velArrow: HTMLDivElement;
  private readonly markers: { el: HTMLDivElement; label: string }[];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.objective = el('div', 'hud-objective', this.root);
    const health = el('div', 'hud-health', this.root, '<span>HULL</span>');
    this.healthFill = el('div', 'hud-health-fill', el('div', 'hud-health-bar', health));
    this.stats = el('div', 'hud-stats', this.root);
    const vel = el('div', 'hud-vel', this.root);
    this.velArrow = el('div', 'hud-vel-arrow', vel);
    this.tools = el('div', 'hud-tools', this.root);
    this.banner = el('div', 'hud-banner', this.root);
    this.help = el(
      'div',
      'hud-help',
      this.root,
      `<b>W/S</b> thrust · <b>A/D</b> rotate · <b>Mouse</b> aim<br>
       <b>LMB</b> cutter · <b>RMB</b> grapple / release · <b>Q/E</b> reel in/out<br>
       <b>Wheel</b> zoom · <b>R</b> restart · <b>H</b> hide help · <b>\`</b> debug panel`,
    );
    this.markers = [
      { el: el('div', 'hud-marker salvage', this.root), label: 'CORE' },
      { el: el('div', 'hud-marker zone', this.root), label: 'EXTRACT' },
    ];
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH') this.help.classList.toggle('hidden');
    });
  }

  update(game: Game, stage: Stage): void {
    const obj = game.objective;
    const t = obj.state === 'complete' ? obj.completedAt : obj.elapsed;
    const objText =
      obj.state === 'complete'
        ? 'Salvage extracted'
        : obj.progress > 0
          ? `Hold the core in the zone… ${Math.round(obj.progress * 100)}%`
          : game.grapple.targetObject === game.salvage
            ? 'Tow the core to the extraction zone'
            : 'Cut into the derelict and grapple the reactor core';
    this.objective.innerHTML = `${objText}<span class="time">${t.toFixed(1)}s</span>`;

    const hp = Math.max(0, game.ship.health / tune.ship.maxHealth);
    this.healthFill.style.width = `${hp * 100}%`;
    this.healthFill.style.background = hp > 0.5 ? '#5fe0a8' : hp > 0.25 ? '#ffc04d' : '#ff5a4d';

    const v = game.ship.body.linvel();
    const speed = Math.hypot(v.x, v.y);
    const mass = game.ship.body.mass() + (game.grapple.targetObject?.kind === 'pixelBody' ? (game.grapple.targetObject as unknown as { body: { mass(): number } }).body.mass() : 0);
    this.stats.innerHTML = `${speed.toFixed(1)} m/s<br><small>${Math.round(mass)} kg ${game.grapple.attached ? '(towing)' : ''}</small>`;
    const ang = Math.atan2(v.y, v.x);
    this.velArrow.style.transform = `rotate(${-ang}rad) scaleX(${Math.min(1, speed / 15)})`;
    this.velArrow.style.opacity = speed > 0.2 ? '1' : '0.2';

    this.tools.innerHTML = game.slots.map((s, i) => `<div><b>${i === 0 ? 'LMB' : 'RMB'}</b> ${s.name} <span>${s.status()}</span></div>`).join('');

    if (obj.state === 'complete') this.showBanner('SALVAGE EXTRACTED', `${obj.completedAt.toFixed(1)} s — press R to run it again`, 'win');
    else if (!game.ship.alive) this.showBanner('SHIP DESTROYED', 'press R to restart', 'lose');
    else if (obj.state === 'lost') this.showBanner('CORE LOST', 'press R to restart', 'lose');
    else this.banner.style.display = 'none';

    const c = game.salvage.alive ? game.salvage.body.worldCom() : null;
    const z = obj.zone;
    this.placeMarker(this.markers[0], c, stage);
    this.placeMarker(this.markers[1], { x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2 }, stage);
  }

  private showBanner(title: string, sub: string, cls: string): void {
    this.banner.style.display = 'block';
    this.banner.className = `hud-banner ${cls}`;
    this.banner.innerHTML = `<div class="title">${title}</div><div class="sub">${sub}</div>`;
  }

  /** Shows an edge arrow when the target is off-screen, hidden otherwise. */
  private placeMarker(m: { el: HTMLDivElement; label: string }, p: { x: number; y: number } | null, stage: Stage): void {
    if (!p) {
      m.el.style.display = 'none';
      return;
    }
    stage.worldToScreen(p.x, p.y, tmp);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const pad = 40;
    const onScreen = tmp.x > pad && tmp.x < W - pad && tmp.y > pad && tmp.y < H - pad;
    if (onScreen) {
      m.el.style.display = 'none';
      return;
    }
    const cx = W / 2;
    const cy = H / 2;
    const dx = tmp.x - cx;
    const dy = tmp.y - cy;
    const s = Math.min((W / 2 - pad) / Math.abs(dx || 1e-6), (H / 2 - pad) / Math.abs(dy || 1e-6));
    m.el.style.display = 'block';
    m.el.style.left = `${cx + dx * s}px`;
    m.el.style.top = `${cy + dy * s}px`;
    m.el.innerHTML = `<i style="transform: rotate(${Math.atan2(dy, dx)}rad)"></i>${m.label}`;
  }
}
