import { type Vec3, vec3 } from '../sphere/vec3.ts';
import type { Organism } from './organism.ts';

export const PLAYER = 0;
export const EJECTED = 1;
export const VIRUS = 2;
export type CellKind = typeof PLAYER | typeof EJECTED | typeof VIRUS;

/** A moving or interactive node: player cell, ejected mass or virus. Food lives in FoodStore. */
export class Cell {
  readonly id: number;
  readonly kind: CellKind;
  /** Unit vector position. */
  readonly p: Vec3;
  /** Position at the start of the tick (render interpolation). */
  readonly prev: Vec3;
  /** Boost heading: unit tangent at p. */
  readonly heading: Vec3 = vec3(1, 0, 0);
  r: number;
  hue: number;
  owner: Organism | null;
  boost = 0;
  bornTick: number;
  canMerge = false;
  removed = false;
  /** Squeeze factor from the last wall resolve (1 = free). */
  squeeze = 1;
  /** Nearest wall distance after the last wall resolve (Infinity when no wall is near). */
  clearance = Infinity;
  /** Tick until which this cell can't be eaten by another organism or exploded (fresh explosion pieces). */
  graceUntil = 0;
  /**
   * Mass that didn't fit the widest way out of the maze spot the cell is in. It is still the cell's mass
   * (score, eating it, explosions, decay) and comes back as size once there is room.
   */
  packed = 0;
  /** Tick of the last `unpack` event (at most one per second per cell). */
  swellTick = -1e9;
  /** Slot in World.cells (swap-remove bookkeeping). */
  slot = -1;

  constructor(id: number, kind: CellKind, p: Vec3, r: number, hue: number, owner: Organism | null, bornTick: number) {
    this.id = id;
    this.kind = kind;
    this.p = vec3(p.x, p.y, p.z);
    this.prev = vec3(p.x, p.y, p.z);
    this.r = r;
    this.hue = hue;
    this.owner = owner;
    this.bornTick = bornTick;
  }

  /** Physical mass (from the radius): what splits, ejects and size comparisons use. */
  get mass(): number {
    return (this.r * this.r) / 100;
  }

  /** Physical plus packed mass. */
  get totalMass(): number {
    return (this.r * this.r) / 100 + this.packed;
  }
}
