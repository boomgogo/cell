// Procedural sound effects: WebAudio oscillators and one generated noise buffer, no audio
// files. Loaded lazily on the first Play.
// All tunes are our own; every call is a no-op when audio is unavailable or muted.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  private lastChomp = 0;
  private chompHigh = false;
  private loop: OscillatorNode | null = null;
  private noise: AudioBuffer | null = null;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  /** Must be called from a user gesture (autoplay policy). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.25;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.25, this.ctx.currentTime, 0.02);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.5, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  chomp(): void {
    const now = performance.now();
    if (now - this.lastChomp < 110) return;
    this.lastChomp = now;
    this.chompHigh = !this.chompHigh;
    if (this.chompHigh) this.tone('triangle', 520, 260, 0.08, 0.35);
    else this.tone('triangle', 300, 520, 0.08, 0.35);
  }

  /**
   * Rainbow loop: a rising arpeggio on one oscillator for `seconds`, replacing any running loop. The last
   * 2 s speed up with the visual flicker.
   */
  rainbow(seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    this.stopRainbow();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    gain.gain.value = 0.07;
    osc.connect(gain);
    gain.connect(this.master);
    const t0 = ctx.currentTime;
    const notes = [523, 659, 784, 988, 1175, 988, 784, 659];
    let t = 0;
    for (let k = 0; t < seconds; k++) {
      osc.frequency.setValueAtTime(notes[k % notes.length] * (t > seconds - 2 ? 1.5 : 1), t0 + t);
      t += t > seconds - 2 ? 0.06 : 0.1;
    }
    osc.start(t0);
    osc.stop(t0 + seconds);
    this.loop = osc;
  }

  stopRainbow(): void {
    if (!this.loop) return;
    try {
      this.loop.stop();
    } catch {
      /* already stopped */
    }
    this.loop = null;
  }

  /** Explosion: a noise burst through a falling low-pass plus a low thump; pitch rises along a chain. */
  boom(k: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.5);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const up = 1 + 0.15 * Math.min(k, 8);
    filter.frequency.setValueAtTime(3000 * up, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.5);
    this.tone('sine', 140 * up, 40, 0.3, 0.5);
  }

  death(): void {
    this.stopRainbow();
    this.tone('sawtooth', 700, 60, 0.9, 0.3);
  }

  home(): void {
    [440, 554, 659].forEach((f, i) => this.tone('triangle', f, f, 0.14, 0.3, i * 0.1));
  }

  lap(): void {
    [392, 494, 587, 784, 988].forEach((f, i) => this.tone('square', f, f, 0.14, 0.22, i * 0.11));
  }

  hurt(): void {
    this.tone('square', 300, 120, 0.2, 0.25);
  }

  /** A packed cell swells back, a soft rising pop. */
  unpack(): void {
    this.tone('sine', 240, 720, 0.14, 0.35);
    this.tone('triangle', 480, 1200, 0.1, 0.18, 0.06);
  }
}
