import { describe, expect, it } from 'vitest';
import { Frame } from '../../src/sphere/frame.ts';
import { angle, moveAlong, randomUnit, rotateToward, tangentToward, vec3, dot, transport } from '../../src/sphere/vec3.ts';
import { createRng } from '../../src/core/rng.ts';

const R = 16000;

describe('sphere math', () => {
  it('angle is symmetric and precise at tiny separations', () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i++) {
      const a = randomUnit(vec3(), rng);
      const b = randomUnit(vec3(), rng);
      expect(angle(a, b)).toBeCloseTo(angle(b, a), 12);
    }
    const p = vec3(0, 0, 1);
    const dir = vec3(1, 0, 0);
    const q = vec3(0, 0, 1);
    moveAlong(q, dir, 1e-7);
    expect(angle(p, q)).toBeCloseTo(1e-7, 14);
  });

  it('projection round-trips to < 1e-9 rad', () => {
    const rng = createRng(2);
    const f = new Frame(randomUnit(vec3(), rng));
    const out = { x: 0, y: 0 };
    const back = vec3();
    for (let i = 0; i < 500; i++) {
      const x = (rng() - 0.5) * 20000;
      const y = (rng() - 0.5) * 20000;
      const p = f.unproject(R, x, y, vec3());
      f.project(R, p, out);
      f.unproject(R, out.x, out.y, back);
      expect(angle(p, back)).toBeLessThan(1e-9);
      expect(out.x).toBeCloseTo(x, 6);
      expect(out.y).toBeCloseTo(y, 6);
    }
  });

  it('distance from the projection centre is exact', () => {
    const f = new Frame(vec3(0.3, -0.5, 0.81));
    const p = f.unproject(R, 3000, -4000, vec3());
    expect(R * angle(f.c, p)).toBeCloseTo(5000, 6);
  });

  it('moveAlong keeps the heading on one great circle and returns after a full lap', () => {
    const p = vec3(0.6, 0, 0.8);
    const start = vec3(p.x, p.y, p.z);
    const h = vec3();
    tangentToward(h, p, vec3(0, 1, 0));
    const h0 = vec3(h.x, h.y, h.z);
    const steps = 10000;
    for (let i = 0; i < steps; i++) moveAlong(p, h, (2 * Math.PI) / steps);
    expect(angle(p, start)).toBeLessThan(1e-9);
    expect(dot(h, h0)).toBeGreaterThan(1 - 1e-9);
  });

  it('a transported camera frame returns unrotated after a lap along a great circle', () => {
    const f = new Frame(vec3(1, 0, 0));
    const e0 = vec3(f.e.x, f.e.y, f.e.z);
    const p = vec3(1, 0, 0);
    const h = vec3(f.e.x, f.e.y, f.e.z);
    const steps = 5000;
    for (let i = 0; i < steps; i++) {
      moveAlong(p, h, (2 * Math.PI) / steps);
      f.moveTo(p);
    }
    expect(dot(f.e, e0)).toBeGreaterThan(1 - 1e-6);
  });

  it('rotateToward never overshoots', () => {
    const p = vec3(0, 0, 1);
    const q = vec3(Math.sin(0.01), 0, Math.cos(0.01));
    const moved = rotateToward(p, q, 0.5);
    expect(moved).toBeCloseTo(0.01, 12);
    expect(angle(p, q)).toBeLessThan(1e-12);
  });

  it('local charts match flat geometry within 0.1 % up to 1000 units', () => {
    const f = new Frame(vec3(0, 0.6, 0.8));
    const rng = createRng(3);
    const a2 = { x: 0, y: 0 };
    const b2 = { x: 0, y: 0 };
    for (let i = 0; i < 300; i++) {
      const a = f.unproject(R, (rng() - 0.5) * 1000, (rng() - 0.5) * 1000, vec3());
      const b = f.unproject(R, (rng() - 0.5) * 1000, (rng() - 0.5) * 1000, vec3());
      f.project(R, a, a2);
      f.project(R, b, b2);
      const flat = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      const surf = R * angle(a, b);
      if (surf > 50) expect(Math.abs(flat - surf) / surf).toBeLessThan(0.001);
    }
  });

  it('transport maps from→to and preserves perpendicularity', () => {
    const from = vec3(0, 0, 1);
    const to = vec3(0, Math.sin(0.3), Math.cos(0.3));
    const v = vec3(1, 0, 0);
    transport(v, from, to);
    expect(dot(v, to)).toBeCloseTo(0, 12);
  });
});
