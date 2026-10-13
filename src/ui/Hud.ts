// DOM HUD: objective, health, velocity, tool status, off-screen markers and banners.
// Reads game state each frame; never mutates it.

import { tune } from '../config';
import type { Game } from '../game/Game';
import type { Stage } from '../render/Stage';
import { hintFor } from './hints';

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
  private readonly shieldFill: HTMLDivElement;
  private readonly heatFill: HTMLDivElement;
  private readonly heatWrap: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly tools: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly alertEl: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly velArrow: HTMLDivElement;
  private readonly markers: { el: HTMLDivElement; label: string }[];
  private readonly hint: HTMLDivElement;
  private readonly legend: HTMLDivElement;
  private live = -1;
  private toastUntil = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.objective = el('div', 'hud-objective', this.root);
    const health = el('div', 'hud-health', this.root, '<span>HULL</span>');
    this.healthFill = el('div', 'hud-health-fill', el('div', 'hud-health-bar', health));
    const shield = el('div', 'hud-health hud-shield', this.root, '<span>SHLD</span>');
    this.shieldFill = el('div', 'hud-health-fill', el('div', 'hud-health-bar', shield));
    this.heatWrap = el('div', 'hud-heat', this.root, '<span>LASER HEAT</span>');
    this.heatFill = el('div', 'hud-heat-fill', el('div', 'hud-heat-bar', this.heatWrap));
    this.stats = el('div', 'hud-stats', this.root);
    const vel = el('div', 'hud-vel', this.root);
    this.velArrow = el('div', 'hud-vel-arrow', vel);
    this.tools = el('div', 'hud-tools', this.root);
    this.banner = el('div', 'hud-banner', this.root);
    this.alertEl = el('div', 'hud-alert', this.root);
    this.help = el(
      'div',
      'hud-help',
      this.root,
      `<b>Mouse</b> aim (the ship turns to face it) · <b>Space</b> thrust · <b>F</b> lamp (sensors see it)<br>
       <b>V</b> knock: vibration scan of what you touch (walking scans too) · <b>LMB</b> cutter (heats until it burns; hot metal pressed together welds) · <b>RMB</b> harpoon · click again: let go · hold: winch in &amp; clamp on contact<br>
       <b>E</b> let go of what the arms hold · clamp to hull / let go · drift slowly into debris: the arms catch it · <b>A/D</b> walk · <b>Space</b> push off · <b>Q</b> pay out tether · <b>M</b> mute · 
<b>P</b> rope pivot COM/nose · <b>Wheel</b> zoom · <b>R</b> restart · <b>H</b> hide help · <b>\`</b> debug panel`,
    );
    this.hint = el('div', 'hud-hint', this.root);
    this.legend = el(
      'div',
      'hud-legend',
      this.root,
      `<b>SCAN</b><span><i class="lg-core"></i>power core</span><span><i class="lg-live"></i>live line</span><span><i class="lg-dead"></i>dead line</span><span><i class="lg-sock"></i>socket (dotted: dead)</span><span><i class="lg-tough"></i>tough: cuts only white-hot</span><span><i class="lg-cav"></i>surface / hidden cavity</span>`,
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
    this.shieldFill.style.width = `${(game.ship.shield / tune.ship.shieldMax) * 100}%`;
    this.shieldFill.style.background = '#6fd8ff';
    const cut = game.cutter;
    this.heatFill.style.width = `${cut.heat * 100}%`;
    this.heatFill.style.background = cut.overheated ? '#ff5a4d' : cut.heat > 0.7 ? '#ffb24d' : '#ffd88a';
    this.heatWrap.classList.toggle('overheated', cut.overheated);

    const v = game.ship.body.linvel();
    const speed = Math.hypot(v.x, v.y);
    const mass = game.ship.body.mass() + (game.grapple.targetObject?.kind === 'pixelBody' ? (game.grapple.targetObject as unknown as { body: { mass(): number } }).body.mass() : 0);
    this.stats.innerHTML = `${speed.toFixed(1)} m/s<br><small>${Math.round(mass)} kg ${game.grapple.attached ? '(towing)' : ''}</small><br><small>lamp ${game.ship.lampOn ? 'on' : 'OFF · dark'} [F]</small><br><small>arms ${game.arms.status()}${tune.audio.muted ? ' · muted [M]' : ''}</small>`;
    const ang = Math.atan2(v.y, v.x);
    this.velArrow.style.transform = `rotate(${-ang}rad) scaleX(${Math.min(1, speed / 15)})`;
    this.velArrow.style.opacity = speed > 0.2 ? '1' : '0.2';

    this.tools.innerHTML =
      game.slots.map((s, i) => `<div><b>${i === 0 ? 'LMB' : 'RMB'}</b> ${s.name} <span>${s.status()}</span></div>`).join('');

    if (obj.state === 'complete') this.showBanner('SALVAGE EXTRACTED', `${obj.completedAt.toFixed(1)} s — press R to run it again`, 'win');
    else if (!game.ship.alive) this.showBanner(game.ship.deathCause === 'crushed' ? 'CRUSHED' : 'SHIP DESTROYED', 'press R to restart', 'lose');
    else if (obj.state === 'lost') this.showBanner('CORE LOST', 'press R to restart', 'lose');
    else this.banner.style.display = 'none';

    // what the thing in front of you is for; a power-restored notice beats it for a moment
    const live = game.power.live;
    if (this.live >= 0 && live > this.live) this.toastUntil = game.time + 3;
    this.live = live;
    const toast = game.time < this.toastUntil;
    const hint = toast ? 'POWER RESTORED: lights, doors and pumps on that line are running' : hintFor(game);
    this.hint.style.display = hint ? 'block' : 'none';
    this.hint.classList.toggle('toast', toast);
    if (this.hint.innerHTML !== hint) this.hint.innerHTML = hint;
    this.legend.style.display = game.scanner.showing ? 'flex' : 'none';

    // security: alarm countdown, or a "watched" meter while a bot is getting suspicious
    const sec = game.security;
    if (sec.alert) {
      this.alertEl.style.display = 'block';
      this.alertEl.className = 'hud-alert alarm';
      this.alertEl.textContent = `ALERT · ${Math.ceil(sec.alertTimer)}s`;
    } else if (sec.suspicion > 0.02) {
      this.alertEl.style.display = 'block';
      this.alertEl.className = 'hud-alert watched';
      this.alertEl.innerHTML = `WATCHED <i style="width:${Math.round(sec.suspicion * 100)}%"></i>`;
    } else this.alertEl.style.display = 'none';

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
