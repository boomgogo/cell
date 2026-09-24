// The DOM-free simulation: fixed 25 Hz ticks on a sphere, rules via rules.ts,
// active/dormant population. Runs in the browser, a Worker, or Node (arena, tests).
import { type GameConfig, perSphere } from '../config/index.ts';
import { type Rng, createRng } from '../core/rng.ts';
import { MASK_GHOST, MASK_REGULAR } from '../maze/district.ts';
import { MazeWorld } from '../maze/walls.ts';
import { Grid3 } from '../sphere/hash3.ts';
import {
  type Vec3,
  angle,
  anyTangent,
  copy,
  cross,
  dot,
  moveAlong,
  nlerp,
  normalize,
  randomUnit,
  rotateToward,
  tangentToward,
  vec3,
} from '../sphere/vec3.ts';
import { Arcade } from './arcade.ts';
import { Cell, EJECTED, PLAYER, VIRUS } from './cell.ts';
import type { SimEvent } from './events.ts';
import { FOOD_KIND, FoodStore } from './food.ts';
import type { Organism } from './organism.ts';
import {
  bigEnoughToEat,
  canEatKind,
  decayedPacked,
  decayedRadius,
  eatReach,
  isRainbow,
  massToRadius,
  maxCells,
  mergeDelayTicks,
  moveStep,
  packedRadius,
  popPieces,
  radiusToMass,
  squeezeSpeed,
  ticksPerSecond,
} from './rules.ts';

const VIRUS_HUE = 120;
const SMALL_CELL_MAX_R = 128;
/** Extra query reach covering movement since the index was rebuilt this tick. */
const INDEX_SLACK = 120;

export interface WorldOptions {
  seed?: number;
  /** Fill food/viruses immediately (tests may disable). */
  populateStatic?: boolean;
}

export class World {
  readonly cfg: GameConfig;
  readonly R: number;
  readonly rng: Rng;
  tick = 0;

  readonly food: FoodStore;
  readonly cells: Cell[] = [];
  readonly cellsById = new Map<number, Cell>();
  readonly organisms: Organism[] = [];
  readonly events: SimEvent[] = [];
  leaderboard: Organism[] = [];

  foodTarget: number;
  virusMin: number;
  virusMax: number;
  virusCount = 0;

  /** Centre of the active zone (the camera). null = simulate everything. */
  observer: Vec3 | null = null;

  /** Maze districts; `maze.enabled` is false in the base and tuned presets. */
  readonly maze: MazeWorld;
  readonly arcade: Arcade | null;
  /** Rainbow touches that couldn't explode (arena metrics): knocked back at the cell cap, and too small (eaten). */
  explodeKnockbacks = 0;
  explodeTooSmall = 0;
  private rainbowTick = -1;
  private readonly rainbowList: Organism[] = [];

  private readonly smallGrid: Grid3;
  private readonly largeGrid: Grid3;
  private readonly dormantGrid: Grid3;
  private nextId = 1;
  private readonly candidates: Cell[] = [];
  private readonly foodCandidates: number[] = [];
  private readonly tmpA = vec3();
  private readonly tmpB = vec3();
  private readonly tmpC = vec3();
  private readonly dirT1 = vec3();
  private readonly dirT2 = vec3();
  private readonly pushTmp = vec3();
  private readonly axisR = vec3();
  private readonly axisD = vec3();

  constructor(cfg: GameConfig, opts: WorldOptions = {}) {
    this.cfg = cfg;
    this.R = cfg.sphereRadius;
    this.rng = createRng(opts.seed ?? 1);
    this.maze = new MazeWorld(cfg);
    // Plains keep the preset densities; maze interiors get food on their dot spots instead (added as each district is built)
    // and no viruses.
    const plains = 1 - (this.maze.enabled ? this.maze.layout.mazeShare() : 0);
    this.foodTarget = Math.round(perSphere(cfg, cfg.foodPerRefArea) * plains);
    this.virusMin = Math.round(perSphere(cfg, cfg.virusMinPerRefArea) * plains);
    this.virusMax = Math.round(perSphere(cfg, cfg.virusMaxPerRefArea) * plains);
    this.arcade = this.maze.enabled ? new Arcade(this) : null;
    if (this.arcade) {
      const arcade = this.arcade;
      this.maze.onBuilt = (d) => arcade.onDistrictBuilt(d);
    }
    this.food = new FoodStore(this.R, cfg.foodSize, Math.max(16, this.foodTarget + 64));
    // Moving cells are sparse (~1 per 4M units²), so coarse buckets beat fine ones; food uses 256.
    this.smallGrid = new Grid3(1024, this.R, true);
    this.largeGrid = new Grid3(4096, this.R, true);
    this.dormantGrid = new Grid3(2048, this.R, true);
    if (opts.populateStatic ?? true) {
      this.spawnStatic();
    }
    this.rebuildIndex();
  }

  // ---------------------------------------------------------------- queries

  newId(): number {
    return this.nextId++;
  }

  /** Visits cells whose centres may lie within `radius` world units of p (superset; check distance yourself). */
  queryCells(p: Vec3, radius: number, visit: (cell: Cell) => void): void {
    const R = this.R;
    const cells = this.cells;
    const fn = (slot: number) => {
      const c = cells[slot];
      if (c !== undefined && !c.removed) visit(c);
    };
    this.smallGrid.query(p.x * R, p.y * R, p.z * R, radius + INDEX_SLACK, fn);
    this.largeGrid.query(p.x * R, p.y * R, p.z * R, radius + INDEX_SLACK, fn);
  }

  distance(a: Vec3, b: Vec3): number {
    return this.R * angle(a, b);
  }

  /** Live, active organisms in the rainbow state this tick. */
  rainbows(): Organism[] {
    if (this.rainbowTick !== this.tick) {
      this.rainbowTick = this.tick;
      const list = this.rainbowList;
      list.length = 0;
      for (const o of this.organisms) if (o.alive && !o.dormant && o.cells.length > 0 && isRainbow(o, this.tick)) list.push(o);
    }
    return this.rainbowList;
  }

  // ---------------------------------------------------------------- tick

  step(): void {
    const cfg = this.cfg;
    this.tick++;
    this.events.length = 0;
    this.maze.floodBudget = cfg.floodBudget;
    this.maze.ghostBudget = cfg.floodBudget;

    for (const c of this.cells) copy(c.prev, c.p);

    // 1. Controllers
    for (const org of this.organisms) {
      if (org.alive && !org.dormant) org.controller.update(this, org);
    }

    // 2. Split / eject intents
    for (const org of this.organisms) {
      if (!org.alive || org.dormant) {
        org.wantSplit = false;
        org.wantEject = false;
        continue;
      }
      if (org.wantSplit) this.splitOrganism(org);
      if (org.wantEject) this.eject(org);
      org.wantSplit = false;
      org.wantEject = false;
    }

    // 3. Unowned moving nodes (ejected mass, shot viruses)
    // The index was built at the end of the previous tick; slots stay valid until compaction below and
    // INDEX_SLACK covers movement since then. Cells created this tick join the index at the end of it.
    for (const c of this.cells) {
      if (!c.owner && c.boost > 0) this.glide(c);
    }
    for (let i = 0, n = this.cells.length; i < n; i++) {
      const c = this.cells[i];
      if (c.removed || c.owner || (c.kind !== EJECTED && c.boost <= 0)) continue;
      this.collectCells(c.p, c.r);
      for (const check of this.candidates) {
        if (check === c || check.removed || c.removed || check.kind === PLAYER) continue;
        // Blobs don't eat blobs; they settle side by side. A virus can take a blob.
        if (c.kind === EJECTED && check.kind === EJECTED) this.pushApart(c, check);
        else this.contact(c, check);
      }
    }

    // 4. Player cells eat
    for (const org of this.organisms) {
      if (!org.alive || org.dormant) continue;
      const own = this.copyCells(org);
      for (const c of own) {
        if (c.removed) continue;
        if (org.species.eatsFood) this.eatFood(c);
        this.collectCells(c.p, c.r);
        for (const check of this.candidates) {
          if (check === c || check.removed || c.removed) continue;
          if (check.owner === org && this.keepApart(c, check)) continue;
          this.contact(c, check);
        }
      }
    }

    // 5. Player cells: merge timers, glide, move, oversize split, own-cell push, decay
    // Decay runs once a second, half a second after the population update, so the two don't share a tick.
    const perSecond = Math.round(ticksPerSecond(cfg));
    const decayTick = this.tick % perSecond === perSecond >> 1;
    for (const org of this.organisms) {
      if (!org.alive || org.dormant) continue;
      const own = this.copyCells(org);
      for (const c of own) {
        if (c.removed) continue;
        c.canMerge = this.tick - c.bornTick >= mergeDelayTicks(cfg, c);
        if (c.boost > 0) this.glide(c);
        this.movePlayerCell(c, org);
        this.splitOversize(c, org);
      }
      const cs = org.cells;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          if (this.keepApart(cs[i], cs[j])) this.pushApart(cs[i], cs[j]);
        }
      }
      if (decayTick) {
        for (const c of cs) {
          c.r = decayedRadius(cfg, c);
          if (c.packed > 0) c.packed = decayedPacked(cfg, c);
        }
      }
    }

    // 6. Walls: summed push-out for everything that moved near a maze.
    if (this.maze.enabled) this.resolveWalls();

    // 7. Cleanup, deaths, respawn, population, leaderboard
    this.compactCells();
    for (const org of this.organisms) {
      if (org.alive && !org.dormant && org.cells.length === 0) this.kill(org);
      if (org.alive) {
        const m = org.mass;
        org.lastMass = m;
        if (m > org.peakMass) org.peakMass = m;
      }
    }
    for (const org of this.organisms) {
      if (!org.alive && !org.isHuman && this.tick >= org.respawnTick) this.spawnOrganism(org);
    }
    this.spawnStatic();
    if (this.tick % Math.round(ticksPerSecond(cfg)) === 0) {
      this.updatePopulation();
      this.arcade?.tick();
    }
    if (this.tick % 8 === 0) this.updateLeaderboard();

    // 8. Keep positions on the unit sphere; index final positions for the renderer and next tick.
    for (const c of this.cells) normalize(c.p);
    this.rebuildIndex();
  }

  // ---------------------------------------------------------------- spawning

  addOrganism(org: Organism): void {
    this.organisms.push(org);
  }

  /** Spawns (or respawns) an organism with one start-size cell at a free random spot, or at `at`. */
  spawnOrganism(org: Organism, at?: Vec3, mass?: number): void {
    const cfg = this.cfg;
    if (!at && org.home) at = org.home;
    if (!mass && org.baseMass > 0) mass = org.baseMass;
    const r = mass ? Math.sqrt(mass * 100) : cfg.startRadius;
    const p = this.tmpA;
    if (at) copy(p, at);
    else this.findFreeSpot(p, r);
    org.alive = true;
    org.spawnTick = this.tick;
    org.kills = 0;
    org.peakMass = radiusToMass(r);
    org.lastEjectTick = -1e9;
    org.rainbowUntil = 0;
    org.explodeCount = 0;
    org.cells.length = 0;
    if (!org.isHuman && this.observer && dot(p, this.observer) < Math.cos(this.cfg.activeZoneRadius / this.R)) {
      org.dormant = true;
      org.dormantMass = radiusToMass(r);
      copy(org.dormantP, org.home ?? p);
      anyTangent(org.dormantHeading, p);
      return;
    }
    org.dormant = false;
    this.addPlayerCell(org, p, r);
    copy(org.target, p);
  }

  private addPlayerCell(org: Organism, p: Vec3, r: number): Cell {
    const cell = new Cell(this.newId(), PLAYER, p, r, org.hue, org, this.tick);
    org.cells.push(cell);
    this.addCell(cell);
    return cell;
  }

  /** A new cell of `org` at p (explosion pieces may be smaller than a normal minimum-size cell). */
  addPieceCell(org: Organism, p: Vec3, r: number): Cell {
    return this.addPlayerCell(org, p, r);
  }

  private addCell(cell: Cell): void {
    cell.slot = this.cells.length;
    this.cells.push(cell);
    this.cellsById.set(cell.id, cell);
    if (cell.kind === VIRUS) this.virusCount++;
    // Index immediately (slot is valid until the end-of-tick compaction, which rebuilds the index).
    const R = this.R;
    const g = cell.r <= SMALL_CELL_MAX_R ? this.smallGrid : this.largeGrid;
    g.insert(cell.slot, cell.p.x * R, cell.p.y * R, cell.p.z * R, cell.r);
  }

  private spawnStatic(): void {
    const food = this.food;
    while (food.pellets < this.foodTarget && this.spawnFood()) {}
    let guard = 0;
    while (this.virusCount < this.virusMin && guard++ < 10000) {
      const p = this.tmpB;
      this.findFreeSpot(p, this.cfg.virusRadius, 8);
      this.addCell(new Cell(this.newId(), VIRUS, p, this.cfg.virusRadius, VIRUS_HUE, null, this.tick));
    }
  }

  /**
   * Food top-up: a new pellet at a uniformly random spot. In the plains it goes right there; one that
   * lands in a built district takes a random empty dot spot of it, so regrowth per area is the same everywhere and maze
   * food stays in its lines. A full or not yet generated district re-rolls. Returns false after 20 re-rolls.
   */
  private spawnFood(): boolean {
    const maze = this.maze;
    const food = this.food;
    if (!maze.enabled) {
      food.spawnRandom(this.rng);
      return true;
    }
    const p = this.tmpC;
    for (let k = 0; k < 20; k++) {
      randomUnit(p, this.rng);
      if (!maze.inInterior(p, 100)) {
        food.add(p, Math.floor(this.rng() * 360));
        return true;
      }
      const i = maze.layout.regionAt(p);
      if (maze.isBuilt(i) && maze.inInterior(p) && this.arcade?.fillRandomSpot(i)) return true;
    }
    return false;
  }

  /**
   * A spot within `maxDist` of `near` where nothing that could eat a cell of radius r is within `safe` units
   * (edge distance). Falls back to the least dangerous candidate.
   */
  findSafeSpotNear(out: Vec3, near: Vec3, maxDist: number, r: number, safe = 900, attempts = 40): Vec3 {
    const cand = vec3();
    const dir = vec3();
    copy(out, near);
    let bestScore = -Infinity;
    for (let i = 0; i < attempts; i++) {
      copy(cand, near);
      this.randomDirection(dir, cand);
      moveAlong(cand, dir, (Math.sqrt(this.rng()) * maxDist) / this.R);
      let nearestThreat = Infinity;
      this.queryCells(cand, safe + 1600, (c) => {
        const d = this.distance(cand, c.p) - c.r - r;
        if (c.kind === VIRUS && d < 0) nearestThreat = Math.min(nearestThreat, d);
        else if (c.kind === PLAYER && c.r > r) nearestThreat = Math.min(nearestThreat, d);
      });
      if (nearestThreat > bestScore) {
        bestScore = nearestThreat;
        copy(out, cand);
      }
      if (nearestThreat >= safe) break;
    }
    return out;
  }

  /** Random spot in the plains (outside maze grids) that doesn't overlap a cell. */
  private findFreeSpot(out: Vec3, r: number, attempts = 10): Vec3 {
    const bad = (p: Vec3) => this.willCollide(p, r) || this.maze.regionWithGridAt(p, r + 200) >= 0;
    randomUnit(out, this.rng);
    for (let i = 0; i < attempts * 3 && bad(out); i++) randomUnit(out, this.rng);
    return out;
  }

  private willCollide(p: Vec3, r: number): boolean {
    let hit = false;
    this.queryCells(p, r, (c) => {
      if (!hit && c.kind !== EJECTED && this.distance(p, c.p) < r + c.r) hit = true;
    });
    return hit;
  }

  // ---------------------------------------------------------------- mechanics

  private rebuildIndex(): void {
    this.smallGrid.clear();
    this.largeGrid.clear();
    const R = this.R;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      c.slot = i;
      if (c.removed) continue;
      const g = c.r <= SMALL_CELL_MAX_R ? this.smallGrid : this.largeGrid;
      g.insert(i, c.p.x * R, c.p.y * R, c.p.z * R, c.r);
    }
  }

  private collectCells(p: Vec3, r: number): void {
    const out = this.candidates;
    out.length = 0;
    this.queryCells(p, r, (c) => out.push(c));
  }

  private copyCells(org: Organism): Cell[] {
    return org.cells.slice();
  }

  /** Is either cell still in its first splitNoCollideTicks (a split piece flies out through its parent)? */
  private justSplit(a: Cell, b: Cell): boolean {
    const t = this.cfg.splitNoCollideTicks;
    return this.tick - a.bornTick < t || this.tick - b.bornTick < t;
  }

  /** Cells of one organism hold each other apart until both may merge, apart from fresh split pieces. */
  private keepApart(a: Cell, b: Cell): boolean {
    return a.owner !== null && a.owner === b.owner && !this.justSplit(a, b) && !(a.canMerge && b.canMerge);
  }

  private eatFood(c: Cell): void {
    const food = this.food;
    const fr = food.radius;
    if (!bigEnoughToEat(this.cfg, c.r, fr)) return;
    const reach = eatReach(this.cfg, c.r, fr, false);
    const list = this.foodCandidates;
    list.length = 0;
    food.query(c.p, c.r, (i) => list.push(i));
    if (list.length === 0) return;
    const R = this.R;
    const cosReach = Math.cos(reach / R);
    let gained = 0;
    for (const i of list) {
      if (!food.alive[i]) continue;
      const d = c.p.x * food.x[i] + c.p.y * food.y[i] + c.p.z * food.z[i];
      if (d <= cosReach) continue;
      const tag = food.tag[i];
      this.events.push({
        type: 'eat',
        eaterId: c.id,
        eatenId: i,
        eatenKind: FOOD_KIND,
        x: food.x[i],
        y: food.y[i],
        z: food.z[i],
        r: fr,
        hue: food.hue[i],
        eaterOrg: c.owner?.id ?? -1,
        foodKind: food.kind[i],
        foodTag: tag,
      });
      if (tag >= 0 && this.arcade) gained += this.arcade.onFoodEaten(i, c);
      food.remove(i);
      gained += fr * fr;
    }
    if (gained > 0) c.r = Math.sqrt(c.r * c.r + gained);
  }

  /**
   * Two nearby cells, `a` the one being moved: a rainbow cell explodes a bigger rival it touches; otherwise the bigger
   * swallows the smaller once it may (mayEat) and reaches far enough over it (eatReach), never through a wall.
   */
  private contact(a: Cell, b: Cell): void {
    if (a.removed || b.removed) return;
    const big = a.r > b.r ? a : b;
    const small = big === a ? b : a;
    const d = this.distance(a.p, b.p);
    const rivals = small.owner !== null && big.owner !== null && small.owner !== big.owner;
    // Touching comes before any eating overlap, so a bigger cell can never eat a rainbow cell.
    if (this.arcade && rivals && small.kind === PLAYER && big.kind === PLAYER && isRainbow(small.owner, this.tick) && big.r > small.r) {
      if (d >= small.r + big.r || this.tick < big.graceUntil) return;
      if (this.maze.enabled && this.maze.blocked(a.p, b.p)) return;
      this.arcade.explode(small, big);
      return;
    }
    if (!this.mayEat(big, small, rivals)) return;
    // A virus moving onto a blob takes it more eagerly.
    if (d >= eatReach(this.cfg, big.r, small.r, a.kind === VIRUS && b.kind === EJECTED)) return;
    if (this.maze.enabled && this.maze.blocked(a.p, b.p)) return;
    this.consumeCell(big, small);
  }

  /** May `big` swallow `small` (size, kind and timing; not distance)? */
  private mayEat(big: Cell, small: Cell, rivals: boolean): boolean {
    // Own pieces that get here aren't held apart (keepApart), so they merge, except right after a split.
    if (small.owner && small.owner === big.owner) return !this.justSplit(small, big);
    // A rainbow cell eats any smaller cell; everything else needs the size ratio.
    const bigEnough =
      small.kind === PLAYER && isRainbow(big.owner, this.tick)
        ? big.r > small.r
        : bigEnoughToEat(this.cfg, big.r, small.r, big.owner?.species.eatRatio ?? 1);
    if (!bigEnough || !canEatKind(big, small, this.virusCount, this.virusMax)) return false;
    // Fresh explosion pieces can't be eaten for a moment (the burst reads first).
    return !(rivals && this.tick < small.graceUntil);
  }

  /** `eater` swallows `prey` whole. */
  consumeCell(eater: Cell, prey: Cell): void {
    this.events.push({
      type: 'eat',
      eaterId: eater.id,
      eatenId: prey.id,
      eatenKind: prey.kind,
      x: prey.p.x,
      y: prey.p.y,
      z: prey.p.z,
      r: prey.r,
      hue: prey.hue,
      eaterOrg: eater.owner?.id ?? -1,
      foodKind: -1,
      foodTag: -1,
    });
    this.removeCell(prey);
    // Fixed-mass species (resident ghosts) don't grow by eating, but their own pieces still merge back. The eater gets
    // the prey's packed mass too; step 6 packs it if that makes it too big for the way out.
    if (!eater.owner?.species.fixedMass || prey.owner === eater.owner) {
      eater.r = Math.sqrt(eater.r * eater.r + prey.r * prey.r + prey.packed * 100);
    }

    if (eater.kind === VIRUS && prey.kind === EJECTED) this.budVirus(eater, prey);
    if (prey.kind === VIRUS && eater.owner) this.popCell(eater);

    const victim = prey.owner;
    if (victim && eater.owner && victim !== eater.owner && victim.cells.length === 0) {
      eater.owner.kills++;
      this.events.push({ type: 'death', organismId: victim.id, killerId: eater.owner.id });
    }
  }

  private removeCell(c: Cell): void {
    if (c.removed) return;
    c.removed = true;
    this.cellsById.delete(c.id);
    if (c.kind === VIRUS) this.virusCount--;
    const org = c.owner;
    if (org) {
      const i = org.cells.indexOf(c);
      if (i >= 0) org.cells.splice(i, 1);
    }
  }

  private compactCells(): void {
    const cells = this.cells;
    let w = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.removed) continue;
      c.slot = w;
      cells[w++] = c;
    }
    cells.length = w;
  }

  /** Sends `c` gliding along unit tangent `dir` for `boost` world units in all. */
  private launch(c: Cell, dir: Vec3, boost: number): void {
    copy(c.heading, dir);
    c.boost = boost;
  }

  /** One tick of a launch: `c` covers 1/boostDivisor of the glide it has left, so it slows smoothly to a stop. */
  private glide(c: Cell): void {
    const dist = c.boost / this.cfg.boostDivisor;
    c.boost -= dist;
    if (this.maze.enabled && this.maze.regionWithGridAt(c.p, c.r + dist + 200) >= 0) this.glideThroughWalls(c, dist);
    else moveAlong(c.p, c.heading, dist / this.R);
    // Blobs coast almost to a standstill; cells and shot viruses drop the last few units at once.
    if (c.boost < (c.kind === EJECTED ? 0.01 : 3)) c.boost = 0;
  }

  /**
   * A glide of `dist` near walls, in substeps so nothing tunnels. Unowned nodes (ejected blobs, shot viruses)
   * bounce off walls; player cells slide along them.
   */
  private glideThroughWalls(c: Cell, dist: number): void {
    const R = this.R;
    const steps = Math.max(1, Math.ceil(dist / Math.max(8, Math.min(c.r, 35))));
    const push = this.pushTmp;
    const h = c.heading;
    const mask = c.owner?.species.passesDoor ? MASK_GHOST : MASK_REGULAR;
    for (let k = 0; k < steps; k++) {
      moveAlong(c.p, h, dist / steps / R);
      this.maze.resolve(c.p, c.r, mask, push);
      // Keep the heading tangent after the push moved the point.
      const hp = dot(h, c.p);
      h.x -= hp * c.p.x;
      h.y -= hp * c.p.y;
      h.z -= hp * c.p.z;
      normalize(h);
      const pl = Math.hypot(push.x, push.y, push.z);
      if (pl < 1e-9 || c.owner) continue;
      const nx = push.x / pl;
      const ny = push.y / pl;
      const nz = push.z / pl;
      const hn = h.x * nx + h.y * ny + h.z * nz;
      if (hn < 0) {
        h.x -= 2 * hn * nx;
        h.y -= 2 * hn * ny;
        h.z -= 2 * hn * nz;
        normalize(h);
      }
    }
  }

  private movePlayerCell(c: Cell, org: Organism): void {
    const cfg = this.cfg;
    const d = this.distance(c.p, org.target);
    let step = moveStep(cfg, c, d);
    if (step <= 0) return;
    step *= squeezeSpeed(cfg, c.squeeze);
    if (this.maze.enabled && cfg.cornerAssist > 0 && this.assistedMove(c, org, step)) return;
    rotateToward(c.p, org.target, step / this.R);
  }

  /**
   * Corner assist: in a corridor less than 2.5 cell diameters wide, a heading within 60° of the corridor
   * axis snaps to it and the cell drifts toward the corridor's centre line. Returns false when not applicable.
   */
  private assistedMove(c: Cell, org: Organism, step: number): boolean {
    const maze = this.maze;
    if (!maze.inInterior(c.p)) return false;
    const dist = maze.districtAt(c.p);
    if (!dist) return false;
    const mask = org.species.passesDoor ? MASK_GHOST : MASK_REGULAR;
    if (dist.collide(c.p, c.r * 3, mask, null) < 0) return false;
    const width = dist.dL + dist.dR;
    const height = dist.dT + dist.dB;
    const tightX = width < 5 * c.r;
    const tightY = height < 5 * c.r;
    if (tightX === tightY) return false;
    const dir = this.tmpC;
    if (!tangentToward(dir, c.p, org.target)) return false;
    const right = this.axisR;
    const down = this.axisD;
    dist.axes(c.p, right, down);
    const dx = dot(dir, right);
    const dy = dot(dir, down);
    const assist = Math.min(1, this.cfg.cornerAssist * 2);
    let mx: number;
    let my: number;
    if (tightX) {
      // Corridor runs along y.
      if (Math.abs(dy) < Math.abs(dx) * 0.577) return false;
      const off = (dist.dR - dist.dL) / 2;
      mx = Math.max(-0.3, Math.min(0.3, off / step)) * assist;
      my = Math.sign(dy);
    } else {
      if (Math.abs(dx) < Math.abs(dy) * 0.577) return false;
      const off = (dist.dB - dist.dT) / 2;
      my = Math.max(-0.3, Math.min(0.3, off / step)) * assist;
      mx = Math.sign(dx);
    }
    const m = this.tmpB;
    m.x = right.x * mx + down.x * my;
    m.y = right.y * mx + down.y * my;
    m.z = right.z * mx + down.z * my;
    if (normalize(m) < 1e-9) return false;
    moveAlong(c.p, m, step / this.R);
    return true;
  }

  /**
   * Step 6: walls push cells out; stores each cell's squeeze factor for next tick's movement.
   * Push-outs from opposite walls cancel, which would let a cell wedge into a gap slightly narrower than itself, so a
   * move may never leave a cell tighter than it was (clamped to its radius): it backs off toward where the tick started.
   */
  private resolveWalls(): void {
    const maze = this.maze;
    const tmp = this.tmpC;
    for (const c of this.cells) {
      if (c.removed) continue;
      if (!c.owner && c.boost <= 0) continue;
      if (maze.regionWithGridAt(c.p, c.r + 200) < 0) {
        c.squeeze = 1;
        c.clearance = Infinity;
        // Packed mass comes back out in the plains too.
        if (c.owner && c.packed > 0) this.fitCell(c);
        continue;
      }
      const mask = c.owner?.species.passesDoor ? MASK_GHOST : MASK_REGULAR;
      c.squeeze = maze.resolve(c.p, c.r, mask);
      let min = maze.lastMin;
      const allowed = Math.min(c.r, c.clearance) - 0.5;
      if (min < allowed && maze.clearanceAt(c.prev, c.r, mask) >= allowed) {
        // Largest step from the tick's start toward the resolved spot that keeps the allowed clearance.
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          nlerp(tmp, c.prev, c.p, mid);
          if (maze.clearanceAt(tmp, c.r, mask) >= allowed) lo = mid;
          else hi = mid;
        }
        nlerp(tmp, c.prev, c.p, lo);
        copy(c.p, tmp);
        c.squeeze = maze.resolve(c.p, c.r, mask);
        min = maze.lastMin;
      }
      c.clearance = min;
      // Then fit the way out from where the walls left it. A cell that grew, merged, woke or was rescued in a
      // pocket packs (it may have been wedged for this one tick); one that only needed a nudge off a wall got it above.
      if (c.owner) this.fitCell(c);
    }
  }

  /**
   * A cell is never bigger than the widest way out from where it is. Mass beyond that is packed (it stays
   * the cell's mass) and comes back as size, a few percent per tick, once the way out is wide enough.
   */
  private fitCell(c: Cell): void {
    const room = this.maze.roomAt(c.p);
    if (!(room > 0)) return;
    const r = c.r;
    const had = c.packed;
    const next = packedRadius(this.cfg, r, had, room, c.clearance);
    if (next === r) return;
    c.r = next;
    c.packed = had + (r * r - next * next) / 100;
    if (c.packed < 1e-6) c.packed = 0;
    const org = c.owner!;
    if (next < r) {
      if (had <= 0) this.events.push({ type: 'pack', cellId: c.id, organismId: org.id });
      return;
    }
    // A real swell (not a unit here and there on the way to a gate) gets an event, at most once a second.
    const goal = Math.min(room - this.cfg.packMargin, Math.sqrt(r * r + had * 100));
    if (goal > r * 1.05 && this.tick - c.swellTick > ticksPerSecond(this.cfg)) {
      c.swellTick = this.tick;
      this.events.push({ type: 'unpack', cellId: c.id, organismId: org.id, x: c.p.x, y: c.p.y, z: c.p.z, r, hue: c.hue });
    }
  }

  private pushApart(a: Cell, b: Cell): void {
    const d = this.distance(a.p, b.p);
    const rs = a.r + b.r;
    if (d >= rs) return;
    // Push the two apart by their whole overlap, the lighter one moving more (shares by r², i.e. by mass). Cells whose
    // centres (nearly) coincide separate by at most 1 unit a tick, so they don't jump.
    const t = this.tmpC;
    let disp = rs - d;
    if (d < 1e-6 || !tangentToward(t, a.p, b.p)) {
      anyTangent(t, a.p);
      disp = 1;
    } else if (d < 1) disp = Math.min(disp, 1);
    const ms = a.r * a.r + b.r * b.r;
    const da = (disp * (b.r * b.r)) / ms;
    const db = (disp * (a.r * a.r)) / ms;
    // a moves away from b; b moves away from a along the same great circle.
    t.x = -t.x;
    t.y = -t.y;
    t.z = -t.z;
    moveAlong(a.p, t, da / this.R);
    if (tangentToward(t, b.p, a.p)) {
      t.x = -t.x;
      t.y = -t.y;
      t.z = -t.z;
      moveAlong(b.p, t, db / this.R);
    }
  }

  /**
   * Moves `mass` out of `parent` into a new cell launched along unit tangent `dir`; the two areas add up to the parent's.
   * Returns the new cell, or null when it would be under minRadius or the parent hasn't that much mass.
   */
  splitCell(org: Organism, parent: Cell, dir: Vec3, mass: number): Cell | null {
    const r = massToRadius(mass);
    const rest = parent.r * parent.r - r * r;
    if (r < this.cfg.minRadius || !(rest >= 0)) return null;
    parent.r = Math.sqrt(rest);
    const piece = this.addPlayerCell(org, parent.p, r);
    this.launch(piece, dir, this.cfg.splitBoost);
    return piece;
  }

  private directionToTarget(out: Vec3, c: Cell, org: Organism): Vec3 {
    if (!tangentToward(out, c.p, org.target) || this.distance(c.p, org.target) < 1) anyTangent(out, c.p);
    return out;
  }

  /** Unit tangent at p at angle `a` in a fixed tangent basis. `out` must not be `p`. */
  randomTangent(out: Vec3, p: Vec3, a: number): Vec3 {
    const t1 = anyTangent(this.dirT1, p);
    const t2 = cross(this.dirT2, p, t1);
    out.x = t1.x * Math.cos(a) + t2.x * Math.sin(a);
    out.y = t1.y * Math.cos(a) + t2.y * Math.sin(a);
    out.z = t1.z * Math.cos(a) + t2.z * Math.sin(a);
    return out;
  }

  /** Uniformly random unit tangent at p. Uses its own scratch vectors, so `out` and `p` may be any vectors. */
  private randomDirection(out: Vec3, p: Vec3): Vec3 {
    const t1 = anyTangent(this.dirT1, p);
    const t2 = cross(this.dirT2, p, t1);
    const a = this.rng() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    out.x = t1.x * ca + t2.x * sa;
    out.y = t1.y * ca + t2.y * sa;
    out.z = t1.z * ca + t2.z * sa;
    return out;
  }

  /** Space: each cell of at least splitMinRadius halves toward the target, as long as the organism has room for more cells. */
  splitOrganism(org: Organism): void {
    const cfg = this.cfg;
    if (!org.species.canSplit) return;
    const dir = vec3();
    for (const c of org.cells.filter((c) => c.r >= cfg.splitMinRadius)) {
      if (org.cells.length >= maxCells(cfg, c)) break;
      this.splitCell(org, c, this.directionToTarget(dir, c, org), c.mass * 0.5);
    }
  }

  /**
   * W, at most once per ejectCooldownTicks: each cell of at least ejectMinRadius gives up the area of an
   * ejectCostRadius disc and fires a blob from its rim toward the target, scattered by up to ±ejectSpread radians.
   */
  eject(org: Organism): void {
    const cfg = this.cfg;
    if (!org.species.canEject || this.tick - org.lastEjectTick < cfg.ejectCooldownTicks) return;
    org.lastEjectTick = this.tick;
    const aim = vec3();
    const rim = vec3();
    const dir = vec3();
    for (const c of this.copyCells(org)) {
      if (c.r < cfg.ejectMinRadius) continue;
      this.directionToTarget(aim, c, org);
      c.r = Math.sqrt(c.r * c.r - cfg.ejectCostRadius * cfg.ejectCostRadius);
      copy(rim, c.p);
      moveAlong(rim, aim, c.r / this.R);
      this.turnTangent(dir, rim, aim, this.rng() * 2 * cfg.ejectSpread - cfg.ejectSpread);
      const blob = new Cell(this.newId(), EJECTED, rim, cfg.ejectRadius, c.hue, null, this.tick);
      this.launch(blob, dir, cfg.ejectBoost);
      this.addCell(blob);
    }
  }

  /** `dir` (a unit tangent at p) turned by `a` radians about p, into `out`. */
  private turnTangent(out: Vec3, p: Vec3, dir: Vec3, a: number): Vec3 {
    const side = cross(this.dirT2, p, dir);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    out.x = dir.x * ca + side.x * sa;
    out.y = dir.y * ca + side.y * sa;
    out.z = dir.z * ca + side.z * sa;
    return out;
  }

  /** A cell past autoSplitRadius halves in a random direction; with no room for another cell it stops growing instead. */
  private splitOversize(c: Cell, org: Organism): void {
    const cfg = this.cfg;
    if (c.removed || c.r < cfg.autoSplitRadius || !org.species.canSplit) return;
    if (org.cells.length < maxCells(cfg, c)) this.splitCell(org, c, this.randomDirection(vec3(), c.p), c.mass / 2);
    else c.r = cfg.autoSplitRadius;
  }

  /**
   * A virus fed to virusShootRadius shrinks back to virusRadius and buds a new virus, launched the way the last
   * blob was going (its heading carried into the virus's tangent plane).
   */
  private budVirus(virus: Cell, blob: Cell): void {
    const cfg = this.cfg;
    if (virus.r < cfg.virusShootRadius) return;
    virus.r = cfg.virusRadius;
    const dir = this.tmpA;
    const k = dot(blob.heading, virus.p);
    dir.x = blob.heading.x - k * virus.p.x;
    dir.y = blob.heading.y - k * virus.p.y;
    dir.z = blob.heading.z - k * virus.p.z;
    if (normalize(dir) < 1e-9) anyTangent(dir, virus.p);
    const bud = new Cell(this.newId(), VIRUS, virus.p, cfg.virusRadius, VIRUS_HUE, null, this.tick);
    this.launch(bud, dir, cfg.virusShotBoost);
    this.addCell(bud);
  }

  /** Virus pop: the cell bursts into pieces (popPieces) flying off in random directions. A crumb is three start cells. */
  private popCell(c: Cell): void {
    const org = c.owner!;
    if (!org.species.canSplit) return;
    const cfg = this.cfg;
    const slots = maxCells(cfg, c) - org.cells.length;
    if (slots <= 0) return;
    const dir = vec3();
    for (const mass of popPieces(radiusToMass(c.r), slots, 3 * radiusToMass(cfg.minRadius), this.rng)) {
      this.splitCell(org, c, this.randomDirection(dir, c.p), mass);
    }
    this.events.push({ type: 'pop', cellId: c.id });
  }

  private kill(org: Organism): void {
    org.alive = false;
    org.dormant = false;
    org.respawnTick = this.tick + (org.resident ? Math.round(this.cfg.ghostRespawnSeconds * ticksPerSecond(this.cfg)) : this.cfg.npcRespawnTicks);
    if (!this.events.some((e) => e.type === 'death' && e.organismId === org.id)) {
      this.events.push({ type: 'death', organismId: org.id, killerId: null });
    }
  }

  // ---------------------------------------------------------------- population

  private updatePopulation(): void {
    const obs = this.observer;
    if (!obs) return;
    const cfg = this.cfg;
    const R = this.R;
    const cosWake = Math.cos(cfg.activeZoneRadius / R);
    const cosSleep = Math.cos((cfg.activeZoneRadius + cfg.activeZoneMargin) / R);
    const center = this.tmpA;
    for (const org of this.organisms) {
      if (!org.alive || org.isHuman) continue;
      if (org.dormant) {
        if (!org.resident) this.dormantStep(org);
        if (dot(org.dormantP, obs) > cosWake) this.wake(org);
      } else if (dot(org.center(center), obs) < cosSleep) {
        this.sleep(org);
      }
    }
    this.dormantFights();
  }

  /** One second of statistical life: graze at an expected rate, decay, wander. */
  private dormantStep(org: Organism): void {
    const cfg = this.cfg;
    const tps = ticksPerSecond(cfg);
    const r = Math.sqrt(org.dormantMass * 100);
    const speed = (2.1106 / Math.pow(r, 0.449)) * 40 * cfg.speedScale * (tps / 25);
    const density = cfg.foodPerRefArea / cfg.refArea;
    const foodMass = radiusToMass(cfg.foodSize);
    const efficiency = 0.3 + 0.4 * this.rng();
    org.dormantMass += 2 * r * speed * density * foodMass * efficiency;
    if (r > cfg.minRadius) org.dormantMass *= 1 - cfg.decayRate * org.species.decay;
    org.dormantMass = Math.min(org.dormantMass, radiusToMass(cfg.autoSplitRadius) * cfg.cellLimit);
    // Wander: heading jitter then half-speed travel.
    const side = cross(this.tmpB, org.dormantP, org.dormantHeading);
    const j = (this.rng() - 0.5) * 0.8;
    const h = org.dormantHeading;
    h.x = h.x * Math.cos(j) + side.x * Math.sin(j);
    h.y = h.y * Math.cos(j) + side.y * Math.sin(j);
    h.z = h.z * Math.cos(j) + side.z * Math.sin(j);
    normalize(h);
    moveAlong(org.dormantP, h, (speed * 0.5) / this.R);
    normalize(org.dormantP);
  }

  private dormantFights(): void {
    const cfg = this.cfg;
    const R = this.R;
    const dormant = this.organisms.filter((o) => o.alive && o.dormant && !o.resident);
    const cosNear = Math.cos(1000 / R);
    const grid = this.dormantGrid;
    grid.clear();
    dormant.forEach((o, i) => grid.insert(i, o.dormantP.x * R, o.dormantP.y * R, o.dormantP.z * R, 0));
    const near: number[] = [];
    for (let i = 0; i < dormant.length; i++) {
      const a = dormant[i];
      near.length = 0;
      grid.query(a.dormantP.x * R, a.dormantP.y * R, a.dormantP.z * R, 1000, (j) => {
        if (j > i) near.push(j);
      });
      for (const j of near) {
        const b = dormant[j];
        if (!a.alive || !b.alive || dot(a.dormantP, b.dormantP) < cosNear) continue;
        const [big, small] = a.dormantMass >= b.dormantMass ? [a, b] : [b, a];
        if (big.dormantMass < small.dormantMass * cfg.eatSizeRatio * cfg.eatSizeRatio) continue;
        if (this.rng() > 0.05) continue;
        big.dormantMass += small.dormantMass * 0.8;
        big.kills++;
        small.alive = false;
        small.dormant = false;
        small.respawnTick = this.tick + cfg.npcRespawnTicks;
      }
    }
  }

  private wake(org: Organism): void {
    const cfg = this.cfg;
    org.dormant = false;
    const r = Math.min(Math.sqrt(org.dormantMass * 100), cfg.autoSplitRadius);
    const at = this.tmpB;
    copy(at, org.home ?? org.dormantP);
    // Dormant NPCs wander through walls; wake them somewhere they fit.
    if (!org.home && this.maze.enabled && this.maze.regionWithGridAt(at, r) >= 0) {
      if (!this.maze.nearestFree(org.dormantP, r, at)) this.findFreeSpot(at, r);
    }
    this.addPlayerCell(org, at, r);
    copy(org.target, at);
  }

  private sleep(org: Organism): void {
    const mass = org.resident ? org.baseMass : org.mass;
    org.center(org.dormantP);
    if (org.home) copy(org.dormantP, org.home);
    anyTangent(org.dormantHeading, org.dormantP);
    for (const c of org.cells.slice()) this.removeCell(c);
    org.cells.length = 0;
    org.dormantMass = mass;
    org.dormant = true;
  }

  /** Like one server's board: organisms in the active zone (dormant ones rejoin when they wake). */
  private updateLeaderboard(): void {
    this.leaderboard = this.organisms.filter((o) => o.alive && !o.dormant && !o.resident).sort((a, b) => b.lastMass - a.lastMass);
  }
}
