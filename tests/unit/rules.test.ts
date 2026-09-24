import { describe, expect, it } from 'vitest';
import { baseConfig } from '../../src/config/base.ts';
import { perSphere } from '../../src/config/index.ts';
import { createRng } from '../../src/core/rng.ts';
import { Cell, PLAYER } from '../../src/sim/cell.ts';
import {
  bigEnoughToEat,
  decayedRadius,
  eatReach,
  massToRadius,
  mergeDelayTicks,
  popPieces,
  speedPerTick,
  viewScale,
} from '../../src/sim/rules.ts';
import { vec3 } from '../../src/sphere/vec3.ts';

const cfg = baseConfig;
const cellOfMass = (mass: number) => new Cell(1, PLAYER, vec3(0, 0, 1), massToRadius(mass), 0, null, 0);

describe('rules (base preset)', () => {
  it('speed curve at several masses', () => {
    const perSecond = (mass: number) => speedPerTick(cfg, cellOfMass(mass)) * 25;
    expect(perSecond(10)).toBeCloseTo(448, -1);
    expect(perSecond(100)).toBeCloseTo(267, -1);
    expect(perSecond(10000)).toBeCloseTo(95, -1);
  });

  it('eating needs 1.1401× radius (≈30 % more mass)', () => {
    expect(bigEnoughToEat(cfg, 114.01, 100)).toBe(true);
    expect(bigEnoughToEat(cfg, 114.0, 100)).toBe(false);
    expect((1.1401 ** 2 - 1) * 100).toBeCloseTo(30, 0);
  });

  it('eat reach is R − r/3', () => {
    expect(eatReach(cfg, 300, 90, false)).toBe(270);
    expect(eatReach(cfg, 300, 90, true)).toBe(295.5);
  });

  it('decay is 0.2 % mass per second, floored at start size', () => {
    const c = cellOfMass(1000);
    expect((decayedRadius(cfg, c) ** 2) / 100).toBeCloseTo(998, 6);
    const small = cellOfMass(10);
    expect(decayedRadius(cfg, small)).toBe(small.r);
  });

  it('merge time is max(30 s, 0.2·r s)', () => {
    expect(mergeDelayTicks(cfg, cellOfMass(100))).toBe(30 * 25);
    expect(mergeDelayTicks(cfg, cellOfMass(40000))).toBeCloseTo(0.2 * 2000 * 25, 6);
  });

  it('zoom formula', () => {
    expect(viewScale(cfg, 31.6, 1920, 1080)).toBe(1);
    expect(viewScale(cfg, 1500, 1920, 1080)).toBeCloseTo(0.283, 3);
    expect(viewScale(cfg, 64, 960, 1080)).toBe(1);
  });

  it('densities scale with sphere area (R = 16000 ≈ 16× the reference area)', () => {
    expect(perSphere(cfg, 1000)).toBeCloseTo(16085, -2);
  });
});

describe('virus pop pieces', () => {
  const MIN = 30;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

  it('keeps the mass: pieces plus what the cell keeps, and the cell keeps at least one crumb', () => {
    const rng = createRng(3);
    for (const mass of [65, 200, 1100, 5000, 22500]) {
      for (const slots of [1, 2, 3, 4, 8, 15]) {
        const p = popPieces(mass, slots, MIN, rng);
        expect(p.length).toBeLessThanOrEqual(slots);
        expect(mass - sum(p)).toBeGreaterThanOrEqual(MIN - 1e-9);
        for (const m of p) expect(m).toBeGreaterThanOrEqual(MIN);
        for (const m of p) expect(m).toBeLessThanOrEqual(mass / 2 + 1e-9);
      }
    }
  });

  it('one free slot splits in half; too small or no room gives nothing', () => {
    expect(popPieces(400, 1, MIN, createRng(1))).toEqual([200]);
    expect(popPieces(50, 15, MIN, createRng(1))).toEqual([]);
    expect(popPieces(1000, 0, MIN, createRng(1))).toEqual([]);
  });

  it('a big cell with 15 free slots uses them all: a few chunks, then crumbs', () => {
    const p = popPieces(1100, 15, MIN, createRng(7));
    expect(p).toHaveLength(15);
    expect(p[0]).toBeGreaterThan(4 * MIN);
    expect(p.filter((m) => m === MIN).length).toBeGreaterThanOrEqual(10);
    // The chunks shrink one after another.
    const chunks = p.filter((m) => m > MIN);
    for (let k = 1; k < chunks.length; k++) expect(chunks[k]).toBeLessThan(chunks[k - 1]);
  });

  it('is deterministic for a seed', () => {
    expect(popPieces(5000, 15, MIN, createRng(11))).toEqual(popPieces(5000, 15, MIN, createRng(11)));
  });
});
