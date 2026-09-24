// Maze generator invariants, region layout, wall geometry, gating, tunnelling, squeeze, placement.
import { describe, expect, it } from 'vitest';
import { arcadeConfig } from '../../src/config/arcade.ts';
import { MASK_GHOST, MASK_REGULAR } from '../../src/maze/district.ts';
import { DOOR, OPEN, PEN, SOLID, generateMaze, validateMaze } from '../../src/maze/generate.ts';
import { MARGIN_TILES, RegionLayout, interiorTiles } from '../../src/maze/layout.ts';
import { MazeWorld } from '../../src/maze/walls.ts';
import { Cell, EJECTED } from '../../src/sim/cell.ts';
import { Organism } from '../../src/sim/organism.ts';
import { ghostSpecies } from '../../src/sim/species.ts';
import { angle, vec3 } from '../../src/sphere/vec3.ts';
import { populateNpcs } from '../../src/ai/population.ts';
import { World } from '../../src/sim/world.ts';
import { addPlayer, arcadeWorld, steerTo } from './helpers.ts';

describe('maze generator', () => {
  it('is deterministic per seed', () => {
    expect(generateMaze(7, 5).tiles).toEqual(generateMaze(7, 5).tiles);
    expect(generateMaze(7, 5).tiles).not.toEqual(generateMaze(7, 6).tiles);
  });

  it('satisfies the invariants for many seeds (symmetric, connected, no dead ends, pockets, dots)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const m = generateMaze(7, seed * 97);
      expect(validateMaze(m)).toEqual([]);
      expect(m.pockets).toBeGreaterThanOrEqual(4);
      expect(m.dots.length / 2).toBeGreaterThan(800);
      expect(m.size).toBe(interiorTiles(7) + 2 * MARGIN_TILES);
      // Pen interior and door exist.
      expect(m.tiles.includes(PEN)).toBe(true);
      expect(m.tiles.filter((t) => t === DOOR).length).toBe(4);
    }
  });

  it('builds a full district (generation + clearance + labels) quickly', () => {
    const mw = new MazeWorld(arcadeConfig);
    mw.district(0); // warm-up
    const t0 = performance.now();
    for (let i = 1; i < 12; i++) mw.district(i);
    expect((performance.now() - t0) / 11).toBeLessThan(40);
  });
});

describe('region layout', () => {
  const layout = new RegionLayout(arcadeConfig);

  it('has 12 regions, 30 borders and 20 junctions with distinct hues far apart for neighbours', () => {
    expect(layout.regions).toHaveLength(12);
    expect(layout.borders).toHaveLength(30);
    expect(layout.junctions).toHaveLength(20);
    expect(new Set(layout.regions.map((r) => r.hue)).size).toBe(12);
    for (const r of layout.regions) {
      expect(r.neighbours).toHaveLength(5);
      for (const n of r.neighbours) {
        const d = Math.abs(r.hue - layout.regions[n].hue);
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('fits 7-pillar districts at R = 16 000 and none on small spheres', () => {
    expect(layout.pillars).toBe(7);
    expect(new RegionLayout({ ...arcadeConfig, sphereRadius: 8000 }).pillars).toBe(0);
    // District grid corners (margin included) stay inside their own region.
    const mw = new MazeWorld(arcadeConfig);
    for (let i = 0; i < 12; i++) {
      const d = mw.district(i);
      for (const [gx, gy] of [[0, 0], [d.G, 0], [0, d.G], [d.G, d.G]]) {
        expect(layout.regionAt(d.point(gx, gy, vec3()))).toBe(i);
      }
    }
  });
});

describe('district geometry', () => {
  const mw = new MazeWorld(arcadeConfig);
  const d = mw.district(3);
  const R = arcadeConfig.sphereRadius;

  it('round-trips grid coordinates', () => {
    const p = vec3();
    for (const [gx, gy] of [[0, 0], [43.25, 12.5], [85.9, 70.1]]) {
      d.point(gx, gy, p);
      d.locate(p);
      expect(d.gx).toBeCloseTo(gx, 9);
      expect(d.gy).toBeCloseTo(gy, 9);
    }
  });

  it('measures exact distances to walls (perimeter wall seen from the margin)', () => {
    const p = vec3();
    // Top perimeter row is grid row MARGIN; a point 3.3 tiles above it in a solid stretch of the wall.
    const gx = 20.5;
    expect(d.tile(Math.floor(gx), MARGIN_TILES)).toBe(SOLID);
    d.point(gx, MARGIN_TILES - 3.3, p);
    d.collide(p, 600, MASK_REGULAR, null);
    const onWall = d.point(gx, MARGIN_TILES, vec3());
    const approx = R * angle(p, onWall);
    expect(d.dB).toBeLessThanOrEqual(approx + 1e-6);
    expect(d.dB).toBeGreaterThan(approx * 0.99);
    expect(d.dB).toBeGreaterThan(3.3 * 140 * 0.95);
  });

  it('blocks line of sight through walls but not along corridors', () => {
    const a = d.point(20.5, MARGIN_TILES - 1.5, vec3());
    const b = d.point(20.5, MARGIN_TILES + 1.5, vec3());
    const c = d.point(30.5, MARGIN_TILES - 1.5, vec3());
    expect(mw.blocked(a, b)).toBe(true);
    expect(mw.blocked(a, c)).toBe(false);
  });
});

/** Gate on the top perimeter wall: [x0, x1) grid columns. */
const GATES = [
  { name: 'fine', x0: MARGIN_TILES + 4, width: 1 },
  { name: 'coarse', x0: MARGIN_TILES + Math.floor(interiorTiles(7) / 4) - 2, width: 4 },
  { name: 'avenue', x0: MARGIN_TILES + interiorTiles(7) / 2 - 4, width: 8 },
];

describe('walls in the simulation', () => {
  for (const gate of GATES) {
    it(`${gate.name} gate (${gate.width * 140} wide) lets cells with 2r < width through and stops bigger ones`, () => {
      for (const passes of [true, false]) {
        let radius: number;
        const w = arcadeWorld({ decayRate: 0, cornerAssist: 0 });
        const d = w.maze.district(0);
        const xc = gate.x0 + gate.width / 2;
        // True world width between the gate's corners (the chart shrinks widths along the district edge by ≤ 5 %).
        const worldWidth = w.R * angle(d.point(gate.x0, MARGIN_TILES, vec3()), d.point(gate.x0 + gate.width, MARGIN_TILES, vec3()));
        radius = passes ? worldWidth / 2 - 6 : (worldWidth / 2) * 1.03 + 2;
        const start = d.point(xc, MARGIN_TILES - radius / 140 - 1.2, vec3());
        const target = d.point(xc, MARGIN_TILES + 6, vec3());
        const org = steerTo(w, start, (radius * radius) / 100, target);
        // Its gate tiles must actually be open.
        for (let i = gate.x0; i < gate.x0 + gate.width; i++) expect(d.tile(i, MARGIN_TILES)).toBe(OPEN);
        let maxY = -Infinity;
        for (let t = 0; t < 25 * 20; t++) {
          w.step();
          d.locate(org.cells[0].p);
          maxY = Math.max(maxY, d.gy);
        }
        if (passes) expect(maxY).toBeGreaterThan(MARGIN_TILES + 2);
        else expect(maxY).toBeLessThan(MARGIN_TILES + 0.5);
      }
    });
  }

  it('boosted ejected mass never tunnels through a wall and bounces back', () => {
    const w = arcadeWorld();
    const d = w.maze.district(1);
    for (let k = 0; k < 64; k++) {
      const a = ((k / 63) * 2 - 1) * (Math.PI * 0.42);
      // A solid stretch of the top perimeter between the fine and coarse gates.
      const p = d.point(MARGIN_TILES + 10.5, MARGIN_TILES - 0.9, vec3());
      const ej = new Cell(w.newId(), EJECTED, p, 40, 0, null, w.tick);
      const right = vec3();
      const down = vec3();
      d.axes(p, right, down);
      ej.heading.x = down.x * Math.cos(a) + right.x * Math.sin(a);
      ej.heading.y = down.y * Math.cos(a) + right.y * Math.sin(a);
      ej.heading.z = down.z * Math.cos(a) + right.z * Math.sin(a);
      ej.boost = 780;
      (w as unknown as { addCell(c: Cell): void }).addCell(ej);
      let maxY = -Infinity;
      for (let t = 0; t < 40; t++) {
        w.step();
        d.locate(ej.p);
        maxY = Math.max(maxY, d.gy);
      }
      expect(maxY).toBeLessThan(MARGIN_TILES);
      // Bounced: resting clear of the wall face (r = 40 → touching at MARGIN − 0.29).
      expect(d.gy).toBeLessThan(MARGIN_TILES - 0.3);
    }
  });

  it('a split fired at a wall stops at it', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(2);
    const start = d.point(MARGIN_TILES + 20.5, MARGIN_TILES - 3, vec3());
    const target = d.point(MARGIN_TILES + 20.5, MARGIN_TILES + 20, vec3());
    const org = steerTo(w, start, 400, target);
    org.wantSplit = true;
    for (let t = 0; t < 50; t++) {
      w.step();
      for (const c of org.cells) {
        d.locate(c.p);
        expect(d.gy).toBeLessThan(MARGIN_TILES);
      }
    }
    expect(org.cells).toHaveLength(2);
  });

  it('a cell too big for its corridor packs to fit the way out, stays centred and keeps its mass', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(4);
    // Find a vertical fine corridor tile: walls left and right, open above and below.
    let tile: [number, number] | null = null;
    for (let j = 1; j < d.G - 1 && !tile; j++) {
      for (let i = 1; i < d.G - 1; i++) {
        if (d.tile(i, j) === OPEN && d.tile(i - 1, j) === SOLID && d.tile(i + 1, j) === SOLID && d.tile(i, j - 1) === OPEN && d.tile(i, j + 1) === OPEN && d.tile(i - 1, j - 1) === SOLID && d.tile(i + 1, j + 1) === SOLID) {
          tile = [i, j];
          break;
        }
      }
    }
    expect(tile).not.toBeNull();
    const [i, j] = tile!;
    const p = d.point(i + 0.5, j + 0.5, vec3());
    const org = addPlayer(w, p, 81); // r 90 in a 140-wide corridor
    const hold = vec3(p.x, p.y, p.z);
    org.controller = { update: (_w, o) => Object.assign(o.target, hold) };
    for (let t = 0; t < 10; t++) w.step();
    const settled = vec3(org.cells[0].p.x, org.cells[0].p.y, org.cells[0].p.z);
    for (let t = 0; t < 50; t++) {
      w.step();
      expect(w.R * angle(org.cells[0].p, settled)).toBeLessThan(1);
    }
    const c = org.cells[0];
    d.locate(c.p);
    expect(Math.abs(d.gx - (i + 0.5))).toBeLessThan(0.05);
    // Packed down to just under the widest way out, so it fits: no squeeze, nothing lost (dots eaten on top).
    expect(c.r).toBeLessThanOrEqual(d.escapeAt(d.gx, d.gy) - w.cfg.packMargin + 1e-9);
    expect(c.squeeze).toBe(1);
    expect(c.packed).toBeGreaterThan(0);
    expect(c.totalMass).toBeGreaterThanOrEqual(81 - 1e-9);
  });

  it('pen doors stop regular cells and let ghosts out', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(5);
    const [px, py] = d.maze.pen;
    const [ex, ey] = d.maze.penExit;
    const penTop = py - 6;
    const inside = d.point(px, py, vec3());
    const exit = d.point(ex, ey, vec3());
    const regular = steerTo(w, exit, 36, inside); // r 60: too big for the ghost to eat
    const ghost = new Organism(w.newId(), 'ghost', 0, { update: (_w, o) => Object.assign(o.target, exit) }, false);
    ghost.species = ghostSpecies(1.25);
    w.addOrganism(ghost);
    w.spawnOrganism(ghost, inside, 30);
    for (let t = 0; t < 25 * 10; t++) {
      w.step();
      d.locate(regular.cells[0].p);
      expect(d.gy).toBeLessThan(penTop + 0.01);
    }
    d.locate(ghost.cells[0].p);
    expect(d.gy).toBeLessThan(penTop);
  });

  it('never puts food, viruses or NPC spawns inside mazes, and wakes NPCs where they fit', () => {
    const w = new World({ ...arcadeConfig, foodPerRefArea: 700 }, { seed: 3 });
    const npcs = populateNpcs(w, { count: 200 });
    const p = vec3();
    for (let i = 0; i < w.food.span; i++) {
      // Maze food sits on the dot spots; plains pellets never land in a maze.
      if (!w.food.alive[i] || w.food.tag[i] >= 0) continue;
      p.x = w.food.x[i];
      p.y = w.food.y[i];
      p.z = w.food.z[i];
      expect(w.maze.inInterior(p)).toBe(false);
    }
    for (const c of w.cells) expect(w.maze.inInterior(c.p)).toBe(false);
    for (const o of npcs) if (!o.dormant) expect(o.cells.every((c) => !w.maze.inInterior(c.p))).toBe(true);
    // A dormant NPC that wandered into a wall wakes up somewhere free.
    const d = w.maze.district(6);
    const npc = new Organism(w.newId(), 'npc', 0, { update() {} }, false);
    w.addOrganism(npc);
    w.observer = d.point(d.G / 2, d.G / 2, vec3());
    w.spawnOrganism(npc, d.point(MARGIN_TILES + 20.5, MARGIN_TILES + 0.5, vec3()), 50);
    // spawnOrganism with an explicit spot inside the active zone creates a cell; force the dormant path instead.
    for (const c of npc.cells.slice()) (w as unknown as { removeCell(c: Cell): void }).removeCell(c);
    npc.dormant = true;
    npc.dormantMass = 50;
    d.point(MARGIN_TILES + 20.5, MARGIN_TILES + 0.5, npc.dormantP);
    w.step();
    for (let t = 0; t < 25; t++) w.step();
    expect(npc.dormant).toBe(false);
    expect(w.maze.isFree(npc.cells[0].p, npc.cells[0].r * 0.99)).toBe(true);
  });

  it('base preset has no walls', () => {
    const w = new World({ ...arcadeConfig, mazes: false, foodPerRefArea: 0, npcPerRefArea: 0 }, { seed: 1 });
    expect(w.maze.enabled).toBe(false);
    expect(w.arcade).toBeNull();
    expect(MASK_GHOST).not.toBe(MASK_REGULAR);
  });
});
