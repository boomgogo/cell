// Food pellets as struct-of-arrays + a static 3D hash (no per-frame allocations).
import { Grid3 } from '../sphere/hash3.ts';
import { type Vec3, randomUnit, vec3 } from '../sphere/vec3.ts';
import type { Rng } from '../core/rng.ts';

export const FOOD_KIND = 3;
export const FOOD_GRID_CELL = 512;

/**
 * Food item kinds. Both are eaten like a pellet. Maze food is an ordinary PELLET that remembers its dot spot in `tag`;
 * a POWER pellet gives the rainbow state.
 */
export const PELLET = 0;
export const POWER = 2;

export class FoodStore {
  readonly R: number;
  readonly radius: number;
  capacity: number;
  count = 0;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  hue: Uint16Array;
  alive: Uint8Array;
  kind: Uint8Array;
  /** Maze spot of the item: district << 16 | slot (−1 for pellets in the plains). */
  tag: Int32Array;
  /** Live pellets, plains and maze spots alike (the food target counts these; power pellets don't count). */
  pellets = 0;
  private free: number[] = [];
  private top = 0;
  readonly grid: Grid3;
  private readonly tmp = vec3();

  constructor(R: number, radius: number, capacity: number) {
    this.R = R;
    this.radius = radius;
    this.capacity = capacity;
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.z = new Float64Array(capacity);
    this.hue = new Uint16Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.tag = new Int32Array(capacity);
    this.grid = new Grid3(FOOD_GRID_CELL, R, false);
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const nx = new Float64Array(cap);
    nx.set(this.x);
    this.x = nx;
    const ny = new Float64Array(cap);
    ny.set(this.y);
    this.y = ny;
    const nz = new Float64Array(cap);
    nz.set(this.z);
    this.z = nz;
    const nh = new Uint16Array(cap);
    nh.set(this.hue);
    this.hue = nh;
    const na = new Uint8Array(cap);
    na.set(this.alive);
    this.alive = na;
    const nk = new Uint8Array(cap);
    nk.set(this.kind);
    this.kind = nk;
    const nt = new Int32Array(cap);
    nt.set(this.tag);
    this.tag = nt;
    this.capacity = cap;
  }

  add(p: Vec3, hue: number, kind = PELLET, tag = -1): number {
    let i: number;
    if (this.free.length > 0) i = this.free.pop()!;
    else {
      if (this.top >= this.capacity) this.grow();
      i = this.top++;
    }
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.z[i] = p.z;
    this.hue[i] = hue;
    this.alive[i] = 1;
    this.kind[i] = kind;
    this.tag[i] = tag;
    this.count++;
    if (kind === PELLET) this.pellets++;
    const R = this.R;
    this.grid.insert(i, p.x * R, p.y * R, p.z * R, this.radius);
    return i;
  }

  /** Adds a plain pellet at a uniformly random spot. */
  spawnRandom(rng: Rng): number {
    randomUnit(this.tmp, rng);
    return this.add(this.tmp, Math.floor(rng() * 360));
  }

  remove(i: number): void {
    if (!this.alive[i]) return;
    const R = this.R;
    this.grid.remove(i, this.x[i] * R, this.y[i] * R, this.z[i] * R);
    this.alive[i] = 0;
    this.count--;
    if (this.kind[i] === PELLET) this.pellets--;
    this.free.push(i);
  }

  /** Visits live pellets whose centres may lie within `radius` world units of unit vector p. */
  query(p: Vec3, radius: number, visit: (i: number) => void): void {
    const R = this.R;
    this.grid.query(p.x * R, p.y * R, p.z * R, radius, visit);
  }

  /** Highest slot index in use + 1 (for full scans). */
  get span(): number {
    return this.top;
  }
}
