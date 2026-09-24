// Home cues: the spawn point of the current life, "home again" / "around the world" detection,
// and a breadcrumb trail. Game layer only; the sim doesn't know about any of this.
import { type Vec3, angle, copy, vec3 } from '../sphere/vec3.ts';

export type HomeEvent = 'home' | 'lap' | null;

export class HomeTracker {
  readonly home: Vec3 = vec3();
  active = false;
  laps = 0;
  returns = 0;
  /** Farthest distance from home since the last return. */
  maxAway = 0;
  private armed = false;
  readonly R: number;
  /** Leave at least this far, then come back within `near`, to count as home again. */
  readonly far: number;
  readonly near: number;

  constructor(R: number, far = 8000, near = 600) {
    this.R = R;
    this.far = far;
    this.near = near;
  }

  reset(p: Vec3): void {
    copy(this.home, p);
    this.active = true;
    this.armed = false;
    this.maxAway = 0;
  }

  /** Distance from p to home (world units). */
  distance(p: Vec3): number {
    return this.R * angle(p, this.home);
  }

  update(p: Vec3): HomeEvent {
    if (!this.active) return null;
    const d = this.distance(p);
    if (d > this.maxAway) this.maxAway = d;
    if (d > this.far) this.armed = true;
    if (!this.armed || d > this.near) return null;
    this.armed = false;
    const lap = this.maxAway > 0.9 * Math.PI * this.R;
    this.maxAway = 0;
    if (lap) {
      this.laps++;
      return 'lap';
    }
    this.returns++;
    return 'home';
  }
}

/** Breadcrumbs every `spacing` units, at most `max` (oldest dropped), as (x, y, z) triples. */
export class Trail {
  readonly points: Float64Array;
  count = 0;
  private readonly max: number;
  private readonly spacing: number;
  private readonly R: number;

  constructor(R: number, max = 1000, spacing = 150) {
    this.R = R;
    this.max = max;
    this.spacing = spacing;
    this.points = new Float64Array(max * 3);
  }

  clear(): void {
    this.count = 0;
  }

  add(p: Vec3): void {
    const pts = this.points;
    if (this.count > 0) {
      const k = (this.count - 1) * 3;
      const d = this.R * angle(p, { x: pts[k], y: pts[k + 1], z: pts[k + 2] });
      if (d < this.spacing) return;
    }
    if (this.count === this.max) {
      const drop = Math.round(this.max / 10);
      pts.copyWithin(0, drop * 3, this.count * 3);
      this.count -= drop;
    }
    const k = this.count * 3;
    pts[k] = p.x;
    pts[k + 1] = p.y;
    pts[k + 2] = p.z;
    this.count++;
  }
}
