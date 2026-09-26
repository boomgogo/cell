// Adaptive quality: watch frame times, step quality down when the device is really over budget and back
// up after sustained headroom. Order: DPR → membrane points + fewer effects → contact dents + wall dents → jelly off and
// minimal effects → grid off. Effects: shockwaves and explosion pieces always draw. Paper grain
// goes first: a phone just over budget should lose the texture before it loses resolution.
//
// It judges load, not vsync: a 60 Hz display that misses the odd vsync has a p95 frame interval of ~24 ms while the
// frame's own work is a few ms, and stepping down there helps nothing. A step down needs a slow interval p95 *and* either
// a slow median interval (the whole frame rate is low: GPU or CPU bound) or work that fills most of a display interval.
// Stepping down is quick (one window per step: an overloaded device must recover fast); stepping back up needs three
// windows of headroom, and after a down → up → down flip-flop it only goes down from then on.
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

/** Frame interval p95 above this (ms) can step quality down. */
const BUDGET_MS = 22;
/** Median interval above this (ms, below ~50 fps) means the whole frame rate is low. */
const SLOW_MEDIAN_MS = 20;
/** Work p95 above this share of the median interval means the frame's own work is the problem. */
const BUSY_SHARE = 0.6;
/** Stepping back up needs a vsync-bound median (≤ this, ms) and work p95 under this share of it. */
const FAST_MEDIAN_MS = 17.5;
const IDLE_SHARE = 0.35;
/** Windows with headroom before stepping up. */
const HEADROOM_CHECKS = 3;
/** Ignore the first frames (startup: maze generation, JIT, first layer draws). */
const WARMUP_MS = 2000;
/** After a flip-flop, only a really slow interval p95 (ms) steps down. */
const LOCKED_BUDGET_MS = 33;

export interface QualityEvent {
  /** Frame-time clock (sum of recorded intervals, ms). */
  t: number;
  from: number;
  to: number;
  dtP50: number;
  dtP95: number;
  workP95: number;
}

export class QualityController {
  level = 0;
  enabled = true;
  /** After a down → up → down flip-flop the level never goes back up. */
  locked = false;
  /** Level changes, newest last (at most 20), for the debug panel and tests. */
  readonly events: QualityEvent[] = [];
  private readonly dts = new Float32Array(120);
  private readonly works = new Float32Array(120);
  private n = 0;
  private windowMs = 0;
  private clock = 0;
  private headroomChecks = 0;
  /** Direction of the last two changes (+1 down in quality, -1 up), for flip-flop detection. */
  private lastDir = 0;
  private flips = 0;
  private readonly pattern: BackgroundPattern;

  constructor(opts: RenderOptions) {
    this.pattern = opts.pattern;
  }

  /**
   * Records a frame: `dtMs` is the interval since the previous frame, `workMs` the frame's own CPU time. Returns true
   * when the level changed (options are already applied; the caller resizes before the next render).
   */
  record(dtMs: number, workMs: number, opts: RenderOptions): boolean {
    if (!this.enabled) return false;
    this.clock += dtMs;
    if (this.clock < WARMUP_MS) {
      this.n = 0;
      this.windowMs = 0;
      return false;
    }
    this.dts[this.n] = dtMs;
    this.works[this.n] = workMs;
    this.n++;
    this.windowMs += dtMs;
    // Decide every 120 frames or every 1.5 s, whichever comes first (slow devices must react quickly).
    if (this.n < this.dts.length && (this.windowMs < 1500 || this.n < 8)) return false;
    const dtSorted = Array.from(this.dts.subarray(0, this.n)).sort((a, b) => a - b);
    const workSorted = Array.from(this.works.subarray(0, this.n)).sort((a, b) => a - b);
    this.n = 0;
    this.windowMs = 0;
    const dtP50 = dtSorted[Math.floor(dtSorted.length * 0.5)];
    const dtP95 = dtSorted[Math.floor(dtSorted.length * 0.95)];
    const workP95 = workSorted[Math.floor(workSorted.length * 0.95)];

    let dir = 0;
    const overloaded = this.locked
      ? dtP95 > LOCKED_BUDGET_MS && dtP50 > SLOW_MEDIAN_MS
      : dtP95 > BUDGET_MS && (dtP50 > SLOW_MEDIAN_MS || workP95 > BUSY_SHARE * dtP50);
    if (overloaded && this.level < LEVELS.length - 1) {
      dir = 1;
      this.headroomChecks = 0;
    } else if (!this.locked && this.level > 0 && dtP50 <= FAST_MEDIAN_MS && workP95 < IDLE_SHARE * dtP50) {
      if (++this.headroomChecks >= HEADROOM_CHECKS) {
        dir = -1;
        this.headroomChecks = 0;
      }
    } else {
      this.headroomChecks = 0;
    }
    if (dir === 0) return false;

    const from = this.level;
    this.level += dir;
    if (this.lastDir !== 0 && dir !== this.lastDir) {
      if (++this.flips >= 2 && dir > 0) this.locked = true;
    }
    this.lastDir = dir;
    this.events.push({ t: this.clock, from, to: this.level, dtP50, dtP95, workP95 });
    if (this.events.length > 20) this.events.shift();
    this.apply(opts);
    return true;
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
