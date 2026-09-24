// Adaptive quality: watch rolling p95 frame time, step quality down when over budget and back
// up after sustained headroom. Order: DPR → membrane points + fewer effects → contact dents + wall dents → jelly off and
// minimal effects → grid off. Effects: shockwaves and explosion pieces always draw. Paper grain
// goes first: a phone just over budget should lose the texture before it loses resolution.
import type { BackgroundPattern } from './canvas/background.ts';
import type { RenderOptions } from './canvas/renderer.ts';

interface Level {
  dprCap: number;
  pointScale: number;
  contactDents: boolean;
  membranes: boolean;
  grid: boolean;
  /** RenderOptions.fx: 0 everything, 1 half the sparks and no trail, 2 minimal. */
  fx: number;
  grain: boolean;
}

const LEVELS: Level[] = [
  { dprCap: 2, pointScale: 1, contactDents: true, membranes: true, grid: true, fx: 0, grain: true },
  { dprCap: 2, pointScale: 1, contactDents: true, membranes: true, grid: true, fx: 0, grain: false },
  { dprCap: 1.5, pointScale: 1, contactDents: true, membranes: true, grid: true, fx: 0, grain: false },
  { dprCap: 1, pointScale: 0.6, contactDents: true, membranes: true, grid: true, fx: 1, grain: false },
  { dprCap: 1, pointScale: 0.4, contactDents: false, membranes: true, grid: true, fx: 1, grain: false },
  { dprCap: 1, pointScale: 0.4, contactDents: false, membranes: false, grid: true, fx: 2, grain: false },
  { dprCap: 1, pointScale: 0.4, contactDents: false, membranes: false, grid: false, fx: 2, grain: false },
];

export const QUALITY_LEVELS = LEVELS.length;

export class QualityController {
  level = 0;
  enabled = true;
  private readonly samples = new Float32Array(120);
  private n = 0;
  private windowMs = 0;
  private headroomChecks = 0;
  private readonly pattern: BackgroundPattern;
  private readonly budgetMs: number;

  constructor(opts: RenderOptions, budgetMs = 22) {
    this.pattern = opts.pattern;
    this.budgetMs = budgetMs;
  }

  /** Records a frame; returns true when the level changed (caller re-applies and resizes). */
  record(frameMs: number, opts: RenderOptions): boolean {
    if (!this.enabled) return false;
    this.samples[this.n++] = frameMs;
    this.windowMs += frameMs;
    // Decide every 120 frames or every 1.5 s, whichever comes first (slow devices must react quickly).
    if (this.n < this.samples.length && (this.windowMs < 1500 || this.n < 8)) return false;
    const sorted = Array.from(this.samples.subarray(0, this.n)).sort((a, b) => a - b);
    this.n = 0;
    this.windowMs = 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    let changed = false;
    if (p95 > this.budgetMs && this.level < LEVELS.length - 1) {
      this.level++;
      this.headroomChecks = 0;
      changed = true;
    } else if (p95 < 14 && this.level > 0) {
      if (++this.headroomChecks >= 3) {
        this.level--;
        this.headroomChecks = 0;
        changed = true;
      }
    } else {
      this.headroomChecks = 0;
    }
    if (changed) this.apply(opts);
    return changed;
  }

  apply(opts: RenderOptions): void {
    const l = LEVELS[this.level];
    opts.dprCap = l.dprCap;
    opts.pointScale = l.pointScale;
    opts.contactDents = l.contactDents;
    opts.wallDents = l.contactDents;
    opts.membranes = l.membranes;
    opts.pattern = l.grid ? this.pattern : 'none';
    opts.fx = l.fx;
    opts.grain = l.grain;
  }
}
