// NPC controller: an influence field evaluated as a context-steering
// map in the NPC's local chart, plus personality-gated actions (split-kill, split-escape, hide, feed virus).
// In and near maze districts directions and distances come from a radius-aware path flood, threats only
// count when they fit the corridors between them and us, and a stuck detector sends the NPC somewhere reachable.
// Turning costs a share of the field's peak, pellets matter less to big cells, a weak field starts a held
// wander goal, and a progress detector catches cells that walk a lot and get nowhere.
import type { Controller } from '../sim/controller.ts';
import { EJECTED, PLAYER, VIRUS, type Cell } from '../sim/cell.ts';
import { MASK_REGULAR, type District } from '../maze/district.ts';
import { sharedFlood } from '../maze/nav.ts';
import type { Organism } from '../sim/organism.ts';
import { isRainbow, radiusToMass, speedPerTick, viewScale } from '../sim/rules.ts';
import type { World } from '../sim/world.ts';
import { Frame, type Vec2 } from '../sphere/frame.ts';
import { type Vec3, angle, copy, dot, vec3 } from '../sphere/vec3.ts';
import type { Difficulty, Personality } from './personalities.ts';

const SLOTS = 16;
const SLOT_ANGLE = (Math.PI * 2) / SLOTS;
const COS = Array.from({ length: SLOTS }, (_, k) => Math.cos(k * SLOT_ANGLE));
const SIN = Array.from({ length: SLOTS }, (_, k) => Math.sin(k * SLOT_ANGLE));
const MAX_FOOD_SAMPLES = 80;
const STUCK_WINDOW = 50;
const STUCK_ESCAPE_TICKS = 75;
/** Progress detector: window, and how long the forced wander goal is held. */
const JITTER_WINDOW = 100;
const JITTER_FORCE_TICKS = 125;

/** Global decision counters (arena diagnostics). */
export const botStats = {
  thinks: 0,
  preySeen: 0,
  splitCandidates: 0,
  virusBlocked: 0,
  splitKills: 0,
  feeds: 0,
  escapes: 0,
  floods: 0,
  deferred: 0,
  stuck: 0,
  powerSeeks: 0,
  wanders: 0,
  jitter: 0,
};

export class BotController implements Controller {
  readonly personality: Personality;
  readonly difficulty: Difficulty;
  private readonly interest = new Float64Array(SLOTS);
  private readonly danger = new Float64Array(SLOTS);
  private readonly frame = new Frame();
  private readonly local: Vec2 = { x: 0, y: 0 };
  private readonly phase: number;
  private splitCooldown = 0;
  private pursuit: Cell | null = null;
  private pursuitTicks = 0;
  private feedTicks = 0;
  private readonly feedTarget = vec3();
  private pending = false;
  // Maze routing for the current think.
  private route: District | null = null;
  private routeStart = -1;
  private readonly q = vec3();
  // Stuck detection.
  private readonly stuckRef = vec3();
  private stuckTick = 0;
  private stuckPath = 0;
  private escapeTicks = 0;
  private readonly escapeTarget = vec3();
  // Wander goal: a far reachable tile in a district, a far point in the plains; held until reached.
  private readonly wanderTarget = vec3();
  private wanderTicks = 0;
  /** District index the goal was picked in (−1 = plains). */
  private wanderWhere = -2;
  /** Ticks left of a wander goal forced by the progress detector, which ignores the field. */
  private forcedTicks = 0;
  /** Where the last three wander goals were picked, so the next one leads somewhere new instead of back. */
  private readonly crumbs = [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)];
  private crumb = 0;
  // Progress detector.
  private readonly jitterStart = vec3();
  private readonly jitterLast = vec3();
  private jitterPath = 0;
  private jitterTick = -1;
  /** Heading chosen last: a unit tangent at the cell. */
  private readonly heading = vec3(0, 0, 0);
  private hasHeading = false;
  private readonly score = new Float64Array(SLOTS);
  /** Ticks spent escaping from being stuck (arena metric). */
  stuckTicks = 0;
  /** Field thinks, and thinks whose heading turned more than 135° from the previous one (arena explore metric). */
  thinks = 0;
  reversals = 0;
  /** Progress detector firings. */
  jitterCount = 0;

  /** The live wander goal, for the debug overlay. */
  get goal(): Vec3 | null {
    return this.wanderTicks > 0 ? this.wanderTarget : null;
  }
  /** Debug hook: called when the stuck detector fires. */
  static onStuck: ((world: World, org: Organism) => void) | null = null;
  /** Last chosen action, for debugging and arena stats. */
  action = 'graze';

  constructor(personality: Personality, difficulty: Difficulty, phase: number) {
    this.personality = personality;
    this.difficulty = difficulty;
    this.phase = phase;
  }

  update(world: World, org: Organism): void {
    if (this.splitCooldown > 0) this.splitCooldown--;

    if (this.forcedTicks > 0) this.forcedTicks--;

    if (this.escapeTicks > 0) {
      this.escapeTicks--;
      this.stuckTicks++;
      copy(org.target, this.escapeTarget);
      this.track(org, false);
      return;
    }
    this.checkProgress(world, org);
    if (world.maze.enabled && this.checkStuck(world, org)) {
      this.track(org, false);
      return;
    }

    if (this.pursuit) {
      if (this.pursuit.removed || this.pursuitTicks <= 0) this.pursuit = null;
      else {
        this.pursuitTicks--;
        copy(org.target, this.pursuit.p);
        this.track(org, false);
        return;
      }
    }
    if (this.feedTicks > 0) {
      this.feedTicks--;
      copy(org.target, this.feedTarget);
      org.wantEject = true;
      this.track(org, false);
      return;
    }
    if (!this.pending && (world.tick + this.phase) % this.difficulty.thinkTicks !== 0) return;
    this.pending = false;
    if (this.think(world, org)) this.track(org, true);
  }

  /**
   * Progress detector, in every preset: over 4 s, a cell that walked more than 3× the distance it ended
   * from its start (and ended less than max(1.5 r, 120) from it) is jittering. Force a far wander goal for 5 s.
   */
  private checkProgress(world: World, org: Organism): void {
    const cell = org.largestCell();
    if (!cell) return;
    if (this.jitterTick < 0 || world.tick - this.jitterTick > JITTER_WINDOW * 2) {
      // First tick, or back from a pause (dormancy, death): start a fresh window.
      copy(this.jitterStart, cell.p);
      copy(this.jitterLast, cell.p);
      this.jitterPath = 0;
      this.jitterTick = world.tick;
      return;
    }
    this.jitterPath += world.distance(cell.p, this.jitterLast);
    copy(this.jitterLast, cell.p);
    if (world.tick - this.jitterTick < JITTER_WINDOW) return;
    const net = world.distance(cell.p, this.jitterStart);
    const path = this.jitterPath;
    copy(this.jitterStart, cell.p);
    this.jitterPath = 0;
    this.jitterTick = world.tick;
    const limit = Math.max(1.5 * cell.r, 120);
    if (net >= limit || path <= 3 * limit || this.forcedTicks > 0) return;
    botStats.jitter++;
    this.jitterCount++;
    this.forcedTicks = JITTER_FORCE_TICKS;
    this.wanderTicks = 0;
    this.pending = true;
  }

  /** Remembers the heading toward org.target (unit tangent at the largest cell); `count` tallies reversals. */
  private track(org: Organism, count: boolean): void {
    const cell = org.largestCell();
    if (!cell) return;
    const p = cell.p;
    const t = org.target;
    const d = t.x * p.x + t.y * p.y + t.z * p.z;
    const x = t.x - d * p.x;
    const y = t.y - d * p.y;
    const z = t.z - d * p.z;
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) return;
    const h = this.heading;
    if (count) {
      this.thinks++;
      if (this.hasHeading && (h.x * x + h.y * y + h.z * z) / l < -0.7071) this.reversals++;
    }
    h.x = x / l;
    h.y = y / l;
    h.z = z / l;
    this.hasHeading = true;
  }

  /**
   * Every 2 s: if the NPC travelled (path length, so grazing back and forth counts) under 20 % of its speed while
   * heading somewhere, walk to a random reachable spot for 3 s.
   */
  private checkStuck(world: World, org: Organism): boolean {
    const cell = org.largestCell();
    if (!cell) return false;
    this.stuckPath += world.distance(cell.p, this.stuckRef);
    copy(this.stuckRef, cell.p);
    if (world.tick - this.stuckTick < STUCK_WINDOW) return false;
    const moved = this.stuckPath;
    this.stuckPath = 0;
    const wanted = world.distance(cell.p, org.target);
    const expected = speedPerTick(world.cfg, cell) * STUCK_WINDOW;
    const wasTracking = this.stuckTick > 0;
    this.stuckTick = world.tick;
    if (!wasTracking || moved > expected * 0.2 || wanted < 150) return false;
    const d = world.maze.districtAt(cell.p);
    if (!d || !d.locate(cell.p)) return false;
    BotController.onStuck?.(world, org);
    // Random tile with room for us 3–10 tiles away.
    const G = d.G;
    const ci = Math.floor(d.gx);
    const cj = Math.floor(d.gy);
    for (let k = 0; k < 24; k++) {
      const i = ci + Math.round((world.rng() - 0.5) * 20);
      const j = cj + Math.round((world.rng() - 0.5) * 20);
      if (i < 0 || j < 0 || i >= G || j >= G || Math.abs(i - ci) + Math.abs(j - cj) < 3) continue;
      if (d.tileClear[j * G + i] < cell.r) continue;
      d.point(i + 0.5, j + 0.5, this.escapeTarget);
      this.escapeTicks = STUCK_ESCAPE_TICKS;
      botStats.stuck++;
      copy(org.target, this.escapeTarget);
      return true;
    }
    return false;
  }

  private add(arr: Float64Array, x: number, y: number, value: number): void {
    const l = Math.hypot(x, y);
    if (l < 1e-9) return;
    const ux = x / l;
    const uy = y / l;
    for (let k = 0; k < SLOTS; k++) {
      const w = ux * COS[k] + uy * SIN[k];
      if (w > 0) arr[k] += value * w;
    }
  }

  /**
   * Local direction (this.local) and travel distance from our cell to q. Inside a routed district the direction is the
   * first hop of the path and the distance its length; returns −1 when q can't be reached.
   */
  private locate(world: World, q: Vec3): number {
    const R = world.R;
    const local = this.local;
    this.frame.project(R, q, local);
    const straight = Math.hypot(local.x, local.y);
    const d = this.route;
    if (!d || !d.locate(q)) return straight;
    const t = d.tileIndex(d.gx, d.gy);
    if (t < 0) return straight;
    const flood = sharedFlood;
    if (!flood.reached(t)) return -1;
    if (t === this.routeStart) return straight;
    const hop = flood.stepToward(t, 2);
    const i = hop % d.G;
    const j = (hop - i) / d.G;
    const p = d.point(i + 0.5, j + 0.5, this.q);
    this.frame.project(R, p, local);
    return Math.max(straight, flood.cost[t] * d.F);
  }

  /** Returns false when the think was deferred (no flood budget) and chose nothing. */
  private think(world: World, org: Organism): boolean {
    const cell = org.largestCell();
    if (!cell) return false;
    const cfg = world.cfg;
    const P = this.personality;
    const R = world.R;
    const frame = this.frame;
    const maze = world.maze;
    frame.reset(cell.p);

    // Maze routing.
    this.route = null;
    this.routeStart = -1;
    const scale = viewScale(cfg, org.sumRadius, cfg.viewBaseWidth, cfg.viewBaseHeight);
    const perception = (Math.hypot(cfg.viewBaseWidth, cfg.viewBaseHeight) / 2 / scale) * this.difficulty.perception;
    if (maze.enabled) {
      const d = maze.districtAt(cell.p);
      if (d && d.locate(cell.p)) {
        if (maze.floodBudget <= 0) {
          this.pending = true;
          botStats.deferred++;
          return false;
        }
        maze.floodBudget--;
        botStats.floods++;
        this.routeStart = d.tileIndex(d.gx, d.gy);
        // Food interest reaches 700 units and threats matter mostly nearby: a bounded flood is enough.
        sharedFlood.run(d, this.routeStart, cell.r, MASK_REGULAR, 900, Math.min(perception * 1.2, 1700) / d.F);
        this.route = d;
      }
    }
    const route = this.route;
    const ourTile = this.routeStart;
    const mazeInterior = route !== null && route.inInterior(route.gx, route.gy);

    const interest = this.interest.fill(0);
    const danger = this.danger.fill(0);
    const local = this.local;
    const smallest = org.cells.reduce((m, c) => Math.min(m, c.r), Infinity);
    const splitR = cell.r / Math.SQRT2;
    const canSplit = cell.r >= cfg.splitMinRadius && org.cells.length < cfg.cellLimit && org.species.canSplit;
    const ignoreThreats = world.rng() < this.difficulty.mistakeRate;
    const tick = world.tick;
    const rainbow = isRainbow(org, tick);
    botStats.thinks++;
    let preySeen = false;

    // Food: nearest samples only (the field is dominated by the closest pellets anyway).
    if (P.food > 0 && org.species.eatsFood) {
      let n = 0;
      // A pellet is worth less to a big cell; it eats what it passes but doesn't turn round for it.
      const foodWeight = Math.min(1, radiusToMass(cfg.foodSize) / (cell.mass * cfg.botFoodShare));
      const foodRadius = Math.min(perception, 700);
      const food = world.food;
      const q = this.q;
      food.query(cell.p, foodRadius, (i) => {
        if (n >= MAX_FOOD_SAMPLES) return;
        q.x = food.x[i];
        q.y = food.y[i];
        q.z = food.z[i];
        const d = this.locate(world, q);
        if (d < 0 || d > foodRadius) return;
        n++;
        // Fade out toward the sampling radius so food crossing it doesn't flip the choice (dithering in corridors).
        this.add(interest, local.x, local.y, ((foodWeight * P.food) / Math.max(d, 20)) * (1 - d / foodRadius));
      });
    }

    // Power pellets: hunters and scavengers go for them when bigger cells are near, survivors when
    // threatened; grazers eat them when they pass one.
    const arcade = world.arcade;
    const wantsPower = arcade && route && org.species.eatsFood && P.id !== 'grazer';

    let bestPrey: Cell | null = null;
    let chase: Cell | null = null;
    let chaseScore = 0;
    let nearestThreat: Cell | null = null;
    let nearestThreatEdge = Infinity;
    let biggerNear = false;
    const viruses: Cell[] = [];
    const bigTargets: Cell[] = [];

    world.queryCells(cell.p, perception, (c) => {
      if (c.owner === org) return;
      frame.project(R, c.p, local);
      const straight = Math.hypot(local.x, local.y);
      if (straight > perception + c.r) return;

      if (c.kind === PLAYER) {
        // Rainbow: a smaller rainbow cell explodes us on touch. While we are rainbow every other cell is
        // prey: smaller ones are eaten (no size margin), bigger ones explode.
        const scared = isRainbow(c.owner, tick) && c.r < cell.r;
        const victim = rainbow && !scared && c.r > cell.r;
        const edible = !scared && (victim || (rainbow ? cell.r > c.r : cell.r >= c.r * cfg.eatSizeRatio));
        if (edible) {
          const d = this.locate(world, c.p);
          if (d < 0) return;
          preySeen = true;
          // Worth chasing: big enough to matter, close enough to catch.
          const score = (c.r * c.r) / Math.max(d, 50);
          if ((P.prey >= 1 || victim) && c.r >= cell.r * 0.25 && score > chaseScore) {
            chaseScore = score;
            chase = c;
          }
          if (P.prey > 0 || victim) this.add(interest, local.x, local.y, ((victim ? 3 : P.prey) * (c.r / 10)) / Math.max(d, 1));
          if (
            P.splitKill &&
            !route &&
            canSplit &&
            !this.splitCooldown &&
            org.cells.length <= 4 &&
            splitR >= c.r * cfg.eatSizeRatio &&
            c.r >= cell.r * 0.3 &&
            d <= Math.max(cfg.splitBoost * 0.8, splitR * 4.5)
          ) {
            if (!bestPrey || c.r > bestPrey.r) bestPrey = c;
            botStats.splitCandidates++;
          }
        } else if (scared || (!rainbow && c.r >= smallest * cfg.eatSizeRatio)) {
          // Can it reach us through the corridors between us?
          if (route && ourTile >= 0 && route.locate(c.p)) {
            const cls = route.classOf(c.r);
            const theirs = route.tileIndex(route.gx, route.gy);
            const label = route.labels[cls][ourTile];
            const outside = theirs < 0;
            const reach = outside ? label !== 0 && label === route.labels[cls][0] : label !== 0 && label === route.labels[cls][theirs];
            if (!reach && !scared) return;
          }
          if (c.r > cell.r) biggerNear = true;
          // Too big to eat, but big enough to pop on a virus: a Trickster target.
          if (!route && c.r >= cfg.virusRadius * cfg.eatSizeRatio && c.r >= cell.r) bigTargets.push(c);
          const d = this.locate(world, c.p);
          const dist = d < 0 ? straight : d;
          const edge = Math.max(dist - cell.r - c.r, 1);
          if (ignoreThreats || (!scared && edge > c.r * P.threatRange + 150)) return;
          const ratio = c.r / cell.r;
          let value = ((scared ? 3 : P.threat) * Math.log(1 + Math.max(ratio, 1))) / edge;
          // Can it split onto us?
          if (!route && c.r / Math.SQRT2 >= cell.r * cfg.eatSizeRatio && edge < Math.max(cfg.splitBoost * 0.8, (c.r / Math.SQRT2) * 4.5)) {
            value *= 3;
          }
          if (P.shadow > 0 && !scared && edge > 350 + c.r * 0.5) {
            this.add(interest, local.x, local.y, P.shadow / edge);
          } else {
            this.add(danger, local.x, local.y, value * 1000);
          }
          if (edge < nearestThreatEdge) {
            nearestThreatEdge = edge;
            nearestThreat = c;
          }
        } else {
          this.add(danger, local.x, local.y, (0.1 * (c.r / cell.r)) / Math.max(straight - cell.r - c.r, 1));
        }
      } else if (c.kind === VIRUS) {
        viruses.push(c);
        if (cell.r >= c.r * cfg.eatSizeRatio && org.cells.length < cfg.cellLimit && org.species.canSplit) {
          this.add(danger, local.x, local.y, (P.virusAvoid * 400) / Math.max(straight - cell.r - c.r, 1));
        }
      } else if (c.kind === EJECTED && cell.r >= c.r * cfg.eatSizeRatio && org.species.eatsFood) {
        const d = this.locate(world, c.p);
        if (d >= 0) this.add(interest, local.x, local.y, (P.ejected * 2) / Math.max(d, 1));
      }
    });

    if (preySeen) botStats.preySeen++;

    if (wantsPower && route && !rainbow && (biggerNear || (P.id === 'survivor' && nearestThreat))) {
      const st = arcade.states[route.index];
      if (st) {
        const food = world.food;
        for (let k = 0; k < st.powerFood.length; k++) {
          const fi = st.powerFood[k];
          if (fi < 0) continue;
          this.q.x = food.x[fi];
          this.q.y = food.y[fi];
          this.q.z = food.z[fi];
          const d = this.locate(world, this.q);
          if (d < 0 || d > 1500) continue;
          this.add(interest, local.x, local.y, 8 / Math.max(d, 30));
          botStats.powerSeeks++;
        }
      }
    }

    // Maze lure: NPCs small enough for a district's corridors drift into it — the food lines are quick to
    // sweep up and narrow corridors are a refuge from big cells. Outside the grid: straight toward the district; in its
    // plains margin: along the flood toward the reachable tile nearest the centre (so there's no tug-of-war at the edge).
    // Inside the perimeter the pull fades over the first 10 tiles, so NPCs don't dither in the gates.
    let depth = 0;
    if (route && mazeInterior) {
      route.locate(cell.p);
      const G = route.G;
      depth = Math.min(route.gx - 8, route.gy - 8, G - 8 - route.gx, G - 8 - route.gy);
    }
    if (maze.enabled && depth < 10 && P.food > 0 && org.species.eatsFood && cell.r <= cfg.fineTile * 2) {
      const threatened = nearestThreat !== null && nearestThreatEdge < 800;
      // A fixed-size bias (food interest sums to ~0.1–1 per think), stronger for grazers and threatened survivors.
      const pull = (1 - depth / 10) * (P.id === 'survivor' && threatened ? 2 : P.id === 'grazer' || P.id === 'survivor' ? 0.35 : 0.2) * P.food;
      if (!route) {
        const c = maze.layout.regions[maze.layout.regionAt(cell.p)].centre;
        if (R * angle(cell.p, c) < 9000) {
          frame.project(R, c, local);
          this.add(interest, local.x, local.y, pull);
        }
      } else {
        const flood = sharedFlood;
        const G = route.G;
        let best = -1;
        let bestD = Infinity;
        for (let k = 0; k < flood.count; k++) {
          const v = flood.list[k];
          const vi = v % G;
          const vj = (v - vi) / G;
          const dd = (vi - G / 2) ** 2 + (vj - G / 2) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = v;
          }
        }
        if (best >= 0 && best !== ourTile) {
          const hop = flood.stepToward(best, 2);
          const hi = hop % G;
          route.point(hi + 0.5, (hop - hi) / G + 0.5, this.q);
          frame.project(R, this.q, local);
          this.add(interest, local.x, local.y, pull);
        }
      }
    }

    // Hide under a virus when small and threatened.
    if (P.hideAtVirus && !mazeInterior && nearestThreat && cell.r < cfg.virusRadius && viruses.length > 0) {
      let best: Cell | null = null;
      let bestD = Infinity;
      for (const v of viruses) {
        const dv = R * angle(cell.p, v.p);
        if (dv < bestD) {
          bestD = dv;
          best = v;
        }
      }
      if (best && bestD < 1200) {
        frame.project(R, best.p, local);
        this.add(interest, local.x, local.y, 5 / Math.max(bestD, 30));
        this.action = 'hide';
      }
    }

    // Field score per slot and its peak (the scale the wander thresholds and the turn cost are measured in).
    const score = this.score;
    let peak = 0;
    for (let k = 0; k < SLOTS; k++) {
      score[k] = interest[k] - danger[k] * P.caution;
      peak = Math.max(peak, Math.abs(score[k]));
    }

    // Wander goal: entered on a weak field, held until reached, timed out or the field gets strong.
    const enter = cfg.botWanderEnter;
    const where = route ? route.index : -1;
    const forced = this.forcedTicks > 0;
    if (this.wanderTicks > 0) {
      this.wanderTicks -= this.difficulty.thinkTicks;
      if (where !== this.wanderWhere || (!forced && peak > 3 * enter) || R * angle(cell.p, this.wanderTarget) < 400) this.wanderTicks = 0;
    }
    if (this.wanderTicks <= 0 && (forced || peak < enter)) this.pickWander(world, org, cell, forced);
    if (this.wanderTicks > 0) {
      const d = this.locate(world, this.wanderTarget);
      if (d < 0) this.wanderTicks = 0;
      else if (forced) {
        // The backstop ignores the field, like the stuck escape.
        score.fill(0);
        this.add(score, local.x, local.y, 1);
        peak = 1;
      } else {
        const w = local;
        const l = Math.hypot(w.x, w.y);
        if (l > 1e-9) {
          for (let k = 0; k < SLOTS; k++) {
            const c = (w.x * COS[k] + w.y * SIN[k]) / l;
            if (c > 0) score[k] += enter * c;
          }
          peak = Math.max(peak, enter);
        }
      }
    }

    // Choose a direction: the field minus a turning cost against the last heading.
    let hx = 0;
    let hy = 0;
    if (this.hasHeading) {
      hx = dot(this.heading, frame.e);
      hy = dot(this.heading, frame.s);
      const hl = Math.hypot(hx, hy);
      if (hl > 1e-9) {
        hx /= hl;
        hy /= hl;
      }
    }
    const turn = cfg.botTurnCost * peak;
    let bestSlot = -1;
    let bestScore = -Infinity;
    let hasSignal = false;
    for (let k = 0; k < SLOTS; k++) {
      if (score[k] !== 0) hasSignal = true;
      if (hx !== 0 || hy !== 0) {
        // In the open every turn costs (turns stay gradual); in corridors only turning back does, since a cost on
        // gradual turns would bias the choice toward the old heading and cut corners into walls.
        const c = COS[k] * hx + SIN[k] * hy;
        score[k] -= turn * (route ? 2 * Math.max(0, -c) : 1 - c);
      }
      if (score[k] > bestScore) {
        bestScore = score[k];
        bestSlot = k;
      }
    }
    if (!hasSignal) bestSlot = hx !== 0 || hy !== 0 ? Math.round(Math.atan2(hy, hx) / SLOT_ANGLE + SLOTS) % SLOTS : Math.floor(world.rng() * SLOTS);

    // Smooth between neighbouring slots (parabolic peak).
    const s0 = score[(bestSlot + SLOTS - 1) % SLOTS];
    const s1 = score[bestSlot];
    const s2 = score[(bestSlot + 1) % SLOTS];
    const denom = s0 - 2 * s1 + s2;
    const offset = hasSignal && denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / denom)) : 0;
    const dir = (bestSlot + offset) * SLOT_ANGLE + (world.rng() - 0.5) * this.difficulty.aimNoise;
    const lookahead = route ? 400 : Math.max(600, perception * 0.5);
    frame.unproject(R, Math.cos(dir) * lookahead, Math.sin(dir) * lookahead, org.target);
    this.action = nearestThreat && nearestThreatEdge < 600 ? 'flee' : this.wanderTicks > 0 ? (forced ? 'unjitter' : 'wander') : 'graze';

    // Chase: commit to the best prey when nothing threatens us, leading its movement (open plains only).
    const target = chase as Cell | null;
    if (target && !route && nearestThreatEdge > 400 && (P.prey * 1.5 > P.threat || rainbow)) {
      // Lead by the ticks we need to get there (capped), using the prey's last-tick velocity.
      const lead = Math.min(12, (R * angle(cell.p, target.p)) / Math.max(1, speedPerTick(cfg, cell)));
      const vx = target.p.x - target.prev.x;
      const vy = target.p.y - target.prev.y;
      const vz = target.p.z - target.prev.z;
      org.target.x = target.p.x + vx * lead;
      org.target.y = target.p.y + vy * lead;
      org.target.z = target.p.z + vz * lead;
      const l = Math.hypot(org.target.x, org.target.y, org.target.z);
      org.target.x /= l;
      org.target.y /= l;
      org.target.z /= l;
      this.action = 'chase';
    }

    // Split-escape: a threat is about to catch us.
    if (P.splitEscape && !route && nearestThreat && nearestThreatEdge < 60 && canSplit && org.cells.length <= 2 && !this.splitCooldown) {
      org.wantSplit = true;
      this.splitCooldown = 25;
      this.action = 'split-escape';
      botStats.escapes++;
      return true;
    }

    // Split-kill: only when no virus sits near the prey.
    const prey = bestPrey as Cell | null;
    if (prey) {
      const clearance = splitR + prey.r + 40;
      const virusNear = viruses.some((v) => R * angle(v.p, prey.p) < clearance + v.r);
      if (virusNear) botStats.virusBlocked++;
      if (!virusNear) {
        botStats.splitKills++;
        copy(org.target, prey.p);
        org.wantSplit = true;
        this.pursuit = prey;
        this.pursuitTicks = 20;
        this.splitCooldown = 21;
        this.action = 'split-kill';
        return true;
      }
    }

    // Trickster: line up virus → big target, then feed the virus until it shoots.
    // Needs ~7 ejects × 20 mass to spare.
    if (P.feedVirus && !route && cell.mass >= 200 && bigTargets.length > 0 && viruses.length > 0) {
      for (const v of viruses) {
        const dv = R * angle(cell.p, v.p);
        if (dv > 900 || dv < cell.r + v.r) continue;
        frame.project(R, v.p, local);
        const vx = local.x;
        const vy = local.y;
        for (const t of bigTargets) {
          frame.project(R, t.p, local);
          const tx = local.x - vx;
          const ty = local.y - vy;
          const dt = Math.hypot(tx, ty);
          if (dt > 1300 || dt < t.r) continue;
          const cosA = (vx * tx + vy * ty) / (Math.hypot(vx, vy) * dt);
          if (cosA > 0.94) {
            copy(this.feedTarget, v.p);
            copy(org.target, v.p);
            this.feedTicks = 7 * cfg.ejectCooldownTicks + 2;
            org.wantEject = true;
            this.action = 'feed-virus';
            botStats.feeds++;
            return true;
          }
        }
      }
    }
    return true;
  }

  /**
   * A wander goal. In a district: a reachable tile from this think's flood, in the far part of it. In the
   * plains: 3 000–6 000 units away, toward the nearest district if we fit its corridors, else roughly straight on.
   */
  private pickWander(world: World, org: Organism, cell: Cell, far: boolean): void {
    const route = this.route;
    const R = world.R;
    this.wanderWhere = route ? route.index : -1;
    copy(this.crumbs[this.crumb], cell.p);
    this.crumb = (this.crumb + 1) % this.crumbs.length;
    if (route) {
      const flood = sharedFlood;
      if (flood.count < 8) return;
      const maxCost = flood.cost[flood.list[flood.count - 1]];
      const minCost = Math.min(far ? 10 : 8, maxCost * (far ? 0.8 : 0.6));
      // Of a dozen far tiles, the one most nearly straight on and furthest from recent picks, so successive goals
      // sweep instead of pacing.
      const hx = dot(this.heading, this.frame.e);
      const hy = dot(this.heading, this.frame.s);
      let best = -1;
      let bestScore = -Infinity;
      for (let k = 0; k < 12; k++) {
        const v = flood.list[Math.floor(flood.count * (0.5 + 0.5 * world.rng()))];
        if (flood.cost[v] < minCost) continue;
        const vi = v % route.G;
        this.frame.project(R, route.point(vi + 0.5, (v - vi) / route.G + 0.5, this.q), this.local);
        let fresh = Infinity;
        for (const c of this.crumbs) if (c.x || c.y || c.z) fresh = Math.min(fresh, R * angle(c, this.q));
        const score =
          (this.local.x * hx + this.local.y * hy) / Math.max(1, Math.hypot(this.local.x, this.local.y)) +
          Math.min(1, fresh / 1500) +
          world.rng() * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      if (best < 0) return;
      const bi = best % route.G;
      route.point(bi + 0.5, (best - bi) / route.G + 0.5, this.wanderTarget);
      this.wanderTicks = far ? JITTER_FORCE_TICKS : world.cfg.botWanderHoldTicks;
      botStats.wanders++;
      return;
    }
    const maze = world.maze;
    const dist = (far ? 4000 : 3000) + 3000 * world.rng();
    if (maze.enabled && cell.r <= world.cfg.fineTile * 2 && org.species.eatsFood) {
      copy(this.wanderTarget, maze.layout.regions[maze.layout.regionAt(cell.p)].centre);
    } else {
      const frame = this.frame;
      const a = (this.hasHeading ? Math.atan2(dot(this.heading, frame.s), dot(this.heading, frame.e)) : world.rng() * Math.PI * 2) + (world.rng() - 0.5) * ((Math.PI * 2) / 3);
      frame.unproject(R, Math.cos(a) * Math.min(dist, R * 2.5), Math.sin(a) * Math.min(dist, R * 2.5), this.wanderTarget);
    }
    this.wanderTicks = far ? JITTER_FORCE_TICKS : world.cfg.botWanderHoldTicks;
    botStats.wanders++;
  }

}
