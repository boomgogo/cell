// Arcade rules: maze food on the districts' dot spots, power pellet spots, and the rainbow
// state with its explosions. DOM-free; driven by World.
//
// Maze food is ordinary food: the same pellet as in the plains, kept on the dot spots so corridors keep
// their lines. It comes back like plains food: World's top-up drops new food at uniformly random spots on the sphere,
// and one that lands in a district fills a random empty dot spot there (`fillRandomSpot`).
import type { District } from '../maze/district.ts';
import { vec3 } from '../sphere/vec3.ts';
import { type Cell, PLAYER } from './cell.ts';
import { POWER, PELLET } from './food.ts';
import type { Organism } from './organism.ts';
import { fragmentMasses, isRainbow, ticksPerSecond } from './rules.ts';
import type { World } from './world.ts';

const POWER_HUE = 45;

export interface DistrictState {
  readonly d: District;
  /** Food index per dot spot, −1 when empty. */
  readonly spotFood: Int32Array;
  readonly total: number;
  /** Empty dot spots (the first `emptyCount` entries) and each spot's index in that list (−1 when filled). */
  readonly empty: Int32Array;
  readonly emptyAt: Int32Array;
  emptyCount: number;
  readonly powerFood: Int32Array;
  readonly powerRespawnAt: Float64Array;
}

export class Arcade {
  private readonly world: World;
  readonly states: (DistrictState | null)[] = new Array<DistrictState | null>(12).fill(null);
  private readonly tmp = vec3();
  private readonly dir = vec3();

  constructor(world: World) {
    this.world = world;
  }

  /** A freshly generated district starts with every dot spot filled and every power pellet up. */
  onDistrictBuilt(d: District): void {
    const total = d.maze.dots.length / 2;
    const st: DistrictState = {
      d,
      spotFood: new Int32Array(total).fill(-1),
      total,
      empty: new Int32Array(total),
      emptyAt: new Int32Array(total).fill(-1),
      emptyCount: 0,
      powerFood: new Int32Array(d.maze.power.length / 2).fill(-1),
      powerRespawnAt: new Float64Array(d.maze.power.length / 2),
    };
    this.states[d.index] = st;
    for (let k = 0; k < total; k++) this.fillSpot(st, k);
    for (let k = 0; k < st.powerFood.length; k++) this.spawnPower(st, k);
    this.world.foodTarget += total;
  }

  /** Food on dot spots currently alive in district i. */
  foodAlive(i: number): number {
    const st = this.states[i];
    return st ? st.total - st.emptyCount : 0;
  }

  /** Live power pellets in district i. */
  powerAlive(i: number): number {
    const st = this.states[i];
    if (!st) return 0;
    let n = 0;
    for (let k = 0; k < st.powerFood.length; k++) if (st.powerFood[k] >= 0) n++;
    return n;
  }

  private fillSpot(st: DistrictState, k: number): void {
    const w = this.world;
    const maze = st.d.maze;
    st.d.point(maze.dots[k * 2], maze.dots[k * 2 + 1], this.tmp);
    st.spotFood[k] = w.food.add(this.tmp, Math.floor(w.rng() * 360), PELLET, (st.d.index << 16) | k);
    const at = st.emptyAt[k];
    if (at >= 0) {
      const last = st.empty[--st.emptyCount];
      st.empty[at] = last;
      st.emptyAt[last] = at;
      st.emptyAt[k] = -1;
    }
  }

  /** Top-up: new food that landed in district i takes a random empty dot spot. False when none is empty. */
  fillRandomSpot(i: number): boolean {
    const st = this.states[i];
    if (!st || st.emptyCount === 0) return false;
    this.fillSpot(st, st.empty[Math.floor(this.world.rng() * st.emptyCount)]);
    return true;
  }

  private spawnPower(st: DistrictState, k: number): void {
    if (st.powerFood[k] >= 0) return;
    const maze = st.d.maze;
    st.d.point(maze.power[k * 2], maze.power[k * 2 + 1], this.tmp);
    st.powerFood[k] = this.world.food.add(this.tmp, POWER_HUE, POWER, (st.d.index << 16) | k);
  }

  /** Called by World before a maze food item or power pellet is removed. Returns extra area (r²) beyond a pellet. */
  onFoodEaten(i: number, cell: Cell): number {
    const w = this.world;
    const cfg = w.cfg;
    const food = w.food;
    const tag = food.tag[i];
    const st = tag >= 0 ? this.states[tag >> 16] : null;
    if (!st) return 0;
    const k = tag & 0xffff;
    if (food.kind[i] === POWER) {
      st.powerFood[k] = -1;
      // ± 25 % so the spots of a district don't come back in sync.
      st.powerRespawnAt[k] = w.tick + cfg.powerRespawnSeconds * (0.75 + 0.5 * w.rng()) * ticksPerSecond(cfg);
      if (cell.owner) this.grantRainbow(cell.owner);
      return cfg.powerPelletSize * cfg.powerPelletSize - food.radius * food.radius;
    }
    st.spotFood[k] = -1;
    st.emptyAt[k] = st.emptyCount;
    st.empty[st.emptyCount++] = k;
    return 0;
  }

  /** Rainbow for `org`; another pellet while rainbow restarts the clock and keeps the chain count. */
  grantRainbow(org: Organism): void {
    const w = this.world;
    if (!isRainbow(org, w.tick)) org.explodeCount = 0;
    org.rainbowUntil = w.tick + w.cfg.rainbowSeconds * ticksPerSecond(w.cfg);
    w.events.push({ type: 'rainbow', organismId: org.id, untilTick: org.rainbowUntil });
  }

  /**
   * `eater` (a rainbow cell) touched the bigger `victim`. The victim splits into pieces that stay its
   * own cells (like a virus pop): the cell keeps the largest chunk, the rest fly out. A victim too small to split (under
   * two minimum pieces, only ever touched by a crumb-sized rainbow cell) is eaten instead; one with no room for more
   * cells is knocked back. Returns true when it exploded.
   */
  explode(eater: Cell, victim: Cell): boolean {
    const w = this.world;
    const cfg = w.cfg;
    const org = eater.owner!;
    const vorg = victim.owner!;
    const grace = w.tick + cfg.explodeGraceTicks;
    victim.graceUntil = grace;
    const room = cfg.explodeMaxCells - vorg.cells.length;
    // The victim's packed mass is part of it and flies out with the pieces.
    const masses = fragmentMasses(cfg, victim.totalMass, eater.mass, room, w.rng);
    if (!masses && room >= 1) {
      w.explodeTooSmall++;
      w.consumeCell(eater, victim);
      return false;
    }
    if (!masses) {
      this.knockBack(eater, victim, cfg.explodeKnockback);
      w.explodeKnockbacks++;
      w.events.push({ type: 'bounce', cellId: victim.id, x: victim.p.x, y: victim.p.y, z: victim.p.z, r: victim.r, hue: victim.hue });
      return false;
    }
    w.events.push({
      type: 'explode',
      organismId: org.id,
      victimId: vorg.id,
      cellId: victim.id,
      x: victim.p.x,
      y: victim.p.y,
      z: victim.p.z,
      r: victim.r,
      hue: victim.hue,
      pieces: masses.length,
      k: org.explodeCount,
    });
    org.explodeCount++;
    const R0 = victim.r;
    victim.r = Math.sqrt(masses[0] * 100);
    victim.packed = 0;
    // Pieces leave in evenly spread directions (with jitter) and travel about 1.5 radii of the old cell.
    const base = w.rng() * Math.PI * 2;
    const n = masses.length - 1;
    const travel = Math.min(1500, 1.5 * R0 + 150);
    for (let k = 0; k < n; k++) {
      const a = base + ((k + 0.3 * (w.rng() - 0.5)) * Math.PI * 2) / n;
      w.randomTangent(this.dir, victim.p, a);
      const piece = w.addPieceCell(vorg, victim.p, Math.sqrt(masses[k + 1] * 100));
      piece.heading.x = this.dir.x;
      piece.heading.y = this.dir.y;
      piece.heading.z = this.dir.z;
      piece.boost = travel * (0.8 + 0.4 * w.rng());
      piece.graceUntil = grace;
    }
    return true;
  }

  private knockBack(from: Cell, c: Cell, boost: number): void {
    const h = c.heading;
    const d = from.p.x * c.p.x + from.p.y * c.p.y + from.p.z * c.p.z;
    h.x = c.p.x * d - from.p.x;
    h.y = c.p.y * d - from.p.y;
    h.z = c.p.z * d - from.p.z;
    const l = Math.hypot(h.x, h.y, h.z);
    if (l < 1e-12) return;
    h.x /= l;
    h.y /= l;
    h.z /= l;
    c.boost = boost;
  }

  /** Can rainbow cell `eater` explode `victim` (both player cells) right now, ignoring distance and walls? */
  static canExplode(eater: Cell, victim: Cell, tick: number): boolean {
    const org = eater.owner;
    const vorg = victim.owner;
    return (
      org !== null &&
      vorg !== null &&
      org !== vorg &&
      eater.kind === PLAYER &&
      victim.kind === PLAYER &&
      victim.r > eater.r &&
      isRainbow(org, tick) &&
      tick >= victim.graceUntil
    );
  }

  /** Once per second: power pellet spots come back. */
  tick(): void {
    const w = this.world;
    for (const st of this.states) {
      if (!st) continue;
      for (let k = 0; k < st.powerFood.length; k++) {
        if (st.powerFood[k] < 0 && w.tick >= st.powerRespawnAt[k]) this.spawnPower(st, k);
      }
    }
  }
}
