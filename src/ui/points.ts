// Arcade points: what the player's events are worth. DOM-free, so the autoplay harness scores exactly like the game.
import { PLAYER } from '../sim/cell.ts';
import type { EatEvent } from '../sim/events.ts';
import { FOOD_KIND, PELLET, POWER } from '../sim/food.ts';
import { radiusToMass } from '../sim/rules.ts';

export const PELLET_POINTS = 10;
export const POWER_POINTS = 50;
/** Eating another organism's cell: this many points per unit of its mass. */
export const MASS_POINTS = 10;
export const HOME_POINTS = 1000;
export const LAP_POINTS = 10000;

/**
 * Points for an eat event to organism `org`: a pellet or a power pellet, or a cell of someone else. Own cells merging
 * back (after a split, a virus pop or an explosion) are the same `eat` event in the sim, and score nothing.
 */
export function eatPoints(e: EatEvent, org: number): number {
  if (e.eaterOrg !== org) return 0;
  if (e.eatenKind === FOOD_KIND) return e.foodKind === PELLET ? PELLET_POINTS : e.foodKind === POWER ? POWER_POINTS : 0;
  if (e.eatenKind !== PLAYER || e.preyOrg === org) return 0;
  return Math.round(radiusToMass(e.r) * MASS_POINTS);
}

/** Points for the k-th explosion (0-based) of a rainbow period: 200 → 3 200 along a chain. */
export function explodePoints(k: number): number {
  return 200 * 2 ** Math.min(k, 4);
}
