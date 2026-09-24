// NPC personalities produce distinct, non-trivial outcomes in a headless arena.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { BotController } from '../../src/ai/bot.ts';
import { populateNpcs, personalityOf } from '../../src/ai/population.ts';
import { World } from '../../src/sim/world.ts';
import { arcadeConfig } from '../../src/config/arcade.ts';
import { DIFFICULTY, PERSONALITIES, type PersonalityId } from '../../src/ai/personalities.ts';
import { MASK_REGULAR } from '../../src/maze/district.ts';
import { Organism } from '../../src/sim/organism.ts';
import { radiusToMass } from '../../src/sim/rules.ts';
import { type Vec3, copy, vec3 } from '../../src/sphere/vec3.ts';
import { arcadeWorld } from './helpers.ts';

describe('NPC arena smoke test', () => {
  it('NPCs eat pellets, fight, and hunters out-kill grazers', () => {
    const cfg = loadConfig(new URLSearchParams({ sphereRadius: '4000' }));
    const world = new World(cfg, { seed: 11 });
    const npcs = populateNpcs(world, { count: 50, varyMass: true });
    const kills = new Map<string, number>();
    let deaths = 0;
    for (let t = 0; t < 25 * 120; t++) {
      world.step();
      for (const e of world.events) {
        if (e.type !== 'death') continue;
        deaths++;
        const killer = npcs.find((o) => o.id === e.killerId);
        if (killer) kills.set(personalityOf(killer)!, (kills.get(personalityOf(killer)!) ?? 0) + 1);
      }
    }
    expect(deaths).toBeGreaterThan(5);
    expect(kills.get('hunter') ?? 0).toBeGreaterThan(kills.get('grazer') ?? 0);
    // Everyone alive has grown or respawned; controllers really are bots.
    expect(npcs.every((o) => o.controller instanceof BotController)).toBe(true);
    expect(Math.max(...npcs.map((o) => o.peakMass))).toBeGreaterThan(300);
  });

  it('dormant NPCs keep living statistically outside the active zone', () => {
    const cfg = loadConfig(new URLSearchParams());
    const world = new World(cfg, { seed: 3 });
    world.observer = { x: 0, y: 0, z: 1 };
    const npcs = populateNpcs(world);
    const dormant = npcs.filter((o) => o.dormant);
    expect(dormant.length).toBeGreaterThan(npcs.length * 0.8);
    const before = dormant.reduce((s, o) => s + o.dormantMass, 0);
    for (let t = 0; t < 25 * 30; t++) world.step();
    const after = dormant.filter((o) => o.alive && o.dormant).reduce((s, o) => s + o.dormantMass, 0);
    expect(after).not.toBe(before);
    const active = npcs.filter((o) => o.alive && !o.dormant).length;
    expect(active).toBeGreaterThan(20);
    expect(active).toBeLessThan(120);
  });
});

// Big NPCs used to turn round on every other think when the field around them was a thin ring of pellets,
// jittering over one spot. Alone, with only food around, they must travel.
describe('big NPCs keep exploring', () => {
  const TPS = 25;

  function bigBot(world: World, at: Vec3, r: number, pid: PersonalityId = 'grazer') {
    const bot = new BotController(PERSONALITIES[pid], DIFFICULTY.normal, 0);
    const org = new Organism(world.newId(), 'big', 30, bot, false);
    world.addOrganism(org);
    world.spawnOrganism(org, at, radiusToMass(r));
    return { org, bot };
  }

  /** Net displacement of the organism's largest cell over `seconds`, and reversals per think. */
  function travel(world: World, org: Organism, bot: BotController, seconds: number) {
    const start = copy(vec3(), org.largestCell()!.p);
    for (let t = 0; t < seconds * TPS; t++) world.step();
    return { net: world.distance(start, org.largestCell()!.p), reversals: bot.reversals / Math.max(1, bot.thinks) };
  }

  for (const pid of ['grazer', 'survivor'] as PersonalityId[]) {
    it(`plains: an r-450 ${pid} among 50 NPCs covers more than 3 r in 30 s (at least 5 of 6 seeds)`, () => {
      let travelled = 0;
      let reversals = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const cfg = loadConfig(new URLSearchParams({ sphereRadius: '4000' }));
        const world = new World({ ...cfg, decayRate: 0 }, { seed });
        populateNpcs(world, { count: 50, varyMass: true });
        for (let t = 0; t < 10 * TPS; t++) world.step();
        const { org, bot } = bigBot(world, vec3(0, 0, 1), 450, pid);
        const run = travel(world, org, bot, 30);
        if (run.net > 3 * 450) travelled++;
        reversals += run.reversals / 6;
      }
      expect(travelled).toBeGreaterThanOrEqual(5);
      expect(reversals).toBeLessThan(0.1);
    });
  }

  it('district: an r-400 grazer on the avenue ring, with maze food on, covers more than 3 r in 30 s', () => {
    for (const dIndex of [2, 7]) {
      const world = arcadeWorld({ foodPerRefArea: arcadeConfig.foodPerRefArea, decayRate: 0 });
      const d = world.maze.district(dIndex);
      const G = d.G;
      let tile = -1;
      for (let t = 0; t < G * G && tile < 0; t++) {
        const i = t % G;
        const j = (t - i) / G;
        if (!d.solid(i, j, MASK_REGULAR) && d.inInterior(i + 0.5, j + 0.5) && d.tileClear[t] >= 540 && d.tileClear[t] < 700) tile = t;
      }
      const at = d.point((tile % G) + 0.5, Math.floor(tile / G) + 0.5, vec3());
      const { org, bot } = bigBot(world, at, 400);
      const { net } = travel(world, org, bot, 30);
      expect(net, `district ${dIndex}`).toBeGreaterThan(3 * 400);
    }
  });
});
