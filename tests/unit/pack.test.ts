// A cell is never bigger than the widest way out from where it is — the escape field, the bug it fixes (cells
// that outgrew a corridor got wedged at a bend, a T-junction or a crossing), mass bookkeeping, release, and fairness.
import { describe, expect, it } from 'vitest';
import { arcadeConfig } from '../../src/config/arcade.ts';
import { populateNpcs, populateResidents } from '../../src/ai/population.ts';
import { type District, MASK_REGULAR } from '../../src/maze/district.ts';
import { MARGIN_TILES } from '../../src/maze/layout.ts';
import type { Cell } from '../../src/sim/cell.ts';
import type { PackEvent, UnpackEvent } from '../../src/sim/events.ts';
import { Organism } from '../../src/sim/organism.ts';
import { decayedPacked, packedRadius } from '../../src/sim/rules.ts';
import { World } from '../../src/sim/world.ts';
import { type Vec3, vec3 } from '../../src/sphere/vec3.ts';
import { arcadeWorld, offset } from './helpers.ts';

const TPS = 25;

/** Deterministic pick of n tiles from a list. */
function pick(list: number[], n: number, seed: number): number[] {
  let s = seed;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(list[s % list.length]);
  }
  return out;
}

/** Open interior tiles whose clearance is in [lo, hi) and whose escape radius is at least `minEscape`. */
function tilesWhere(d: District, lo: number, hi: number, minEscape = 0): number[] {
  const out: number[] = [];
  const G = d.G;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const t = j * G + i;
      if (d.solid(i, j, MASK_REGULAR) || !d.inInterior(i + 0.5, j + 0.5)) continue;
      if (d.tileClear[t] >= lo && d.tileClear[t] < hi && d.escape[t] >= minEscape) out.push(t);
    }
  }
  return out;
}

/**
 * Shortest 4-neighbour tile path from `start` to a tile with room for radius `full` and a way out as wide (or the
 * border), through tiles with room somewhere for the cell's body (radius `body`).
 */
function pathOut(d: District, start: number, body: number, full: number): number[] | null {
  const G = d.G;
  const prev = new Int32Array(G * G).fill(-2);
  prev[start] = -1;
  const queue = [start];
  for (let h = 0; h < queue.length; h++) {
    const t = queue[h];
    const i = t % G;
    const j = (t - i) / G;
    if ((d.escape[t] >= full + 2 && d.tileClear[t] >= full + 2) || i === 0 || j === 0 || i === G - 1 || j === G - 1) {
      const path: number[] = [];
      for (let k = t; k >= 0; k = prev[k]) path.push(k);
      return path.reverse();
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= G || nj >= G || d.solid(ni, nj, MASK_REGULAR)) continue;
      const n = nj * G + ni;
      if (prev[n] !== -2 || d.tileClear[n] < body - 1) continue;
      prev[n] = t;
      queue.push(n);
    }
  }
  return null;
}

const fullRadius = (c: Cell) => Math.sqrt(c.totalMass * 100);

/** Where a player steers through a tile: its widest spot (a corridor's centre line is often a tile edge). */
function steerPoint(d: District, tile: number, out: Vec3): Vec3 {
  const i = tile % d.G;
  const j = (tile - i) / d.G;
  let best = -1;
  let bx = i + 0.5;
  let by = j + 0.5;
  for (const ox of [0.5, 0, 1]) {
    for (const oy of [0.5, 0, 1]) {
      d.point(i + ox, j + oy, out);
      const c = d.clearance(out, 600, MASK_REGULAR);
      if (c > best + 1e-6) {
        best = c;
        bx = i + ox;
        by = j + oy;
      }
    }
  }
  return d.point(bx, by, out);
}

interface Trial {
  out: boolean;
  ticks: number;
  cell: Cell;
  org: Organism;
  fed: number;
}

/**
 * The bug: a cell starts on `tile` with `startMass`, eats pellets dropped on it until its total radius is
 * `r` (3 s, holding still), then steers along the shortest tile path to room for its full size. `out` = got there
 * within `seconds` (big cells are slow: r 540 covers about 150 units a second).
 */
function trial(dIndex: number, tile: number, startMass: number, r: number, human = false, seconds = 10, food = true): Trial {
  const w = arcadeWorld({ decayRate: 0 });
  const d = w.maze.district(dIndex);
  if (!food) {
    for (let i = 0; i < w.food.span; i++) w.food.remove(i);
    w.foodTarget = 0;
  }
  const G = d.G;
  const at = d.point((tile % G) + 0.5, Math.floor(tile / G) + 0.5, vec3());
  const target = vec3(at.x, at.y, at.z);
  const org = new Organism(w.newId(), 'test', 30, { update: (_w, o) => Object.assign(o.target, target) }, human);
  w.addOrganism(org);
  w.spawnOrganism(org, at, startMass);
  const cell = org.cells[0];
  const goal = (r * r) / 100;
  let fed = 0;
  for (let t = 0; t < 3 * TPS; t++) {
    const want = startMass + ((goal - startMass) * (t + 1)) / (3 * TPS) - cell.totalMass;
    for (let k = 0; k < Math.ceil(want); k++) {
      w.food.add(cell.p, 0);
      fed++;
    }
    w.step();
  }
  let path: number[] | null = null;
  let idx = 0;
  let wp = 0;
  for (let t = 0; t < seconds * TPS; t++) {
    if (!org.alive || org.cells.length !== 1) return { out: false, ticks: t, cell, org, fed };
    if (!d.locate(cell.p)) return { out: false, ticks: t, cell, org, fed };
    const cur = d.tileIndex(d.gx, d.gy);
    const full = fullRadius(cell);
    if (cur < 0 || (d.escape[cur] >= full + 2 && d.tileClear[cur] >= full + 2)) return { out: true, ticks: t, cell, org, fed };
    if (!path || path.indexOf(cur) < 0) {
      path = pathOut(d, cur, cell.r, full);
      idx = 0;
      wp = 0;
    }
    if (!path) return { out: false, ticks: t, cell, org, fed };
    idx = Math.max(idx, path.indexOf(cur));
    // Next waypoint along the path; once reached (the widest spot may be the tile's near edge), the one after it.
    wp = Math.min(Math.max(wp, idx + 1), path.length - 1);
    steerPoint(d, path[wp], target);
    if (w.distance(cell.p, target) < 30 && wp < path.length - 1) steerPoint(d, path[++wp], target);
    w.step();
  }
  return { out: false, ticks: seconds * TPS, cell, org, fed };
}

describe('escape field', () => {
  const w = arcadeWorld();

  it('matches the corridor sizes on all 12 districts: fine ≈ 68, coarse ≈ 273, avenue ring ≈ 535, open ∞, walls 0', () => {
    for (let k = 0; k < 12; k++) {
      const d = w.maze.district(k);
      const G = d.G;
      for (const t of tilesWhere(d, 1, 80)) {
        expect(d.escape[t]).toBeGreaterThanOrEqual(66);
        expect(d.escape[t]).toBeLessThanOrEqual(70);
      }
      // Coarse corridor centre tiles: the gates at the district edge are narrower than the corridors (the chart).
      for (const t of tilesWhere(d, 250, 290)) {
        expect(d.escape[t]).toBeGreaterThan(260);
        expect(d.escape[t]).toBeLessThanOrEqual(280);
      }
      // The avenue ring (clearance 560) only lets r ≈ 535 out through its gates.
      const ring = (MARGIN_TILES + 5) * G + Math.floor(G / 2);
      expect(d.tileClear[ring]).toBeGreaterThan(540);
      expect(d.escape[ring]).toBeGreaterThan(525);
      expect(d.escape[ring]).toBeLessThan(545);
      expect(d.escape[0]).toBe(Infinity);
      for (let t = 0; t < G * G; t++) {
        if (d.tiles[t] !== 0) expect(d.escape[t]).toBe(0);
        // Never more than the tile's own room.
        else if (d.escape[t] !== Infinity) expect(d.escape[t]).toBeLessThanOrEqual(d.tileClear[t]);
      }
    }
  });

  it('is deterministic and cheap', () => {
    const a = arcadeWorld().maze.district(4).escape;
    expect(arcadeWorld().maze.district(4).escape).toEqual(a);
    const d = w.maze.district(5) as unknown as { buildEscape(): Float32Array };
    d.buildEscape();
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) d.buildEscape();
    expect((performance.now() - t0) / 5).toBeLessThan(5);
  });

  it('connects the avenue ring to the plains in the class-2 labels', () => {
    for (let k = 0; k < 12; k++) {
      const d = w.maze.district(k);
      const ring = (MARGIN_TILES + 5) * d.G + Math.floor(d.G / 2);
      expect(d.labels[2][ring]).not.toBe(0);
      expect(d.labels[2][ring]).toBe(d.labels[2][0]);
    }
  });
});

describe('cells that outgrow their corridor get out (regression)', () => {
  for (const dIndex of [0, 4, 9]) {
    it(`fine corridors of district ${dIndex}: r 72, 90, 150, 250`, () => {
      const d = arcadeWorld().maze.district(dIndex);
      const tiles = pick(tilesWhere(d, 1, 80), 10, 1000 + dIndex);
      for (const r of [72, 90, 150, 250]) {
        for (const tile of tiles) {
          const res = trial(dIndex, tile, 25, r);
          expect(res.out, `tile ${tile % d.G},${Math.floor(tile / d.G)} r ${r}`).toBe(true);
          // Nothing lost: the total is what it ate (the start mass, the pellets and any maze dots on the way).
          expect(res.cell.totalMass).toBeGreaterThanOrEqual(25 + res.fed - 1e-6);
        }
      }
    });
  }

  it('cells that grew to just under the way out (they fit, so nothing is packed) get out too', () => {
    for (const dIndex of [0, 9]) {
      const d = arcadeWorld().maze.district(dIndex);
      for (const tile of pick(tilesWhere(d, 1, 80), 10, 500 + dIndex)) {
        const res = trial(dIndex, tile, 25, d.escape[tile] - 0.3, false, 10, false);
        expect(res.out, `tile ${tile % d.G},${Math.floor(tile / d.G)}`).toBe(true);
        expect(res.cell.packed).toBe(0);
      }
    }
  });

  it('coarse corridors (r 290–360) and big rooms whose way out is a coarse corridor (r 400)', () => {
    for (const dIndex of [1, 6]) {
      const d = arcadeWorld().maze.district(dIndex);
      for (const tile of pick(tilesWhere(d, 250, 290), 5, 77 + dIndex)) {
        for (const r of [290, 330, 360]) expect(trial(dIndex, tile, 225, r, false, 30).out, `coarse ${tile} r ${r}`).toBe(true);
      }
      const rooms = tilesWhere(d, 400, 600).filter((t) => d.escape[t] < 300);
      if (rooms.length) for (const tile of pick(rooms, 3, 5)) expect(trial(dIndex, tile, 225, 400, false, 30).out, `room ${tile}`).toBe(true);
    }
  });

  it('the avenue ring (r 540 and 555, bigger than its 535 gates)', () => {
    for (const dIndex of [2, 7]) {
      const d = arcadeWorld().maze.district(dIndex);
      const ring = pick(tilesWhere(d, 540, 700, 525), 4, 3 + dIndex);
      // Half-way round the ring to a gate can take over 30 s at this size.
      for (const tile of ring) for (const r of [540, 555]) expect(trial(dIndex, tile, 1600, r, false, 60).out, `ring ${tile} r ${r}`).toBe(true);
    }
  });
});

describe('packing rule', () => {
  const cfg = arcadeConfig;

  it('packedRadius: down to room − margin, back up by at most packRelease per tick, never into a wall', () => {
    expect(packedRadius(cfg, 90, 0, 69, 90)).toBe(68);
    expect(packedRadius(cfg, 60, 0, 69, 60)).toBe(60);
    // Still fits (within the margin): left alone, so wall-huggers don't pack slivers at tile edges.
    expect(packedRadius(cfg, 68.6, 0, 69, 68.6)).toBe(68.6);
    expect(packedRadius(cfg, 68.6, 5, 69, 100)).toBe(68.6);
    expect(packedRadius(cfg, 68, 40, Infinity, 100)).toBeCloseTo(68 * 1.04, 9);
    expect(packedRadius(cfg, 68, 0.5, Infinity, 100)).toBeCloseTo(Math.sqrt(68 * 68 + 50), 9);
    expect(packedRadius(cfg, 68, 40, 69, 68)).toBe(68);
    // Pressed into a wall: no growth this tick.
    expect(packedRadius(cfg, 68, 40, Infinity, 60)).toBe(68);
    // A room too small for a start-size cell (a centre pushed into a wall corner) is ignored.
    expect(packedRadius(cfg, 50, 0, 20, 50)).toBe(50);
  });

  function packedCellInPocket(opts: Partial<typeof arcadeConfig> = {}) {
    const w = arcadeWorld({ decayRate: 0, ...opts });
    const d = w.maze.district(4);
    const tile = pick(tilesWhere(d, 1, 80), 1, 42)[0];
    const at = d.point((tile % d.G) + 0.5, Math.floor(tile / d.G) + 0.5, vec3());
    const org = new Organism(w.newId(), 'p', 30, { update: (_w, o) => Object.assign(o.target, at) }, true);
    w.addOrganism(org);
    w.spawnOrganism(org, at, 200);
    w.step();
    return { w, d, org, cell: org.cells[0], at };
  }

  it('packs at once, keeps the total mass, and sends one pack event', () => {
    const { w, d, cell } = packedCellInPocket();
    d.locate(cell.p);
    expect(cell.r).toBeLessThanOrEqual(d.escapeAt(d.gx, d.gy) - 1 + 1e-9);
    expect(cell.totalMass).toBeGreaterThanOrEqual(200 - 1e-9);
    let packs = w.events.filter((e): e is PackEvent => e.type === 'pack').length;
    for (let t = 0; t < 20; t++) {
      w.step();
      packs += w.events.filter((e) => e.type === 'pack').length;
    }
    expect(packs).toBe(1);
  });

  it('decay shrinks packed mass at the normal rate', () => {
    const { w, cell } = packedCellInPocket({ decayRate: 0.002 });
    // No food at all (the food target includes the district's dots, so it would come back).
    for (let i = 0; i < w.food.span; i++) w.food.remove(i);
    w.foodTarget = 0;
    expect(decayedPacked(w.cfg, cell)).toBeCloseTo(cell.packed * 0.998, 9);
    const before = cell.totalMass;
    for (let t = 0; t < 10 * TPS; t++) w.step();
    expect(cell.totalMass).toBeCloseTo(before * 0.998 ** 10, 3);
    expect(cell.packed).toBeGreaterThan(0);
  });

  it('split keeps the packed mass on the parent; the organism keeps its total', () => {
    const { w, org, cell } = packedCellInPocket();
    const packed = cell.packed;
    const total = org.mass;
    w.splitOrganism(org);
    expect(org.cells).toHaveLength(2);
    expect(cell.packed).toBeCloseTo(packed, 9);
    expect(org.cells[1].packed).toBe(0);
    expect(org.mass).toBeCloseTo(total, 9);
  });

  it('eating a packed cell gives its total mass; merging adds both', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = w.maze.layout.junctions[0].p;
    const a = new Organism(w.newId(), 'a', 10, { update() {} }, false);
    const b = new Organism(w.newId(), 'b', 20, { update() {} }, false);
    w.addOrganism(a);
    w.addOrganism(b);
    w.spawnOrganism(a, at, 400);
    w.spawnOrganism(b, offset(w, at, 3000, 0), 100);
    const prey = b.cells[0];
    prey.packed = 60;
    const before = a.mass;
    w.consumeCell(a.cells[0], prey);
    expect(a.mass).toBeCloseTo(before + 160, 9);
    // Own cells merging: the same bookkeeping.
    const other = (w as unknown as { addPieceCell(o: Organism, p: Vec3, r: number): Cell }).addPieceCell(a, a.cells[0].p, 50);
    other.packed = 30;
    const total = a.mass;
    w.consumeCell(a.cells[0], other);
    expect(a.cells).toHaveLength(1);
    expect(a.mass).toBeCloseTo(total, 9);
  });

  it('an explosion hands the packed mass out with the pieces', () => {
    const { w, org, cell } = packedCellInPocket();
    const total = org.mass;
    const hero = new Organism(w.newId(), 'hero', 90, { update() {} }, false);
    w.addOrganism(hero);
    w.spawnOrganism(hero, w.maze.layout.junctions[1].p, 9);
    w.arcade!.grantRainbow(hero);
    expect(w.arcade!.explode(hero.cells[0], cell)).toBe(true);
    expect(org.cells.length).toBeGreaterThanOrEqual(5);
    expect(org.cells.reduce((s, c) => s + c.packed, 0)).toBe(0);
    expect(org.mass).toBeCloseTo(total, 6);
  });

  it('out in the open, packed mass comes back within 0.5 s with one unpack event', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const at = w.maze.layout.junctions[2].p;
    const org = new Organism(w.newId(), 'p', 30, { update: (_w, o) => Object.assign(o.target, at) }, true);
    w.addOrganism(org);
    w.spawnOrganism(org, at, (68 * 68) / 100);
    const cell = org.cells[0];
    cell.packed = 40;
    const total = cell.totalMass;
    const unpacks: UnpackEvent[] = [];
    for (let t = 0; t < Math.ceil(0.5 * TPS); t++) {
      w.step();
      unpacks.push(...w.events.filter((e): e is UnpackEvent => e.type === 'unpack'));
    }
    expect(cell.packed).toBe(0);
    expect(cell.totalMass).toBeCloseTo(total, 9);
    expect(unpacks).toHaveLength(1);
    expect(unpacks[0].cellId).toBe(cell.id);
  });
});

describe('fairness and the whole game', () => {
  it('the same overgrown cell comes out the same way for a human and for an NPC', () => {
    const d = arcadeWorld().maze.district(0);
    for (const tile of pick(tilesWhere(d, 1, 80), 3, 9)) {
      const human = trial(0, tile, 25, 120, true);
      const npc = trial(0, tile, 25, 120, false);
      expect(human.out).toBe(true);
      expect(npc.ticks).toBe(human.ticks);
      expect(npc.cell.r).toBe(human.cell.r);
      expect(npc.cell.packed).toBe(human.cell.packed);
      expect(npc.cell.p).toEqual(human.cell.p);
    }
  });

  it('in a 2-minute arcade arena, no cell ends a tick bigger than its way out', () => {
    const w = new World(arcadeConfig, { seed: 2 });
    const observer = vec3(0, 0, 1);
    while (w.maze.buildNext()) {}
    Object.assign(observer, w.maze.layout.regions[0].centre);
    w.observer = observer;
    populateNpcs(w, { count: 400, varyMass: true });
    populateResidents(w);
    let over = 0;
    let checked = 0;
    let packs = 0;
    for (let t = 0; t < 2 * 60 * TPS; t++) {
      if (t % (30 * TPS) === 0) Object.assign(observer, w.maze.layout.regions[(t / (30 * TPS)) % 12].centre);
      w.step();
      packs += w.events.filter((e) => e.type === 'pack').length;
      for (const c of w.cells) {
        if (!c.owner || c.removed) continue;
        const room = w.maze.roomAt(c.p);
        if (room === Infinity) continue;
        checked++;
        if (room > 0 && c.r > room + 1e-6) over++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(packs).toBeGreaterThan(0);
    expect(over).toBe(0);
  });
});
