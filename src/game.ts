// Game shell: fixed-step loop + rAF render, menu/attract mode, player lifecycle, and the arcade layer:
// district spawns, arcade score, home/lap cues, trail, minimap, banners, rainbow and explosion cues,
// sound and district camera alignment. Everything here is presentation: the sim treats the human like any NPC.
import type { GameConfig } from './config/types.ts';
import { BotController } from './ai/bot.ts';
import { DIFFICULTY, PERSONALITIES } from './ai/personalities.ts';
import { populateNpcs, populateResidents } from './ai/population.ts';
import { HumanController } from './input/human.ts';
import { Input } from './input/input.ts';
import { Camera } from './render/camera.ts';
import { setStock } from './render/canvas/palette.ts';
import { CanvasRenderer, type RenderOptions, defaultRenderOptions } from './render/canvas/renderer.ts';
import { QUALITY_LEVELS, QualityController } from './render/quality.ts';
import { FOOD_KIND, PELLET, POWER } from './sim/food.ts';
import { Organism } from './sim/organism.ts';
import { radiusToMass, ticksPerSecond } from './sim/rules.ts';
import { World } from './sim/world.ts';
import { type Vec3, randomUnit, vec3 } from './sphere/vec3.ts';
import type { Sfx } from './ui/audio.ts';
import { HomeTracker, Trail } from './ui/home.ts';
import { Hud } from './ui/hud.ts';
import type { Minimap } from './ui/minimap.ts';

export type GameState = 'menu' | 'playing' | 'dead';

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
  readonly world: World;
  readonly camera: Camera;
  readonly renderer: CanvasRenderer;
  readonly opts: RenderOptions;
  readonly quality: QualityController;
  readonly input: Input;
  readonly hud: Hud;
  readonly human: Organism;
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
    const districtParam = Number(params.get('district'));
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
      this.camera.district = (c, up, right) => {
        const i = maze.regionWithGridAt(c, 1500);
        if (i < 0 || !maze.isBuilt(i)) return 0;
        const d = maze.district(i);
        if (!d.locate(c)) return 0;
        const G = d.G;
        const lo = 8;
        const out = Math.max(lo - d.gx, d.gx - (G - lo), lo - d.gy, d.gy - (G - lo), 0) * d.F;
        d.axes(c, right, up);
        up.x = -up.x;
        up.y = -up.y;
        up.z = -up.z;
        return Math.max(0, 1 - out / 1500);
      };
    }
    this.camera.jumpTo(start, 64);
    this.world.observer = this.camera.frame.c;
    const difficulty = DIFFICULTY[(params.get('difficulty') as keyof typeof DIFFICULTY) ?? 'normal'] ?? DIFFICULTY.normal;
    populateNpcs(this.world, { difficulty });
    populateResidents(this.world);
    this.scheduleDistricts();

    this.human = new Organism(this.world.newId(), '', 50, new HumanController(this.input, this.camera), true);
    this.world.addOrganism(this.human);

    window.addEventListener('resize', () => (this.pendingResize = true));
    this.hud.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.play(this.hud.nick.value.trim().slice(0, 15));
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
    human.name = name;
    human.hue = Math.floor(Math.random() * 360);
    let at: Vec3 | null = null;
    if (this.arcade && world.maze.enabled) {
      // Spawn on the start tile of the nearest district, below its ghost pen, if nothing big is close.
      const i = world.maze.layout.regionAt(this.camera.frame.c);
      const d = world.maze.district(i);
      const p = d.point(d.maze.start[0], d.maze.start[1], vec3());
      let threat = false;
      world.queryCells(p, 900, (c) => {
        if (c.owner && c.r > this.cfg.startRadius && world.distance(c.p, p) - c.r < 500) threat = true;
      });
      if (!threat) at = p;
    }
    if (!at) at = world.findSafeSpotNear(vec3(), this.camera.frame.c, 4000, this.cfg.startRadius);
    world.spawnOrganism(human, at);
    this.camera.jumpTo(at, human.sumRadius);
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

    this.acc += dt;
    let steps = 0;
    const t0 = performance.now();
    while (this.acc >= tickMs && steps < 4) {
      world.step();
      this.renderer.onEvents(world, world.events, now);
      this.handleEvents(now);
      this.acc -= tickMs;
      steps++;
    }
    if (steps === 4 && this.acc > tickMs) this.acc = tickMs * 0.5;
    const t1 = performance.now();
    if (steps > 0) this.stats.tickMs = (t1 - t0) / steps;

    const alpha = this.acc / tickMs;
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
      this.hud.showMenu(`Eaten${this.killerName ? ` by ${this.killerName}` : ''} · peak mass ${Math.floor(this.human.peakMass)}`);
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
        this.addPoints(1000, this.tmp, now);
        this.sfx?.home();
      } else if (ev === 'lap') {
        hud.toast(`AROUND THE WORLD! LAP ${this.homeTracker.laps}`, 2600, now);
        this.addPoints(10000, this.tmp, now);
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
        const n = world.arcade.powerAlive(i);
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
        case 'eat':
          if (e.eaterOrg !== human.id) break;
          if (e.eatenKind === FOOD_KIND && e.foodKind === PELLET) {
            // Every pellet scores the same, in the plains and in mazes.
            this.addPoints(10, null, now);
            this.sfx?.chomp();
          } else if (e.eatenKind === FOOD_KIND && e.foodKind === POWER) {
            this.addPoints(50, null, now);
          } else if (e.foodKind === -1 && e.eatenKind === 0) {
            at.x = e.x;
            at.y = e.y;
            at.z = e.z;
            this.addPoints(Math.round(radiusToMass(e.r) * 10), at, now);
          }
          break;
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
            this.addPoints(200 * 2 ** Math.min(e.k, 4), at, now, e.k > 0 ? ` ×${e.k + 1}` : '');
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
