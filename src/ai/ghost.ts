// Resident maze ghosts: scatter/chase cycles per district, four chase styles, flight from smaller
// rainbow cells, and leaving the pen through its door. Movement follows the radius-aware path flood toward a
// target tile.
import { MASK_GHOST, type District } from '../maze/district.ts';
import { PEN, DOOR } from '../maze/generate.ts';
import { sharedFlood } from '../maze/nav.ts';
import type { Cell } from '../sim/cell.ts';
import type { Controller } from '../sim/controller.ts';
import type { GhostStyle, Organism } from '../sim/organism.ts';
import { isRainbow, ticksPerSecond } from '../sim/rules.ts';
import type { World } from '../sim/world.ts';
import { type Vec3, vec3 } from '../sphere/vec3.ts';

const THINK_TICKS = 4;
/** Ghosts flee rainbow cells smaller than themselves within this distance. */
const FLEE_RANGE = 1500;
const SCATTER_CORNER: Record<GhostStyle, number> = { chaser: 0, ambusher: 1, flanker: 2, shy: 3 };

export const ghostStats = { thinks: 0, chase: 0, scatter: 0, flee: 0, deferred: 0 };

export class GhostController implements Controller {
  readonly style: GhostStyle;
  private readonly phase: number;
  private pending = false;
  private readonly tmp = vec3();
  /** Current mode, for debugging and tests. */
  mode: 'pen' | 'scatter' | 'chase' | 'flee' | 'idle' = 'idle';
  /** Target tile chosen at the last think (grid coordinates). */
  targetX = 0;
  targetY = 0;
  /** Chase diagnostics: sum and count of target-to-prey distances (tiles), per style differences show here. */
  chaseOffsetSum = 0;
  chaseCount = 0;

  constructor(style: GhostStyle, phase: number) {
    this.style = style;
    this.phase = phase;
  }

  update(world: World, org: Organism): void {
    if (!this.pending && (world.tick + this.phase) % THINK_TICKS !== 0) return;
    const res = org.resident;
    const cell = org.cells[0];
    if (!res || !cell || !world.maze.enabled) return;
    // Ghosts use A* toward one goal (a few hundred tiles at most), so they have their own, larger allowance.
    if (world.maze.ghostBudget <= 0) {
      this.pending = true;
      ghostStats.deferred++;
      return;
    }
    this.pending = false;
    world.maze.ghostBudget--;
    ghostStats.thinks++;
    const d = world.maze.district(res.district);
    if (!d.locate(cell.p)) return;
    const gx = d.gx;
    const gy = d.gy;
    const G = d.G;
    const start = d.tileIndex(gx, gy);
    if (start < 0) {
      // Wandered out of the grid: head back to the district centre.
      d.point(d.maze.penExit[0], d.maze.penExit[1], org.target);
      return;
    }
    const flood = sharedFlood;
    const cfg = world.cfg;
    const tps = ticksPerSecond(cfg);
    const tile = d.tiles[start];
    let tx: number;
    let ty: number;
    const threat = tile === PEN || tile === DOOR ? null : this.rainbowThreat(world, org, cell);
    if (tile === PEN || tile === DOOR) {
      this.mode = 'pen';
      [tx, ty] = d.maze.penExit;
    } else if (threat) {
      this.mode = 'flee';
      ghostStats.flee++;
      flood.run(d, start, cell.r, MASK_GHOST, 400, 10);
      [tx, ty] = this.fleeTarget(world, d, threat);
    } else {
      const cycle = cfg.scatterSeconds + cfg.chaseSeconds;
      const t = (world.tick / tps + res.district * 1.7) % cycle;
      const prey = t >= cfg.scatterSeconds ? this.pickPrey(world, d, org, cell, start) : null;
      if (prey) {
        this.mode = 'chase';
        ghostStats.chase++;
        [tx, ty] = this.chaseTarget(world, d, org, prey);
        d.locate(prey.p);
        this.chaseOffsetSum += Math.hypot(tx - d.gx, ty - d.gy);
        this.chaseCount++;
      } else {
        this.mode = 'scatter';
        ghostStats.scatter++;
        [tx, ty] = d.maze.corners[SCATTER_CORNER[this.style]];
      }
    }
    this.targetX = tx;
    this.targetY = ty;

    // Goal: the target tile, or the nearest tile around it with room for us; then A* toward it.
    let goal = this.passableNear(d, tx, ty, cell.r);
    if (this.mode !== 'flee') flood.run(d, start, cell.r, MASK_GHOST, 2500, Infinity, goal);
    if (goal < 0 || !flood.reached(goal)) {
      let best = Infinity;
      goal = -1;
      for (let k = 0; k < flood.count; k++) {
        const v = flood.list[k];
        const vi = v % G;
        const vj = (v - vi) / G;
        const dd = (vi + 0.5 - tx) ** 2 + (vj + 0.5 - ty) ** 2;
        if (dd < best) {
          best = dd;
          goal = v;
        }
      }
    }
    if (goal < 0) return;
    if (goal === start) {
      d.point(tx, ty, org.target);
      return;
    }
    const hop = flood.stepToward(goal, 3);
    const hi = hop % G;
    const hj = (hop - hi) / G;
    d.point(hi + 0.5, hj + 0.5, this.tmp);
    extend(cell.p, this.tmp, 300 / world.R, org.target);
  }

  /** The nearest rainbow organism with a cell smaller than ours within FLEE_RANGE (it would explode us), or null. */
  private rainbowThreat(world: World, org: Organism, cell: Cell): Organism | null {
    let best: Organism | null = null;
    let bestD = FLEE_RANGE;
    for (const o of world.rainbows()) {
      if (o === org) continue;
      for (const c of o.cells) {
        if (c.r >= cell.r) continue;
        const d = world.distance(c.p, cell.p);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
    }
    return best;
  }

  /** Tile at (tx, ty) clamped to the grid, or the nearest tile within 6 with room for radius r (−1 if none). */
  private passableNear(d: District, tx: number, ty: number, r: number): number {
    const G = d.G;
    const ci = Math.max(0, Math.min(G - 1, Math.floor(tx)));
    const cj = Math.max(0, Math.min(G - 1, Math.floor(ty)));
    for (let ring = 0; ring <= 6; ring++) {
      for (let j = cj - ring; j <= cj + ring; j++) {
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (i < 0 || j < 0 || i >= G || j >= G) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if (d.tileClear[j * G + i] >= r) return j * G + i;
        }
      }
    }
    return -1;
  }

  /** Most attractive edible cell in this district that the ghost can reach (the human counts double), or null. */
  private pickPrey(world: World, d: District, org: Organism, cell: Cell, start: number): Cell | null {
    const cfg = world.cfg;
    const labels = d.labels[d.classOf(cell.r)];
    const mine = labels[start];
    d.locate(cell.p);
    const gx = d.gx;
    const gy = d.gy;
    let best: Cell | null = null;
    let bestScore = 0;
    for (const o of world.organisms) {
      // Rainbow cells are never prey: touching one explodes the ghost.
      if (!o.alive || o.dormant || o.resident || o === org || isRainbow(o, world.tick)) continue;
      for (const c of o.cells) {
        if (cell.r < c.r * cfg.eatSizeRatio) continue;
        if (!d.locate(c.p)) continue;
        const t = d.tileIndex(d.gx, d.gy);
        if (t < 0) continue;
        // Reachable through corridors the ghost fits (a ghost still in its pen has no label yet).
        if (mine !== 0 && labels[t] !== mine) continue;
        const dist = Math.hypot(d.gx - gx, d.gy - gy);
        if (dist > 40) continue;
        const score = (o.isHuman ? 2 : 1) / (1 + dist);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    return best;
  }

  private chaseTarget(world: World, d: District, org: Organism, prey: Cell): [number, number] {
    d.locate(prey.p);
    const px = d.gx;
    const py = d.gy;
    // Prey heading in grid units per tick.
    d.locate(prey.prev);
    let hx = px - d.gx;
    let hy = py - d.gy;
    const hl = Math.hypot(hx, hy);
    if (hl > 1e-6) {
      hx /= hl;
      hy /= hl;
    } else {
      hx = 0;
      hy = -1;
    }
    switch (this.style) {
      case 'ambusher':
        return [px + hx * 4, py + hy * 4];
      case 'flanker': {
        const ax = px + hx * 2;
        const ay = py + hy * 2;
        const chaser = world.organisms.find((o) => o.alive && !o.dormant && o.resident?.district === org.resident!.district && o.resident.style === 'chaser' && o.cells.length > 0);
        if (!chaser) return [px, py];
        d.locate(chaser.cells[0].p);
        return [ax + (ax - d.gx), ay + (ay - d.gy)];
      }
      case 'shy': {
        const cell = org.cells[0];
        d.locate(cell.p);
        if (Math.hypot(px - d.gx, py - d.gy) > 8) return [px, py];
        return d.maze.corners[SCATTER_CORNER.shy];
      }
      default:
        return [px, py];
    }
  }

  /** A reachable tile a few tiles away that maximises distance from the threatening organism. */
  private fleeTarget(world: World, d: District, threat: Organism): [number, number] {
    const c = threat.largestCell();
    const G = d.G;
    if (!c || !d.locate(c.p)) return d.maze.corners[SCATTER_CORNER[this.style]];
    const ax = d.gx;
    const ay = d.gy;
    let best = -1;
    let bestD = -Infinity;
    const flood = sharedFlood;
    for (let k = 0; k < flood.count; k++) {
      const v = flood.list[k];
      if (flood.cost[v] > 10) break;
      const vi = v % G;
      const vj = (v - vi) / G;
      const dd = (vi + 0.5 - ax) ** 2 + (vj + 0.5 - ay) ** 2 + world.rng() * 4;
      if (dd > bestD) {
        bestD = dd;
        best = v;
      }
    }
    if (best < 0) return d.maze.corners[SCATTER_CORNER[this.style]];
    const bi = best % G;
    return [bi + 0.5, (best - bi) / G + 0.5];
  }
}

/** Point `ang` radians beyond b along the great circle from a through b. */
function extend(a: Vec3, b: Vec3, ang: number, out: Vec3): Vec3 {
  let tx = b.x - (a.x * b.x + a.y * b.y + a.z * b.z) * a.x;
  let ty = b.y - (a.x * b.x + a.y * b.y + a.z * b.z) * a.y;
  let tz = b.z - (a.x * b.x + a.y * b.y + a.z * b.z) * a.z;
  const l = Math.hypot(tx, ty, tz);
  if (l < 1e-12) {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    return out;
  }
  tx /= l;
  ty /= l;
  tz /= l;
  const base = Math.atan2(l, a.x * b.x + a.y * b.y + a.z * b.z);
  const t = base + ang;
  out.x = a.x * Math.cos(t) + tx * Math.sin(t);
  out.y = a.y * Math.cos(t) + ty * Math.sin(t);
  out.z = a.z * Math.cos(t) + tz * Math.sin(t);
  return out;
}
