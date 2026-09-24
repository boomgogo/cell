import { describe, expect, it } from 'vitest';
import { Grid3 } from '../../src/sphere/hash3.ts';
import { createRng } from '../../src/core/rng.ts';
import { angle, randomUnit, vec3 } from '../../src/sphere/vec3.ts';

describe('Grid3', () => {
  it('query returns a superset of everything within surface distance', () => {
    const R = 16000;
    const rng = createRng(5);
    const grid = new Grid3(256, R, true);
    const pts = Array.from({ length: 20000 }, () => randomUnit(vec3(), rng));
    pts.forEach((p, i) => grid.insert(i, p.x * R, p.y * R, p.z * R, 10));
    for (let t = 0; t < 20; t++) {
      const q = pts[Math.floor(rng() * pts.length)];
      const radius = 300 + rng() * 2000;
      const found = new Set<number>();
      grid.query(q.x * R, q.y * R, q.z * R, radius, (id) => found.add(id));
      pts.forEach((p, i) => {
        if (R * angle(p, q) <= radius) expect(found.has(i)).toBe(true);
      });
    }
  });

  it('remove and clear', () => {
    const grid = new Grid3(256, 1000, true);
    grid.insert(1, 10, 20, 990, 5);
    grid.insert(2, 12, 22, 990, 5);
    expect(grid.remove(1, 10, 20, 990)).toBe(true);
    const seen: number[] = [];
    grid.query(10, 20, 990, 50, (id) => seen.push(id));
    expect(seen).toEqual([2]);
    grid.clear();
    seen.length = 0;
    grid.query(10, 20, 990, 50, (id) => seen.push(id));
    expect(seen).toEqual([]);
  });
});

describe('Grid3 shell scan', () => {
  it('never visits an id twice and finds everything for huge query radii', () => {
    const R = 4000;
    const rng = createRng(9);
    const grid = new Grid3(256, R, false);
    const pts = Array.from({ length: 5000 }, () => randomUnit(vec3(), rng));
    pts.forEach((p, i) => grid.insert(i, p.x * R, p.y * R, p.z * R, 10));
    for (const q of [vec3(0, 0, 1), vec3(1, 0, 0), vec3(0.577, 0.577, 0.577), vec3(0, -0.6, 0.8)]) {
      for (const radius of [100, 3000, 9000, 1e7]) {
        const seen = new Map<number, number>();
        grid.query(q.x * R, q.y * R, q.z * R, radius, (id) => seen.set(id, (seen.get(id) ?? 0) + 1));
        for (const n of seen.values()) expect(n).toBe(1);
        pts.forEach((p, i) => {
          if (R * angle(p, q) <= radius) expect(seen.has(i)).toBe(true);
        });
      }
    }
  });
});
