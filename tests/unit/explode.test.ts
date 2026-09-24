// Rainbow explosions — pieces stay with the victim, the chain, what never explodes, the cell cap, resident
// ghosts, fair rules for humans and NPCs, and the piece split itself.
import { describe, expect, it } from 'vitest';
import { arcadeConfig } from '../../src/config/arcade.ts';
import { Cell, VIRUS } from '../../src/sim/cell.ts';
import type { ExplodeEvent } from '../../src/sim/events.ts';
import { Organism } from '../../src/sim/organism.ts';
import { fragmentMasses } from '../../src/sim/rules.ts';
import { ghostSpecies } from '../../src/sim/species.ts';
import type { World } from '../../src/sim/world.ts';
import { type Vec3, copy } from '../../src/sphere/vec3.ts';
import { arcadeWorld, offset } from './helpers.ts';

const hold = (o: Organism) => {
  o.controller = { update: (_w, org) => org.cells[0] && Object.assign(org.target, org.cells[0].p) };
};

const reindex = (w: World) => (w as unknown as { rebuildIndex(): void }).rebuildIndex();

/** Places cell c at `dist` world units from `from` (east) and re-indexes. */
function place(w: World, c: Cell, from: Vec3, dist: number): void {
  copy(c.p, offset(w, from, dist, 0));
  copy(c.prev, c.p);
  reindex(w);
}

function npc(w: World, at: Vec3, mass: number, human = false): Organism {
  const o = new Organism(w.newId(), human ? 'human' : 'npc', 200, { update() {} }, human);
  w.addOrganism(o);
  w.spawnOrganism(o, at, mass);
  hold(o);
  return o;
}

/** A plains spot far from every maze. */
const plains = (w: World, k = 0) => w.maze.layout.junctions[k].p;

function explosions(w: World): ExplodeEvent[] {
  return w.events.filter((e): e is ExplodeEvent => e.type === 'explode');
}

describe('rainbow explosions', () => {
  it('a touch splits the bigger cell into pieces that stay with the victim, mass kept', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w);
    const hero = npc(w, at, 20);
    const big = npc(w, offset(w, at, 2000, 0), 2000);
    w.arcade!.grantRainbow(hero);
    place(w, big.cells[0], at, hero.cells[0].r + big.cells[0].r - 5);
    w.step();
    const ev = explosions(w);
    expect(ev).toHaveLength(1);
    expect(ev[0].organismId).toBe(hero.id);
    expect(ev[0].victimId).toBe(big.id);
    expect(big.alive).toBe(true);
    expect(big.cells.length).toBe(ev[0].pieces);
    expect(big.cells.length).toBeGreaterThanOrEqual(5);
    expect(big.cells.length).toBeLessThanOrEqual(14);
    expect(big.mass).toBeCloseTo(2000, 6);
    const masses = big.cells.map((c) => c.mass).sort((a, b) => a - b);
    expect(masses[masses.length - 1]).toBeLessThanOrEqual(2000 / 3 + 1e-6);
    expect(masses[0]).toBeLessThan(hero.mass);
    expect(big.cells.every((c) => c.owner === big && c.graceUntil > w.tick)).toBe(true);
  });

  it('chains: after the grace time a crumb is eaten and a chunk bigger than the exploder explodes again', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w);
    const hero = npc(w, at, 30);
    const big = npc(w, offset(w, at, 3000, 0), 3000);
    w.arcade!.grantRainbow(hero);
    place(w, big.cells[0], at, hero.cells[0].r + big.cells[0].r - 5);
    w.step();
    expect(explosions(w)).toHaveLength(1);
    // During the grace time nothing happens to the pieces, even when touched.
    const crumb = big.cells.reduce((a, b) => (a.r < b.r ? a : b));
    place(w, crumb, hero.cells[0].p, 0);
    w.step();
    expect(crumb.removed).toBe(false);
    for (let t = 0; t < arcadeConfig.explodeGraceTicks; t++) w.step();
    // The crumb is smaller than the hero: eaten.
    const heroMass = hero.mass;
    const crumbMass = crumb.mass;
    place(w, crumb, hero.cells[0].p, 0);
    w.step();
    expect(crumb.removed).toBe(true);
    expect(hero.mass).toBeCloseTo(heroMass + crumbMass, 3);
    // A chunk bigger than the hero explodes again, and the chain counter goes up.
    const chunk = big.cells.reduce((a, b) => (a.r > b.r ? a : b));
    expect(chunk.r).toBeGreaterThan(hero.cells[0].r);
    const before = big.cells.length;
    place(w, chunk, hero.cells[0].p, hero.cells[0].r + chunk.r - 5);
    w.step();
    const ev = explosions(w);
    expect(ev).toHaveLength(1);
    expect(ev[0].k).toBe(1);
    expect(big.cells.length).toBe(before + ev[0].pieces - 1);
  });

  it('never explodes own cells, cells that aren’t bigger, viruses, or anything once the rainbow is over', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w);
    const hero = npc(w, at, 200);
    w.arcade!.grantRainbow(hero);
    // Own cells: split into two unequal halves touching each other.
    const own = w.addPieceCell(hero, offset(w, at, 0, 200), 30);
    place(w, own, at, hero.cells[0].r + own.r - 5);
    // A virus bigger than the hero touching it.
    const virus = w.cells.find((c) => c.kind === VIRUS) ?? null;
    expect(virus).toBeNull();
    const v = new Cell(w.newId(), VIRUS, offset(w, at, -300, 0), 160, 120, null, w.tick);
    (w as unknown as { addCell(c: Cell): void }).addCell(v);
    place(w, v, at, -(hero.cells[0].r + 160 - 5));
    // An equal-size rival: neither eaten nor exploded.
    const twin = npc(w, offset(w, at, 0, -2000), 200);
    place(w, twin.cells[0], offset(w, at, 0, -(2 * hero.cells[0].r - 5)), 0);
    for (let t = 0; t < 5; t++) w.step();
    expect(explosions(w)).toHaveLength(0);
    expect(hero.cells.length).toBe(2);
    expect(v.removed).toBe(false);
    expect(twin.alive).toBe(true);
    expect(twin.cells).toHaveLength(1);
    // Rainbow over: a bigger cell touching the hero stays whole.
    hero.rainbowUntil = w.tick;
    const big = npc(w, offset(w, at, 5000, 0), 2000);
    place(w, big.cells[0], hero.cells[0].p, hero.cells[0].r + big.cells[0].r - 5);
    for (let t = 0; t < 3; t++) w.step();
    expect(big.cells).toHaveLength(1);
  });

  it('a bigger cell steered or split onto a rainbow cell explodes and never eats it', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w, 3);
    const hero = npc(w, at, 20);
    w.arcade!.grantRainbow(hero);
    const big = npc(w, offset(w, at, 700, 0), 4000);
    big.controller = { update: (_w, o) => Object.assign(o.target, hero.cells[0]?.p ?? o.target) };
    let exploded = 0;
    for (let t = 0; t < 60; t++) {
      w.step();
      exploded += explosions(w).length;
    }
    expect(hero.alive).toBe(true);
    expect(exploded).toBeGreaterThanOrEqual(1);
    // A split jump onto the rainbow cell.
    const big2 = npc(w, offset(w, at, 0, 1400), 4000);
    Object.assign(big2.target, hero.cells[0].p);
    big2.controller = { update: (_w, o) => Object.assign(o.target, hero.cells[0]?.p ?? o.target) };
    big2.wantSplit = true;
    for (let t = 0; t < 40; t++) w.step();
    expect(hero.alive).toBe(true);
  });

  it('a victim already at the cell cap is knocked back instead', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w, 4);
    const hero = npc(w, at, 5);
    w.arcade!.grantRainbow(hero);
    const victim = npc(w, offset(w, at, 3000, 0), 40);
    for (let k = 1; k < arcadeConfig.explodeMaxCells; k++) w.addPieceCell(victim, offset(w, at, 3000 + 150 * k, 600), Math.sqrt(40 * 100));
    expect(victim.cells).toHaveLength(arcadeConfig.explodeMaxCells);
    place(w, victim.cells[0], at, hero.cells[0].r + victim.cells[0].r - 3);
    w.step();
    expect(explosions(w)).toHaveLength(0);
    expect(w.explodeKnockbacks).toBe(1);
    expect(w.events.some((e) => e.type === 'bounce' && e.cellId === victim.cells[0].id)).toBe(true);
    expect(victim.cells).toHaveLength(arcadeConfig.explodeMaxCells);
    expect(victim.cells[0].boost).toBeGreaterThan(0);
  });

  it('a victim too small to split is swallowed by the (even smaller) rainbow cell', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w, 7);
    const hero = npc(w, at, 1.5);
    w.arcade!.grantRainbow(hero);
    const tiny = npc(w, offset(w, at, 500, 0), 3.5);
    place(w, tiny.cells[0], at, hero.cells[0].r + tiny.cells[0].r - 2);
    w.step();
    expect(explosions(w)).toHaveLength(0);
    expect(tiny.alive).toBe(false);
    expect(hero.mass).toBeCloseTo(5, 6);
    expect(w.explodeTooSmall).toBe(1);
  });

  it('a resident ghost explodes too; its pieces merge back, and once they are all eaten it respawns in its pen', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = plains(w, 5);
    const ghost = new Organism(w.newId(), 'ghost', 0, { update() {} }, false);
    ghost.species = ghostSpecies(1.25);
    ghost.resident = { district: 0, style: 'chaser', tier: 1 };
    ghost.baseMass = 400;
    ghost.home = offset(w, at, 0, 5000);
    w.addOrganism(ghost);
    w.spawnOrganism(ghost, at);
    hold(ghost);
    const hero = npc(w, offset(w, at, 1500, 0), 20);
    w.arcade!.grantRainbow(hero);
    place(w, hero.cells[0], at, hero.cells[0].r + ghost.cells[0].r - 5);
    w.step();
    expect(explosions(w)).toHaveLength(1);
    expect(ghost.cells.length).toBeGreaterThanOrEqual(5);
    expect(ghost.mass).toBeCloseTo(400, 6);
    // A big NPC eats every piece after the grace time.
    hero.rainbowUntil = w.tick;
    copy(hero.cells[0].p, offset(w, at, 4000, 0));
    for (let t = 0; t < arcadeConfig.explodeGraceTicks + 1; t++) w.step();
    const eater = npc(w, offset(w, at, 3000, 3000), 20000);
    for (let t = 0; t < 40 && ghost.alive; t++) {
      const c = ghost.cells[0];
      if (c) place(w, eater.cells[0], c.p, 0);
      w.step();
    }
    expect(ghost.alive).toBe(false);
    for (let t = 0; t < 25 * 5 + 2; t++) w.step();
    expect(ghost.alive).toBe(true);
    expect(ghost.mass).toBeCloseTo(400, 6);
  });

  it('is fair: the same touch with the roles of human and NPC swapped gives the same pieces', () => {
    const run = (humanIsRainbow: boolean) => {
      const w = arcadeWorld({ decayRate: 0 });
      const at = plains(w, 6);
      const hero = npc(w, at, 25, humanIsRainbow);
      const big = npc(w, offset(w, at, 2000, 0), 900, !humanIsRainbow);
      w.arcade!.grantRainbow(hero);
      place(w, big.cells[0], at, hero.cells[0].r + big.cells[0].r - 5);
      w.step();
      return { events: explosions(w).length, masses: big.cells.map((c) => c.mass).sort((a, b) => a - b) };
    };
    const a = run(true);
    const b = run(false);
    expect(a.events).toBe(1);
    expect(b).toEqual(a);
  });
});

describe('fragmentMasses', () => {
  it('sums to M, keeps pieces within bounds and gives the exploder something to eat', () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let n = 0; n < 1000; n++) {
      const m = 7 + rng() * 2000;
      const M = m * (1.01 + rng() * 200);
      const out = fragmentMasses(arcadeConfig, M, m, 31, rng)!;
      expect(out).not.toBeNull();
      expect(out.reduce((s, x) => s + x, 0)).toBeCloseTo(M, 6);
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out.length).toBeLessThanOrEqual(14);
      for (const x of out) expect(x).toBeGreaterThanOrEqual(arcadeConfig.explodeMinMass - 1e-9);
      if (M >= 1000) expect(Math.max(...out)).toBeLessThanOrEqual(M / 3 + 1e-6);
      expect(Math.min(...out)).toBeLessThan(m);
    }
    // No room, or less than two minimum pieces: nothing to split into. Small cells split in half.
    expect(fragmentMasses(arcadeConfig, 500, 10, 0, rng)).toBeNull();
    expect(fragmentMasses(arcadeConfig, 3.5, 1, 10, rng)).toBeNull();
    const halves = fragmentMasses(arcadeConfig, 5, 1.5, 10, rng)!;
    expect(halves.length).toBeGreaterThanOrEqual(2);
    expect(halves.reduce((s, x) => s + x, 0)).toBeCloseTo(5, 9);
    expect(Math.min(...halves)).toBeGreaterThanOrEqual(arcadeConfig.explodeMinMass - 1e-9);
  });
});
