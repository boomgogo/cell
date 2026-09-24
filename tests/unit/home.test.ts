// The home cues fire — "home again" after a trip away, "around the world" after a full lap on the arcade
// sphere (the lap follows a great circle through the plains that misses every maze district).
import { describe, expect, it } from 'vitest';
import { HomeTracker, Trail } from '../../src/ui/home.ts';
import { dot, vec3 } from '../../src/sphere/vec3.ts';
import { addPlayer, arcadeWorld, offset } from './helpers.ts';

describe('home cues', () => {
  it('home again after leaving 8 000 units and coming back; no event for short trips', () => {
    const t = new HomeTracker(16000);
    const w = arcadeWorld();
    const home = vec3(0, 0, 1);
    t.reset(home);
    expect(t.update(offset(w, home, 5000, 0))).toBeNull();
    expect(t.update(offset(w, home, 300, 0))).toBeNull();
    expect(t.update(offset(w, home, 9000, 0))).toBeNull();
    expect(t.update(offset(w, home, 2000, 0))).toBeNull();
    expect(t.update(offset(w, home, 200, 0))).toBe('home');
    expect(t.returns).toBe(1);
    // Needs to leave again before it can fire again.
    expect(t.update(offset(w, home, 100, 0))).toBeNull();
  });

  it('a trip to the far side and back along the region borders fires "around the world"; the trail stays bounded', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const maze = w.maze;
    const { junctions, borders } = maze.layout;
    // Every great circle crosses some maze district (the icosahedron has no axis clear of its vertices), so the route
    // follows region borders, which lie entirely in the plains: junction 0 → its antipode → back.
    const same = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => dot(a, b) > 1 - 1e-9;
    const idx = (p: { x: number; y: number; z: number }) => junctions.findIndex((j) => same(j.p, p));
    const adj = junctions.map(() => [] as number[]);
    for (const b of borders) {
      adj[idx(b.p0)].push(idx(b.p1));
      adj[idx(b.p1)].push(idx(b.p0));
    }
    const target = junctions.findIndex((j) => dot(j.p, junctions[0].p) < -1 + 1e-9);
    const prev = new Array<number>(junctions.length).fill(-1);
    const queue = [0];
    prev[0] = 0;
    while (queue.length) {
      const a = queue.shift()!;
      for (const b of adj[a]) if (prev[b] < 0) (prev[b] = a), queue.push(b);
    }
    const out: number[] = [];
    for (let v = target; v !== 0; v = prev[v]) out.unshift(v);
    const route = [...out, ...out.slice(0, -1).reverse(), 0].map((k) => junctions[k].p);
    const start = junctions[0].p;
    let leg = 0;
    const org = addPlayer(w, start, 10, {
      update: (_w, o) => {
        const p = o.cells[0].p;
        if (leg < route.length - 1 && w.distance(p, route[leg]) < 150) leg++;
        Object.assign(o.target, route[leg]);
      },
    });
    const tracker = new HomeTracker(w.R);
    const trail = new Trail(w.R, 200);
    tracker.reset(start);
    const events: string[] = [];
    let farthest = 0;
    for (let t = 0; t < 25 * 60 * 12 && events.length === 0; t++) {
      w.step();
      const p = org.cells[0].p;
      if (t % 25 === 0) expect(maze.inInterior(p)).toBe(false);
      if (t % 5 === 0) {
        const e = tracker.update(p);
        if (e) events.push(e);
        trail.add(p);
        farthest = Math.max(farthest, tracker.distance(p));
      }
    }
    expect(farthest).toBeGreaterThan(0.95 * Math.PI * w.R);
    expect(events).toEqual(['lap']);
    expect(tracker.laps).toBe(1);
    expect(trail.count).toBeLessThanOrEqual(200);
    expect(trail.count).toBeGreaterThan(150);
  });
});
