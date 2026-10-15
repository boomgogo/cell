// The Node harness: one game with the autoplayer, faster than real time, for tuning and gameplay data. It mirrors
// Game's 60 Hz frame loop (fixed sim steps, camera follow, attract mode, the spawn rule, the points), and the brain and
// hands drive the player through a stand-in for the game's Input, exactly as they do in the browser.
// It is not the browser run (camera timing and district builds differ), so a seed plays differently there; the
// statistics are what carry over.
import { BotController } from '../../src/ai/bot.ts';
import { DIFFICULTY, PERSONALITIES } from '../../src/ai/personalities.ts';
import { populateNpcs, populateResidents } from '../../src/ai/population.ts';
import { loadConfig } from '../../src/config/index.ts';
import type { GameConfig } from '../../src/config/types.ts';
import { createRng } from '../../src/core/rng.ts';
import { HumanController } from '../../src/input/human.ts';
import type { Input } from '../../src/input/input.ts';
import { Camera, districtView } from '../../src/render/camera.ts';
import { FOOD_KIND, POWER } from '../../src/sim/food.ts';
import { Organism } from '../../src/sim/organism.ts';
import { radiusToMass } from '../../src/sim/rules.ts';
import { World } from '../../src/sim/world.ts';
import { type Vec3, vec3 } from '../../src/sphere/vec3.ts';
import { eatPoints, explodePoints } from '../../src/ui/points.ts';
import { Brain, type BrainParams, type Intent } from './brain.ts';
import { type HandEvent, Hands, type Rect, type Screen } from './hands.ts';
import { type Snapshot, takeSnapshot } from './snapshot.ts';

export const FRAME_MS = 1000 / 60;
/** The brain decides every this many frames (100 ms). */
export const DECIDE_FRAMES = 6;

export interface RunOptions {
  seed: number;
  /** Seconds of play (default: the brain's runSeconds). */
  seconds?: number;
  params?: Partial<BrainParams>;
  /** Seed for the hands (default: the world seed). */
  hands?: number;
  /** CSS viewport (default 1280×720, the desktop recording). */
  width?: number;
  height?: number;
  touch?: boolean;
  /** 'brain': the autoplayer through input. 'npc': the NPC hunter (hard) writing the target directly, as autopilot() does. */
  driver?: 'brain' | 'npc';
  /** Attract mode before Play, ms. */
  preRoll?: number;
  /** Or exactly this many frames before Play (to replay a browser run, whose log has the frame of Play). */
  preFrames?: number;
  /** Every frame after Play, for the sanity checks and traces. */
  onFrame?: (h: Harness) => void;
}

export interface RunResult {
  seed: number;
  driver: string;
  alive: boolean;
  /** Mass at the end of the run (0 when dead). */
  mass: number;
  peak: number;
  points: number;
  /** Seconds survived (the full run when alive). */
  seconds: number;
  rank: number;
  /** Seconds until first #1 on the leaderboard (−1 never). */
  topAt: number;
  /** Longest explosion chain. */
  chain: number;
  /** Median-friendly mass at the end of each minute (0 after death). */
  curve: number[];
  /** Mass gained by source. */
  sources: Record<string, number>;
  death: string | null;
  splits: number;
  /** Sanity problems found (empty when none). */
  problems: string[];
}

/** Stand-in for the game's Input: the same fields HumanController reads, set the way the DOM events would set them. */
class FakeInput {
  x = 0;
  y = 0;
  has = false;
  touch = false;
  ejectHeld = false;
  private splitQueued = 0;
  private ejectQueued = 0;
  consumeSplit(): boolean {
    if (this.splitQueued > 0) {
      this.splitQueued--;
      return true;
    }
    return false;
  }
  consumeEject(): boolean {
    if (this.ejectQueued > 0) {
      this.ejectQueued--;
      return true;
    }
    return this.ejectHeld;
  }
  takeWheel(): number {
    return 0;
  }
  /** Applies one hand event as the page's listeners would. */
  apply(e: HandEvent, split: Rect | null): void {
    if (e.type === 'move') {
      this.x = e.x;
      this.y = e.y;
      this.has = true;
    } else if (e.type === 'key') {
      if (e.code === 'Space' && e.down) this.splitQueued++;
      if (e.code === 'KeyW') {
        if (e.down) this.ejectQueued++;
        this.ejectHeld = e.down;
      }
    } else if (e.type === 'touch' && (e.phase !== 'end' || e.points.length)) {
      for (const p of e.points) {
        // A finger on the Split button presses it; the steering thumb moves the pointer on the canvas.
        if (split && p.x >= split.x && p.y >= split.y && p.x <= split.x + split.w && p.y <= split.y + split.h) {
          if (e.phase === 'start' && p.id === 2) this.splitQueued++;
          continue;
        }
        if (p.id !== 1) continue;
        this.x = p.x;
        this.y = p.y;
        this.has = true;
        this.touch = true;
      }
    }
  }
}

/** The HUD's hit areas, as index.html lays them out, for a viewport. */
export function hudRects(w: number, h: number, touch: boolean): { avoid: Rect[]; split: Rect | null } {
  const narrow = w <= 560;
  const mini = narrow ? 72 : 96;
  const avoid: Rect[] = [
    { x: 10, y: 10, w: mini, h: mini },
    { x: 10 + mini + 4, y: 10, w: narrow ? 30 : 34, h: narrow ? 30 : 34 },
  ];
  let split: Rect | null = null;
  if (touch) {
    split = { x: w - 16 - 88, y: h - 16 - 88, w: 88, h: 88 };
    avoid.push({ x: w - 16 - 88 - 14 - 72, y: h - 16 - 88, w: 88 + 14 + 72, h: 88 });
  }
  return { avoid, split };
}

export class Harness {
  readonly cfg: GameConfig;
  readonly world: World;
  readonly camera: Camera;
  readonly human: Organism;
  readonly input = new FakeInput();
  readonly hands: Hands;
  readonly brain: Brain;
  readonly rects: { avoid: Rect[]; split: Rect | null };
  state: 'menu' | 'playing' | 'dead' = 'menu';
  points = 0;
  /** Frames since Play. */
  frames = 0;
  private acc = 0;
  private spectate: Organism | null = null;
  private spectatePickTick = 0;
  private readonly camTarget = vec3();
  private readonly driver: 'brain' | 'npc';
  readonly result: RunResult;
  lastIntent: Intent | null = null;
  lastSnapshot: Snapshot | null = null;

  constructor(opts: RunOptions) {
    const cfg = loadConfig(new URLSearchParams());
    this.cfg = cfg;
    const w = opts.width ?? 1280;
    const h = opts.height ?? 720;
    this.driver = opts.driver ?? 'brain';
    // As Game's constructor, in its order (the world's rng sees the same sequence of draws).
    const world = new World(cfg, { seed: opts.seed });
    this.world = world;
    const camera = new Camera(cfg);
    this.camera = camera;
    camera.resize(w, h);
    const maze = world.maze;
    const startDistrict = maze.enabled ? Math.floor(world.rng() * 12) : -1;
    let start: Vec3;
    if (startDistrict >= 0) {
      const d = maze.district(startDistrict);
      start = d.point(d.maze.start[0], d.maze.start[1], vec3());
    } else start = vec3(0, 0, 1);
    if (maze.enabled) {
      camera.mazeZoom = cfg.mazeZoom;
      camera.district = districtView(maze);
    }
    camera.jumpTo(start, 64);
    world.observer = camera.frame.c;
    populateNpcs(world, { difficulty: DIFFICULTY.normal });
    populateResidents(world);
    // The browser builds the rest in idle time, nearest first (under the recorder's clock, before the first frame).
    while (maze.buildNext(camera.frame.c)) {}
    this.human = new Organism(world.newId(), '', 50, new HumanController(this.input as unknown as Input, camera), true);
    world.addOrganism(this.human);
    this.rects = hudRects(w, h, !!opts.touch);
    this.hands = new Hands(opts.hands ?? opts.seed, !!opts.touch, w, h);
    this.hands.R = cfg.sphereRadius;
    this.brain = new Brain(cfg, opts.params);
    this.result = {
      seed: opts.seed,
      driver: this.driver,
      alive: false,
      mass: 0,
      peak: 0,
      points: 0,
      seconds: 0,
      rank: 0,
      topAt: -1,
      chain: 0,
      curve: [],
      sources: {},
      death: null,
      splits: 0,
      problems: [],
    };
  }

  /** Game.play, with the player's name. */
  play(name: string, hue: number): void {
    const { world, human, camera, cfg } = this;
    human.name = name;
    human.hue = hue;
    let at: Vec3 | null = null;
    if (world.maze.enabled) {
      const i = world.maze.layout.regionAt(camera.frame.c);
      const d = world.maze.district(i);
      const p = d.point(d.maze.start[0], d.maze.start[1], vec3());
      let threat = false;
      world.queryCells(p, 900, (c) => {
        if (c.owner && c.r > cfg.startRadius && world.distance(c.p, p) - c.r < 500) threat = true;
      });
      if (!threat) at = p;
    }
    if (!at) at = world.findSafeSpotNear(vec3(), camera.frame.c, 4000, cfg.startRadius);
    world.spawnOrganism(human, at);
    camera.jumpTo(at, human.sumRadius);
    this.state = 'playing';
    this.points = 0;
    this.frames = 0;
    if (this.driver === 'npc') human.controller = new BotController(PERSONALITIES.hunter, DIFFICULTY.hard, 0);
  }

  /** The screen as the hands see it now. */
  screen(): Screen {
    const f = this.camera.frame;
    const L = this.human.alive ? this.human.largestCell() : null;
    return {
      cam: [f.c.x, f.c.y, f.c.z, f.e.x, f.e.y, f.e.z, f.s.x, f.s.y, f.s.z, this.camera.zoom, this.camera.width, this.camera.height],
      me: L ? [L.p.x, L.p.y, L.p.z] : null,
      avoid: this.rects.avoid,
      split: this.rects.split,
    };
  }

  /** One 60 Hz frame of Game.frame: sim ticks, events, camera follow. */
  frame(): void {
    const { world, cfg, camera } = this;
    this.acc += FRAME_MS;
    let steps = 0;
    while (this.acc >= cfg.tickMs && steps < 4) {
      world.step();
      this.handleEvents();
      this.acc -= cfg.tickMs;
      steps++;
    }
    if (steps === 4 && this.acc > cfg.tickMs) this.acc = cfg.tickMs * 0.5;
    const alpha = this.acc / cfg.tickMs;
    const target = this.focus();
    if (target) {
      interpolatedCenter(target, alpha, this.camTarget);
      camera.follow(this.camTarget, target.cells.length ? target.sumRadius : 64, FRAME_MS);
    }
  }

  private handleEvents(): void {
    const { world, human, result } = this;
    if (this.state !== 'playing') return;
    for (const e of world.events) {
      if (e.type === 'death' && e.organismId === human.id) {
        this.state = 'dead';
        const killer = e.killerId !== null ? world.organisms.find((o) => o.id === e.killerId) : undefined;
        result.death = killer ? (killer.resident ? `phage ${killer.name}` : `npc ${Math.round(killer.lastMass)}`) : 'unknown';
        continue;
      }
      if (e.type === 'eat') {
        if (e.eaterOrg !== human.id) continue;
        this.points += eatPoints(e, human.id);
        let source = '';
        let mass = 0;
        if (e.eatenKind === FOOD_KIND) {
          source = e.foodKind === POWER ? 'spore' : e.foodTag >= 0 ? 'maze' : 'pellet';
          mass = radiusToMass(e.foodKind === POWER ? this.cfg.powerPelletSize : this.cfg.foodSize);
        } else if (e.preyOrg !== human.id && e.preyOrg >= 0) {
          const prey = world.organisms.find((o) => o.id === e.preyOrg);
          source = prey?.resident ? 'phage' : 'cell';
          mass = radiusToMass(e.r);
        } else if (e.preyOrg < 0) {
          source = e.eatenKind === 1 ? 'blob' : 'virus';
          mass = radiusToMass(e.r);
        }
        if (source) result.sources[source] = (result.sources[source] ?? 0) + mass;
      } else if (e.type === 'explode' && e.organismId === human.id) {
        this.points += explodePoints(e.k);
        result.chain = Math.max(result.chain, e.k + 1);
      }
    }
  }

  /** Game.focus: the player, or an NPC in attract mode. */
  private focus(): Organism | null {
    if (this.state === 'playing' && this.human.alive) return this.human;
    const world = this.world;
    const s = this.spectate;
    const stale = !s || !s.alive || s.dormant || s.cells.length === 0 || world.tick - this.spectatePickTick > 25 * 20;
    if (stale) {
      let best: Organism | null = null;
      const c = this.camera.frame.c;
      for (const o of world.organisms) {
        if (!o.alive || o.dormant || o.isHuman || o.cells.length === 0) continue;
        if (world.distance(o.cells[0].p, c) > 6000) continue;
        if (!best || o.lastMass > best.lastMass) best = o;
      }
      if (best !== s) this.spectatePickTick = world.tick;
      this.spectate = best ?? s;
    }
    return this.spectate && this.spectate.cells.length ? this.spectate : null;
  }

  /** Brain and hands for one frame after Play: hand events first (as the recorder sends them), then the frame. */
  playFrame(): void {
    const t = (this.frames * FRAME_MS) / 1000;
    if (this.driver === 'brain') {
      for (const e of this.hands.frame(t, this.screen())) {
        this.input.apply(e, this.rects.split);
        if (e.type === 'key' && e.down && e.code === 'Space') this.result.splits++;
        if (e.type === 'touch' && e.phase === 'start' && e.points.some((p) => p.id === 2)) this.result.splits++;
      }
    }
    this.frame();
    this.frames++;
    if (this.driver === 'brain' && this.frames % DECIDE_FRAMES === 0 && this.state === 'playing') {
      const snap = takeSnapshot({ world: this.world, camera: this.camera, human: this.human, points: this.points, t: this.frames * FRAME_MS });
      this.lastSnapshot = snap;
      const intent = this.brain.decide(snap);
      this.lastIntent = intent;
      this.hands.push(intent);
    }
  }
}

function interpolatedCenter(org: Organism, alpha: number, out: Vec3): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const c of org.cells) {
    x += c.prev.x + (c.p.x - c.prev.x) * alpha;
    y += c.prev.y + (c.p.y - c.prev.y) * alpha;
    z += c.prev.z + (c.p.z - c.prev.z) * alpha;
  }
  const l = Math.hypot(x, y, z) || 1;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Problems a run should never show. */
function sanity(h: Harness): string[] {
  const out: string[] = [];
  const { world } = h;
  const maze = world.maze;
  for (const c of world.cells) {
    if (!Number.isFinite(c.p.x + c.p.y + c.p.z + c.r)) out.push(`NaN cell ${c.id} at tick ${world.tick}`);
  }
  for (const c of h.human.cells) {
    if (maze.enabled && maze.inInterior(c.p) && !maze.isFree(c.p, Math.min(c.r, 20) * 0.5)) out.push(`player cell in a wall at tick ${world.tick}`);
    const room = maze.roomAt(c.p);
    if (room > 0 && c.r > room + 1) out.push(`player cell r ${c.r.toFixed(0)} over its way out ${room.toFixed(0)} at tick ${world.tick}`);
  }
  for (const o of world.organisms) if (o.cells.length > h.cfg.explodeMaxCells) out.push(`organism ${o.id} has ${o.cells.length} cells at tick ${world.tick}`);
  return out;
}

/** One game: attract mode, Play, then up to `seconds` of play or until the player is eaten. */
export function runGame(opts: RunOptions): RunResult {
  const h = new Harness(opts);
  const seconds = opts.seconds ?? h.brain.params.runSeconds;
  const pre = opts.preFrames ?? Math.round((opts.preRoll ?? 3000) / FRAME_MS);
  for (let k = 0; k < pre; k++) h.frame();
  h.play('Rad', Math.floor(createRng(opts.seed ^ 0x777)() * 360));
  const result = h.result;
  const total = Math.round((seconds * 1000) / FRAME_MS);
  const perMinute = Math.round(60000 / FRAME_MS);
  for (let k = 0; k < total && h.state === 'playing'; k++) {
    h.playFrame();
    const human = h.human;
    if (human.alive) {
      result.peak = Math.max(result.peak, human.mass);
      const rank = h.world.leaderboard.indexOf(human) + 1;
      if (rank === 1 && result.topAt < 0) result.topAt = (h.frames * FRAME_MS) / 1000;
    }
    if (h.frames % perMinute === 0) result.curve.push(human.alive ? Math.round(human.mass) : 0);
    if (h.frames % 60 === 0 && result.problems.length < 10) result.problems.push(...sanity(h));
    opts.onFrame?.(h);
  }
  const human = h.human;
  result.alive = h.state === 'playing' && human.alive;
  result.mass = result.alive ? Math.round(human.mass) : 0;
  result.peak = Math.round(result.peak);
  result.points = h.points;
  result.seconds = Math.round((h.frames * FRAME_MS) / 100) / 10;
  result.rank = result.alive ? h.world.leaderboard.indexOf(human) + 1 : 0;
  for (const k of Object.keys(result.sources)) result.sources[k] = Math.round(result.sources[k]);
  return result;
}
