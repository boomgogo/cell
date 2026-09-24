// Maze food on the dot spots and its regrowth, power pellet spots and respawn, the rainbow grant
// and eat rule, ghost species traits.
import { describe, expect, it } from 'vitest';
import { MASK_REGULAR } from '../../src/maze/district.ts';
import { Flood } from '../../src/maze/nav.ts';
import { PELLET, POWER } from '../../src/sim/food.ts';
import { Organism } from '../../src/sim/organism.ts';
import { ghostSpecies } from '../../src/sim/species.ts';
import { type Vec3, angle, vec3 } from '../../src/sphere/vec3.ts';
import { addPlayer, arcadeWorld, offset } from './helpers.ts';
import type { World } from '../../src/sim/world.ts';

const hold = (o: Organism) => {
  o.controller = { update: (_w, org) => org.cells[0] && Object.assign(org.target, org.cells[0].p) };
};

const spawnFood = (w: World) => (w as unknown as { spawnFood(): boolean }).spawnFood();

describe('maze food', () => {
  it('sits on the dot spots as ordinary coloured pellets, and a district starts full', () => {
    const w = arcadeWorld({ decayRate: 0 });
    expect(w.foodTarget).toBe(0);
    const d = w.maze.district(0);
    const st = w.arcade!.states[0]!;
    expect(w.foodTarget).toBe(st.total);
    expect(w.arcade!.foodAlive(0)).toBe(st.total);
    const food = w.food;
    const hues = new Set<number>();
    const p = vec3();
    for (let k = 0; k < st.total; k++) {
      const i = st.spotFood[k];
      expect(i).toBeGreaterThanOrEqual(0);
      expect(food.kind[i]).toBe(PELLET);
      expect(food.tag[i]).toBe(k);
      d.point(d.maze.dots[k * 2], d.maze.dots[k * 2 + 1], p);
      expect(Math.hypot(food.x[i] - p.x, food.y[i] - p.y, food.z[i] - p.z)).toBeLessThan(1e-9);
      hues.add(food.hue[i]);
    }
    expect(hues.size).toBeGreaterThan(100);
  });

  it('eaten food comes back only on empty spots of its own district, at the plains rate per area', () => {
    const w = arcadeWorld({ decayRate: 0 });
    while (w.maze.buildNext()) {}
    const st = w.arcade!.states[0]!;
    const food = w.food;
    // Empty district 0 completely, as if everything had been eaten.
    const eater = addPlayer(w, w.maze.layout.junctions[0].p, 10);
    for (let k = 0; k < st.total; k++) {
      const i = st.spotFood[k];
      w.arcade!.onFoodEaten(i, eater.cells[0]);
      food.remove(i);
    }
    expect(st.emptyCount).toBe(st.total);
    // Count where 20 000 top-up pellets land: district 0's spots vs. a plains cap around a junction.
    // (The test world has no plains food of its own, so every plains pellet counted here is a new one.)
    const cap = w.maze.layout.junctions[0].p;
    const capR = 3000;
    const N = 20000;
    let inCap = 0;
    for (let n = 0; n < N; n++) spawnFood(w);
    const q = vec3();
    for (let i = 0; i < food.span; i++) {
      if (!food.alive[i] || food.tag[i] >= 0) continue;
      q.x = food.x[i];
      q.y = food.y[i];
      q.z = food.z[i];
      if (w.R * angle(q, cap) < capR) inCap++;
    }
    const filled = st.total - st.emptyCount;
    // Every refilled pellet sits exactly on one of the district's own spots.
    for (let k = 0; k < st.total; k++) {
      const i = st.spotFood[k];
      if (i < 0) continue;
      expect(food.tag[i]).toBe(k);
    }
    const sphere = 4 * Math.PI * w.R * w.R;
    const districtArea = (w.maze.layout.mazeShare() * sphere) / 12;
    const capArea = 2 * Math.PI * w.R * w.R * (1 - Math.cos(capR / w.R));
    const perAreaDistrict = filled / districtArea;
    const perAreaPlains = inCap / capArea;
    expect(perAreaDistrict / perAreaPlains).toBeGreaterThan(0.8);
    expect(perAreaDistrict / perAreaPlains).toBeLessThan(1.2);
  });

  it('keeps the world at its food target: a pellet eaten in a corridor is replaced on the same tick', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(1);
    const org = addPlayer(w, d.point(d.maze.dots[0], d.maze.dots[1], vec3()), 10);
    hold(org);
    const m0 = org.mass;
    w.step();
    const eaten = w.events.filter((e) => e.type === 'eat' && e.foodKind === PELLET && e.foodTag >= 0);
    expect(eaten.length).toBeGreaterThanOrEqual(1);
    expect(org.mass).toBeCloseTo(m0 + eaten.length, 3);
    expect(w.food.pellets).toBe(w.foodTarget);
  });

  it('never generates a district to place food, and plains pellets stay out of maze interiors', () => {
    const w = arcadeWorld({ foodPerRefArea: 700 });
    expect([...Array(12).keys()].some((i) => w.maze.isBuilt(i))).toBe(false);
    for (let n = 0; n < 5000; n++) spawnFood(w);
    expect([...Array(12).keys()].some((i) => w.maze.isBuilt(i))).toBe(false);
    const p = vec3();
    for (let i = 0; i < w.food.span; i++) {
      if (!w.food.alive[i]) continue;
      expect(w.food.tag[i]).toBe(-1);
      p.x = w.food.x[i];
      p.y = w.food.y[i];
      p.z = w.food.z[i];
      expect(w.maze.inInterior(p)).toBe(false);
    }
  });
});

describe('power pellets', () => {
  it('has 12 spots per district: 4 each in fine, coarse and avenue corridors, left-right symmetric', () => {
    const w = arcadeWorld();
    const flood = new Flood();
    // Radii that fit fine corridors, coarse corridors and the avenue ring (as in the nav tests).
    const radii = [60, 250, 500];
    for (const i of [0, 5, 11]) {
      const d = w.maze.district(i);
      const power = d.maze.power;
      expect(power.length).toBe(24);
      const byClass = [0, 0, 0];
      for (let k = 0; k < power.length; k += 2) {
        const x = power[k];
        const y = power[k + 1];
        // Mirror image is also a spot.
        let mirrored = false;
        for (let j = 0; j < power.length; j += 2) if (Math.abs(power[j] - (d.G - x)) < 1e-6 && Math.abs(power[j + 1] - y) < 1e-6) mirrored = true;
        expect(mirrored).toBe(true);
        // Biggest of the three cells that can get to the spot from the plains margin.
        const t = d.tileIndex(x - 0.25, y - 0.25);
        let cls = -1;
        for (let c = 0; c < 3; c++) {
          flood.run(d, 0, radii[c], MASK_REGULAR, d.G * d.G, Infinity);
          if (flood.reached(t)) cls = c;
        }
        expect(cls).toBeGreaterThanOrEqual(0);
        byClass[cls]++;
      }
      expect(byClass).toEqual([4, 4, 4]);
    }
  });

  it('gives the rainbow to whoever eats it (NPCs too) and comes back after 15 s ± 25 %', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(2);
    const st = w.arcade!.states[2]!;
    const k = 6;
    const at = d.point(d.maze.power[k * 2], d.maze.power[k * 2 + 1], vec3());
    const npc = new Organism(w.newId(), 'npc', 10, { update() {} }, false);
    w.addOrganism(npc);
    w.spawnOrganism(npc, at, 20);
    hold(npc);
    w.step();
    expect(w.events.some((e) => e.type === 'eat' && e.foodKind === POWER)).toBe(true);
    expect(w.events.some((e) => e.type === 'rainbow' && e.organismId === npc.id)).toBe(true);
    expect(w.tick < npc.rainbowUntil).toBe(true);
    expect(st.powerFood[k]).toBe(-1);
    // Move away so it isn't eaten again, then wait.
    Object.assign(npc.cells[0].p, d.point(-20, -20, vec3()));
    for (let t = 0; t < 25 * 11; t++) w.step();
    expect(st.powerFood[k]).toBe(-1);
    for (let t = 0; t < 25 * 9; t++) w.step();
    expect(st.powerFood[k]).toBeGreaterThanOrEqual(0);
    expect(w.arcade!.powerAlive(2)).toBe(12);
  });

  it('a second pellet restarts the rainbow clock and keeps the chain count', () => {
    const w = arcadeWorld();
    const org = addPlayer(w, w.maze.layout.junctions[1].p, 20);
    w.arcade!.grantRainbow(org);
    org.explodeCount = 3;
    for (let t = 0; t < 100; t++) w.step();
    const before = org.rainbowUntil;
    w.arcade!.grantRainbow(org);
    expect(org.rainbowUntil).toBe(before + 100);
    expect(org.explodeCount).toBe(3);
    // After it runs out, a new rainbow starts a new chain.
    org.rainbowUntil = w.tick;
    w.arcade!.grantRainbow(org);
    expect(org.explodeCount).toBe(0);
  });
});

describe('rainbow eat rule', () => {
  it('a rainbow cell eats any smaller cell; a normal cell needs the 14 % margin', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = w.maze.layout.junctions[2].p;
    const big = addPlayer(w, at, 100);
    const small = addPlayer(w, offset(w, at, 10, 0), 95 * 0.9);
    hold(big);
    hold(small);
    for (let t = 0; t < 3; t++) w.step();
    expect(small.alive).toBe(true);
    w.arcade!.grantRainbow(big);
    for (let t = 0; t < 3; t++) w.step();
    expect(small.alive).toBe(false);
  });
});

describe('ghost species', () => {
  it('fixed mass after eating, cannot split or eject, and never eats food', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(5);
    const at: Vec3 = d.point(d.maze.dots[10], d.maze.dots[11], vec3());
    const ghost = new Organism(w.newId(), 'g', 0, { update: (_w, o) => Object.assign(o.target, o.cells[0].p) }, false);
    ghost.species = ghostSpecies(1.25);
    ghost.baseMass = 30;
    w.addOrganism(ghost);
    w.spawnOrganism(ghost, at);
    const prey = addPlayer(w, offset(w, at, 5, 0), 10);
    hold(prey);
    ghost.wantSplit = true;
    ghost.wantEject = true;
    w.step();
    expect(w.events.some((e) => e.type === 'eat' && e.eaterOrg === ghost.id && e.foodKind >= 0)).toBe(false);
    expect(prey.alive).toBe(false);
    expect(ghost.cells).toHaveLength(1);
    expect(ghost.mass).toBeCloseTo(30, 6);
    expect(w.R * angle(ghost.cells[0].p, at)).toBeLessThan(40);
  });
});
