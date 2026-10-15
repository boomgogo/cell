import { describe, expect, it } from 'vitest';
import { Cell, VIRUS } from '../../src/sim/cell.ts';
import type { EatEvent } from '../../src/sim/events.ts';
import { FOOD_KIND, PELLET, POWER } from '../../src/sim/food.ts';
import type { World } from '../../src/sim/world.ts';
import { eatPoints, explodePoints } from '../../src/ui/points.ts';
import { NORTH, addPlayer, emptyWorld, offset } from './helpers.ts';

const still = { update: (_w: World, o: { cells: { p: object }[]; target: object }) => o.cells[0] && Object.assign(o.target, o.cells[0].p) };

/** Runs the world for `seconds` and sums the points `org` would get from its eat events, counting own merges. */
function run(w: World, org: number, seconds: number): { points: number; merges: number } {
  let points = 0;
  let merges = 0;
  for (let t = 0; t < seconds * 25; t++) {
    w.step();
    for (const e of w.events) {
      if (e.type !== 'eat') continue;
      if (e.eaterOrg === org && e.preyOrg === org) merges++;
      points += eatPoints(e, org);
    }
  }
  return { points, merges };
}

const eat = (over: Partial<EatEvent>): EatEvent => ({
  type: 'eat',
  eaterId: 1,
  eatenId: 2,
  eatenKind: FOOD_KIND,
  x: 0,
  y: 0,
  z: 1,
  r: 10,
  hue: 0,
  eaterOrg: 7,
  preyOrg: -1,
  foodKind: PELLET,
  foodTag: -1,
  ...over,
});

describe('arcade points', () => {
  it('pays for pellets, power pellets and other organisms’ cells, only to the eater', () => {
    expect(eatPoints(eat({}), 7)).toBe(10);
    expect(eatPoints(eat({ foodKind: POWER }), 7)).toBe(50);
    expect(eatPoints(eat({ eatenKind: 0, foodKind: -1, r: 100, preyOrg: 9 }), 7)).toBe(1000);
    expect(eatPoints(eat({}), 8)).toBe(0);
    expect(eatPoints(eat({ eatenKind: VIRUS, foodKind: -1, r: 100 }), 7)).toBe(0);
  });

  it('pays nothing when own cells merge back', () => {
    expect(eatPoints(eat({ eatenKind: 0, foodKind: -1, r: 100, preyOrg: 7 }), 7)).toBe(0);
  });

  it('split → merge scores nothing in the sim (it used to pay 10 × the merged mass)', () => {
    const w = emptyWorld();
    const org = addPlayer(w, NORTH, 1000, still);
    org.wantSplit = true;
    const { points, merges } = run(w, org.id, 60);
    expect(merges).toBeGreaterThan(0);
    expect(org.cells).toHaveLength(1);
    expect(points).toBe(0);
  });

  it('a virus pop and the merges after it score nothing', () => {
    const w = emptyWorld();
    w.virusMax = 100;
    const org = addPlayer(w, NORTH, 1500, still);
    const virus = new Cell(w.newId(), VIRUS, offset(w, NORTH, 30, 0), 100, 120, null, 0);
    (w as unknown as { addCell(c: Cell): void }).addCell(virus);
    const { points, merges } = run(w, org.id, 90);
    expect(merges).toBeGreaterThan(3);
    expect(points).toBe(0);
  });

  it('eating a rival pays 10 × its mass', () => {
    const w = emptyWorld();
    const big = addPlayer(w, NORTH, 400, still);
    addPlayer(w, offset(w, NORTH, 30, 0), 100, still);
    expect(run(w, big.id, 1).points).toBe(1000);
  });

  it('explosions pay 200 → 3 200 along a chain', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(explodePoints)).toEqual([200, 400, 800, 1600, 3200, 3200, 3200]);
  });
});
