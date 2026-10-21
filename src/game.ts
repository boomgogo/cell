// Game shell: fixed-step loop + rAF render, menu/attract mode, player lifecycle, and the arcade layer:
// district spawns, arcade score, home/lap cues, trail, minimap, banners, rainbow and explosion cues,
// sound and district camera alignment. Everything here is presentation: the sim treats the human like any NPC.
import type { GameConfig } from './config/types.ts';
import { BotController } from './ai/bot.ts';
import { DIFFICULTY, PERSONALITIES } from './ai/personalities.ts';
import { populateNpcs, populateResidents } from './ai/population.ts';
import { HumanController } from './input/human.ts';
import { Input } from './input/input.ts';
import { Camera, districtView } from './render/camera.ts';
import { setStock } from './render/canvas/palette.ts';
import { CanvasRenderer, type RenderOptions, defaultRenderOptions } from './render/canvas/renderer.ts';
import { QUALITY_LEVELS, QualityController } from './render/quality.ts';
import { FOOD_KIND, PELLET } from './sim/food.ts';
import { Organism } from './sim/organism.ts';
import { ticksPerSecond } from './sim/rules.ts';
import { World } from './sim/world.ts';
import { type Vec3, randomUnit, vec3 } from './sphere/vec3.ts';
import type { Sfx } from './ui/audio.ts';
import { HomeTracker, Trail } from './ui/home.ts';
import { Hud } from './ui/hud.ts';
import { HOME_POINTS, LAP_POINTS, eatPoints, explodePoints } from './ui/points.ts';
import type { Minimap } from './ui/minimap.ts';

export type GameState = 'menu' | 'playing' | 'dead';

/**
 * What the game asks of a room (`net/`), when the page is in one. Unset, the game is the page's own, as it always
 * was.
 */
export interface GameNet {
  /** True on a guest's page: the world is the host's, and this page draws what the host sends it. */
  readonly drawing: boolean;
  /**
   * On a guest's page, once a frame, `dt` ms after the last: takes in what the host sent, and moves this player's own
   * cells on; returns how far between two reports to draw everything else.
   */
  frame(now: number, dt: number): number;
  /** On the host's page, after each step of the world. */
  stepped(now: number): void;
  /** PLAY. True when the room takes care of it: on a guest's page, the host puts the player in its world. */
  play(name: string, hue: number): boolean;
  /** On the host's page: why this page's own PLAY must wait (the world has as many colonies as it takes), or null. */
  full(): string | null;
  /** On a guest's page: the live spores of district `d`, as the host last said, a bit for each spot. */
  sporeMask(d: number): number;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  tickMs: number;
  p95: number;
}

const HIGH_SCORE_KEY = 'cell.highscore';
const MUTE_KEY = 'cell.muted';

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage */
  }
}

export class Game {
  readonly cfg: GameConfig;
  /** World seed (also fixes the NPCs' countries). */
  readonly seed: number;
  /** Replaced in a room: by the host's world drawn on a guest's page, or by a world carried on from the last host. */
  world: World;
  readonly camera: Camera;
  readonly renderer: CanvasRenderer;
  readonly opts: RenderOptions;
  readonly quality: QualityController;
  readonly input: Input;
  readonly hud: Hud;
  human: Organism;
  /** The room, while the page is in one. See `GameNet`. */
  net: GameNet | null = null;
  /** While the page holds an invite it has not answered (ui/friends.ts): what PLAY and Enter do instead. */
  invite: ((name: string) => void) | null = null;
  readonly difficulty: (typeof DIFFICULTY)[keyof typeof DIFFICULTY];
  state: GameState = 'menu';
  readonly stats: FrameStats = { fps: 0, frameMs: 0, tickMs: 0, p95: 0 };
  /** Hook for the debug panel / bench. */
  onFrame: ((game: Game) => void) | null = null;

  // Arcade layer.
  readonly arcade: boolean;
  readonly homeTracker: HomeTracker;
  readonly trail: Trail;
  points = 0;
  highScore = 0;
  private sfx: Sfx | null = null;
  private muted: boolean;
  /** Loaded after the first frame (keeps the initial bundle inside its budget). */
  private minimap: Minimap | null = null;
  private readonly startDistrict: number;
  /** Set by window resizes and quality changes; applied at the start of the next frame, before it renders. */
  private pendingResize = false;

  private spectate: Organism | null = null;
  private spectatePickTick = 0;
  private acc = 0;
  private last = 0;
  private readonly frameTimes = new Float32Array(120);
  private frameIdx = 0;
  private readonly camTarget: Vec3 = vec3();
  private deathAt = 0;
  private killerName = '';
  private slowTick = 0;
  private readonly tmp = vec3();
  private readonly local = { x: 0, y: 0 };
  /** Rainbow organisms already warned about ("RUN!"), by id → the rainbowUntil it was for. */
  private readonly warned = new Map<number, number>();
  /** The "PACKED" toast shows once per life. */
  private packedToast = false;
  /** Live power pellet positions for the minimap (x, y, z triples). */
  private power = new Float64Array(0);

  constructor(canvas: HTMLCanvasElement, cfg: GameConfig, params: URLSearchParams) {
    this.cfg = cfg;
    const seed = Number(params.get('seed') ?? Math.floor(Math.random() * 2 ** 31));
    this.seed = seed;
    this.world = new World(cfg, { seed });
    this.camera = new Camera(cfg);
    this.opts = defaultRenderOptions();
    // Arcade features come with the mazes; the look is separate.
    this.arcade = this.world.maze.enabled;
    this.opts.dark = cfg.theme === 'press';
    setStock(this.opts.dark);
    const pattern = params.get('bg');
    if (pattern === 'hex' || pattern === 'cube' || pattern === 'dots' || pattern === 'none') this.opts.pattern = pattern;
    if (params.get('trail') === '0') this.opts.trail = false;
    this.renderer = new CanvasRenderer(canvas, this.opts);
    this.quality = new QualityController(this.opts);
    if (params.has('quality')) {
      this.quality.enabled = false;
      this.quality.level = Math.max(0, Math.min(QUALITY_LEVELS - 1, Number(params.get('quality'))));
      this.quality.apply(this.opts);
    }
    this.input = new Input(canvas);
    this.hud = new Hud();
    this.hud.setArcade(this.arcade);
    this.hud.setDark(this.opts.dark);
    if (this.arcade) void import('./ui/minimap.ts').then((m) => (this.minimap = new m.Minimap(this.hud.minimap)));
    this.homeTracker = new HomeTracker(cfg.sphereRadius);
    this.trail = new Trail(cfg.sphereRadius);
    this.highScore = Number(readStore(HIGH_SCORE_KEY) ?? 0) || 0;
    this.muted = params.get('mute') === '1' || readStore(MUTE_KEY) === '1';
    this.hud.mute.textContent = this.muted ? '✕' : '♪';

    this.resize();
    const maze = this.world.maze;
    // `?district=` picks the start district; without it the world's rng does (Number(null) would be district 0).
    const districtParam = params.has('district') ? Number(params.get('district')) : NaN;
    this.startDistrict = maze.enabled ? (Number.isInteger(districtParam) && districtParam >= 0 && districtParam < 12 ? districtParam : Math.floor(this.world.rng() * 12)) : -1;
    let start: Vec3;
    if (this.startDistrict >= 0) {
      // Attract mode opens on a maze (only this district is generated up front; the rest follow in idle time).
      const d = maze.district(this.startDistrict);
      start = d.point(d.maze.start[0], d.maze.start[1], vec3());
    } else {
      start = randomUnit(vec3(), this.world.rng);
    }
    if (maze.enabled) {
      this.camera.alignEnabled = params.get('align') !== '0';
      this.camera.mazeZoom = cfg.mazeZoom;
      this.camera.district = districtView(maze);
    }
    this.camera.jumpTo(start, 64);
    this.world.observer = this.camera.frame.c;
    const difficulty = DIFFICULTY[(params.get('difficulty') as keyof typeof DIFFICULTY) ?? 'normal'] ?? DIFFICULTY.normal;
    this.difficulty = difficulty;
    populateNpcs(this.world, { difficulty });
    populateResidents(this.world);
    this.scheduleDistricts();

    this.human = new Organism(this.world.newId(), '', 50, new HumanController(this.input, this.camera), true);
    this.world.addOrganism(this.human);

    window.addEventListener('resize', () => (this.pendingResize = true));
    this.hud.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.hud.nick.value.trim().slice(0, 15);
      if (this.invite) this.invite(name);
      else this.play(name);
    });
    const press = (el: HTMLElement, fn: () => void) =>
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    press(this.hud.splitBtn, () => this.input.queueSplit());
    press(this.hud.ejectBtn, () => this.input.queueEject());
    press(this.hud.mute, () => this.toggleMute());
    press(this.hud.minimap, () => this.hud.minimap.classList.toggle('large'));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !(e.target instanceof HTMLInputElement)) this.toggleMute();
    });
    this.hud.showMenu(null);
    this.loadFlags(params);
  }

  /**
   * Country flags, in idle time after startup so they never delay the menu: the atlas and NPC countries
   * (`?flags=0` turns flags off), and the player's country from locate.ts (`?geo=0` skips the lookup).
   */
  private loadFlags(params: URLSearchParams): void {
    if (params.get('flags') === '0') return;
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const later = (fn: () => void) => (idle ? idle(fn, { timeout: 1500 }) : setTimeout(fn, 500));
    later(() => {
      import('./render/canvas/flags.ts')
        .then(async (m) => {
          const flags = await m.loadFlags();
          m.assignCountries(this.world.organisms, this.seed);
          this.renderer.flags = flags;
          this.hud.flags = flags;
        })
        .catch(() => {
          /* offline or blocked: no flags */
        });
      if (params.get('geo') === '0') return;
      import('./geo/locate.ts')
        .then((m) =>
          m.locateCountry({
            fetch: (url, init) => fetch(url, init),
            language: navigator.language ?? '',
            read: readStore,
            write: writeStore,
            now: Date.now,
          }),
        )
        .then((code) => {
          if (code) this.human.country = code.toLowerCase();
        })
        .catch(() => {
          /* no flag for the player */
        });
    });
  }

  /**
   * A world from a seed, peopled as the page's first one is: the room needs one when a guest becomes the host, and
   * when a guest leaves the room and plays alone again.
   */
  newWorld(seed: number): World {
    const world = new World(this.cfg, { seed });
    world.observer = this.camera.frame.c;
    populateNpcs(world, { difficulty: this.difficulty });
    populateResidents(world);
    return world;
  }

  /** Puts another world in place of this one, with `human` as this player in it. */
  replaceWorld(world: World, human: Organism): void {
    this.world = world;
    this.human = human;
    world.observer = this.camera.frame.c;
    this.spectate = null;
    this.acc = 0;
    this.scheduleDistricts();
  }

  /**
   * In a room, on a guest's page: the host has put this player's cells at `at`. Home, the trail and the camera start
   * there, as they start where `play` spawns alone.
   */
  placed(at: Vec3): void {
    this.camera.jumpTo(at, this.human.sumRadius);
    this.homeTracker.reset(at);
    this.trail.clear();
    this.renderer.home = this.arcade ? vec3(at.x, at.y, at.z) : null;
    this.renderer.homeHue = this.human.hue;
  }

  /** In a room, on a guest's page, on the menu: look at `at` (where the host looks), so PLAY starts there. */
  lookAt(at: Vec3): void {
    this.camera.jumpTo(at, 64);
    this.spectate = null;
  }

  /** PLAY was refused (the room's world is full): back to the menu, saying why. A colony already in play stays. */
  refused(message: string): void {
    if (this.state === 'playing' && this.human.alive && this.human.cells.length > 0) return;
    this.state = 'menu';
    this.hud.showMenu(message);
    this.hud.setBanner('', '');
  }

  /** The events of the world's last step, for the renderer and the HUD: on a guest's page, of the host's last report. */
  takeEvents(now: number): void {
    this.renderer.onEvents(this.world, this.world.events, now);
    this.handleEvents(now);
  }

  /** Where a player who presses PLAY starts: on the nearest district's start tile if nothing big is close, else somewhere safe near `near`. */
  spawnPoint(near: Vec3): Vec3 {
    const world = this.world;
    if (this.arcade && world.maze.enabled) {
      const i = world.maze.layout.regionAt(near);
      const d = world.maze.district(i);
      const p = d.point(d.maze.start[0], d.maze.start[1], vec3());
      let threat = false;
      world.queryCells(p, 900, (c) => {
        if (c.owner && c.r > this.cfg.startRadius && world.distance(c.p, p) - c.r < 500) threat = true;
        // In a room: another player on the tile, as small as this one, would start on top of it.
        if (c.owner?.isHuman && world.distance(c.p, p) - c.r < 200) threat = true;
      });
      if (!threat) return p;
    }
    return world.findSafeSpotNear(vec3(), near, 4000, this.cfg.startRadius);
  }

  /** Generate the remaining maze districts in idle time, nearest first. */
  private scheduleDistricts(): void {
    const maze = this.world.maze;
    if (!maze.enabled) return;
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const step = () => {
      if (!maze.buildNext(this.camera.frame.c)) return;
      if (idle) idle(step, { timeout: 2000 });
      else setTimeout(step, 50);
    };
    if (idle) idle(step, { timeout: 2000 });
    else setTimeout(step, 300);
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    writeStore(MUTE_KEY, this.muted ? '1' : '0');
    this.hud.mute.textContent = this.muted ? '✕' : '♪';
    this.sfx?.setMuted(this.muted);
  }

  /** Switches between the paper and press stocks (debug panel; `?theme=` picks it at load). */
  setTheme(dark: boolean): void {
    this.opts.dark = dark;
    setStock(dark);
    this.hud.setDark(dark);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.resize(w, h);
    this.renderer.resize(w, h);
  }

  /** Automation: render exactly one frame `dtMs` after the previous one (use with ?manual=1). */
  advance(dtMs: number): void {
    this.frame(this.last + dtMs);
  }

  start(manual = false): void {
    if (manual) {
      this.last = performance.now();
      return;
    }
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame((now) => {
      this.last = now;
      loop(now);
    });
  }

  play(name: string): void {
    const human = this.human;
    const world = this.world;
    const full = this.net?.full() ?? null;
    if (full) {
      this.refused(full);
      return;
    }
    human.name = name;
    human.hue = Math.floor(Math.random() * 360);
    // In a room as a guest the host puts the player in its world, near a friend (net/Net.ts).
    const remote = this.net?.play(name, human.hue) ?? false;
    // Spawn on the start tile of the nearest district, below its ghost pen, if nothing big is close.
    const at = remote ? vec3(this.camera.frame.c.x, this.camera.frame.c.y, this.camera.frame.c.z) : this.spawnPoint(this.camera.frame.c);
    if (!remote) {
      world.spawnOrganism(human, at);
      this.camera.jumpTo(at, human.sumRadius);
    }
    this.state = 'playing';
    this.hud.hideMenu(this.input.touch || matchMedia('(pointer: coarse)').matches);
    this.points = 0;
    this.warned.clear();
    this.packedToast = false;
    this.homeTracker.reset(at);
    this.trail.clear();
    this.renderer.home = this.arcade ? vec3(at.x, at.y, at.z) : null;
    this.renderer.homeHue = human.hue;
    if (this.arcade) {
      this.hud.toast('GO!', 1400, performance.now());
      void this.loadSfx();
    }
  }

  private async loadSfx(): Promise<void> {
    if (!this.sfx) {
      try {
        const m = await import('./ui/audio.ts');
        this.sfx = new m.Sfx(this.muted);
      } catch {
        return;
      }
    }
    this.sfx.unlock();
  }

  /**
   * Bench/automation: put the human in control of an NPC brain at a given mass (optionally on a district's start tile;
   * `rainbow` is a hunter in the plains that ui/bench.ts keeps rainbow).
   */
  autopilot(mass: number, scene = 'plains'): void {
    this.human.controller = new BotController(scene === 'maze' ? PERSONALITIES.grazer : PERSONALITIES.hunter, DIFFICULTY.hard, 0);
    this.human.name = 'bench';
    let at = this.camera.frame.c;
    const maze = this.world.maze;
    if (scene === 'maze' && maze.enabled) {
      const d = maze.district(maze.layout.regionAt(this.camera.frame.c));
      at = d.point(d.maze.start[0], d.maze.start[1], vec3());
    } else if (scene === 'rainbow' && maze.enabled) {
      // Open plains: the nearest junction where three regions meet (always far from any maze).
      let best = -2;
      for (const j of maze.layout.junctions) {
        const d = j.p.x * at.x + j.p.y * at.y + j.p.z * at.z;
        if (d > best) {
          best = d;
          at = j.p;
        }
      }
    }
    this.world.spawnOrganism(this.human, at, mass);
    this.camera.jumpTo(at, this.human.sumRadius);
    this.state = 'playing';
    this.hud.hideMenu(false);
  }

  private frame(now: number): void {
    const dt = Math.min(now - this.last, 250);
    this.last = now;
    if (this.pendingResize) {
      this.pendingResize = false;
      this.resize();
    }
    const world = this.world;
    const tickMs = this.cfg.tickMs;

    const wheel = this.input.takeWheel();
    if (wheel) this.camera.addWheel(wheel);

    let steps = 0;
    const t0 = performance.now();
    let alpha: number;
    if (this.net?.drawing) {
      // A guest's page: the host's world, as the host last said, drawn between its last two reports; its own cells
      // it moves itself (net/predict.ts).
      alpha = this.net.frame(now, dt);
    } else {
      this.acc += dt;
      while (this.acc >= tickMs && steps < 4) {
        world.step();
        this.takeEvents(now);
        this.net?.stepped(now);
        this.acc -= tickMs;
        steps++;
      }
      if (steps === 4 && this.acc > tickMs) this.acc = tickMs * 0.5;
      alpha = this.acc / tickMs;
    }
    const t1 = performance.now();
    if (steps > 0) this.stats.tickMs = (t1 - t0) / steps;

    const target = this.focus();
    if (target) {
      this.interpolatedCenter(target, alpha, this.camTarget);
      this.camera.follow(this.camTarget, target.cells.length ? target.sumRadius : 64, dt);
    }
    this.renderer.render(world, this.camera, alpha, now, dt, this.state === 'playing' ? this.human : null);

    if (this.state === 'playing') this.hud.setScore(this.human.mass);
    if (world.tick % 8 === 0) this.hud.setLeaderboard(world.leaderboard, this.human);
    if (this.state === 'dead' && now - this.deathAt > 1200) {
      this.state = 'menu';
      const points = this.arcade ? ` · ${this.points.toLocaleString('en-US')} points` : '';
      this.hud.showMenu(`Eaten${this.killerName ? ` by ${this.killerName}` : ''}${points} · peak mass ${Math.floor(this.human.peakMass)}`);
      this.hud.setBanner('', '');
    }
    if (this.arcade) this.arcadeFrame(now);

    const frameMs = performance.now() - t0;
    this.frameTimes[this.frameIdx++ % this.frameTimes.length] = dt;
    this.stats.frameMs = frameMs;
    if (this.frameIdx % 30 === 0) {
      const sorted = Array.from(this.frameTimes).sort((a, b) => a - b);
      this.stats.p95 = sorted[Math.floor(sorted.length * 0.95)];
      const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
      this.stats.fps = mean > 0 ? 1000 / mean : 0;
    }
    // A level change resizes at the start of the next frame: resizing here, after the render, would show a wiped canvas.
    if (this.quality.record(dt, frameMs, this.opts)) this.pendingResize = true;
    this.onFrame?.(this);
  }

  /** HUD, home cues, trail and minimap. Heavy parts run at 10 Hz. */
  private arcadeFrame(now: number): void {
    const hud = this.hud;
    const human = this.human;
    const world = this.world;
    const playing = this.state === 'playing' && human.alive && human.cells.length > 0;
    hud.tick(now);
    if (playing) {
      hud.setPoints(this.points, this.highScore, this.homeTracker.laps);
      const left = human.rainbowUntil - world.tick;
      hud.setPower(left > 0 ? left / (this.cfg.rainbowSeconds * ticksPerSecond(this.cfg)) : 0);
      this.updateHomeArrow();
    }
    if (now - this.slowTick < 100) return;
    this.slowTick = now;
    const center = this.camera.frame.c;
    if (playing) {
      human.center(this.tmp);
      this.trail.add(this.tmp);
      this.renderer.trail = this.trail.points;
      this.renderer.trailCount = this.trail.count;
      const ev = this.homeTracker.update(this.tmp);
      if (ev === 'home') {
        hud.toast('HOME AGAIN!', 1800, now);
        this.addPoints(HOME_POINTS, this.tmp, now);
        this.sfx?.home();
      } else if (ev === 'lap') {
        hud.toast(`AROUND THE WORLD! LAP ${this.homeTracker.laps}`, 2600, now);
        this.addPoints(LAP_POINTS, this.tmp, now);
        this.sfx?.lap();
      }
      this.warnRainbows(now);
    }
    // District banner.
    const maze = world.maze;
    if (maze.enabled) {
      const layout = maze.layout;
      const i = layout.regionAt(center);
      const region = layout.regions[i];
      const inside = maze.inInterior(center);
      let sub = '';
      if (inside && world.arcade) {
        const spots = maze.isBuilt(i) ? maze.district(i).maze.power.length / 2 : 12;
        const n = this.net?.drawing ? popcount(this.net.sporeMask(i) & ((1 << spots) - 1)) : world.arcade.powerAlive(i);
        if (n > 0) sub = `spores ×${n}`;
      }
      hud.setBanner(`${region.fruit} ${i + 1} · ${region.name.toUpperCase()}`, sub);
      const powerCount = this.collectPower();
      this.minimap?.draw(
        maze,
        this.camera,
        playing ? this.homeTracker.home : null,
        human.hue,
        this.trail.points,
        playing ? this.trail.count : 0,
        playing ? this.tmp : null,
        this.power,
        powerCount,
      );
    }
  }

  /** Live power pellet positions of the built districts into `this.power`; returns the count. */
  private collectPower(): number {
    const arcade = this.world.arcade;
    if (!arcade) return 0;
    const net = this.net;
    if (net?.drawing) return this.collectRoomPower(net);
    const food = this.world.food;
    let n = 0;
    for (const st of arcade.states) {
      if (!st) continue;
      for (let k = 0; k < st.powerFood.length; k++) {
        const fi = st.powerFood[k];
        if (fi < 0) continue;
        if (this.power.length < (n + 1) * 3) {
          const grown = new Float64Array(Math.max(48, this.power.length * 2));
          grown.set(this.power);
          this.power = grown;
        }
        this.power[n * 3] = food.x[fi];
        this.power[n * 3 + 1] = food.y[fi];
        this.power[n * 3 + 2] = food.z[fi];
        n++;
      }
    }
    return n;
  }

  /** On a guest's page: the spores the host says are live, on the spots of the districts this page has built. */
  private collectRoomPower(net: GameNet): number {
    const maze = this.world.maze;
    const at = this.tmp;
    let n = 0;
    for (let d = 0; d < 12; d++) {
      if (!maze.isBuilt(d)) continue;
      const district = maze.district(d);
      const spots = district.maze.power;
      const mask = net.sporeMask(d);
      for (let k = 0; k < spots.length / 2 && k < 16; k++) {
        if (!(mask & (1 << k))) continue;
        if (this.power.length < (n + 1) * 3) {
          const grown = new Float64Array(Math.max(48, this.power.length * 2));
          grown.set(this.power);
          this.power = grown;
        }
        district.point(spots[k * 2], spots[k * 2 + 1], at);
        this.power[n * 3] = at.x;
        this.power[n * 3 + 1] = at.y;
        this.power[n * 3 + 2] = at.z;
        n++;
      }
    }
    return n;
  }

  /**
   * "RUN!": once per rainbow period, when a rainbow cell smaller than our largest cell comes within 1 500
   * units. That is only what the screen already shows, made obvious.
   */
  private warnRainbows(now: number): void {
    const human = this.human;
    const mine = human.largestCell();
    if (!mine) return;
    const world = this.world;
    for (const o of world.rainbows()) {
      if (o === human || this.warned.get(o.id) === o.rainbowUntil) continue;
      if (!o.cells.some((c) => c.r < mine.r && world.distance(c.p, mine.p) < 1500)) continue;
      this.warned.set(o.id, o.rainbowUntil);
      this.hud.toast('RUN!', 1200, now);
      this.sfx?.hurt();
    }
  }

  private updateHomeArrow(): void {
    const cam = this.camera;
    const home = this.homeTracker.home;
    const local = this.local;
    cam.frame.project(cam.R, home, local);
    const sx = local.x * cam.zoom;
    const sy = local.y * cam.zoom;
    const w = cam.width;
    const h = cam.height;
    const margin = 34;
    if (Math.abs(sx) < w / 2 - margin && Math.abs(sy) < h / 2 - margin) {
      this.hud.setHomeArrow(0, 0, 0, null);
      return;
    }
    const a = Math.atan2(sy, sx);
    const k = Math.min((w / 2 - margin) / Math.max(1e-6, Math.abs(Math.cos(a))), (h / 2 - margin) / Math.max(1e-6, Math.abs(Math.sin(a))));
    const d = this.homeTracker.distance(this.camera.frame.c);
    const label = d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k` : `${Math.round(d)}`;
    this.hud.setHomeArrow(w / 2 + Math.cos(a) * k, h / 2 + Math.sin(a) * k, a, `HOME ${label}`);
  }

  private addPoints(n: number, at: Vec3 | null, now: number, suffix = ''): void {
    this.points += n;
    if (this.points > this.highScore) {
      this.highScore = this.points;
      writeStore(HIGH_SCORE_KEY, String(this.highScore));
    }
    if (at && n >= 100) this.renderer.popup(at, `+${n.toLocaleString('en-US')}${suffix}`, now);
  }

  private handleEvents(now: number): void {
    const human = this.human;
    const world = this.world;
    const playing = this.state === 'playing';
    for (const e of world.events) {
      if (e.type === 'death' && e.organismId === human.id && playing) {
        this.state = 'dead';
        this.deathAt = now;
        const killer = e.killerId !== null ? world.organisms.find((o) => o.id === e.killerId) : undefined;
        this.killerName = killer?.name ?? '';
        this.spectate = killer && killer.alive ? killer : null;
        this.sfx?.death();
        continue;
      }
      if (!this.arcade || !playing) continue;
      const at = this.tmp;
      switch (e.type) {
        case 'eat': {
          // Every pellet scores the same, in the plains and in mazes; own cells merging back score nothing.
          const n = eatPoints(e, human.id);
          if (n <= 0) break;
          if (e.eatenKind === FOOD_KIND) {
            this.addPoints(n, null, now);
            if (e.foodKind === PELLET) this.sfx?.chomp();
          } else {
            at.x = e.x;
            at.y = e.y;
            at.z = e.z;
            this.addPoints(n, at, now);
          }
          break;
        }
        case 'pack':
          if (e.organismId === human.id && !this.packedToast) {
            this.packedToast = true;
            this.hud.toast('PACKED', 1200, now);
          }
          break;
        case 'unpack':
          if (e.organismId === human.id) this.sfx?.unpack();
          break;
        case 'rainbow':
          if (e.organismId === human.id) {
            this.hud.toast('RAINBOW!', 900, now);
            this.sfx?.rainbow((e.untilTick - world.tick) / ticksPerSecond(this.cfg));
          }
          break;
        case 'explode': {
          const mine = e.organismId === human.id;
          if (!mine && e.victimId !== human.id) break;
          // Shake by the size of what blew up.
          this.renderer.shake(Math.min(8, 2 + Math.log2(1 + e.r / 50) * 1.5), now);
          if (mine) {
            at.x = e.x;
            at.y = e.y;
            at.z = e.z;
            // 200 → 3 200 along a chain; the popup shows the chain length from the second explosion on.
            this.addPoints(explodePoints(e.k), at, now, e.k > 0 ? ` ×${e.k + 1}` : '');
            this.sfx?.boom(e.k);
          } else this.sfx?.hurt();
          break;
        }
      }
    }
  }

  /** Who the camera follows: the player, or an NPC in attract / death mode. */
  private focus(): Organism | null {
    if (this.state === 'playing' && this.human.alive) return this.human;
    const world = this.world;
    // In a room, the menu watches a friend who plays.
    if (this.net) {
      const friend = this.friendInSight();
      if (friend) return (this.spectate = friend);
    }
    const s = this.spectate;
    const stale = !s || !s.alive || s.dormant || s.cells.length === 0 || world.tick - this.spectatePickTick > 25 * 20;
    if (stale) {
      let best: Organism | null = null;
      const c = this.camera.frame.c;
      for (const o of world.organisms) {
        if (!o.alive || o.dormant || o.isHuman || o.cells.length === 0) continue;
        const cell = o.cells[0];
        if (world.distance(cell.p, c) > 6000) continue;
        if (!best || o.lastMass > best.lastMass) best = o;
      }
      if (best !== s) this.spectatePickTick = world.tick;
      this.spectate = best ?? s;
    }
    return this.spectate && this.spectate.cells.length ? this.spectate : null;
  }

  /** In a room: the friend the menu watches, the one it watched if still playing, else the nearest. */
  friendInSight(): Organism | null {
    const s = this.spectate;
    if (s && s.isHuman && s !== this.human && s.alive && s.cells.length > 0) return s;
    let best: Organism | null = null;
    let bestDist = Infinity;
    for (const o of this.world.organisms) {
      if (!o.isHuman || o === this.human || !o.alive || o.cells.length === 0) continue;
      const d = this.world.distance(o.cells[0].p, this.camera.frame.c);
      if (d < bestDist) {
        bestDist = d;
        best = o;
      }
    }
    return best;
  }

  private interpolatedCenter(org: Organism, alpha: number, out: Vec3): Vec3 {
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
}

function popcount(n: number): number {
  let c = 0;
  for (let v = n >>> 0; v; v &= v - 1) c++;
  return c;
}
