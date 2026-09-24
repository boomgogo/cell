// Jelly membrane: each drawn cell's outline is a closed ring of n boundary points at even angles, each holding a
// radius (world units) and a radial velocity. The ring is a damped, noise-driven wave. With u = rad − R (R the
// cell's true radius) every point feels
//   a_i = TENSION·(u_{i−1} − 2u_i + u_{i+1}) − PULL·u_i − DAMP·v_i + NOISE·(rand() − ½)
// and is integrated with semi-implicit Euler (v += a, then u += v) at a fixed 60 Hz step, so the wobble does not
// depend on the frame rate. Tension carries bumps along the rim and irons out single-point jaggies, the pull
// brings the rim back to R, the damping sets how long a bump rings, and the noise keeps the surface alive.
// Every constant is per step and per point, and the noise is in world units, so ripples are about ten points
// long and a world unit or so high whatever the cell's size or point count. When R itself changes the whole
// ring moves with it, so the outline never lags the cell's size. Touching cells dent each other: a point is
// pushed in where it meets the other rim, the push fading out a few units either side and never pressing
// deeper than a shallow cap, so a cell deep inside another is left alone rather than flattened, and the dent
// springs back in a quick gulp when they part. Viruses are never dented. Maze walls squash the rim last.

export class Membrane {
  n = 0;
  rad = new Float32Array(0);
  vel = new Float32Array(0);
  /** True when the cell was drawn as a plain circle last frame (radii are reset when it switches back). */
  simple = true;
  /** True radius the ring was last stepped around (world units); the ring moves with it when it changes. */
  base = 0;

  ensure(n: number, r: number): void {
    if (n === this.n) return;
    const rad = new Float32Array(n);
    const vel = new Float32Array(n);
    if (this.n === 0) {
      rad.fill(r);
      this.base = r;
    } else {
      for (let i = 0; i < n; i++) {
        const j = Math.floor((i * this.n) / n);
        rad[i] = this.rad[j];
        vel[i] = this.vel[j];
      }
    }
    this.rad = rad;
    this.vel = vel;
    this.n = n;
  }

  reset(r: number): void {
    this.rad.fill(r);
    this.vel.fill(0);
    this.base = r;
  }

  /** Radius of the boundary in local direction `a` (radians), given this membrane's roll (linear between points). */
  radiusAt(a: number, roll: number): number {
    const n = this.n;
    if (n === 0) return 0;
    let t = (a - roll) / TWO_PI;
    t -= Math.floor(t);
    const x = t * n;
    const i = Math.floor(x) % n;
    const j = i + 1 === n ? 0 : i + 1;
    const rad = this.rad;
    return rad[i] + (rad[j] - rad[i]) * (x - Math.floor(x));
  }
}

export interface MembraneBody {
  membrane: Membrane;
  /** Camera-local centre, world units. */
  lx: number;
  ly: number;
  /** True (target) radius, world units. */
  r: number;
  roll: number;
  agitated: boolean;
  spiky: boolean;
  contacts: MembraneBody[];
  /** Wall half-planes in camera-local units, (nx, ny, d) triples: points may not go further than d along n. */
  walls: Float32Array;
  wallCount: number;
}

const TWO_PI = Math.PI * 2;

// Wave constants, per 60 Hz step. Lengths are world units; neighbours are one point apart whatever the spacing.
/** Neighbour coupling: how fast a bump spreads along the rim (the explicit step is stable up to ~0.9). */
const TENSION = 0.1;
/** Spring back to the true radius; agitated cells get a weaker one (longer, lazier swells). */
const PULL = 0.005;
const PULL_AGITATED = 0.0045;
/** Velocity damping: a lone bump settles in about half a second without ringing. */
const DAMP = 0.14;
/** Peak-to-peak random kick per point per step (world units per step²). */
const NOISE = 0.25;
const NOISE_AGITATED = 0.88;
/** Outline travel allowed around the true radius, as fractions of R. */
const MIN_U = -0.75;
const MAX_U = 0.3;

// Contact dents.
/** Inward push per step (world units per step²) on a point sitting exactly on the other cell's rim. */
const PUSH = 0.3;
/** The push fades to nothing this far outside / inside the other rim (world units). */
const REACH_OUT = 6;
const REACH_IN = 10;
/** Deepest dent a contact can press, world units and fraction of R (the smaller wins). */
const DENT_MAX = 12;
const DENT_FRAC = 0.15;

export function stepMembrane(b: MembraneBody, rand: () => number): void {
  const m = b.membrane;
  const n = m.n;
  const rad = m.rad;
  const R = b.r;

  if (n > 0) {
    // A change of the true radius (the displayed size springing after a meal or a split) carries the whole ring
    // with it, so the outline keeps pace with the cell and only the wobble on top of it is dynamic.
    const shift = R - m.base;
    if (shift !== 0) {
      for (let i = 0; i < n; i++) rad[i] += shift;
      m.base = R;
    }
    const vel = m.vel;
    if (!b.spiky && b.contacts.length > 0) dent(b, n, rad, vel, R);

    // Wave step. Every read below sees last step's displacements: the left neighbour is carried in `prev` before
    // it is overwritten, the right one has not been reached yet, and point 0 is saved for the wrap.
    const pull = b.agitated ? PULL_AGITATED : PULL;
    const noise = b.agitated ? NOISE_AGITATED : NOISE;
    const lo = MIN_U * R;
    const hi = MAX_U * R;
    const first = rad[0] - R;
    let prev = rad[n - 1] - R;
    for (let i = 0; i < n; i++) {
      const u = rad[i] - R;
      const next = i + 1 < n ? rad[i + 1] - R : first;
      let v = vel[i];
      v += TENSION * (prev + next - 2 * u) - pull * u - DAMP * v + noise * (rand() - 0.5);
      let nu = u + v;
      if (nu > hi) {
        nu = hi;
        if (v > 0) v = 0;
      } else if (nu < lo) {
        nu = lo;
        if (v < 0) v = 0;
      }
      vel[i] = v;
      rad[i] = Math.max(0, R + nu);
      prev = u;
    }
  }

  // Squash against maze walls.
  const wc = b.wallCount;
  if (wc > 0) {
    const walls = b.walls;
    for (let i = 0; i < n; i++) {
      const a = (TWO_PI * i) / n + b.roll;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      let r = rad[i];
      for (let k = 0; k < wc; k++) {
        const dd = ux * walls[k * 3] + uy * walls[k * 3 + 1];
        if (dd > 0.05 && r * dd > walls[k * 3 + 2]) r = walls[k * 3 + 2] / dd;
      }
      rad[i] = Math.max(r, R * 0.25);
    }
  }
}

/**
 * Pushes this rim's points inward where they meet a contact's rim. The push peaks when a point sits exactly on
 * the other outline and fades smoothly to zero REACH_OUT outside and REACH_IN inside it, so only the band where
 * the outlines meet is dented, and it weakens as the point's dent nears the cap, so a contact only ever presses a
 * shallow dimple. It is added to the velocities, so the wave step spreads it along the rim and the dent rebounds
 * when the contact goes away.
 */
function dent(b: MembraneBody, n: number, rad: Float32Array, vel: Float32Array, R: number): void {
  const step = TWO_PI / n;
  const cr = Math.cos(step);
  const sr = Math.sin(step);
  const c0 = Math.cos(b.roll);
  const s0 = Math.sin(b.roll);
  const ownMax = R * (1 + MAX_U);
  const cap = Math.min(DENT_MAX, DENT_FRAC * R);
  if (!(cap > 0)) return;
  const contacts = b.contacts;
  for (let k = 0; k < contacts.length; k++) {
    const o = contacts[k];
    const om = o.membrane;
    const on = om.n;
    if (on === 0) continue;
    const dx = o.lx - b.lx;
    const dy = o.ly - b.ly;
    // Extent of the other rim: only points in the annulus it can reach need the exact test.
    const orad = om.rad;
    let oLo = orad[0];
    let oHi = orad[0];
    for (let j = 1; j < on; j++) {
      const r = orad[j];
      if (r > oHi) oHi = r;
      else if (r < oLo) oLo = r;
    }
    const outer = oHi + REACH_OUT;
    if (Math.abs(dx) > outer + ownMax || Math.abs(dy) > outer + ownMax) continue;
    const outer2 = outer * outer;
    const inner = oLo - REACH_IN;
    const inner2 = inner > 0 ? inner * inner : -1;
    let cs = c0;
    let sn = s0;
    for (let i = 0; i < n; i++) {
      const r = rad[i];
      const room = cap - Math.max(0, R - r);
      if (room > 0) {
        const px = r * cs - dx;
        const py = r * sn - dy;
        const d2 = px * px + py * py;
        if (d2 < outer2 && d2 > inner2) {
          // Depth of this point inside the other outline (negative: outside it).
          const s = om.radiusAt(Math.atan2(py, px), o.roll) - Math.sqrt(d2);
          if (s > -REACH_OUT && s < REACH_IN) {
            const w = s < 0 ? s / REACH_OUT : s / REACH_IN;
            const f = 1 - w * w;
            vel[i] -= ((PUSH * room) / cap) * f * f;
          }
        }
      }
      const t = cs * cr - sn * sr;
      sn = sn * cr + cs * sr;
      cs = t;
    }
  }
}
