import type { Organism } from './organism.ts';
import type { World } from './world.ts';

/** Produces an organism's intent (target, split, eject) each tick. Human input and NPCs share this. */
export interface Controller {
  update(world: World, org: Organism): void;
}

/** Keeps the current intent; used for tests and spectator placeholders. */
export const idleController: Controller = { update() {} };
