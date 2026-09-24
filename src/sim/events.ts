import { FOOD_KIND } from './food.ts';
import type { CellKind } from './cell.ts';

export type EatenKind = CellKind | typeof FOOD_KIND;

/** Emitted when anything is eaten. The renderer turns these into fading ghosts. */
export interface EatEvent {
  type: 'eat';
  eaterId: number;
  eatenId: number;
  eatenKind: EatenKind;
  x: number;
  y: number;
  z: number;
  r: number;
  hue: number;
  /** Organism of the eater (−1 for unowned eaters like viruses). */
  eaterOrg: number;
  /** For food: PELLET / POWER (−1 for cells). */
  foodKind: number;
  /** For food: the maze spot (district << 16 | slot), −1 in the plains and for cells. */
  foodTag: number;
}

export interface DeathEvent {
  type: 'death';
  organismId: number;
  killerId: number | null;
}

export interface PopEvent {
  type: 'pop';
  cellId: number;
}

/** An organism ate a power pellet and is rainbow until `untilTick`. */
export interface RainbowEvent {
  type: 'rainbow';
  organismId: number;
  untilTick: number;
}

/** A rainbow cell exploded a bigger cell into pieces that still belong to the victim. */
export interface ExplodeEvent {
  type: 'explode';
  /** The rainbow organism. */
  organismId: number;
  victimId: number;
  cellId: number;
  x: number;
  y: number;
  z: number;
  /** Radius of the cell before it exploded. */
  r: number;
  hue: number;
  pieces: number;
  /** Explosion number in this rainbow period (0-based). */
  k: number;
}

/** A rainbow touch that couldn't explode (the victim is at the cell cap) and knocked the cell back. */
export interface BounceEvent {
  type: 'bounce';
  cellId: number;
  x: number;
  y: number;
  z: number;
  r: number;
  hue: number;
}

/** A cell started packing mass that doesn't fit the way out of the maze spot it is in. */
export interface PackEvent {
  type: 'pack';
  cellId: number;
  organismId: number;
}

/** A packed cell has room again and swells back (at most one per cell per second). */
export interface UnpackEvent {
  type: 'unpack';
  cellId: number;
  organismId: number;
  x: number;
  y: number;
  z: number;
  /** Radius when the swell starts. */
  r: number;
  hue: number;
}

export type SimEvent = EatEvent | DeathEvent | PopEvent | RainbowEvent | ExplodeEvent | BounceEvent | PackEvent | UnpackEvent;
