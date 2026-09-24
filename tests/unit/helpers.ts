import { baseConfig } from '../../src/config/base.ts';
import { arcadeConfig } from '../../src/config/arcade.ts';
import type { GameConfig } from '../../src/config/types.ts';
import type { Controller } from '../../src/sim/controller.ts';
import { Organism } from '../../src/sim/organism.ts';
import { World } from '../../src/sim/world.ts';
import { type Vec3, vec3 } from '../../src/sphere/vec3.ts';

/** Empty world: no food, no viruses, no NPCs. */
export function emptyConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...baseConfig, foodPerRefArea: 0, virusMinPerRefArea: 0, npcPerRefArea: 0, ...overrides };
}

export function emptyWorld(overrides: Partial<GameConfig> = {}): World {
  return new World(emptyConfig(overrides), { seed: 7 });
}

export function addPlayer(world: World, at: Vec3, mass: number, controller: Controller = { update() {} }): Organism {
  const org = new Organism(world.newId(), 'test', 30, controller, true);
  world.addOrganism(org);
  world.spawnOrganism(org, at, mass);
  return org;
}

export const NORTH = vec3(0, 0, 1);

/** Unit vector at `dist` world units from `from` along an arbitrary fixed direction. */
export function offset(world: World, from: Vec3, dx: number, dy: number): Vec3 {
  const a = Math.hypot(dx, dy) / world.R;
  const ux = a > 0 ? dx / Math.hypot(dx, dy) : 0;
  const uy = a > 0 ? dy / Math.hypot(dx, dy) : 0;
  // Tangent basis at `from` (works for NORTH and generic points).
  const e = Math.abs(from.z) < 0.9 ? vec3(-from.y, from.x, 0) : vec3(1, 0, -from.x);
  const el = Math.hypot(e.x, e.y, e.z);
  e.x /= el;
  e.y /= el;
  e.z /= el;
  const s = vec3(e.y * from.z - e.z * from.y, e.z * from.x - e.x * from.z, e.x * from.y - e.y * from.x);
  const tx = e.x * ux + s.x * uy;
  const ty = e.y * ux + s.y * uy;
  const tz = e.z * ux + s.z * uy;
  return vec3(from.x * Math.cos(a) + tx * Math.sin(a), from.y * Math.cos(a) + ty * Math.sin(a), from.z * Math.cos(a) + tz * Math.sin(a));
}

/** Arcade world with maze districts but no pellets, viruses or NPCs. */
export function arcadeWorld(overrides: Partial<GameConfig> = {}): World {
  return new World({ ...arcadeConfig, foodPerRefArea: 0, virusMinPerRefArea: 0, virusMaxPerRefArea: 0, npcPerRefArea: 0, ...overrides }, { seed: 7 });
}

/** Human-like organism that steers toward a fixed point every tick. */
export function steerTo(world: World, at: Vec3, mass: number, target: Vec3): Organism {
  return addPlayer(world, at, mass, { update: (_w, o) => Object.assign(o.target, target) });
}
