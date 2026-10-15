// The autoplayer's brain: a snapshot of the screen in, an intent out (where to steer, whether to split). It plays to be
// as big as possible at the end of a timed run, and a death throws the run away, so staying alive always comes first.
//
// It works in the camera's chart (world units from the screen centre, x right, y down) and scores 32 headings plus the
// exact heading of each goal: what it would gain going that way (pellets swept, prey, rainbow victims, spores, a maze
// exit, a wander heading) minus what it risks (anything that can eat or explode one of our cells, split lunges, viruses
// that would pop us), weighed by the mass at stake. In a maze, directions and distances come from a path flood over the
// district's tiles; the mazes are the same every game, so a regular player knows them. All the numbers it uses are in
// BrainParams, which `npm run autoplay -- tune` searches.
import type { GameConfig } from '../../src/config/types.ts';
import { MASK_REGULAR, type District } from '../../src/maze/district.ts';
import { Flood } from '../../src/maze/nav.ts';
import { MazeWorld } from '../../src/maze/walls.ts';
import { Frame } from '../../src/sphere/frame.ts';
import { type Vec3, normalize, vec3 } from '../../src/sphere/vec3.ts';
import { CELL_STRIDE, F_FLICKER, F_PHAGE, F_RAINBOW, FOOD_STRIDE, K_CELL, K_EJECTED, K_VIRUS, ME_STRIDE, type Snapshot } from './snapshot.ts';

export interface BrainParams {
  /** Seconds of play the run lasts (the brain knows the clock). */
  runSeconds: number;
  /** Extra world units added to every threat's reach. */
  margin: number;
  /** How fast risk fades with the gap to a threat (world units). */
  fall: number;
  /** Weight of risk (× the mass at stake) against gain. */
  risk: number;
  /** Weight of a threat that could split onto us. */
  lunge: number;
  /** Share of splitBoost a lunge is trusted to cover (ours and theirs). */
  splitReach: number;
  /** Pellet gain weight. */
  food: number;
  /** Prey gain weight. */
  prey: number;
  /** Longest intercept (s) worth chasing. */
  chaseMax: number;
  /** Split onto prey worth at least this share of our mass. */
  splitShare: number;
  /** No cell that could eat our halves within this many units (edge distance) of us or the prey. */
  splitSafe: number;
  /** A spore's worth (mass) on its own; big cells on screen add to it. */
  spore: number;
  /** How much big cells on screen add to a spore's worth (× their mass). */
  sporeBig: number;
  /** Farthest spore (world units of path) worth a detour. */
  sporeRange: number;
  /** Share of a victim's mass a rainbow touch is worth (crumbs, and chunks for the chain). */
  rainbowShare: number;
  /** Leave a maze when our radius passes this share of the widest way out. */
  mazeLeave: number;
  /** Leave a maze above this radius whatever the room. */
  mazeMaxR: number;
  /** A pop on a virus, as a share of our mass at stake. */
  virus: number;
  /** Last seconds of the run: risk counts double and there are no splits. */
  endCare: number;
  /** How much big cells remembered near a spore (seen in the last 20 s) count, against those on screen (0 = screen only). */
  sporeMem: number;
  /** While rainbow, worth of heading for a remembered big cell off screen (× its mass × rainbowShare; 0 = never). */
  hunt: number;
  /** Mass a second the wander heading is worth when nothing else is. */
  wander: number;
  /** Bonus for keeping the current heading, against dithering. */
  keep: number;
  /** Cursor distance from our cell when cruising (CSS px). */
  cursor: number;
}

export const DEFAULT_PARAMS: BrainParams = {
  runSeconds: 300,
  margin: 120,
  fall: 220,
  risk: 3,
  lunge: 0.6,
  splitReach: 0.8,
  food: 1,
  prey: 1,
  chaseMax: 3,
  splitShare: 0.15,
  splitSafe: 1600,
  spore: 30,
  sporeBig: 0.15,
  sporeRange: 3000,
  rainbowShare: 0.5,
  sporeMem: 0,
  hunt: 0,
  mazeLeave: 0.85,
  mazeMaxR: 150,
  virus: 0.25,
  endCare: 10,
  wander: 2,
  keep: 0.15,
  cursor: 190,
};

export type IntentMode = 'go' | 'at' | 'park';

export interface Intent {
  /** 'go': steer along `dir` (a world tangent at our centre); 'at': put the cursor on world point `p`; 'park': on our cell. */
  mode: IntentMode;
  dir: number[];
  p: number[];
  /** Cursor distance from our cell for 'go' (CSS px). */
  dist: number;
  /** Split once the cursor is on the target. */
  split: boolean;
  /** What it is doing, for logs. */
  goal: string;
  /** Snapshot time the decision was made at (ms since Play). */
  t: number;
}

interface Body {
  id: number;
  p: Vec3;
  x: number;
  y: number;
  r: number;
  mass: number;
  age: number;
  speed: number;
}

interface Other {
  id: number;
  p: Vec3;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  mass: number;
  kind: number;
  owner: number;
  flags: number;
  speed: number;
  /** A remembered cell that left the screen. */
  ghost: boolean;
}

interface Seen {
  p: Vec3;
  v: Vec3;
  t: number;
  r: number;
  owner: number;
  flags: number;
}

interface Goal {
  x: number;
  y: number;
  /** Mass it is worth. */
  value: number;
  /** Seconds to get there. */
  time: number;
  name: string;
}

const DIRS = 32;
const TAU = [0, 0.3, 0.6, 1, 1.5];
const SQRT2 = Math.SQRT2;

export class Brain {
  readonly cfg: GameConfig;
  readonly params: BrainParams;
  private readonly maze: MazeWorld;
  private readonly flood = new Flood();
  private readonly frame = new Frame();
  private readonly seen = new Map<number, Seen>();
  /** Big cells seen in the last 20 s (worth a rainbow): position and mass when last seen. */
  private readonly bigSeen = new Map<number, { p: Vec3; mass: number; t: number }>();
  private readonly q = vec3();
  private readonly loc = { x: 0, y: 0 };
  private heading = { x: 0, y: 0 };
  private wanderDir = { x: 0, y: 0 };
  private wanderUntil = 0;
  private lastSplit = -1e9;
  /** Diagnostics for logs and tests. */
  lastScores: number[] = [];
  lastRisk = 0;
  lastThreats = 0;
  lastGoals: string[] = [];
  /** Why split-kills didn't happen (diagnostics). */
  readonly splitWhy: Record<string, number> = {};

  constructor(cfg: GameConfig, params: Partial<BrainParams> = {}) {
    this.cfg = cfg;
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.maze = new MazeWorld(cfg);
  }

  /** Speed of a cell of radius r in world units per second (full speed; phages are faster). */
  speedOf(r: number, phage = false): number {
    const cfg = this.cfg;
    return (2.1106 / Math.pow(Math.max(r, 1), 0.449)) * 40 * cfg.speedScale * (phage ? cfg.ghostSpeed : 1) * (1000 / cfg.tickMs) * (cfg.tickMs / 40);
  }

  decide(s: Snapshot): Intent {
    const P = this.params;
    const cfg = this.cfg;
    const R = cfg.sphereRadius;
    const intent: Intent = { mode: 'go', dir: [0, 0, 0], p: [0, 0, 0], dist: P.cursor, split: false, goal: 'idle', t: s.t };
    const f = this.frame;
    const cam = s.cam;
    f.c.x = cam[0];
    f.c.y = cam[1];
    f.c.z = cam[2];
    f.e.x = cam[3];
    f.e.y = cam[4];
    f.e.z = cam[5];
    f.s.x = cam[6];
    f.s.y = cam[7];
    f.s.z = cam[8];
    if (s.t >= P.runSeconds * 1000) {
      intent.mode = 'park';
      intent.goal = 'park';
      return intent;
    }

    // ---- Our cells.
    const me: Body[] = [];
    let M = 0;
    let L: Body | null = null;
    for (let k = 0; k < s.me.length; k += ME_STRIDE) {
      const p = vec3(s.me[k + 1], s.me[k + 2], s.me[k + 3]);
      f.project(R, p, this.loc);
      const r = s.me[k + 4];
      const b: Body = { id: s.me[k], p, x: this.loc.x, y: this.loc.y, r, mass: (r * r) / 100 + s.me[k + 5], age: s.me[k + 6], speed: this.speedOf(r) };
      me.push(b);
      M += b.mass;
      if (!L || r > L.r) L = b;
    }
    if (!L) return intent;
    let cx = 0;
    let cy = 0;
    for (const b of me) {
      cx += b.x * b.mass;
      cy += b.y * b.mass;
    }
    cx /= M;
    cy /= M;
    const v = L.speed;
    const rainbow = s.rainbow > 0;
    const timeLeft = P.runSeconds - s.t / 1000;
    const endCare = timeLeft < P.endCare;
    const riskW = P.risk * (endCare ? 2 : 1);

    // ---- Others, with velocities from the last sighting, plus remembered threats that left the screen.
    const others = this.readOthers(s, f, R);

    const tmp = { x: 0, y: 0 };
    // ---- Maze: a path flood from our tile when we're in a district's grid.
    let d: District | null = null;
    let ourTile = -1;
    let interior = false;
    if (this.maze.enabled) {
      d = this.maze.districtAt(L.p);
      if (d && d.locate(L.p)) {
        ourTile = d.tileIndex(d.gx, d.gy);
        interior = d.inInterior(d.gx, d.gy);
        if (ourTile >= 0) this.flood.run(d, ourTile, L.r * 0.98, MASK_REGULAR, 4000, 90);
        else d = null;
      } else d = null;
    }
    // Path direction and length from us to world point q (straight in the open; −1 when the flood can't reach it).
    const route = (q: Vec3, out: { x: number; y: number }): number => {
      f.project(R, q, out);
      const straight = Math.hypot(out.x - L.x, out.y - L.y);
      if (!d || !d.locate(q)) return straight;
      const t = d.tileIndex(d.gx, d.gy);
      if (t < 0) return straight;
      if (!this.flood.reached(t)) return d.inInterior(d.gx, d.gy) ? -1 : straight;
      if (t === ourTile) return straight;
      const hop = this.flood.stepToward(t, 2);
      const i = hop % d.G;
      const j = (hop - i) / d.G;
      d.point(i + 0.5, j + 0.5, this.q);
      f.project(R, this.q, out);
      return Math.max(straight, this.flood.cost[t] * d.F);
    };
    // Can a cell of radius r at q get its reach onto us through the corridors? Outside a maze interior, yes. Inside, yes
    // when any tile within its eating reach of us is in the same corridor component (for its size) as the cell; its
    // centre needn't fit our tile (a big cell in an avenue eats a small one at the mouth of a fine corridor).
    const canReach = (q: Vec3, r: number): boolean => {
      if (!d || ourTile < 0 || !interior) return true;
      const cls = d.classOf(r);
      const labels = d.labels[cls];
      const G = d.G;
      let theirs = labels[0];
      if (d.locate(q)) {
        const t = d.tileIndex(d.gx, d.gy);
        if (t >= 0) theirs = labels[t];
      }
      if (theirs === 0) return true;
      const reach = Math.max(0, r - L.r / 3) + d.F;
      const k = Math.ceil(reach / d.F);
      const oi = ourTile % G;
      const oj = (ourTile - oi) / G;
      for (let dj = -k; dj <= k; dj++) {
        for (let di = -k; di <= k; di++) {
          const i = oi + di;
          const j = oj + dj;
          if (i < 0 || j < 0 || i >= G || j >= G) continue;
          if ((di * di + dj * dj) * d.F * d.F > reach * reach) continue;
          if (labels[j * G + i] === theirs) return true;
        }
      }
      return false;
    };

    // ---- Threats and goals.
    const goals: Goal[] = [];
    const threats: { o: Other; reach: number[]; lungeReach: number[]; weight: number; speed: number }[] = [];
    const viruses: Other[] = [];
    const eatRatio = cfg.eatSizeRatio;
    let bigOnScreen = 0;
    for (const o of others) {
      if (o.kind === K_VIRUS) {
        viruses.push(o);
        continue;
      }
      if (o.kind === K_EJECTED) {
        if (L.r >= o.r * eatRatio && !o.ghost) {
          const dist = route(o.p, tmp);
          if (dist >= 0) goals.push({ x: tmp.x, y: tmp.y, value: o.mass * P.prey, time: dist / v, name: 'blob' });
        }
        continue;
      }
      const theirRainbow = (o.flags & F_RAINBOW) !== 0;
      const phage = (o.flags & F_PHAGE) !== 0;
      if (o.mass > M * 1.3) bigOnScreen += o.mass;
      if (!o.ghost && !phage && !theirRainbow && o.mass > Math.max(M * 1.5, 60)) this.bigSeen.set(o.owner * 1e6 + o.id, { p: o.p, mass: o.mass, t: s.t });
      // Threat to each of our cells?
      const reach: number[] = [];
      const lungeReach: number[] = [];
      let any = false;
      for (const b of me) {
        let r = -Infinity;
        let lr = -Infinity;
        if (rainbow) {
          // Nothing bigger can eat a rainbow cell; a smaller rainbow cell explodes us on touch.
          if (theirRainbow && o.r < b.r) r = o.r + b.r;
        } else if (theirRainbow) {
          if (o.r < b.r) r = o.r + b.r;
          else if (o.r > b.r) r = o.r - b.r / 3;
        } else if (o.r >= b.r * eatRatio) {
          r = o.r - b.r / 3;
          const half = o.r / SQRT2;
          if (!phage && o.r >= cfg.splitMinRadius && half >= b.r * eatRatio) lr = cfg.splitBoost * P.splitReach + half - b.r / 3;
        }
        reach.push(r);
        lungeReach.push(lr);
        if (r > -Infinity) any = true;
      }
      if (any && canReach(o.p, o.r)) {
        const weight = theirRainbow && o.r < L.r ? 0.5 : 1;
        threats.push({ o, reach, lungeReach, weight, speed: Math.max(o.speed, Math.hypot(o.vx, o.vy)) });
      }
      if (o.ghost) continue;
      // Goals: prey, rainbow victims.
      if (rainbow) {
        const leftAfter = s.rainbow - 0.2;
        if (o.r > L.r && o.mass >= 8) {
          const dist = route(o.p, tmp);
          const time = dist < 0 ? Infinity : Math.max(0, dist - L.r - o.r) / v;
          if (time < leftAfter) goals.push({ x: tmp.x, y: tmp.y, value: o.mass * P.rainbowShare, time, name: 'explode' });
        } else if (o.r < L.r) {
          const dist = route(o.p, tmp);
          if (dist >= 0) goals.push({ x: tmp.x, y: tmp.y, value: o.mass * P.prey, time: Math.max(0, dist - L.r) / v, name: 'eat' });
        }
      } else if (L.r >= o.r * eatRatio && !theirRainbow) {
        const t = this.intercept(L, o, v);
        if (t >= 0 && t <= P.chaseMax) {
          this.q.x = o.x + o.vx * t;
          this.q.y = o.y + o.vy * t;
          f.unproject(R, this.q.x, this.q.y, this.q);
          const dist = route(this.q, tmp);
          // Faster prey gets away more often.
          const odds = Math.min(1, Math.max(0.15, v / Math.max(1, o.speed)) * 0.8);
          if (dist >= 0) goals.push({ x: tmp.x, y: tmp.y, value: o.mass * P.prey * odds, time: dist / v, name: phage ? 'phage' : 'chase' });
        }
      }
    }

    // ---- Big cells remembered from the last 20 s: what a rainbow could reach from where we are.
    for (const [k, b] of this.bigSeen) if (s.t - b.t > 20000 || b.mass <= M * 1.2) this.bigSeen.delete(k);

    // ---- Spores: on screen or on the minimap, worth more with big cells near them.
    if (!rainbow) {
      for (let k = 0; k < s.spores.length; k += 3) {
        this.q.x = s.spores[k];
        this.q.y = s.spores[k + 1];
        this.q.z = s.spores[k + 2];
        let big = 0;
        for (const b of this.bigSeen.values()) {
          const dd = R * Math.acos(Math.min(1, b.p.x * this.q.x + b.p.y * this.q.y + b.p.z * this.q.z));
          if (dd < v * 6) big += Math.min(b.mass, 4000);
        }
        const dist = route(this.q, tmp);
        if (dist < 0 || dist > P.sporeRange) continue;
        goals.push({ x: tmp.x, y: tmp.y, value: P.spore + P.sporeBig * Math.max(P.sporeMem * big, bigOnScreen), time: dist / v, name: 'spore' });
      }
    } else if (s.rainbow > 1.5 && P.hunt > 0) {
      // Rainbow with no victim in reach on screen: where the big cells were.
      for (const b of this.bigSeen.values()) {
        const dist = route(b.p, tmp);
        if (dist < 0) continue;
        const time = Math.max(0, dist - L.r) / v;
        if (time < s.rainbow - 0.5) goals.push({ x: tmp.x, y: tmp.y, value: b.mass * P.rainbowShare * P.hunt, time, name: 'hunt' });
      }
    }

    // ---- Maze exit: before packing caps us, or when we're past the size for corridors.
    if (d && interior && ourTile >= 0) {
      const room = d.escape[ourTile];
      const packed = me.some((_, k) => s.me[k * ME_STRIDE + 5] > 0);
      if (packed || L.r > P.mazeLeave * room || L.r > P.mazeMaxR) {
        const exit = this.nearestExit(d);
        if (exit >= 0) {
          const i = exit % d.G;
          const j = (exit - i) / d.G;
          d.point(i + 0.5, j + 0.5, this.q);
          const dist = route(this.q, tmp);
          if (dist >= 0) goals.push({ x: tmp.x, y: tmp.y, value: Math.max(20, M * 0.5), time: dist / v, name: 'exit' });
        }
      }
    }

    // ---- Wander: a held heading for when nothing on screen is worth much.
    if (s.t >= this.wanderUntil || (this.wanderDir.x === 0 && this.wanderDir.y === 0)) {
      const h = this.heading.x || this.heading.y ? this.heading : { x: 1, y: 0 };
      const a = Math.atan2(h.y, h.x) + Math.sin(s.t * 0.00037) * 1.2;
      this.wanderDir = { x: Math.cos(a), y: Math.sin(a) };
      this.wanderUntil = s.t + 12000;
    }

    // ---- Score the headings. In a maze interior the candidates are the corridor directions out of our tile, each with
    // the risk of the safest tile it leads to; in the open, 32 headings and the exact heading of each goal.
    const cands: { x: number; y: number; risk: number }[] = [];
    const inMaze = d !== null && interior && ourTile >= 0 && this.flood.count > 1;
    if (inMaze) cands.push(...this.mazeCandidates(d!, L, me.indexOf(L), v, threats));
    if (!cands.length) {
      for (let k = 0; k < DIRS; k++) cands.push({ x: Math.cos((k / DIRS) * Math.PI * 2), y: Math.sin((k / DIRS) * Math.PI * 2), risk: -1 });
      for (const g of goals) {
        const gx = g.x - L.x;
        const gy = g.y - L.y;
        const l = Math.hypot(gx, gy);
        if (l > 1) cands.push({ x: gx / l, y: gy / l, risk: -1 });
      }
    }
    const food = this.foodField(s, L, v, d, route);
    const scores: number[] = [];
    let best = -Infinity;
    let bestK = 0;
    let bestRisk = 0;
    for (let k = 0; k < cands.length; k++) {
      const u = cands[k];
      let gain = P.food * food(u);
      for (const g of goals) {
        const gx = g.x - L.x;
        const gy = g.y - L.y;
        const l = Math.hypot(gx, gy);
        const c = l > 1 ? (u.x * gx + u.y * gy) / l : 1;
        if (c <= 0) continue;
        gain += (g.value * c ** 8) / (1 + g.time);
      }
      gain += P.wander * Math.max(0, u.x * this.wanderDir.x + u.y * this.wanderDir.y) ** 4;
      const risk = u.risk >= 0 ? u.risk : this.risk(u, me, threats, viruses);
      let score = gain - riskW * risk * (M + 10);
      score += P.keep * (u.x * this.heading.x + u.y * this.heading.y) * (Math.abs(gain) + 1);
      scores.push(score);
      if (score > best) {
        best = score;
        bestK = k;
        bestRisk = risk;
      }
    }
    this.lastScores = scores;
    this.lastRisk = bestRisk;
    this.lastThreats = threats.length;
    this.lastGoals = goals.map((g) => `${g.name}:${Math.round(g.value)}/${g.time.toFixed(1)}`);
    const u = cands[bestK];
    this.heading = { x: u.x, y: u.y };

    // The goal this heading serves best, for the log.
    let goalName = 'graze';
    let goalBest = 0;
    for (const g of goals) {
      const gx = g.x - L.x;
      const gy = g.y - L.y;
      const l = Math.hypot(gx, gy);
      const c = l > 1 ? (u.x * gx + u.y * gy) / l : 1;
      const w = (g.value * Math.max(0, c) ** 8) / (1 + g.time);
      if (w > goalBest) {
        goalBest = w;
        goalName = g.name;
      }
    }
    if (bestRisk > 0.3) goalName = `flee/${goalName}`;

    // ---- Split onto prey, when it is worth it and safe.
    const split = rainbow || endCare || interior ? null : this.splitTarget(s, me, L, M, others);
    if (split) {
      this.lastSplit = s.t;
      intent.mode = 'at';
      f.unproject(R, split.x, split.y, this.q);
      intent.p = [this.q.x, this.q.y, this.q.z];
      intent.split = true;
      intent.goal = 'split-kill';
      return intent;
    }

    // Heading → world tangent at our largest cell.
    const t3 = vec3(f.e.x * u.x + f.s.x * u.y, f.e.y * u.x + f.s.y * u.y, f.e.z * u.x + f.s.z * u.y);
    const k = t3.x * L.p.x + t3.y * L.p.y + t3.z * L.p.z;
    t3.x -= k * L.p.x;
    t3.y -= k * L.p.y;
    t3.z -= k * L.p.z;
    normalize(t3);
    intent.dir = [t3.x, t3.y, t3.z];
    intent.goal = goalName;
    return intent;
  }

  /** Visible cells with velocities, and threats seen in the last 2 s that left the screen, moved on by their speed. */
  private readOthers(s: Snapshot, f: Frame, R: number): Other[] {
    const out: Other[] = [];
    const now = s.t;
    const present = new Set<number>();
    for (let k = 0; k < s.cells.length; k += CELL_STRIDE) {
      const id = s.cells[k];
      const p = vec3(s.cells[k + 1], s.cells[k + 2], s.cells[k + 3]);
      const r = s.cells[k + 4];
      const kind = s.cells[k + 5];
      const owner = s.cells[k + 6];
      const flags = s.cells[k + 7];
      present.add(id);
      const prev = this.seen.get(id);
      const vel = vec3();
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000;
        vel.x = ((p.x - prev.p.x) * R) / dt;
        vel.y = ((p.y - prev.p.y) * R) / dt;
        vel.z = ((p.z - prev.p.z) * R) / dt;
        // Smooth a little: a person reads motion over a few frames.
        vel.x = 0.6 * vel.x + 0.4 * prev.v.x;
        vel.y = 0.6 * vel.y + 0.4 * prev.v.y;
        vel.z = 0.6 * vel.z + 0.4 * prev.v.z;
      }
      this.seen.set(id, { p, v: vel, t: now, r, owner, flags });
      f.project(R, p, this.loc);
      out.push({
        id,
        p,
        x: this.loc.x,
        y: this.loc.y,
        vx: vel.x * f.e.x + vel.y * f.e.y + vel.z * f.e.z,
        vy: vel.x * f.s.x + vel.y * f.s.y + vel.z * f.s.z,
        r,
        mass: (r * r) / 100,
        kind,
        owner,
        flags,
        speed: kind === K_CELL ? this.speedOf(r, (flags & F_PHAGE) !== 0) : 0,
        ghost: false,
      });
    }
    for (const [id, m] of this.seen) {
      if (present.has(id)) continue;
      const age = now - m.t;
      if (age > 2000) {
        this.seen.delete(id);
        continue;
      }
      // Only remembered as a possible threat, carried on along its last motion.
      const dt = age / 1000;
      const p = vec3(m.p.x + (m.v.x * dt) / R, m.p.y + (m.v.y * dt) / R, m.p.z + (m.v.z * dt) / R);
      normalize(p);
      f.project(R, p, this.loc);
      const flags = m.flags & ~F_FLICKER;
      out.push({ id, p, x: this.loc.x, y: this.loc.y, vx: 0, vy: 0, r: m.r, mass: (m.r * m.r) / 100, kind: K_CELL, owner: m.owner, flags, speed: this.speedOf(m.r, (flags & F_PHAGE) !== 0), ghost: true });
    }
    return out;
  }

  /** Seconds until our cell L can reach prey o moving with its velocity, or −1. */
  private intercept(L: Body, o: Other, v: number): number {
    const dx = o.x - L.x;
    const dy = o.y - L.y;
    const reach = Math.max(1, L.r - o.r / 3);
    // |d + w t| = v t + reach → (w·w − v²) t² + 2 (d·w − v reach) t + d·d − reach² = 0
    const a = o.vx * o.vx + o.vy * o.vy - v * v;
    const b = 2 * (dx * o.vx + dy * o.vy - v * reach);
    const c = dx * dx + dy * dy - reach * reach;
    if (c <= 0) return 0;
    if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : -1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    return Number.isFinite(t) ? t : -1;
  }

  /**
   * Risk of heading along u: for each threat and each of our cells it could take, the smallest gap over the look-ahead
   * (our cell moving at full speed, the threat carrying on for 0.25 s and then coming straight at us), turned into a
   * risk that is 1 at contact and grows inside it, weighted by the share of our mass that cell carries.
   */
  private risk(u: { x: number; y: number }, me: Body[], threats: { o: Other; reach: number[]; lungeReach: number[]; weight: number; speed: number }[], viruses: Other[]): number {
    const P = this.params;
    let M = 0;
    let maxMass = 0;
    for (const b of me) {
      M += b.mass;
      maxMass = Math.max(maxMass, b.mass);
    }
    const g = (gap: number) => (gap < 0 ? 1 - gap / P.fall : Math.exp(-gap / P.fall));
    let total = 0;
    for (const t of threats) {
      const o = t.o;
      let worst = 0;
      for (let i = 0; i < me.length; i++) {
        const b = me[i];
        const reach = t.reach[i];
        if (reach === -Infinity) continue;
        const stake = (b.mass + (b.mass === maxMass ? 0.5 * M : 0)) / (1.5 * M);
        let minGap = Infinity;
        for (const tau of TAU) {
          const px = b.x + u.x * b.speed * tau;
          const py = b.y + u.y * b.speed * tau;
          const carry = Math.min(tau, 0.25);
          const ox = o.x + o.vx * carry;
          const oy = o.y + o.vy * carry;
          const gap = Math.hypot(px - ox, py - oy) - reach - P.margin - t.speed * Math.max(0, tau - 0.25);
          if (gap < minGap) minGap = gap;
        }
        let risk = g(minGap);
        const lr = t.lungeReach[i];
        if (lr > -Infinity) {
          const px = b.x + u.x * b.speed * 0.3;
          const py = b.y + u.y * b.speed * 0.3;
          const gap = Math.hypot(px - o.x, py - o.y) - lr - P.margin;
          risk = Math.max(risk, P.lunge * g(gap));
        }
        worst = Math.max(worst, risk * stake);
      }
      total += worst * t.weight;
    }
    if (P.virus > 0) {
      for (const b of me) {
        if (b.r < this.cfg.virusRadius * this.cfg.eatSizeRatio || me.length >= this.cfg.cellLimit) continue;
        const stake = b.mass / M;
        for (const vir of viruses) {
          let minGap = Infinity;
          for (const tau of TAU) {
            const gap = Math.hypot(b.x + u.x * b.speed * tau - vir.x, b.y + u.y * b.speed * tau - vir.y) - (b.r - vir.r / 3) - 20;
            if (gap < minGap) minGap = gap;
          }
          total += P.virus * stake * (minGap < 0 ? 1 : Math.exp(-minGap / 60));
        }
      }
    }
    return total;
  }

  /** Mass of pellets (spores count more) swept going along u for a couple of seconds, sooner ones worth more. */
  private foodField(s: Snapshot, L: Body, v: number, d: District | null, route: (q: Vec3, out: { x: number; y: number }) => number): (u: { x: number; y: number }) => number {
    const food = s.food;
    const reach = Math.max(8, L.r - this.cfg.foodSize / 3);
    const horizon = v * 2.5;
    // In a maze, pellets are summed into the first-hop direction of their path.
    if (d) {
      const dirs: { x: number; y: number; w: number }[] = [];
      const f = this.frame;
      const R = this.cfg.sphereRadius;
      const tmp = { x: 0, y: 0 };
      for (let k = 0; k < food.length; k += FOOD_STRIDE) {
        const fx = food[k];
        const fy = food[k + 1];
        const straight = Math.hypot(fx - L.x, fy - L.y);
        if (straight > horizon * 1.5) continue;
        f.unproject(R, fx, fy, this.q);
        const dist = route(this.q, tmp);
        if (dist < 0) continue;
        const dx = tmp.x - L.x;
        const dy = tmp.y - L.y;
        const l = Math.hypot(dx, dy);
        const w = (food[k + 2] === 2 ? 9 : 1) / (1 + Math.max(0, dist - reach) / (v * 0.8));
        if (l < 1) dirs.push({ x: 0, y: 0, w });
        else dirs.push({ x: dx / l, y: dy / l, w });
      }
      return (u) => {
        let sum = 0;
        for (const p of dirs) {
          const c = p.x === 0 && p.y === 0 ? 1 : u.x * p.x + u.y * p.y;
          if (c > 0.5) sum += p.w * (c - 0.5) * 2;
        }
        return sum;
      };
    }
    return (u) => {
      let sum = 0;
      for (let k = 0; k < food.length; k += FOOD_STRIDE) {
        const dx = food[k] - L.x;
        const dy = food[k + 1] - L.y;
        const along = dx * u.x + dy * u.y;
        if (along < -reach || along > horizon) continue;
        const across = Math.abs(dx * u.y - dy * u.x);
        if (across > reach) continue;
        sum += (food[k + 2] === 2 ? 9 : 1) / (1 + Math.max(0, along) / (v * 0.8));
      }
      return sum;
    };
  }

  /**
   * Maze interior: one candidate per corridor direction out of our tile (tiles grouped by the first hop of their path).
   * A direction's risk is the larger of the risk at its first tile and the smallest risk among the tiles it leads to
   * within 3 s: going that way, how safe is the best place we can get to? A tile's risk compares when we'd arrive with
   * how close each threat could be by then (straight through the walls, which errs on the safe side).
   */
  private mazeCandidates(
    d: District,
    L: Body,
    li: number,
    v: number,
    threats: { o: Other; reach: number[]; weight: number; speed: number }[],
  ): { x: number; y: number; risk: number }[] {
    const P = this.params;
    const flood = this.flood;
    const R = this.cfg.sphereRadius;
    const f = this.frame;
    const G = d.G;
    const maxCost = Math.min(90, (v * 3) / d.F);
    const g = (gap: number) => (gap < 0 ? 1 - gap / P.fall : Math.exp(-gap / P.fall));
    const groups = new Map<number, { first: number; cont: number; rep: number; repCost: number }>();
    const loc = this.loc;
    for (let n = 1; n < flood.count; n++) {
      const t = flood.list[n];
      const c = flood.cost[t];
      if (c > maxCost) break;
      const i = t % G;
      const j = (t - i) / G;
      d.point(i + 0.5, j + 0.5, this.q);
      f.project(R, this.q, loc);
      const arrive = (c * d.F) / v;
      let risk = 0;
      for (const th of threats) {
        const reach = th.reach[li];
        if (reach === -Infinity) continue;
        const gap = Math.hypot(th.o.x - loc.x, th.o.y - loc.y) - reach - P.margin - th.speed * (arrive + 0.25);
        risk += g(gap) * th.weight;
      }
      const h = flood.first[t];
      let grp = groups.get(h);
      if (!grp) {
        grp = { first: Infinity, cont: Infinity, rep: t, repCost: c };
        groups.set(h, grp);
      }
      if (t === h) grp.first = risk;
      if (c >= 2 && risk < grp.cont) grp.cont = risk;
      // The direction: toward the path two tiles ahead of a nearby tile of this group.
      if (c >= 2 && (grp.repCost < 2 || c < grp.repCost)) {
        grp.rep = t;
        grp.repCost = c;
      }
    }
    const out: { x: number; y: number; risk: number }[] = [];
    for (const grp of groups.values()) {
      const hop = flood.stepToward(grp.rep, 2);
      if (hop < 0) continue;
      const i = hop % G;
      const j = (hop - i) / G;
      d.point(i + 0.5, j + 0.5, this.q);
      f.project(R, this.q, loc);
      const dx = loc.x - L.x;
      const dy = loc.y - L.y;
      const l = Math.hypot(dx, dy);
      if (l < 1) continue;
      const first = Number.isFinite(grp.first) ? grp.first : 0;
      const cont = Number.isFinite(grp.cont) ? grp.cont : first;
      out.push({ x: dx / l, y: dy / l, risk: Math.max(first, cont) });
    }
    return out;
  }

  /** The nearest flood-reached tile outside the maze interior, or −1. */
  private nearestExit(d: District): number {
    const flood = this.flood;
    for (let n = 0; n < flood.count; n++) {
      const t = flood.list[n];
      const i = t % d.G;
      const j = (t - i) / d.G;
      if (!d.inInterior(i + 0.5, j + 0.5)) return t;
    }
    return -1;
  }

  /** A split-kill: the aim point (chart), or null. */
  private splitTarget(s: Snapshot, me: Body[], L: Body, M: number, others: Other[]): { x: number; y: number } | null {
    const P = this.params;
    const cfg = this.cfg;
    const why = (k: string) => {
      this.splitWhy[k] = (this.splitWhy[k] ?? 0) + 1;
      return null;
    };
    if (s.t - this.lastSplit < 1500) return why('cooldown');
    if (L.r < cfg.splitMinRadius) return why('small');
    if (me.length > 2) return why('cells');
    // Every cell over the split size splits at once.
    const splitting = me.filter((b) => b.r >= cfg.splitMinRadius);
    if (me.length + splitting.length > cfg.cellLimit) return why('limit');
    const half = L.r / SQRT2;
    const smallestAfter = Math.min(...me.map((b) => (b.r >= cfg.splitMinRadius ? b.r / SQRT2 : b.r)));
    const glide = cfg.splitBoost * P.splitReach;
    let best: { x: number; y: number; value: number } | null = null;
    for (const o of others) {
      if (o.ghost || o.kind !== K_CELL || (o.flags & F_RAINBOW) !== 0) continue;
      if (half < o.r * cfg.eatSizeRatio * 1.05) {
        if (o.r < L.r) why('prey too big for a half');
        continue;
      }
      if (o.mass < P.splitShare * M) {
        why('prey too light');
        continue;
      }
      // Where it will be when the half gets there (about 0.35 s for most of the glide).
      const tx = o.x + o.vx * 0.35;
      const ty = o.y + o.vy * 0.35;
      const dist = Math.hypot(tx - L.x, ty - L.y);
      if (dist > glide + half - o.r / 3) {
        why('prey too far');
        continue;
      }
      if (!best || o.mass > best.value) best = { x: tx, y: ty, value: o.mass };
    }
    if (!best) return why('no prey');
    // Nothing on screen that could eat our halves near us or near the prey.
    for (const o of others) {
      if (o.kind !== K_CELL) continue;
      if (o.r < smallestAfter * cfg.eatSizeRatio && !((o.flags & F_RAINBOW) !== 0 && o.r < half)) continue;
      const edge = Math.min(Math.hypot(o.x - L.x, o.y - L.y), Math.hypot(o.x - best.x, o.y - best.y)) - o.r;
      if (edge < P.splitSafe) return why('unsafe');
    }
    why('split');
    return best;
  }
}
