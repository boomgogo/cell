// Creates the NPC population.
import { perSphere } from '../config/index.ts';
import { type GhostStyle, Organism } from '../sim/organism.ts';
import { ghostSpecies } from '../sim/species.ts';
import { vec3 } from '../sphere/vec3.ts';
import type { World } from '../sim/world.ts';
import { BotController } from './bot.ts';
import { GhostController } from './ghost.ts';
import { NPC_NAMES } from './names.ts';
import { DIFFICULTY, type Difficulty, PERSONALITIES, PERSONALITY_MIX, type PersonalityId } from './personalities.ts';

export interface PopulateOptions {
  count?: number;
  difficulty?: Difficulty;
  mix?: [PersonalityId, number][];
  /** Spread initial masses so the world feels mid-game. */
  varyMass?: boolean;
}

export function pickPersonality(r: number, mix: [PersonalityId, number][]): PersonalityId {
  const total = mix.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [id, w] of mix) {
    if ((x -= w) < 0) return id;
  }
  return mix[mix.length - 1][0];
}

export function populateNpcs(world: World, opts: PopulateOptions = {}): Organism[] {
  const count = opts.count ?? perSphere(world.cfg, world.cfg.npcPerRefArea);
  const difficulty = opts.difficulty ?? DIFFICULTY.normal;
  const mix = opts.mix ?? PERSONALITY_MIX;
  const rng = world.rng;
  const out: Organism[] = [];
  for (let i = 0; i < count; i++) {
    const pid = pickPersonality(rng(), mix);
    const bot = new BotController(PERSONALITIES[pid], difficulty, i);
    const name = NPC_NAMES[Math.floor(rng() * NPC_NAMES.length)];
    const org = new Organism(world.newId(), name, Math.floor(rng() * 360), bot, false);
    world.addOrganism(org);
    const mass = opts.varyMass === false ? undefined : 10 * Math.exp(rng() * Math.log(150));
    world.spawnOrganism(org, undefined, mass);
    out.push(org);
  }
  return out;
}

export function personalityOf(org: Organism): PersonalityId | null {
  return org.controller instanceof BotController ? org.controller.personality.id : null;
}

/** The four resident phages of every district: chase style, name, hue (its ink) and size tier. */
export const GHOSTS: { style: GhostStyle; label: string; hue: number; tier: number }[] = [
  { style: 'chaser', label: 'T4', hue: 210, tier: 0 },
  { style: 'ambusher', label: 'Lambda', hue: 270, tier: 0 },
  { style: 'flanker', label: 'Phi', hue: 90, tier: 1 },
  { style: 'shy', label: 'Mu', hue: 150, tier: 1 },
];

/**
 * Resident ghosts for every maze district: cfg.residentsPerDistrict per district, cycling through the four
 * styles (small ones first), living in the district's pen. Districts are not generated here: the pen is the grid centre.
 */
export function populateResidents(world: World): Organism[] {
  const maze = world.maze;
  const cfg = world.cfg;
  const out: Organism[] = [];
  if (!maze.enabled) return out;
  const species = ghostSpecies(cfg.ghostSpeed);
  const G = maze.layout.gridTiles;
  let phase = 0;
  for (let i = 0; i < maze.count; i++) {
    for (let k = 0; k < cfg.residentsPerDistrict; k++) {
      const g = GHOSTS[k % GHOSTS.length];
      const org = new Organism(world.newId(), g.label, g.hue, new GhostController(g.style, phase++), false);
      org.species = species;
      org.resident = { district: i, style: g.style, tier: g.tier };
      org.baseMass = g.tier === 0 ? cfg.ghostSmallMass : cfg.ghostMidMass;
      org.home = maze.gridPoint(i, G / 2 + (k % 2 === 0 ? -1.8 : 1.8), G / 2 + (k < 2 ? -1.8 : 1.8), vec3());
      world.addOrganism(org);
      world.spawnOrganism(org);
      out.push(org);
    }
  }
  return out;
}
