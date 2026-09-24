// The jelly membrane: a damped wave on a ring of boundary points, dented where cells touch.
import { describe, expect, it } from 'vitest';
import { Membrane, type MembraneBody, stepMembrane } from '../../src/render/canvas/membrane.ts';

/** Small seeded LCG, uniform [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const still = () => 0.5;

function body(r: number, n: number, opts: Partial<MembraneBody> = {}): MembraneBody {
  const membrane = new Membrane();
  membrane.ensure(n, r);
  membrane.reset(r);
  return {
    membrane,
    lx: 0,
    ly: 0,
    r,
    roll: 0,
    agitated: false,
    spiky: false,
    contacts: [],
    walls: new Float32Array(0),
    wallCount: 0,
    ...opts,
  };
}

/** Two equal cells on the x axis overlapping by `overlap`·R, contacts wired both ways. */
function pair(r: number, n: number, overlap: number, opts: Partial<MembraneBody> = {}) {
  const a = body(r, n, opts);
  const b = body(r, n, { ...opts, lx: 2 * r - overlap * r });
  a.contacts.push(b);
  b.contacts.push(a);
  return { a, b };
}

const maxDev = (b: MembraneBody) => Math.max(...Array.from(b.membrane.rad, (x) => Math.abs(x - b.r)));
const mean = (a: Float32Array) => a.reduce((s, x) => s + x, 0) / a.length;

describe('membrane', () => {
  it('settles a displaced ring back to its radius within 2 s without noise', () => {
    for (const [r, n] of [
      [30, 10],
      [60, 60],
      [300, 120],
      [1500, 300],
    ]) {
      const b = body(r, n);
      const rand = lcg(3);
      const rad = b.membrane.rad;
      for (let i = 0; i < n; i++) rad[i] = r * (1 + 0.4 * (rand() - 0.5));
      rad[0] = r * 1.25;
      for (let t = 0; t < 120; t++) stepMembrane(b, still);
      expect(maxDev(b)).toBeLessThan(0.01 * r);
    }
  });

  it('keeps radii within [0.25R, 1.3R] under noise for 10 000 steps', () => {
    for (const agitated of [false, true]) {
      for (const [r, n] of [
        [30, 10],
        [30, 30],
        [1500, 300],
      ]) {
        const b = body(r, n, { agitated });
        const rand = lcg(11);
        let lo = Infinity;
        let hi = 0;
        for (let t = 0; t < 10000; t++) {
          stepMembrane(b, rand);
          for (const x of b.membrane.rad) {
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
        expect(lo).toBeGreaterThanOrEqual(0.25 * r);
        expect(hi).toBeLessThanOrEqual(1.3 * r * (1 + 1e-6));
        expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
      }
    }
  });

  it('wobbles by about a world unit whatever the size, livelier when agitated', () => {
    const rms = (r: number, n: number, agitated: boolean) => {
      const b = body(r, n, { agitated });
      const rand = lcg(5);
      let s = 0;
      let c = 0;
      for (let t = 0; t < 1200; t++) {
        stepMembrane(b, rand);
        if (t < 300) continue;
        for (const x of b.membrane.rad) {
          s += (x - r) ** 2;
          c++;
        }
      }
      return Math.sqrt(s / c);
    };
    for (const [r, n] of [
      [60, 60],
      [800, 200],
    ]) {
      const calm = rms(r, n, false);
      const lively = rms(r, n, true);
      expect(calm).toBeGreaterThan(0.4);
      expect(calm).toBeLessThan(0.9);
      expect(lively).toBeGreaterThan(2.5 * calm);
    }
  });

  it('dents touching rims a little, never crushes them, and leaves the far side alone', () => {
    // Just touching, no noise: a shallow dent facing the other cell, nothing on the far side.
    const touch = pair(60, 60, 0);
    for (let t = 0; t < 600; t++) {
      stepMembrane(touch.a, still);
      stepMembrane(touch.b, still);
    }
    const facing = touch.a.membrane.rad[0];
    expect(60 - facing).toBeGreaterThan(1);
    expect(60 - facing).toBeLessThan(6);
    expect(Math.abs(touch.a.membrane.rad[30] - 60)).toBeLessThan(0.1);

    // Overlapping, with noise: dented, but a 30 % overlap never flattens the rim.
    for (const [r, overlap, minDent] of [
      [60, 0.1, 2],
      [200, 0.1, 3],
      [200, 0.3, 1],
    ]) {
      const { a, b } = pair(r, 200 > r ? r : 200, overlap);
      const rand = lcg(7);
      let lowest = Infinity;
      let facingLowest = Infinity;
      for (let t = 0; t < 600; t++) {
        stepMembrane(a, rand);
        stepMembrane(b, rand);
        if (t < 300) continue;
        lowest = Math.min(lowest, ...a.membrane.rad);
        facingLowest = Math.min(facingLowest, a.membrane.rad[0]);
      }
      const n = a.membrane.n;
      expect(r - Math.min(...a.membrane.rad)).toBeGreaterThan(minDent);
      expect(lowest).toBeGreaterThanOrEqual(0.9 * r);
      expect(facingLowest).toBeGreaterThanOrEqual(0.9 * r);
      expect(Math.abs(a.membrane.rad[n / 2] - r)).toBeLessThan(3);
    }
  });

  it('springs back when the contact goes away', () => {
    const { a, b } = pair(60, 60, 0.1);
    for (let t = 0; t < 300; t++) {
      stepMembrane(a, still);
      stepMembrane(b, still);
    }
    expect(60 - a.membrane.rad[0]).toBeGreaterThan(2);
    a.contacts.length = 0;
    for (let t = 0; t < 60; t++) stepMembrane(a, still);
    expect(maxDev(a)).toBeLessThan(0.6);
  });

  it('moves with a change of the true radius instead of lagging behind it', () => {
    const b = body(60, 60);
    const rand = lcg(4);
    for (let t = 0; t < 120; t++) stepMembrane(b, rand);
    const before = mean(b.membrane.rad) - 60;
    for (const r of [85, 42]) {
      b.r = r;
      stepMembrane(b, still);
      expect(Math.abs(mean(b.membrane.rad) - r - before)).toBeLessThan(0.3);
    }
    b.membrane.reset(50);
    b.r = 50;
    stepMembrane(b, still);
    expect(maxDev(b)).toBeLessThan(1e-4);
  });

  it('is deterministic for the same random sequence', () => {
    const run = () => {
      const { a, b } = pair(120, 120, 0.15, { agitated: true });
      const rand = lcg(42);
      for (let t = 0; t < 500; t++) {
        stepMembrane(a, rand);
        stepMembrane(b, rand);
      }
      return [Array.from(a.membrane.rad), Array.from(a.membrane.vel)];
    };
    expect(run()).toEqual(run());
  });

  it('keeps the mean radius when ensure() resamples to a new point count', () => {
    const b = body(100, 100, { agitated: true });
    const rand = lcg(9);
    for (let t = 0; t < 400; t++) stepMembrane(b, rand);
    const m = b.membrane;
    const before = mean(m.rad);
    for (const n of [37, 260, 100]) {
      m.ensure(n, b.r);
      expect(m.n).toBe(n);
      expect(m.rad.length).toBe(n);
      expect(m.vel.length).toBe(n);
      expect(Math.abs(mean(m.rad) - before)).toBeLessThan(0.01 * before);
    }
  });

  it('does not dent spiky bodies (viruses)', () => {
    const virus = body(100, 48, { spiky: true });
    const cell = body(100, 100, { lx: 185 });
    virus.contacts.push(cell);
    cell.contacts.push(virus);
    for (let t = 0; t < 300; t++) {
      stepMembrane(virus, still);
      stepMembrane(cell, still);
    }
    expect(maxDev(virus)).toBeLessThan(1e-3);
    expect(100 - Math.min(...cell.membrane.rad)).toBeGreaterThan(2);
  });
});
