// Procedural WebAudio: no sample files. Everything is oscillators, a noise buffer and filters.
// Long-lived (survives restarts), like the renderer.
//
// Three buses, matching how sound reaches you in a vacuum:
//   self:    your own ship (thrusters, jets, tools, servos, the hum of its power). Heard through
//            your own frame: close, a bit muffled, with a short metallic ring. It brightens in
//            atmosphere (setAir).
//   conduct: sound traveling through structure you touch (hull, a held body, a taut tether).
//            Lowpassed thumps with a long, resonant hull ring and no crisp highs.
//   air:     ordinary airborne sound, only where there is atmosphere. Full range.
// The Soundscape decides which buses an event reaches and how loud; this class only synthesizes.
//
// The AudioContext starts on the first real key or mouse press (browser autoplay rules).

import { tune } from '../config';

export type Bus = 'self' | 'conduct' | 'air';

/** A continuous voice (engine, jets, wind) whose level and pitch are set every frame. */
export interface Loop {
  set(gain: number, pitch?: number): void;
}

interface LoopVoice extends Loop {
  gain: GainNode;
}

const PLATE = [1, 2.76, 5.4, 8.93, 13.34]; // inharmonic modes of a struck plate
const PLATE_AMP = [1, 0.6, 0.38, 0.22, 0.12];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private selfLp!: BiquadFilterNode;
  private readonly bus = {} as Record<Bus, GainNode>;
  private noise!: AudioBuffer;
  private voices = 0;
  private readonly maxVoices = 28;
  private readonly loops: LoopVoice[] = [];
  /** One-shots played per bus (tests and the debug HUD). */
  readonly played: Record<Bus, number> = { self: 0, conduct: 0, air: 0 };

  constructor() {
    const unlock = () => this.start();
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    // headless tests launch with autoplay allowed; start right away there
    if (new URLSearchParams(location.search).has('autotest')) this.start();
  }

  /** True once the context exists (it may still be suspended until a gesture). */
  get ready(): boolean {
    return !!this.ctx;
  }
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return; // no audio device: the game runs silent
    }
    this.ctx = ctx;
    void ctx.resume();
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);

    // self: muffled, short ring of the ship's own frame
    this.bus.self = ctx.createGain();
    this.selfLp = ctx.createBiquadFilter();
    this.selfLp.type = 'lowpass';
    this.selfLp.frequency.value = 2400;
    this.bus.self.connect(this.selfLp).connect(this.master);
    this.reverb(this.selfLp, this.hullIR(0.35, [520, 870, 1340]), 0.22);

    // conduct: low, resonant, long hull ring
    this.bus.conduct = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 190;
    peak.gain.value = 6;
    this.bus.conduct.connect(lp).connect(peak).connect(this.master);
    this.reverb(peak, this.hullIR(2.2, [96, 151, 233, 347, 512]), 0.55);

    // air: plain
    this.bus.air = ctx.createGain();
    this.bus.air.connect(this.master);
    this.buildLoops();
  }

  /** Wet send from `src` through a convolver into the master. */
  private reverb(src: AudioNode, ir: AudioBuffer, wet: number): void {
    const ctx = this.ctx!;
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const g = ctx.createGain();
    g.gain.value = wet;
    src.connect(conv).connect(g).connect(this.master);
  }

  /** Synthetic metal-structure impulse response: decaying noise plus ringing modes. */
  private hullIR(seconds: number, modes: number[]): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const ph = modes.map(() => Math.random() * Math.PI * 2);
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        let v = (Math.random() * 2 - 1) * Math.exp(-t / (seconds * 0.18)) * 0.6;
        for (let k = 0; k < modes.length; k++) v += Math.sin(2 * Math.PI * modes[k] * (1 + ch * 0.003) * t + ph[k]) * Math.exp(-t / (seconds * (0.45 - k * 0.05))) * 0.12;
        d[i] = v;
      }
    }
    return buf;
  }

  private noiseSource(loop: boolean): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    if (loop) s.loopStart = Math.random();
    return s;
  }

  // ---------------------------------------------------------------- continuous voices

  /** Ship power hum, main thruster, RCS hiss, cutter, cutter sizzle, winch, arm servos, wind, room tone. */
  hum!: Loop;
  thrust!: Loop;
  rcs!: Loop;
  cutter!: Loop;
  sizzle!: Loop;
  winch!: Loop;
  servo!: Loop;
  wind!: Loop;
  room!: Loop;

  private buildLoops(): void {
    const ctx = this.ctx!;
    const out = (bus: Bus) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.bus[bus]);
      return g;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const voice = (gain: GainNode, pitch?: (p: number, t: number) => void): LoopVoice => {
      const v: LoopVoice = {
        gain,
        set: (g, p) => {
          const t = ctx.currentTime;
          gain.gain.setTargetAtTime(Math.max(0, g), t, 0.04);
          if (pitch && p !== undefined) pitch(p, t);
        },
      };
      this.loops.push(v);
      return v;
    };

    // hum: a low saw through a lowpass, a sine an octave up, and a faint electrical whine
    {
      const g = out('self');
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = 46;
      const lp = filter('lowpass', 260);
      const sine = ctx.createOscillator();
      sine.frequency.value = 92;
      const sg = ctx.createGain();
      sg.gain.value = 0.6;
      const whine = ctx.createOscillator();
      whine.frequency.value = 2900;
      const wg = ctx.createGain();
      wg.gain.value = 0.015;
      saw.connect(lp).connect(g);
      sine.connect(sg).connect(g);
      whine.connect(wg).connect(g);
      for (const o of [saw, sine, whine]) o.start();
      this.hum = voice(g, (p, t) => {
        saw.frequency.setTargetAtTime(46 * p, t, 0.15);
        sine.frequency.setTargetAtTime(92 * p, t, 0.15);
        whine.frequency.setTargetAtTime(2900 * p, t, 0.15);
      });
    }
    // main thruster: deep filtered roar
    {
      const g = out('self');
      const n = this.noiseSource(true);
      const lp = filter('lowpass', 380);
      const bp = filter('bandpass', 110, 0.8);
      const bg = ctx.createGain();
      bg.gain.value = 1.4;
      n.connect(lp).connect(g);
      n.connect(bp).connect(bg).connect(g);
      n.start();
      this.thrust = voice(g, (p, t) => lp.frequency.setTargetAtTime(380 * p, t, 0.08));
    }
    // RCS jets: hiss
    {
      const g = out('self');
      const n = this.noiseSource(true);
      const bp = filter('bandpass', 2600, 1.1);
      n.connect(bp).connect(g);
      n.start();
      this.rcs = voice(g);
    }
    // cutter: buzzing saw with vibrato
    {
      const g = out('self');
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 210;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 31;
      const lg = ctx.createGain();
      lg.gain.value = 9;
      lfo.connect(lg).connect(o.frequency);
      const bp = filter('bandpass', 900, 0.9);
      o.connect(bp).connect(g);
      o.start();
      lfo.start();
      this.cutter = voice(g, (p, t) => o.frequency.setTargetAtTime(210 * p, t, 0.05));
    }
    // cutter sizzle: metal boiling off where the beam lands (felt through the ship as crackle)
    {
      const g = out('self');
      const n = this.noiseSource(true);
      const hp = filter('highpass', 3200, 0.7);
      n.connect(hp).connect(g);
      n.start();
      this.sizzle = voice(g);
    }
    // winch: geared whine, pitch with line speed
    {
      const g = out('self');
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 120;
      const lp = filter('lowpass', 900);
      o.connect(lp).connect(g);
      o.start();
      this.winch = voice(g, (p, t) => o.frequency.setTargetAtTime(p, t, 0.05));
    }
    // arm servos: small motors
    {
      const g = out('self');
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 260;
      const bp = filter('bandpass', 700, 2);
      o.connect(bp).connect(g);
      o.start();
      this.servo = voice(g, (p, t) => o.frequency.setTargetAtTime(p, t, 0.05));
    }
    // wind: air rushing past the hull
    {
      const g = out('air');
      const n = this.noiseSource(true);
      const bp = filter('bandpass', 400, 0.6);
      n.connect(bp).connect(g);
      n.start();
      this.wind = voice(g, (p, t) => bp.frequency.setTargetAtTime(p, t, 0.1));
    }
    // room tone: the low hiss of being somewhere with air
    {
      const g = out('air');
      const n = this.noiseSource(true);
      const lp = filter('lowpass', 220);
      n.connect(lp).connect(g);
      n.start();
      this.room = voice(g);
    }
  }

  /** Per frame: master volume, and how airborne the ship's own sound is (0 vacuum .. 1). */
  update(air: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(tune.audio.muted ? 0 : tune.audio.volume, t, 0.05);
    this.selfLp.frequency.setTargetAtTime(2400 + 7000 * Math.min(1, air), t, 0.2);
  }

  /** Silences all continuous voices (death, restart). */
  quiet(): void {
    for (const l of this.loops) l.set(0);
  }

  // ---------------------------------------------------------------- one-shots

  private oneShot(bus: Bus, gain: number, pan: number, seconds: number): { out: GainNode; t: number } | null {
    const ctx = this.ctx;
    if (!ctx || gain < 0.003 || this.voices >= this.maxVoices) return null;
    this.played[bus]++;
    const out = ctx.createGain();
    out.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(p).connect(this.bus[bus]);
    this.voices++;
    window.setTimeout(() => {
      this.voices--;
      p.disconnect();
    }, (seconds + 0.2) * 1000);
    return { out, t: ctx.currentTime };
  }

  /** A struck metal plate: inharmonic partials plus a short noise transient. */
  metal(bus: Bus, gain: number, freq: number, decay: number, pan = 0, bright = 1): void {
    const s = this.oneShot(bus, gain, pan, decay);
    if (!s) return;
    const ctx = this.ctx!;
    for (let i = 0; i < PLATE.length; i++) {
      const o = ctx.createOscillator();
      o.frequency.value = freq * PLATE[i] * (1 + (Math.random() - 0.5) * 0.03);
      const g = ctx.createGain();
      const a = PLATE_AMP[i] * Math.pow(bright, i) * 0.5;
      g.gain.setValueAtTime(a, s.t);
      g.gain.exponentialRampToValueAtTime(1e-4, s.t + decay / (1 + i * 0.7));
      o.connect(g).connect(s.out);
      o.start(s.t);
      o.stop(s.t + decay);
    }
    this.burst(s.out, s.t, freq * 3, 0.03, 0.8);
  }

  /** A dull body thump: a falling sine and a lowpassed noise puff. */
  thump(bus: Bus, gain: number, pan = 0): void {
    const s = this.oneShot(bus, gain, pan, 0.4);
    if (!s) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(95, s.t);
    o.frequency.exponentialRampToValueAtTime(38, s.t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, s.t);
    g.gain.exponentialRampToValueAtTime(1e-4, s.t + 0.3);
    o.connect(g).connect(s.out);
    o.start(s.t);
    o.stop(s.t + 0.32);
    this.burst(s.out, s.t, 300, 0.08, 0.6, 'lowpass');
  }

  /** Explosion: a long falling roar and a sub drop. */
  boom(bus: Bus, gain: number, pan = 0): void {
    const s = this.oneShot(bus, gain, pan, 2.2);
    if (!s) return;
    const ctx = this.ctx!;
    const n = this.noiseSource(false);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(bus === 'air' ? 3000 : 700, s.t);
    lp.frequency.exponentialRampToValueAtTime(60, s.t + 1.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, s.t);
    g.gain.exponentialRampToValueAtTime(1e-4, s.t + 2);
    n.connect(lp).connect(g).connect(s.out);
    n.start(s.t);
    n.stop(s.t + 2.1);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, s.t);
    o.frequency.exponentialRampToValueAtTime(28, s.t + 1.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.9, s.t);
    og.gain.exponentialRampToValueAtTime(1e-4, s.t + 1.4);
    o.connect(og).connect(s.out);
    o.start(s.t);
    o.stop(s.t + 1.5);
  }

  /** A relay click (lamp, clamps locking). */
  click(bus: Bus, gain: number, pan = 0): void {
    const s = this.oneShot(bus, gain, pan, 0.05);
    if (!s) return;
    this.burst(s.out, s.t, 4000, 0.012, 1, 'highpass');
  }

  /** A swept noise zip (harpoon cord paying out, a gust). */
  zip(bus: Bus, gain: number, from: number, to: number, seconds: number, pan = 0): void {
    const s = this.oneShot(bus, gain, pan, seconds);
    if (!s) return;
    const ctx = this.ctx!;
    const n = this.noiseSource(false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(from, s.t);
    bp.frequency.exponentialRampToValueAtTime(to, s.t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, s.t);
    g.gain.exponentialRampToValueAtTime(1e-4, s.t + seconds);
    n.connect(bp).connect(g).connect(s.out);
    n.start(s.t);
    n.stop(s.t + seconds + 0.05);
  }

  private burst(dest: AudioNode, t: number, freq: number, seconds: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx!;
    const n = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + seconds);
    n.connect(f).connect(g).connect(dest);
    n.start(t);
    n.stop(t + seconds + 0.02);
  }
}
