// Raw keyboard/mouse state. Edge-triggered presses are latched until consumed so they are
// never lost between render frames and fixed physics steps.

export class Input {
  private readonly held = new Set<string>();
  private readonly hits = new Set<string>();
  mouseX = window.innerWidth / 2;
  mouseY = window.innerHeight / 2;
  wheel = 0;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
      this.held.add(e.code);
      this.hits.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    target.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    target.addEventListener('mousedown', (e) => {
      const code = `Mouse${e.button}`;
      this.held.add(code);
      this.hits.add(code);
    });
    window.addEventListener('mouseup', (e) => this.held.delete(`Mouse${e.button}`));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  down(code: string): boolean {
    return this.held.has(code);
  }

  /** True once per physical press (consumes the press). */
  hit(code: string): boolean {
    return this.hits.delete(code);
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Test hooks (used by the scripted smoke runs). */
  simulateDown(code: string): void {
    this.held.add(code);
    this.hits.add(code);
  }
  simulateUp(code: string): void {
    this.held.delete(code);
  }
}
