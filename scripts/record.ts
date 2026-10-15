// Plays the built game in Chrome with the autoplayer and records it, frame by frame.
//
// The recorder owns the page's clock (scripts/record/page.ts): it advances time by exactly one frame, lets the game draw
// it, takes a screenshot and pipes it to ffmpeg. Every frame is drawn in full however long it takes, so the video is
// smooth on any machine; it just renders slower than real time. The sound is rendered offline in step with the frames.
//
// The autoplayer reads a snapshot of the screen ten times a second (scripts/autoplay/brain.ts) and carries out what it
// decides the way a person does (scripts/autoplay/hands.ts): real mouse, keyboard or touch input sent over CDP, with a
// handshake so the page sees every event on the frame it was meant for.
//
// A dry run plays the same run with nothing captured and the rendering off (about 3 ms a frame). It is the prediction:
// a recording replays the same seed and must match the dry run's state hash every second.
//
// Usage: npm run build && npm run record -- dry --seed 7 [--profile desktop|short]
//        npm run record -- search --seeds 1-200 [--profile desktop|short] [--workers 6]
//        npm run record -- youtube --seed 7 [--res 1440]        (needs the dry run from the search)
//        npm run record -- pilot --seed 7 [--seconds 90]
//        npm run record -- watch --seed 7 [--profile short]     (a visible window, in real time, no capture)
// Common: --out <dir> (default recordings/), --params <file.json> (brain parameters; default the tuned ones if found).
// Needs Google Chrome and ffmpeg.
import { type Browser, type BrowserContext, type CDPSession, type Page, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { loadConfig } from '../src/config/index.ts';
import { Brain, type BrainParams } from './autoplay/brain.ts';
import { type HandEvent, Hands, type Rect, type Screen, menuScript } from './autoplay/hands.ts';
import type { RecConfig, RecEvent, Status, StepOptions } from './record/page.ts';
import { type Ffmpeg, TO_709, X264, clock, ffmpeg, mux, writeWav } from './record/ffmpeg.ts';

export const ROOT = join(import.meta.dirname, '..');
export const SITE = 'c0.muon.day';
export const SITE_URL = 'https://c0.muon.day/';
export const REPO_URL = 'https://github.com/boomgogo/cell';
export const FPS = 60;
export const FRAME = 1000 / FPS;
/** Seconds of play in a run, then seconds the end is held before the end card. */
export const RUN_SECONDS = 300;
export const HOLD_SECONDS = 3;
/** After a death: the death card shows after 1.2 s; hold it this long. */
const DEATH_HOLD = 5;
/** Decide every 6 frames (100 ms), as in the Node harness. */
const DECIDE = 6;
export const NAME = 'Rad';

export type ProfileName = 'desktop' | 'short';
export const PROFILES: Record<ProfileName, { viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean }> = {
  // A common laptop window: the same view of the world as 1920×1080 (the game scales by the larger of w/1920, h/1080),
  // with the HUD 1.5× larger against the frame. At 2× it is 2560×1440.
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  // The Short's middle: a phone at 2.5×, 1080×1440, with room above and below for Shorts' own overlays.
  short: { viewport: { width: 432, height: 576 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true },
};

export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** The output folder: --out, or recordings/. It must exist and be writable (a missing drive stops here). */
export function outDir(): string {
  const dir = arg('out', join(ROOT, 'recordings'));
  const parent = join(dir, '..');
  try {
    accessSync(existsSync(dir) ? dir : parent, constants.W_OK);
  } catch {
    throw new Error(`Output folder ${dir} is missing or not writable (is the drive mounted?)`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Brain parameters: --params, else the tuned ones in <out>/tune/params.json, else the defaults. */
export function brainParams(out: string): Partial<BrainParams> {
  const file = arg('params', join(out, 'tune', 'params.json'));
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<BrainParams>) : {};
}

// ---- Page script, server, browser ----

let bundle: string | null = null;
async function pageBundle(): Promise<string> {
  if (bundle) return bundle;
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    build: { write: false, minify: false, target: 'es2022', lib: { entry: join(ROOT, 'scripts/record/page.ts'), formats: ['iife'], name: 'CellRec', fileName: 'rec' } },
  });
  const result = Array.isArray(out) ? out[0] : out;
  bundle = (result as { output: { code: string }[] }).output[0].code;
  return bundle;
}

export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('No build: run npm run build first');
  const server = await preview({ root: ROOT, logLevel: 'warn', preview: { port: 4190, strictPort: false, open: false } });
  const url = server.resolvedUrls?.local[0] ?? 'http://localhost:4190/';
  return { url, close: () => new Promise<void>((resolve) => server.httpServer.close(() => resolve())) };
}

export async function launch(headless = true): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunOptions {
  seed: number;
  profile: ProfileName;
  /** No capture, no rendering, muted. */
  dry: boolean;
  /** Real time in a visible window. */
  watch?: boolean;
  params?: Partial<BrainParams>;
  /** Device scale (desktop: 2 → 1440p, 1.5 → 1080p, 3 → 4K). */
  scale?: number;
  /** Where to write (capture: video.mp4, video.wav; all: run.json). */
  dir?: string;
  /** Stop after this many seconds of play (the pilot). */
  maxPlaySeconds?: number;
  /** Hashes of the dry run to check against, one per second of play. */
  compare?: string[];
  /** Capture only these windows of play frames (the Short), each with a warm-up; and add the opening and the ending. */
  windows?: { from: number; to: number; name: string }[];
  /** The end card (YouTube). */
  card?: boolean;
  /** Log progress every this many seconds of video. */
  progress?: number;
}

export interface RunLog {
  seed: number;
  profile: ProfileName;
  dry: boolean;
  fps: number;
  scale: number;
  /** Page frame of Play, and video frame of Play (capture). */
  playPageFrame: number;
  playVideoFrame: number;
  /** Play frames run. */
  playFrames: number;
  videoFrames: number;
  final: { alive: boolean; mass: number; peak: number; points: number; rank: number; topAt: number; chain: number; deathAt: number };
  events: (RecEvent & { play: number })[];
  /** Every half second of play: t (s), mass, points, rank, region, interior, rainbow. */
  samples: number[][];
  hashes: string[];
  diverged: number | null;
  checks?: Record<string, unknown>;
  params: Partial<BrainParams>;
}

export class Session {
  readonly o: RunOptions;
  readonly profile: (typeof PROFILES)[ProfileName];
  readonly touch: boolean;
  readonly scale: number;
  context!: BrowserContext;
  page!: Page;
  cdp!: CDPSession;
  status!: Status;
  fade = 0;
  playT = -1;
  /** Video frames captured so far. */
  videoFrames = 0;
  private encoder: Ffmpeg | null = null;
  private capturing = false;
  private keysSent = 0;
  /** Fingers down, by id, as last sent. */
  private fingers = new Map<number, { x: number; y: number }>();
  private mouse: [number, number] | null = null;
  private down = false;
  private readonly timing = { step: 0, shot: 0, write: 0, input: 0 };
  private lastShot = '';
  private lastCam = '';
  private repeats = 0;
  private moving = 0;
  readonly log: RunLog;
  /** Page time of the first captured frame (where its sound starts). */
  captureStartMs = 0;
  private renderOn = true;

  constructor(o: RunOptions) {
    this.o = o;
    this.profile = PROFILES[o.profile];
    this.touch = this.profile.hasTouch;
    this.scale = o.scale ?? this.profile.deviceScaleFactor;
    this.log = {
      seed: o.seed,
      profile: o.profile,
      dry: o.dry,
      fps: FPS,
      scale: this.scale,
      playPageFrame: -1,
      playVideoFrame: -1,
      playFrames: 0,
      videoFrames: 0,
      final: { alive: false, mass: 0, peak: 0, points: 0, rank: 0, topAt: -1, chain: 0, deathAt: -1 },
      events: [],
      samples: [],
      hashes: [],
      diverged: null,
      params: o.params ?? {},
    };
  }

  async open(browser: Browser, url: string): Promise<void> {
    const o = this.o;
    this.context = await browser.newContext({ ...this.profile, deviceScaleFactor: this.scale });
    const cfg: RecConfig = {
      virtual: !o.watch,
      seed: (o.seed ^ 0x9e3779b9) >>> 0,
      audio: !o.dry && !o.watch,
      audioSeconds: RUN_SECONDS + 60,
      touch: this.touch,
      dry: o.dry,
      countdown: RUN_SECONDS,
      countdownTop: o.profile === 'short',
    };
    await this.context.addInitScript({ content: `${await pageBundle()}\n;window.__recInstall(${JSON.stringify(cfg)});` });
    this.page = await this.context.newPage();
    this.page.on('pageerror', (e) => console.error(`[seed ${o.seed}] page error:`, e.message));
    this.page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[seed ${o.seed}] page console:`, m.text());
    });
    this.cdp = await this.context.newCDPSession(this.page);
    await this.page.goto(`${url}?seed=${o.seed}&quality=0&geo=0${o.dry ? '&mute=1' : ''}`, { waitUntil: 'load' });
    // The game exists once its module ran; wait in real time (stepping now would make the run depend on load speed).
    for (let i = 0; !(await this.page.evaluate(() => !!(window as unknown as { __game?: unknown }).__game)); i++) {
      if (i > 500) throw new Error('The game did not load');
      await sleep(20);
    }
    // One frame fires the idle callbacks (districts, flags); then wait for the lazy chunks in real time.
    await this.frame();
    for (let i = 0; !(await this.page.evaluate(() => window.__rec.ready())); i++) {
      if (i > 500) {
        console.warn(`[seed ${o.seed}] the minimap or flags did not load; going on without`);
        break;
      }
      await sleep(20);
    }
  }

  /** Sends one hand event over CDP. */
  private async send(e: HandEvent): Promise<void> {
    const cdp = this.cdp;
    switch (e.type) {
      case 'move':
        this.mouse = [e.x, e.y];
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e.x, y: e.y, button: this.down ? 'left' : 'none', buttons: this.down ? 1 : 0 });
        break;
      case 'button':
        this.mouse = [e.x, e.y];
        this.down = e.down;
        await cdp.send('Input.dispatchMouseEvent', { type: e.down ? 'mousePressed' : 'mouseReleased', x: e.x, y: e.y, button: 'left', buttons: e.down ? 1 : 0, clickCount: 1 });
        break;
      case 'key': {
        const space = e.code === 'Space';
        const key = space ? ' ' : 'w';
        await cdp.send('Input.dispatchKeyEvent', {
          type: e.down ? 'keyDown' : 'keyUp',
          key,
          code: e.code,
          windowsVirtualKeyCode: space ? 32 : 87,
          ...(e.down ? { text: key } : {}),
        });
        this.keysSent++;
        break;
      }
      case 'char': {
        const upper = e.key.toUpperCase();
        await cdp.send('Input.dispatchKeyEvent', {
          type: e.down ? 'keyDown' : 'keyUp',
          key: e.key,
          code: `Key${upper}`,
          windowsVirtualKeyCode: upper.charCodeAt(0),
          ...(e.down ? { text: e.key } : {}),
        });
        this.keysSent++;
        break;
      }
      case 'touch': {
        // The hand gives the fingers down after the event. CDP takes new and moved fingers in touchStart/touchMove, and
        // in touchEnd the fingers that lift (the others stay down).
        const point = (id: number, p: { x: number; y: number }) => ({ x: p.x, y: p.y, id, radiusX: id === 1 ? 2 : 8, radiusY: id === 1 ? 2 : 8, force: 1 });
        const next = new Map(e.points.map((p) => [p.id, { x: p.x, y: p.y }]));
        if (e.phase === 'end') {
          const lifted = [...this.fingers].filter(([id]) => !next.has(id)).map(([id, p]) => point(id, p));
          const moved = [...next].some(([id, p]) => this.fingers.get(id)?.x !== p.x || this.fingers.get(id)?.y !== p.y);
          this.fingers = next;
          if (lifted.length) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: lifted });
          if (moved && next.size) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...next].map(([id, p]) => point(id, p)) });
        } else {
          // A small contact area for the steering thumb (a wide one lets Chrome's touch adjustment pick a nearby button).
          this.fingers = next;
          await cdp.send('Input.dispatchTouchEvent', { type: e.phase === 'start' ? 'touchStart' : 'touchMove', touchPoints: [...next].map(([id, p]) => point(id, p)) });
        }
        break;
      }
    }
  }

  /** One frame: the input for it, the step (after the page has seen that input), and the capture. */
  async frame(events: HandEvent[] = [], opts: StepOptions = {}): Promise<Status> {
    const t0 = performance.now();
    for (const e of events) await this.send(e);
    const t1 = performance.now();
    const thumb = this.fingers.get(1);
    const expect = { mouse: this.mouse ?? undefined, keys: this.keysSent, touch: this.touch ? { n: this.fingers.size, x: thumb?.x, y: thumb?.y } : undefined };
    if (this.o.watch) {
      await sleep(Math.max(0, FRAME - (performance.now() - t0)));
      this.status = await this.page.evaluate(([o]) => window.__rec.step(0, o), [{ ...opts, fade: this.fade, playT: this.playT }] as const);
    } else {
      this.status = await this.page.evaluate(([ms, o]) => window.__rec.step(ms, o), [FRAME, { ...opts, fade: this.fade, playT: this.playT, expect }] as const);
    }
    const t2 = performance.now();
    this.timing.input += t1 - t0;
    this.timing.step += t2 - t1;
    if (this.capturing && this.encoder) {
      const clip = { x: 0, y: 0, width: this.profile.viewport.width, height: this.profile.viewport.height, scale: this.scale };
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, optimizeForSpeed: true, clip });
      const t3 = performance.now();
      this.timing.shot += t3 - t2;
      // A frame identical to the last while the camera moves would be a stale screenshot.
      const camKey = this.status.cam.slice(0, 3).map((v) => v.toFixed(7)).join();
      const hash = createHash('md5').update(data).digest('hex');
      if (camKey !== this.lastCam) {
        this.moving++;
        if (hash === this.lastShot) this.repeats++;
      }
      this.lastCam = camKey;
      this.lastShot = hash;
      if (!this.encoder.stdin!.write(Buffer.from(data, 'base64'))) await once(this.encoder.stdin!, 'drain');
      this.timing.write += performance.now() - t3;
      this.videoFrames++;
    }
    return this.status;
  }

  startCapture(file: string): void {
    if (this.o.dry || this.o.watch) return;
    this.encoder = ffmpeg(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-vf', TO_709, ...X264(FPS), '-movflags', '+faststart', file], { input: true });
    this.capturing = true;
    // The first frame captured is the next one drawn: its time is where the sound starts.
    this.captureStartMs = this.status.t + FRAME;
  }

  async stopCapture(): Promise<void> {
    if (!this.encoder) return;
    this.capturing = false;
    this.encoder.stdin!.end();
    await this.encoder.done;
    this.encoder = null;
  }

  /** The sound from `fromMs` (page clock) for `seconds`, as 16-bit mono at 48 kHz. */
  async sound(fromMs: number, seconds: number): Promise<Int16Array> {
    const total = Math.round(seconds * 48000);
    const pcm = new Int16Array(total);
    const audio = await this.page.evaluate(() => window.__rec.finishAudio());
    if (!audio) return pcm;
    const skip = Math.round(((fromMs - audio.startMs) / 1000) * audio.rate);
    const chunk = 48000 * 10;
    for (let to = 0; to < total; to += chunk) {
      const n = Math.min(chunk, total - to);
      const bytes = Buffer.from(await this.page.evaluate(([f, k]) => window.__rec.audioSlice(f, k), [to + skip, n] as const), 'base64');
      pcm.set(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2), to);
    }
    return pcm;
  }

  private pendingMove: HandEvent | null = null;
  /**
   * Continuous moves go to the page only on frames where the game will read the pointer (a sim tick, 25 times a
   * second): Chrome holds each one for its next real-time frame, about 16 ms. The latest position is what the tick
   * reads either way; presses, keys and touches going down or up go at once.
   */
  throttle(events: HandEvent[], tickNext: boolean): HandEvent[] {
    const out: HandEvent[] = [];
    for (const e of events) {
      if (e.type === 'move' || (e.type === 'touch' && e.phase === 'move')) this.pendingMove = e;
      else {
        if (this.pendingMove && e.type === 'touch') this.pendingMove = null;
        out.push(e);
      }
    }
    if (tickNext && this.pendingMove) {
      out.unshift(this.pendingMove);
      this.pendingMove = null;
    }
    return out;
  }

  /** Ends every touch (after the browser cancelled one), so CDP's touch state matches the hand's. */
  async releaseTouches(): Promise<void> {
    const lifted = [...this.fingers].map(([id, p]) => ({ x: p.x, y: p.y, id }));
    this.fingers.clear();
    this.pendingMove = null;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: lifted });
  }

  async setRender(on: boolean): Promise<void> {
    if (on === this.renderOn) return;
    this.renderOn = on;
    await this.page.evaluate((v) => {
      const g = (window as unknown as { __game: { renderer: { render: unknown; __render?: unknown } } }).__game;
      const r = g.renderer as { render: unknown; __render?: unknown };
      r.__render ??= r.render;
      r.render = v ? r.__render : () => {};
    }, on);
  }

  async rects(): Promise<Record<string, Rect | null>> {
    return this.page.evaluate(() => window.__rec.rects());
  }

  timingSummary(): Record<string, number> {
    const n = Math.max(1, this.videoFrames || this.log.playFrames);
    const r = (x: number) => Math.round((x / n) * 10) / 10;
    return { msPerFrame: r(this.timing.input + this.timing.step + this.timing.shot + this.timing.write), input: r(this.timing.input), step: r(this.timing.step), screenshot: r(this.timing.shot), encode: r(this.timing.write) };
  }

  get stale(): { moving: number; repeats: number } {
    return { moving: this.moving, repeats: this.repeats };
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
  }
}

/**
 * One run, start to end: the menu by hand, then 5:00 of play (or until the player is eaten), the hold, and for YouTube
 * the end card. Dry runs and recordings take exactly the same frames and input, so their hashes must agree.
 */
export async function playRun(browser: Browser, url: string, o: RunOptions): Promise<RunLog> {
  const s = new Session(o);
  const log = s.log;
  const cfg = loadConfig(new URLSearchParams());
  const brain = new Brain(cfg, o.params);
  const { width: w, height: h } = s.profile.viewport;
  const hands = new Hands(o.seed, s.touch, w, h);
  hands.R = cfg.sphereRadius;
  const capture = !o.dry && !o.watch;
  const windows = o.windows ?? null;
  try {
    await s.open(browser, url);
    const r = await s.rects();
    const playTotal = Math.round(((o.maxPlaySeconds ?? RUN_SECONDS) + HOLD_SECONDS) * FPS);

    // The opening: a second of attract mode (fading in), then the menu by hand.
    if (capture && !windows) {
      s.fade = 1;
      s.startCapture(join(o.dir!, 'video.mp4'));
    }
    for (let k = 0; k < FPS; k++) {
      if (capture && !windows) s.fade = 1 - (k + 1) / FPS;
      await s.frame();
    }
    s.fade = 0;
    const menu = menuScript(o.seed, NAME, r.nick!, r.play!, s.touch, w, h, FPS);
    for (const events of menu) await s.frame(events);
    // Wait (real time) for the sound chunk Play loads, so no sound is lost and the page's clock didn't move meanwhile.
    for (let i = 0; !(await s.page.evaluate(() => window.__rec.soundReady())) && i < 500; i++) await sleep(20);
    if (s.status.state !== 'playing') {
      await s.frame();
      if (s.status.state !== 'playing') throw new Error(`Play did not start (state ${s.status.state})`);
    }
    log.playPageFrame = s.status.frame;
    log.playVideoFrame = s.videoFrames;

    // Play.
    const after = await s.rects();
    const avoid: Rect[] = [after.minimap, after.mute, s.touch ? after.touch : null].filter((x): x is Rect => !!x);
    const screen = (st: Status): Screen => ({ cam: st.cam, me: st.me, avoid, split: s.touch ? after['btn-split'] : null });
    let st = s.status;
    let deathFrame = -1;
    let win = 0;
    const WARM = 3 * FPS;
    if (windows) await s.setRender(false);
    let lastProgress = 0;
    for (let n = 0; n < playTotal; n++) {
      // The Short: rendering on from the warm-up before each window, capture inside it.
      if (windows) {
        let wnd = windows[win];
        if (wnd && n === wnd.to) {
          await s.stopCapture();
          wnd = windows[++win];
          if (!wnd) break;
        }
        // Rendering on from the warm-up before a window (or from Play, when the window starts sooner), off between.
        await s.setRender(!!wnd && n >= wnd.from - WARM);
        if (wnd && n === wnd.from) s.startCapture(join(o.dir!, `${wnd.name}.mp4`));
      }
      s.playT = (n + 1) * FRAME;
      const events = st.alive ? hands.frame((n * FRAME) / 1000, screen(st)) : [];
      const decide = (n + 1) % DECIDE === 0;
      st = await s.frame(s.throttle(events, st.tickNext), { snap: decide && st.alive, hash: (n + 1) % FPS === 0, hand: hands.fingers() });
      if (st.touchCancelled) {
        // The browser dropped the thumb's touch: lift it everywhere and let the hand put it down again.
        await s.releaseTouches();
        hands.cancelTouch(((n + 1) * FRAME) / 1000);
        log.events.push({ frame: st.frame, type: 'touch-cancelled', play: n });
      }
      log.playFrames = n + 1;
      if (decide && st.snap) {
        const it = brain.decide(st.snap);
        hands.push(it);
        // REC_TRACE=1: what the brain is doing, twice a second.
        if (process.env.REC_TRACE && (n + 1) % 30 === 0) console.log(`t${((n + 1) / FPS).toFixed(1)} ${it.goal} risk ${brain.lastRisk.toFixed(2)} mass ${Math.round(st.mass)} hand ${hands.x.toFixed(0)},${hands.y.toFixed(0)} goals ${brain.lastGoals.slice(0, 4).join(' ')}`);
      }
      if (st.hash) {
        log.hashes.push(st.hash);
        const k = log.hashes.length - 1;
        if (o.compare && log.diverged === null && o.compare[k] !== undefined && o.compare[k] !== st.hash) {
          log.diverged = k + 1;
          console.warn(`\n[seed ${o.seed}] the run left its dry run at ${k + 1} s of play`);
          if (!windows) break;
        }
      }
      if ((n + 1) % (FPS / 2) === 0) log.samples.push([Math.round(((n + 1) / FPS) * 10) / 10, Math.round(st.mass), st.points, st.rank, st.region, st.interior ? 1 : 0, Math.round(st.rainbow * 10) / 10]);
      if (st.alive) {
        log.final.peak = Math.max(log.final.peak, st.mass);
        if (st.rank === 1 && log.final.topAt < 0) log.final.topAt = (n + 1) / FPS;
      }
      if (!st.alive && deathFrame < 0 && st.state !== 'playing') deathFrame = n;
      for (const e of st.events) {
        log.events.push({ ...e, play: e.frame - log.playPageFrame });
        if (e.type === 'explode') log.final.chain = Math.max(log.final.chain, Number(e.k) + 1);
      }
      if (deathFrame >= 0 && n - deathFrame >= (1.2 + DEATH_HOLD) * FPS) break;
      if (o.progress && s.videoFrames - lastProgress >= o.progress * FPS) {
        lastProgress = s.videoFrames;
        const t = s.timingSummary();
        process.stdout.write(`\r${clock(s.videoFrames / FPS)} recorded, ${clock((n + 1) / FPS)} played, mass ${Math.round(st.mass)}, rank ${st.rank}, ${t.msPerFrame} ms a frame (step ${t.step}, screenshot ${t.screenshot}, encode ${t.encode})   `);
      }
    }
    const runEnd = Math.min(log.playFrames, Math.round(RUN_SECONDS * FPS));
    const atEnd = log.samples.filter((x) => x[0] * FPS <= runEnd).pop();
    log.final.alive = deathFrame < 0;
    log.final.mass = log.final.alive ? Math.round(atEnd?.[1] ?? st.mass) : 0;
    log.final.points = st.points;
    log.final.rank = log.final.alive ? st.rank : 0;
    log.final.peak = Math.round(log.final.peak);
    log.final.deathAt = deathFrame >= 0 ? Math.round((deathFrame / FPS) * 10) / 10 : -1;

    // The end card (YouTube): the final mass over the dimmed last frames, then a fade.
    if (capture && o.card && log.diverged === null) {
      const lines = [`Mass ${log.final.mass.toLocaleString('en-US')} in 5 minutes`, log.final.rank === 1 ? '#1 on the leaderboard' : `${log.final.points.toLocaleString('en-US')} points`, `Play free at ${SITE}`];
      await s.page.evaluate((l) => window.__rec.card(l), log.final.alive ? lines : [`Peak mass ${log.final.peak.toLocaleString('en-US')}`, `${log.final.points.toLocaleString('en-US')} points`, `Play free at ${SITE}`]);
      for (let k = 0; k < 8 * FPS; k++) await s.frame();
      for (let k = 0; k < FPS; k++) {
        s.fade = (k + 1) / FPS;
        await s.frame();
      }
    }
    log.videoFrames = s.videoFrames;
    if (capture && !windows) {
      await s.stopCapture();
      const pcm = await s.sound(s.captureStartMs, s.videoFrames / FPS);
      writeWav(join(o.dir!, 'video.wav'), pcm);
      log.checks = { ...s.timingSummary(), ...s.stale, soundClockDriftMs: await s.page.evaluate(() => window.__rec.drift), late: await s.page.evaluate(() => window.__rec.late), toasts: await s.page.evaluate(() => window.__rec.toasts), sync: chompSync(pcm, log) };
    } else if (capture && windows) {
      await s.stopCapture();
      // Each piece's sound, cut from the replay's own offline render.
      // Each piece's sound, cut from the replay's own offline render. Play frame n is drawn at page frame
      // playPageFrame + n + 1.
      for (const wnd of windows) {
        const fromMs = (log.playPageFrame + wnd.from + 1) * FRAME;
        writeWav(join(o.dir!, `${wnd.name}.wav`), await s.sound(fromMs, (wnd.to - wnd.from) / FPS));
      }
      log.checks = { ...s.timingSummary(), ...s.stale };
    } else log.checks = { ...s.timingSummary(), late: await s.page.evaluate(() => window.__rec.late) };
    return log;
  } finally {
    await s.close();
  }
}

/**
 * Sound against picture: for pellets eaten after a quiet moment, where the chomp starts relative to the frame it was
 * eaten on (ms; median and count). Within a frame (±17 ms) is in sync.
 */
function chompSync(pcm: Int16Array, log: RunLog): { medianMs: number | null; checked: number } {
  const rate = 48000;
  const env = (t: number) => {
    let s = 0;
    const i0 = Math.round(t * rate);
    for (let i = i0; i < i0 + 96; i++) s += (pcm[i] ?? 0) ** 2;
    return s;
  };
  const offsets: number[] = [];
  let lastSound = -1e9;
  for (const e of log.events) {
    if (e.type !== 'eat') continue;
    // The tick ran in play frame e.play's step; its frame is video frame playVideoFrame + e.play, and the sound it booked
    // starts at that frame's time.
    const t = (log.playVideoFrame + e.play) / FPS;
    const quiet = t - lastSound > 0.35;
    if (e.what === 'pellet') lastSound = t;
    if (!quiet || e.what !== 'pellet' || (t + 0.2) * rate > pcm.length) continue;
    let best = 0;
    let bestAt: number | null = null;
    for (let x = t - 0.05; x < t + 0.05; x += 0.001) {
      const rise = env(x + 0.002) / (env(x - 0.004) + 1e3);
      if (rise > best) [best, bestAt] = [rise, x];
    }
    if (bestAt !== null && best > 50) offsets.push((bestAt - t) * 1000);
  }
  offsets.sort((a, b) => a - b);
  return { medianMs: offsets.length ? Math.round(offsets[offsets.length >> 1]) : null, checked: offsets.length };
}

// ---- Commands ----

/** Dry runs of many seeds, several at a time; each saved as search/<profile>/seed-N.json, ranked in search/<profile>.json. */
export async function search(profile: ProfileName, seeds: number[], workers: number, out: string, params: Partial<BrainParams>): Promise<void> {
  const dir = join(out, 'search', profile);
  mkdirSync(dir, { recursive: true });
  const server = await startServer();
  const browser = await launch();
  const results: { seed: number; final: RunLog['final']; seconds: number; diverged: number | null }[] = [];
  const t0 = Date.now();
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(workers, seeds.length) }, async () => {
        while (next < seeds.length) {
          const seed = seeds[next++];
          const file = join(dir, `seed-${seed}.json`);
          let log: RunLog;
          if (existsSync(file)) log = JSON.parse(readFileSync(file, 'utf8')) as RunLog;
          else {
            log = await playRun(browser, server.url, { seed, profile, dry: true, params });
            writeFileSync(file, JSON.stringify(log));
          }
          results.push({ seed, final: log.final, seconds: log.playFrames / FPS, diverged: log.diverged });
          const f = log.final;
          console.log(`seed ${seed}: ${f.alive ? `alive, mass ${f.mass}` : `eaten at ${f.deathAt} s`}, peak ${f.peak}, points ${f.points}, rank ${f.rank}, chain ${f.chain}  (${results.length}/${seeds.length}, ${Math.round((Date.now() - t0) / 1000)} s)`);
        }
      }),
    );
  } finally {
    await browser.close();
    await server.close();
  }
  results.sort((a, b) => Number(b.final.alive) - Number(a.final.alive) || b.final.mass - a.final.mass || b.final.peak - a.final.peak);
  writeFileSync(join(out, 'search', `${profile}.json`), JSON.stringify(results, null, 1));
  const alive = results.filter((r) => r.final.alive);
  console.log(`\n${profile}: ${alive.length} of ${results.length} alive at 5:00. Best:`);
  for (const r of results.slice(0, 10)) console.log(`  seed ${r.seed}: mass ${r.final.mass}, peak ${r.final.peak}, points ${r.final.points}, rank ${r.final.rank}, #1 at ${r.final.topAt} s, chain ${r.final.chain}`);
}

/** The dry run of a seed: from the search if there, else played now. */
export async function dryRun(profile: ProfileName, seed: number, out: string, params: Partial<BrainParams>): Promise<RunLog> {
  const file = join(out, 'search', profile, `seed-${seed}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as RunLog;
  const server = await startServer();
  const browser = await launch();
  try {
    const log = await playRun(browser, server.url, { seed, profile, dry: true, params });
    mkdirSync(join(out, 'search', profile), { recursive: true });
    writeFileSync(file, JSON.stringify(log));
    return log;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** The YouTube master (or the pilot): one take of the whole run, checked against its dry run, with the sound muxed. */
export async function recordMaster(name: 'youtube' | 'pilot', seed: number, out: string, params: Partial<BrainParams>, opts: { scale?: number; seconds?: number } = {}): Promise<RunLog> {
  const dry = await dryRun('desktop', seed, out, params);
  // The recording must replay its dry run exactly: same brain parameters, whatever the tuning has written since.
  params = dry.params;
  const f = dry.final;
  console.log(`Dry run of seed ${seed}: ${f.alive ? `alive at 5:00 with mass ${f.mass}` : `eaten at ${f.deathAt} s`}, peak ${f.peak}, points ${f.points}.`);
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const server = await startServer();
  const browser = await launch();
  try {
    const log = await playRun(browser, server.url, { seed, profile: 'desktop', dry: false, params, dir, scale: opts.scale, compare: dry.hashes, card: name === 'youtube', maxPlaySeconds: opts.seconds, progress: 15 });
    process.stdout.write('\n');
    writeFileSync(join(dir, 'run.json'), JSON.stringify(log));
    console.log('Checks:', JSON.stringify(log.checks));
    const matched = log.diverged === null && log.hashes.every((x, k) => dry.hashes[k] === undefined || dry.hashes[k] === x);
    console.log(matched ? `The recording matched its dry run, every second (${log.hashes.length} s).` : `The recording LEFT its dry run at ${log.diverged} s.`);
    const sound = await mux(join(dir, 'video.mp4'), join(dir, 'video.wav'), join(dir, `cell-${name}.mp4`));
    console.log(`Wrote ${join(dir, `cell-${name}.mp4`)} (${clock(log.videoFrames / FPS)}; sound ${sound.i} LUFS, ${sound.peak} dBTP)`);
    return log;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** A visible window, in real time: the quick way to see the autoplayer at work. */
async function watch(seed: number, profile: ProfileName, params: Partial<BrainParams>): Promise<void> {
  const server = await startServer();
  const browser = await launch(false);
  try {
    const log = await playRun(browser, server.url, { seed, profile, dry: false, watch: true, params });
    console.log(JSON.stringify(log.final));
  } finally {
    await browser.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = outDir();
  const params = brainParams(out);
  const profile = arg('profile', 'desktop') as ProfileName;
  const seed = Number(arg('seed', '1'));
  if (cmd === 'search') {
    const { seedList } = await import('./autoplay.ts');
    await search(profile, seedList(arg('seeds', '1-24')), Number(arg('workers', String(Math.max(1, Math.min(6, availableParallelism() - 2))))), out, params);
  } else if (cmd === 'dry') {
    const log = await dryRun(profile, seed, out, params);
    console.log(JSON.stringify({ final: log.final, checks: log.checks, seconds: log.playFrames / FPS }));
  } else if (cmd === 'youtube') await recordMaster('youtube', seed, out, params, { scale: Number(arg('res', '1440')) / 720 });
  else if (cmd === 'pilot') await recordMaster('pilot', seed, out, params, { scale: Number(arg('res', '1440')) / 720, seconds: Number(arg('seconds', '90')) });
  else if (cmd === 'watch') await watch(seed, profile, params);
  else {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('// Usage') || l.startsWith('//        ') || l.startsWith('// Common')).join('\n'));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
