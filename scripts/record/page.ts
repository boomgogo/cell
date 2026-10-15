// Injected by scripts/record.ts into the page before any of the game's code runs (bundled into one script by Vite).
// Ported from Bubbler's recorder clock.
//
// With `virtual`, the page's clock belongs to the recorder: time moves only when __rec.step(ms) is called, so every frame
// of the video is drawn in full however long it takes. That covers performance.now, Date.now, requestAnimationFrame,
// the timers and requestIdleCallback (the twelve districts build at the same virtual moments every run), CSS animations,
// and the sound: the AudioContext becomes an OfflineAudioContext that renders in step with the frames.
//
// It also seeds Math.random; waits, at each step, until the page has seen the input the recorder sent (Chrome may
// deliver mouse moves on its own frame, and a late one would change the run); logs the player's events; hashes the
// state every second (a recording must match its dry run); builds the autoplayer's snapshot; and draws a cursor or
// touch dots, the 5:00 countdown and a black fade layer. A dry run switches the game's rendering off.
import type { Game } from '../../src/game.ts';
import { eatPoints, explodePoints } from '../../src/ui/points.ts';
import { type Snapshot, takeSnapshot } from '../autoplay/snapshot.ts';

export interface RecConfig {
  virtual: boolean;
  /** Seed for Math.random. */
  seed: number;
  /** Render the sound offline (capture runs). */
  audio: boolean;
  audioSeconds: number;
  touch: boolean;
  /** A dry run: no rendering, no overlays. */
  dry: boolean;
  /** Countdown length in seconds (0: none), and where it sits. */
  countdown: number;
  countdownTop: boolean;
}

/** What the recorder sent before this step, for the handshake. */
export interface Expect {
  /** Last mouse position sent. */
  mouse?: [number, number];
  /** Key events (down and up) sent so far. */
  keys?: number;
  /** Fingers down after the touch events sent, and where the steering thumb is (when it is down). */
  touch?: { n: number; x?: number; y?: number };
}

export interface StepOptions {
  fade?: number;
  expect?: Expect;
  /** Milliseconds since Play (−1 before), for the countdown and the snapshot. */
  playT?: number;
  /** Return the autoplayer's snapshot with the status. */
  snap?: boolean;
  /** Return the state hash with the status. */
  hash?: boolean;
  /** Where the hand is (CSS px): the cursor or the touch dots are drawn there every frame (input reaches the game only
   * when it reads it, at its sim ticks). */
  hand?: { x: number; y: number; down: boolean; id: number }[];
}

export interface Status {
  t: number;
  frame: number;
  state: string;
  booted: boolean;
  alive: boolean;
  cam: number[];
  /** Our largest cell (unit vector), or null. */
  me: number[] | null;
  mass: number;
  points: number;
  rank: number;
  /** Region index under the camera, and whether the camera is inside a maze interior. */
  region: number;
  interior: boolean;
  rainbow: number;
  snap?: Snapshot;
  hash?: string;
  /** Will the next frame run a sim tick (when the game reads the pointer)? */
  tickNext: boolean;
  /** Player events since the last step. */
  events: RecEvent[];
  /** The browser cancelled the touch the recorder sent for this step. */
  touchCancelled: boolean;
}

/** A player event, in frames of the page's clock. */
export interface RecEvent {
  frame: number;
  type: string;
  [k: string]: number | string | boolean;
}

type GameLike = Game;
/** Game fields TypeScript keeps private: the lazy minimap and sound. */
const lazy = (g: Game) => g as unknown as { minimap: unknown; sfx: unknown };

declare global {
  interface Window {
    __rec: ReturnType<typeof install>;
    __recInstall: (cfg: RecConfig) => void;
  }
}

function install(cfg: RecConfig) {
  const rec = {
    now: 0,
    frames: 0,
    fade: 0,
    playT: -1,
    audio: null as OfflineAudioContext | null,
    audioStart: 0,
    audioDone: null as Promise<AudioBuffer> | null,
    samples: null as Float32Array | null,
    drift: 0,
    late: 0,
    /** This step's touch was cancelled by the browser. */
    cancelled: false,
    events: [] as RecEvent[],
    step: (_ms: number, _o?: StepOptions): Promise<Status> => Promise.reject(new Error('not ready')),
    status: (_o?: StepOptions): Status => ({}) as Status,
    finishAudio: async (): Promise<{ startMs: number; rate: number } | null> => null,
    audioSlice: (_from: number, _n: number): string => '',
    rects: (): Record<string, { x: number; y: number; w: number; h: number } | null> => ({}),
    ready: (): boolean => false,
    /** How long each toast stayed up (ms on the page's clock): a check that the HUD keeps time. */
    toasts: [] as { text: string; ms: number }[],
    card: (_lines: string[]): void => {},
    soundReady: (): boolean => false,
    hash: (): string => '',
  };
  window.__rec = rec as never;
  const realSetTimeout = window.setTimeout.bind(window);
  const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

  // ---- Seeded randomness: the player's hue, effects and the noise buffer come out the same every time.
  let a = cfg.seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---- Input the page has seen (capture phase, before the game's listeners).
  const seen = { mx: -1, my: -1, keys: 0, tn: 0, touches: [] as { x: number; y: number }[] };
  const pointers = new Map<number, { x: number; y: number; down: boolean; lift: number; type: string }>();
  let ripple = -1;
  // The last few pointer events, for the handshake's error message.
  const recent: string[] = [];
  let touchCancelled = false;
  const onPointer = (e: PointerEvent) => {
    if (e.type === 'pointercancel' && e.pointerType === 'touch') touchCancelled = true;
    recent.push(`${e.type}:${e.pointerType}#${e.pointerId}@${e.clientX.toFixed(1)},${e.clientY.toFixed(1)}`);
    if (recent.length > 8) recent.shift();
    if (e.pointerType === 'mouse') {
      seen.mx = e.clientX;
      seen.my = e.clientY;
      if (e.type === 'pointerdown') ripple = 0;
    }
    let p = pointers.get(e.pointerId);
    if (!p) {
      p = { x: e.clientX, y: e.clientY, down: false, lift: 1, type: e.pointerType };
      pointers.set(e.pointerId, p);
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (e.type === 'pointerdown') {
      p.down = true;
      p.lift = 0;
    } else if (e.type === 'pointerup' || e.type === 'pointercancel') p.down = false;
  };
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, onPointer as EventListener, true);
  addEventListener('keydown', () => seen.keys++, true);
  addEventListener('keyup', () => seen.keys++, true);
  // Touches: how many fingers are down, and where, from the touch pointer events the game reads. (Chrome sends no
  // DOM touchmove to a touch-action: none canvas with passive listeners, but every pointermove arrives.)
  const touchState = () => {
    const down = [...pointers.values()].filter((p) => p.type === 'touch' && p.down);
    seen.tn = down.length;
    seen.touches = down.map((p) => ({ x: p.x, y: p.y }));
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) addEventListener(type, touchState, true);

  const game = () => (window as unknown as { __game?: GameLike }).__game;

  // ---- Virtual time.
  const timers = new Map<number, { at: number; every: number; fn: (...args: unknown[]) => void; args: unknown[]; seq: number }>();
  let frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  if (cfg.virtual) {
    const epoch = Date.now();
    performance.now = () => rec.now;
    Date.now = () => epoch + rec.now;
    const add = (fn: unknown, ms: unknown, args: unknown[], every: boolean) => {
      const id = nextId++;
      const wait = Math.max(0, Number(ms) || 0);
      timers.set(id, { at: rec.now + wait, every: every ? Math.max(1, wait) : 0, fn: fn as (...args: unknown[]) => void, args, seq: id });
      return id;
    };
    const w = window as unknown as Record<string, unknown>;
    w.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, false);
    w.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, true);
    w.clearTimeout = w.clearInterval = (id: number) => void timers.delete(id);
    w.requestIdleCallback = (fn: (d: IdleDeadline) => void) => add(() => fn({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline), 1, [], false);
    w.cancelIdleCallback = w.clearTimeout;
    w.requestAnimationFrame = (fn: FrameRequestCallback) => {
      const id = nextId++;
      frameCallbacks.set(id, fn);
      return id;
    };
    w.cancelAnimationFrame = (id: number) => void frameCallbacks.delete(id);
  }

  // ---- Sound, rendered offline in step with the frames.
  const RATE = 48000;
  const QUANTUM = 128;
  let rendered = 0;
  let started = false;
  if (cfg.virtual && cfg.audio) {
    const Offline = window.OfflineAudioContext;
    const proto = Offline.prototype;
    class RecordedAudioContext extends Offline {
      constructor() {
        super({ numberOfChannels: 1, length: Math.ceil((cfg.audioSeconds * RATE) / QUANTUM) * QUANTUM, sampleRate: RATE });
        rec.audio = this;
        rec.audioStart = rec.now;
      }
      get state(): AudioContextState {
        return 'running';
      }
      resume() {
        return Promise.resolve();
      }
      suspend() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    (window as unknown as Record<string, unknown>).AudioContext = RecordedAudioContext;
    (window as unknown as Record<string, unknown>).webkitAudioContext = RecordedAudioContext;
    rec.finishAudio = async () => {
      if (!rec.audio || !started) return null;
      if (!rec.samples) {
        void proto.resume.call(rec.audio);
        rec.samples = (await rec.audioDone!).getChannelData(0);
      }
      return { startMs: rec.audioStart, rate: RATE };
    };
    rec.audioSlice = (from: number, n: number) => {
      const src = rec.samples!.subarray(Math.max(0, from), Math.max(0, from + n));
      const ints = new Int16Array(n);
      const off = from < 0 ? -from : 0;
      for (let i = 0; i < src.length && off + i < n; i++) ints[off + i] = Math.max(-1, Math.min(1, src[i])) * 32767;
      const bytes = new Uint8Array(ints.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
  }
  // Renders the sound up to `ms` on the page's clock, to the nearest render quantum.
  const advanceAudio = async (ms: number) => {
    const ctx = rec.audio;
    if (!ctx) return;
    const proto = OfflineAudioContext.prototype;
    const frame = Math.round((((ms - rec.audioStart) / 1000) * RATE) / QUANTUM) * QUANTUM;
    if (frame <= rendered || frame >= ctx.length) return;
    const reached = proto.suspend.call(ctx, frame / RATE);
    if (!started) {
      started = true;
      rec.audioDone = proto.startRendering.call(ctx);
    } else void proto.resume.call(ctx);
    await reached;
    rendered = frame;
    rec.drift = Math.max(rec.drift, Math.abs(ctx.currentTime * 1000 - (ms - rec.audioStart)));
  };

  // ---- CSS animations and transitions follow the same clock.
  const begun = new WeakMap<Animation, number | null>();
  const driveAnimations = () => {
    for (const anim of document.getAnimations()) {
      let start = begun.get(anim);
      if (start === undefined) {
        if (anim.playState === 'finished') continue;
        start = rec.now;
        begun.set(anim, start);
        anim.pause();
      }
      if (start === null) continue;
      const end = Number(anim.effect?.getComputedTiming().endTime ?? Infinity);
      const t = rec.now - start;
      if (t >= end) {
        begun.set(anim, null);
        anim.finish();
      } else anim.currentTime = t;
    }
  };

  // ---- Hooks into the game once it exists: the player's events, and no rendering in a dry run.
  let hooked = false;
  const hook = (g: GameLike) => {
    hooked = true;
    if (cfg.dry) g.renderer.render = () => {};
    const w = g.world;
    const step = w.step.bind(w);
    w.step = () => {
      step();
      if (g.state !== 'playing') return;
      const me = g.human.id;
      for (const e of w.events) {
        if (e.type === 'eat' && e.eaterOrg === me) {
          const pts = eatPoints(e, me);
          if (e.preyOrg === me) continue;
          rec.events.push({ frame: rec.frames, type: 'eat', what: e.foodKind === 2 ? 'spore' : e.foodKind === 0 ? 'pellet' : e.eatenKind === 2 ? 'virus' : e.eatenKind === 1 ? 'blob' : 'cell', mass: Math.round(((e.r * e.r) / 100) * 10) / 10, points: pts, x: e.x, y: e.y, z: e.z, prey: e.preyOrg });
        } else if (e.type === 'explode' && (e.organismId === me || e.victimId === me)) {
          rec.events.push({ frame: rec.frames, type: e.organismId === me ? 'explode' : 'exploded', k: e.k, mass: Math.round((e.r * e.r) / 100), points: e.organismId === me ? explodePoints(e.k) : 0, x: e.x, y: e.y, z: e.z });
        } else if (e.type === 'rainbow' && e.organismId === me) rec.events.push({ frame: rec.frames, type: 'rainbow', seconds: (e.untilTick - w.tick) / 25 });
        else if (e.type === 'death' && e.organismId === me) {
          const killer = e.killerId !== null ? w.organisms.find((o) => o.id === e.killerId) : undefined;
          rec.events.push({ frame: rec.frames, type: 'death', killer: killer?.name ?? '', killerMass: Math.round(killer?.lastMass ?? 0), phage: !!killer?.resident });
        } else if (e.type === 'pop' && w.cellsById.get(e.cellId)?.owner === g.human) rec.events.push({ frame: rec.frames, type: 'pop' });
        else if (e.type === 'pack' && e.organismId === me) rec.events.push({ frame: rec.frames, type: 'pack' });
      }
    };
  };

  // ---- State hash: tick, points, every cell, food count.
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  rec.hash = () => {
    const g = game();
    if (!g) return '';
    let h = 0x811c9dc5;
    const mix = (x: number) => {
      f64[0] = x;
      h = Math.imul(h ^ u32[0], 0x01000193);
      h = Math.imul(h ^ u32[1], 0x01000193);
    };
    const w = g.world;
    mix(w.tick);
    mix(g.points);
    mix(w.food.count);
    for (const c of w.cells) {
      mix(c.id);
      mix(c.p.x);
      mix(c.p.y);
      mix(c.p.z);
      mix(c.r);
    }
    for (const c of g.human.cells) mix(c.r);
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  rec.status = (o: StepOptions = {}) => {
    const g = game();
    const s: Status = {
      t: rec.now,
      frame: rec.frames,
      state: g?.state ?? 'loading',
      booted: !!g && g.world.tick > 0,
      alive: !!g && g.state === 'playing' && g.human.alive,
      cam: [],
      me: null,
      mass: 0,
      points: g?.points ?? 0,
      rank: 0,
      region: -1,
      interior: false,
      rainbow: 0,
      tickNext: true,
      events: [],
      touchCancelled: rec.cancelled,
    };
    if (!g) return s;
    // Game.frame adds the frame's time to its accumulator and ticks while it holds a whole tick.
    const acc = (g as unknown as { acc: number }).acc;
    s.tickNext = acc + 1000 / 60 >= g.cfg.tickMs;
    s.events = rec.events;
    rec.events = [];
    const f = g.camera.frame;
    s.cam = [f.c.x, f.c.y, f.c.z, f.e.x, f.e.y, f.e.z, f.s.x, f.s.y, f.s.z, g.camera.zoom, g.camera.width, g.camera.height];
    const maze = g.world.maze;
    if (maze.enabled) {
      s.region = maze.layout.regionAt(f.c);
      s.interior = maze.inInterior(f.c);
    }
    if (s.alive) {
      const L = g.human.largestCell();
      if (L) s.me = [L.p.x, L.p.y, L.p.z];
      s.mass = g.human.mass;
      s.rank = g.world.leaderboard.indexOf(g.human) + 1;
      s.rainbow = Math.max(0, (g.human.rainbowUntil - g.world.tick) / 25);
    }
    if (o.snap && s.alive && o.playT !== undefined) s.snap = takeSnapshot({ world: g.world, camera: g.camera, human: g.human, points: g.points, t: o.playT });
    if (o.hash) s.hash = rec.hash();
    return s;
  };

  rec.ready = () => {
    const g = game();
    return !!g && lazy(g).minimap !== null && g.renderer.flags !== null;
  };

  rec.soundReady = () => {
    const g = game();
    return !!g && lazy(g).sfx !== null;
  };

  rec.rects = () => {
    const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
    for (const id of ['nick', 'play', 'minimap', 'mute', 'btn-split', 'btn-eject', 'touch', 'score', 'leaderboard', 'banner', 'arcade-hud']) {
      const el = document.getElementById(id);
      if (!el || el.hidden) {
        out[id] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      out[id] = r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    }
    return out;
  };

  // Waits (in real time) until the page has seen the input sent for this frame.
  const handshake = async (ex: Expect | undefined) => {
    if (!ex) return;
    const ok = () =>
      (!ex.mouse || (Math.abs(seen.mx - ex.mouse[0]) < 0.01 && Math.abs(seen.my - ex.mouse[1]) < 0.01)) &&
      (ex.keys === undefined || seen.keys >= ex.keys) &&
      (!ex.touch ||
        (seen.tn === ex.touch.n && (ex.touch.x === undefined || seen.touches.some((t) => Math.abs(t.x - ex.touch!.x!) < 0.01 && Math.abs(t.y - ex.touch!.y!) < 0.01))));
    if (ok()) return;
    // Steps that had to wait for their input (diagnostics), and a give-up after about 2 s. A touch the browser cancelled
    // won't arrive: stop waiting and say so (the recorder lifts the thumb and puts it down again).
    rec.late++;
    for (let tries = 0; !ok() && tries < 2000; tries++) {
      if (touchCancelled && ex.touch && seen.tn < ex.touch.n) {
        rec.cancelled = true;
        return;
      }
      await sleep(1);
    }
    if (!ok()) console.error(`rec: input not seen after 2 s (${JSON.stringify(ex)} vs ${JSON.stringify(seen)}; last pointer events ${recent.join(' ')})`);
  };

  // ---- One frame: the input handshake, then the sound, then every timer that falls due, in order, then the frame.
  let hand: { x: number; y: number; down: boolean; id: number }[] | null = null;
  rec.step = async (ms: number, o: StepOptions = {}) => {
    touchCancelled = false;
    rec.cancelled = false;
    if (o.fade !== undefined) rec.fade = o.fade;
    if (o.hand) hand = o.hand;
    if (o.playT !== undefined) rec.playT = o.playT;
    await handshake(o.expect);
    if (cfg.virtual) {
      const target = rec.now + ms;
      if (rec.audio) await advanceAudio(target);
      for (let guard = 0; guard < 5000; guard++) {
        let due: { id: number; t: { at: number; every: number; fn: (...args: unknown[]) => void; args: unknown[]; seq: number } } | null = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.t.at || (t.at === due.t.at && t.seq < due.t.seq))) due = { id, t };
        }
        if (!due) break;
        rec.now = Math.max(rec.now, due.t.at);
        if (due.t.every) {
          due.t.at += due.t.every;
          due.t.seq = nextId++;
        } else timers.delete(due.id);
        try {
          if (typeof due.t.fn === 'function') due.t.fn(...due.t.args);
        } catch (error) {
          console.error(error);
        }
      }
      rec.now = target;
      const g = game();
      if (g && !hooked) hook(g);
      const callbacks = frameCallbacks;
      frameCallbacks = new Map();
      for (const fn of callbacks.values()) {
        try {
          fn(target);
        } catch (error) {
          console.error(error);
        }
      }
      driveAnimations();
    } else {
      rec.now = performance.now();
      const g = game();
      if (g && !hooked) hook(g);
    }
    rec.frames++;
    if (!cfg.dry) overlays(ms);
    return rec.status(o);
  };

  // ---- Toasts: how long each stays up.
  let toastAt = -1;
  let toastText = '';
  new MutationObserver(() => {
    const el = document.getElementById('toast');
    if (!el) return;
    if (!el.hidden && toastAt < 0) {
      toastAt = rec.now;
      toastText = el.textContent ?? '';
    } else if (el.hidden && toastAt >= 0) {
      rec.toasts.push({ text: toastText, ms: rec.now - toastAt });
      toastAt = -1;
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'], childList: true });

  // ---- The end card: lines over the dimmed game.
  rec.card = (lines: string[]) => {
    if (!els) build();
    const card = els!.card;
    card.replaceChildren(
      ...lines.map((text, k) => {
        const p = document.createElement('p');
        p.textContent = text;
        p.className = k === 0 ? 'big' : k === lines.length - 1 ? 'link' : '';
        return p;
      }),
    );
    els!.veil.hidden = false;
    card.hidden = false;
  };

  // ---- Overlays: cursor or touch dots, the countdown, the end card, the fade.
  let els: Record<string, HTMLElement> | null = null;
  const build = () => {
    const style = document.createElement('style');
    style.textContent = `
      #rec-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      #rec-layer > * { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
      #rec-fade { inset: 0; width: 100%; height: 100%; background: #000; }
      #rec-cursor { width: 21px; height: 30px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      #rec-ripple { width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid rgba(36,31,28,.8); }
      .rec-touch { width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; background: rgba(36,31,28,.18); border: 2px solid rgba(36,31,28,.55); }
      #rec-veil { inset: 0; width: 100%; height: 100%; background: color-mix(in srgb, var(--paper) 62%, transparent); }
      #rec-card { left: 50%; top: 50%; transform: translate(-50%, -50%); min-width: min(560px, 86vw); padding: 22px 28px; text-align: center;
        background: var(--paper); color: var(--key); border: 2px solid var(--key); border-radius: 2px; box-shadow: 6px 6px 0 var(--navy);
        font: 700 22px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif; }
      #rec-card p { margin: 6px 0; }
      #rec-card .big { font-size: 40px; font-weight: 900; letter-spacing: 1px; text-shadow: 3px 2px 0 var(--coral); }
      #rec-card .link { margin-top: 14px; font: 800 24px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; border-bottom: 3px solid var(--emerald); display: inline-block; }
      #rec-clock { ${cfg.countdownTop ? 'left: 41%; top: 12px;' : 'left: 50%; top: auto; bottom: 12px;'} transform: translateX(-50%); padding: 2px 10px;
        font: 800 ${cfg.countdownTop ? 18 : 22}px/1.25 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; letter-spacing: 1px;
        color: var(--key); background: var(--paper); border: 2px solid var(--key); border-radius: 2px; box-shadow: 3px 3px 0 var(--amber); }
    `;
    document.head.append(style);
    const layer = document.createElement('div');
    layer.id = 'rec-layer';
    layer.innerHTML =
      '<div id="rec-clock" hidden></div>' +
      (cfg.touch
        ? '<div class="rec-touch" id="rec-touch-1"></div><div class="rec-touch" id="rec-touch-2"></div><div class="rec-touch" id="rec-touch-3"></div>'
        : '<div id="rec-ripple"></div><svg id="rec-cursor" viewBox="0 0 14 20"><path d="M1 1v15.5l3.9-3.7 2.6 6 2.6-1.1-2.6-5.9h5.4z" fill="#fff" stroke="#241f1c" stroke-width="1.1" stroke-linejoin="round"/></svg>') +
      '<div id="rec-veil" hidden></div><div id="rec-card" hidden></div><div id="rec-fade"></div>';
    document.body.append(layer);
    els = Object.fromEntries([...layer.children].map((el) => [el.id.slice(4), el as HTMLElement]));
  };
  // A lifted finger's dot fades over 140 ms.
  const lifts = new Map<number, number>();
  const tip = (id: number, down: boolean, ms: number) => {
    const l = down ? 0 : Math.min(1, (lifts.get(id) ?? 1) + ms / 140);
    lifts.set(id, l);
    return l;
  };
  function overlays(ms: number) {
    if (!els) {
      if (!document.body) return;
      build();
    }
    const e = els!;
    e.fade.style.opacity = String(rec.fade);
    // Countdown: from Play to the end of the run, then held at 0:00.
    if (cfg.countdown > 0 && rec.playT >= 0 && game()?.state === 'playing') {
      const left = Math.max(0, Math.ceil(cfg.countdown - rec.playT / 1000 - 1e-9));
      e.clock.hidden = false;
      e.clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else e.clock.hidden = true;
    if (cfg.touch) {
      // Touch dots: the hand's fingers when the recorder says where they are, else the touches the page saw.
      const touches = hand ? hand.map((f) => ({ x: f.x, y: f.y, down: f.down, lift: tip(f.id, f.down, ms) })) : [...pointers.values()].filter((p) => p.type === 'touch').slice(-3);
      for (let k = 0; k < 3; k++) {
        const el = e[`touch-${k + 1}`];
        const p = touches[k];
        if (!p) {
          el.style.opacity = '0';
          continue;
        }
        if (!hand) p.lift = p.down ? 0 : Math.min(1, p.lift + ms / 140);
        el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${1 - 0.15 * p.lift})`;
        el.style.opacity = String(1 - p.lift);
      }
      for (const [id, p] of pointers) if (p.type === 'touch' && !p.down && p.lift >= 1 && pointers.size > 3) pointers.delete(id);
    } else {
      const mx = hand?.[0]?.x ?? seen.mx;
      const my = hand?.[0]?.y ?? seen.my;
      const at = `translate(${mx}px, ${my}px)`;
      e.cursor.style.transform = at;
      e.cursor.style.opacity = mx >= 0 ? '1' : '0';
      if (ripple >= 0) ripple += ms / 320;
      e.ripple.style.opacity = ripple >= 0 && ripple < 1 ? String(0.8 * (1 - ripple)) : '0';
      e.ripple.style.transform = `${at} scale(${0.4 + 0.9 * Math.max(0, ripple)})`;
    }
  }
  return rec;
}

window.__recInstall = install;
