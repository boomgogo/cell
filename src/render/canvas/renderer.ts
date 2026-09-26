// Canvas 2D renderer: background, pellets, eat ghosts, size-sorted cells with
// jelly membranes, cached text. Cells are drawn in screen space around their projected centres, so shapes never distort.
// With mazes it adds a cached static layer (grid, borders, walls), rainbow power pellet orbs, rainbow cells, explosion
// effects, membranes squashed by walls, score popups, and the home nest and trail. The look is a risograph print:
// flat ink fills, one key-coloured outline on everything, square pellets and a paper grain.
import { MASK_GHOST, MASK_REGULAR } from '../../maze/district.ts';
import { EJECTED, PLAYER, VIRUS, type Cell } from '../../sim/cell.ts';
import { FOOD_KIND, POWER } from '../../sim/food.ts';
import type { SimEvent } from '../../sim/events.ts';
import type { Organism } from '../../sim/organism.ts';
import { isRainbow, ticksPerSecond } from '../../sim/rules.ts';
import type { World } from '../../sim/world.ts';
import { type Vec3, nlerp, vec3 } from '../../sphere/vec3.ts';
import type { Camera } from '../camera.ts';
import { type BackgroundPattern, drawBackground } from './background.ts';
import type { Flags } from './flags.ts';
import { Fx } from './fx.ts';
import { Membrane, type MembraneBody, stepMembrane } from './membrane.ts';
import { INKS, RAINBOW_FILL, VIRUS_FILL, fillColor, floorColor, glowColor, stock } from './palette.ts';
import { PELLET_BUCKETS, drawPellet, hueBucket, pelletSide } from './sprites.ts';
import { StaticLayer } from './staticLayer.ts';
import { textFrame, textSprite } from './text.ts';

export interface RenderOptions {
  pattern: BackgroundPattern;
  membranes: boolean;
  contactDents: boolean;
  dark: boolean;
  showMass: boolean;
  /** Membrane points per screen px of radius (1, low quality 0.4). */
  pointScale: number;
  pointBudget: number;
  dprCap: number;
  /** Eat-animation extras. */
  ghostShrink: boolean;
  sizeSpring: boolean;
  wallDents: boolean;
  trail: boolean;
  /** Effects detail: 0 everything, 1 half the sparks and no sparkle trail, 2 minimal. */
  fx: number;
  /** Paper grain over the frame: one pattern fill, the first thing quality drops. */
  grain: boolean;
}

export const defaultRenderOptions = (): RenderOptions => ({
  pattern: 'dots',
  membranes: true,
  contactDents: true,
  dark: false,
  showMass: true,
  pointScale: 1,
  pointBudget: 4000,
  dprCap: 2,
  ghostShrink: false,
  sizeSpring: true,
  wallDents: true,
  trail: true,
  fx: 0,
  grain: true,
});

class CellView implements MembraneBody {
  readonly id: number;
  kind: number;
  hue = 0;
  readonly p: Vec3 = vec3();
  sx = 0;
  sy = 0;
  lx = 0;
  ly = 0;
  /** Displayed radius (spring) and its velocity. */
  dr = 0;
  vr = 0;
  /** Sim radius (membrane sizing). */
  simR = 0;
  /** Total mass (the mass text) and the packed share of it (a darker ring with a band inside). */
  mass = 0;
  packShare = 0;
  seen = 0;
  roll = 0;
  agitated = false;
  spiky = false;
  detailed = false;
  readonly membrane = new Membrane();
  readonly contacts: CellView[] = [];
  readonly walls = new Float32Array(12);
  wallCount = 0;
  name = '';
  /** Owner's country code for the flag ('' for none). */
  country = '';
  own = false;
  /** Resident ghost (passes pen doors, so its membrane squashes against a different wall set). */
  resident = false;
  /** 0 normal, 1 rainbow colours, 2 rainbow but showing its own colours (the end-of-rainbow flicker). */
  rainbow = 0;
  /** Screen motion direction (smoothed) and the last sparkle time, for the rainbow trail. */
  mx = 0;
  my = 0;
  lastSparkle = 0;

  constructor(id: number, kind: number) {
    this.id = id;
    this.kind = kind;
  }

  /** The membrane's true radius: the displayed radius (which springs toward the sim radius). */
  get r(): number {
    return this.dr;
  }
}

interface Ghost {
  start: Vec3;
  end: Vec3;
  r: number;
  hue: number;
  kind: number;
  eaterId: number;
  t0: number;
}

interface Popup {
  p: Vec3;
  t0: number;
  text: string;
}

const POPUP_MS = 900;
/** Drawn radius of a power pellet orb in world units (the sim radius is the food radius). */
const ORB_R = 40;
const ORB_MIN_PX = 9;
const PING_MS = 1200;
const SHAKE_MS = 250;

const GHOST_MS = 120;
const MAX_GHOSTS = 600;
const MEMBRANE_STEP_MS = 1000 / 60;

export interface RenderStats {
  cells: number;
  food: number;
  background: number;
  ghosts: number;
  points: number;
  /** Per-stage CPU time of the last frame (ms). */
  bgMs: number;
  foodMs: number;
  cellsMs: number;
  drawMs: number;
  layerRedraws: number;
  /** Backing store resizes (each one wipes the canvas). */
  resizes: number;
}

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly opts: RenderOptions;
  dpr = 1;
  readonly stats: RenderStats = { cells: 0, food: 0, background: 0, ghosts: 0, points: 0, bgMs: 0, foodMs: 0, cellsMs: 0, drawMs: 0, layerRedraws: 0, resizes: 0 };
  /** Home nest and trail breadcrumbs as unit vectors (x, y, z triples). */
  home: Vec3 | null = null;
  homeHue = 0;
  trail: Float64Array = new Float64Array(0);
  trailCount = 0;
  /** Flag atlas (lazy; null until loaded or with ?flags=0). */
  flags: Flags | null = null;

  private readonly views = new Map<number, CellView>();
  private readonly visible: CellView[] = [];
  private readonly ghosts: Ghost[] = [];
  private readonly popups: Popup[] = [];
  layer: StaticLayer | null = null;
  private frameNo = 0;
  private membraneAcc = 0;
  private readonly pt = { x: 0, y: 0 };
  private readonly tmp = vec3();
  private readonly axisR = vec3();
  private readonly axisD = vec3();
  private readonly tinyX: Float32Array[] = [];
  private readonly tinyY: Float32Array[] = [];
  private readonly tinyN = new Int32Array(PELLET_BUCKETS);
  private readonly specials: number[] = [];
  private readonly rand = Math.random;
  readonly fx = new Fx();
  private shakeUntil = 0;
  private shakeAmp = 0;
  private shaking = false;
  private readonly reducedMotion: boolean;
  private readonly hasConic: boolean;
  /** Paper grain tile and packed-band halftone for the current stock. */
  private grainFor = '';
  private grain: CanvasPattern | null = null;
  private halftone: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement, opts: RenderOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.opts = opts;
    this.hasConic = typeof this.ctx.createConicGradient === 'function';
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let b = 0; b < PELLET_BUCKETS; b++) {
      this.tinyX.push(new Float32Array(512));
      this.tinyY.push(new Float32Array(512));
    }
  }

  /**
   * Sizes the backing store for the CSS size and the capped DPR. Setting canvas.width wipes the canvas (opaque black,
   * as it has no alpha), so it only happens when the pixel size really changes, and callers do it before a render,
   * never between a render and the frame being shown.
   */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.dprCap);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    const cw = `${cssW}px`;
    const ch = `${cssH}px`;
    if (dpr === this.dpr && w === this.canvas.width && h === this.canvas.height && this.canvas.style.width === cw && this.canvas.style.height === ch) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = cw;
    this.canvas.style.height = ch;
    this.stats.resizes++;
    this.layer?.invalidate();
  }

  /** Turn this tick's eat events into ghosts and explosions into effects. Call after every world.step(). */
  onEvents(world: World, events: SimEvent[], now: number): void {
    for (const e of events) {
      if (e.type === 'explode') {
        this.tmp.x = e.x;
        this.tmp.y = e.y;
        this.tmp.z = e.z;
        this.fx.explosion(this.tmp, e.r, e.hue, now, this.opts.fx === 0 ? 1 : this.opts.fx === 1 ? 0.5 : 0.25);
        continue;
      }
      if (e.type === 'bounce' || e.type === 'unpack') {
        this.tmp.x = e.x;
        this.tmp.y = e.y;
        this.tmp.z = e.z;
        if (e.type === 'bounce') this.fx.bounce(this.tmp, e.r, e.hue, now);
        else if (this.opts.fx < 2) this.fx.swell(this.tmp, e.r, e.hue, now);
        continue;
      }
      if (e.type !== 'eat') continue;
      if (this.ghosts.length >= MAX_GHOSTS) break;
      let start: Vec3;
      let r = e.r;
      if (e.eatenKind === FOOD_KIND) start = vec3(e.x, e.y, e.z);
      else {
        const v = this.views.get(e.eatenId);
        // Only cells that were drawn at least once get a ghost.
        if (!v || this.frameNo - v.seen > 2) continue;
        start = vec3(v.p.x, v.p.y, v.p.z);
        r = v.dr;
      }
      const eater = world.cellsById.get(e.eaterId);
      const end = eater ? vec3(eater.p.x, eater.p.y, eater.p.z) : vec3(e.x, e.y, e.z);
      this.ghosts.push({ start, end, r, hue: e.hue, kind: e.eatenKind, eaterId: e.eaterId, t0: now });
    }
  }

  /** Screen shake of `px` CSS px for SHAKE_MS; off under prefers-reduced-motion. */
  shake(px: number, now: number): void {
    if (this.reducedMotion) return;
    this.shakeAmp = Math.max(this.shakeAmp * (now < this.shakeUntil ? 1 : 0), px);
    this.shakeUntil = now + SHAKE_MS;
  }

  private applyShake(now: number): void {
    const left = this.shakeUntil - now;
    if (left > 0) {
      const a = this.shakeAmp * (left / SHAKE_MS);
      this.canvas.style.transform = `translate(${((this.rand() - 0.5) * 2 * a).toFixed(1)}px, ${((this.rand() - 0.5) * 2 * a).toFixed(1)}px)`;
      this.shaking = true;
    } else if (this.shaking) {
      this.canvas.style.transform = '';
      this.shaking = false;
      this.shakeAmp = 0;
    }
  }

  /** Floating text at a world point (score popups). */
  popup(p: Vec3, text: string, now: number): void {
    if (this.popups.length > 80) return;
    this.popups.push({ p: vec3(p.x, p.y, p.z), t0: now, text });
  }

  render(world: World, cam: Camera, alpha: number, now: number, dtMs: number, player: Organism | null): void {
    const ctx = this.ctx;
    const o = this.opts;
    const w = cam.width;
    const h = cam.height;
    this.frameNo++;
    textFrame();

    const stats = this.stats;
    const t0 = performance.now();
    this.applyShake(now);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (world.maze.enabled) {
      // One floor path inside and outside mazes: the stock with the region's ink screened over it.
      ctx.fillStyle = this.floorAt(world, cam.center);
      ctx.fillRect(0, 0, w, h);
      if (!this.layer) this.layer = new StaticLayer(world.cfg);
      const hue = world.maze.layout.regions[world.maze.layout.regionAt(cam.center)].hue;
      const style = { pattern: o.pattern, hue, light: !o.dark, gridZoom: cam.gridZoom };
      if (this.layer.draw(ctx, world, cam, this.dpr, style)) stats.layerRedraws++;
      stats.background = this.layer.lastCount;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawHome(world, cam, now);
    } else {
      ctx.fillStyle = stock.paper;
      ctx.fillRect(0, 0, w, h);
      stats.background = drawBackground(ctx, cam, o.pattern, world.cfg.gridSpacing, o.dark, stock.dots, cam.zoom, true);
    }
    const t1 = performance.now();
    this.drawFood(world, cam, now);
    const t2 = performance.now();
    this.collectCells(world, cam, alpha, dtMs, player, now);
    this.updateMembranes(world, cam, dtMs);
    const t3 = performance.now();
    this.drawGhosts(world, cam, now);
    this.drawCells(cam, now);
    this.fx.draw(ctx, cam, now, dtMs);
    this.drawText(cam);
    if (this.popups.length) this.drawPopups(cam, now);
    if (o.grain) this.drawGrain();
    const t4 = performance.now();
    stats.bgMs = t1 - t0;
    stats.foodMs = t2 - t1;
    stats.cellsMs = t3 - t2;
    stats.drawMs = t4 - t3;
  }

  // ---------------------------------------------------------------- print texture

  /** Builds the grain tile and the halftone for the current stock (once per theme). */
  private ensureTexture(): void {
    if (this.grainFor === stock.key) return;
    this.grainFor = stock.key;
    const g = document.createElement('canvas');
    g.width = g.height = 128;
    const gc = g.getContext('2d')!;
    const img = gc.createImageData(128, 128);
    const [r, gg, b] = [1, 3, 5].map((k) => parseInt(stock.key.slice(k, k + 2), 16));
    for (let k = 0; k < img.data.length; k += 4) {
      const v = this.rand();
      img.data[k] = r;
      img.data[k + 1] = gg;
      img.data[k + 2] = b;
      // Mostly clear with sparse specks: paper tooth rather than an even haze.
      img.data[k + 3] = v < 0.55 ? 0 : Math.round((v - 0.55) * 566);
    }
    gc.putImageData(img, 0, 0);
    this.grain = this.ctx.createPattern(g, 'repeat');
    const t = document.createElement('canvas');
    t.width = t.height = 5;
    const tc = t.getContext('2d')!;
    tc.fillStyle = stock.key;
    tc.beginPath();
    tc.arc(2.5, 2.5, 1.3, 0, Math.PI * 2);
    tc.fill();
    this.halftone = this.ctx.createPattern(t, 'repeat');
  }

  /** Paper grain in device pixels over the whole frame. */
  private drawGrain(): void {
    this.ensureTexture();
    if (!this.grain) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = this.grain;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  // ---------------------------------------------------------------- arcade backdrop

  /** Floor colour at the camera: the region's, blended toward the neighbour's within 1 500 units of a border. */
  private floorAt(world: World, c: Vec3): string {
    const regions = world.maze.layout.regions;
    let a = 0;
    let b = 1;
    let da = -2;
    let db = -2;
    for (let i = 0; i < regions.length; i++) {
      const d = c.x * regions[i].centre.x + c.y * regions[i].centre.y + c.z * regions[i].centre.z;
      if (d > da) {
        b = a;
        db = da;
        a = i;
        da = d;
      } else if (d > db) {
        b = i;
        db = d;
      }
    }
    const toBorder = (world.R * (Math.acos(Math.min(1, db)) - Math.acos(Math.min(1, da)))) / 2;
    const wgt = 0.5 * Math.max(0, 1 - toBorder / 1500);
    return floorColor(regions[a].hue, regions[b].hue, Math.round(wgt * 20) / 20);
  }

  private drawHome(world: World, cam: Camera, now: number): void {
    const ctx = this.ctx;
    const pt = this.pt;
    const zoom = cam.zoom;
    if (this.opts.trail && this.trailCount > 1) {
      const t = this.trail;
      ctx.strokeStyle = fillColor(this.homeHue);
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(1, 4 * zoom);
      const size = Math.max(2, 9 * zoom);
      const view = cam.viewRadius() + 200;
      const cosView = Math.cos(Math.min(Math.PI, view / world.R));
      const c = cam.center;
      for (let k = 0; k < this.trailCount; k++) {
        const x = t[k * 3];
        const y = t[k * 3 + 1];
        const z = t[k * 3 + 2];
        if (x * c.x + y * c.y + z * c.z < cosView) continue;
        cam.toScreenXYZ(x, y, z, pt);
        // Slime trail: small hollow rings, unlike the solid food pellets.
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const home = this.home;
    if (!home || !cam.toScreen(home, pt)) return;
    const r = 160 * zoom;
    if (pt.x < -r || pt.y < -r || pt.x > cam.width + r || pt.y > cam.height + r) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.lineWidth = Math.max(1.5, 10 * zoom);
    ctx.strokeStyle = fillColor(this.homeHue);
    ctx.globalAlpha = 0.5 + 0.3 * pulse;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.moveTo(pt.x + r * 0.6, pt.y);
    ctx.arc(pt.x, pt.y, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    // Flag.
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineTo(pt.x, pt.y - r * 1.1);
    ctx.stroke();
    ctx.fillStyle = fillColor(this.homeHue);
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y - r * 1.1);
    ctx.lineTo(pt.x + r * 0.5, pt.y - r * 0.9);
    ctx.lineTo(pt.x, pt.y - r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- food

  private drawFood(world: World, cam: Camera, now: number): void {
    const ctx = this.ctx;
    const food = world.food;
    const w = cam.width;
    const h = cam.height;
    const hw = w / 2;
    const hh = h / 2;
    const zoom = cam.zoom;
    const sr = (food.radius + 5) * zoom;
    const tinyN = this.tinyN;
    tinyN.fill(0);
    const { c, e, s } = cam.frame;
    const Rz = cam.R * zoom;
    const fx = food.x;
    const fy = food.y;
    const fz = food.z;
    const hue = food.hue;
    const alive = food.alive;
    const kind = food.kind;
    const specials = this.specials;
    specials.length = 0;
    const margin = Math.max(sr, 60 * zoom);
    let count = 0;
    // Hot loop: the azimuthal equidistant projection inlined, with θ/sinθ = asin(s)/s expanded as a series
    // (visible pellets are < ~0.5 rad from the centre, where the error is far below a pixel).
    food.query(c, cam.viewRadius() + 60, (i) => {
      if (!alive[i]) return;
      const px = fx[i];
      const py = fy[i];
      const pz = fz[i];
      if (px * c.x + py * c.y + pz * c.z <= 0) return;
      const tx = px * e.x + py * e.y + pz * e.z;
      const ty = px * s.x + py * s.y + pz * s.z;
      const s2 = tx * tx + ty * ty;
      const k = Rz * (1 + s2 * (0.16666666666666666 + s2 * (0.075 + s2 * 0.044642857142857144)));
      const X = hw + tx * k;
      const Y = hh + ty * k;
      if (X < -margin || Y < -margin || X > w + margin || Y > h + margin) return;
      count++;
      // Power pellets are drawn after the pellets; maze food is an ordinary pellet.
      if (kind[i] !== 0) {
        specials.push(i, X, Y);
        return;
      }
      {
        const b = hueBucket(hue[i]);
        const n = tinyN[b];
        if (n >= this.tinyX[b].length) {
          const nx = new Float32Array(n * 2);
          nx.set(this.tinyX[b]);
          this.tinyX[b] = nx;
          const ny = new Float32Array(n * 2);
          ny.set(this.tinyY[b]);
          this.tinyY[b] = ny;
        }
        this.tinyX[b][n] = X;
        this.tinyY[b][n] = Y;
        tinyN[b] = n + 1;
      }
    });
    {
      // Flat ink squares, one fillStyle per ink.
      const size = pelletSide(sr);
      for (let b = 0; b < PELLET_BUCKETS; b++) {
        const n = tinyN[b];
        if (n === 0) continue;
        ctx.fillStyle = INKS[b];
        const xs = this.tinyX[b];
        const ys = this.tinyY[b];
        for (let k = 0; k < n; k++) ctx.fillRect(xs[k] - size / 2, ys[k] - size / 2, size, size);
      }
    }
    for (let k = 0; k < specials.length; k += 3) {
      const i = specials[k];
      if (kind[i] === POWER) this.drawOrb(specials[k + 1], specials[k + 2], zoom, now);
      else drawPellet(ctx, hue[i], specials[k + 1], specials[k + 2], sr);
    }
    this.stats.food = count;
  }

  /**
   * Power pellet: a rainbow orb (the same wheel as a rainbow cell, so it shows what it gives) with a dark
   * outline and highlight that read on any floor, a 2 Hz pulse, a sonar ping every 1.2 s, and a minimum screen size.
   */
  private drawOrb(x: number, y: number, zoom: number, now: number): void {
    const ctx = this.ctx;
    const r = Math.max(ORB_MIN_PX, ORB_R * zoom) * (1 + 0.125 * Math.sin((now / 1000) * Math.PI * 4));
    const cycle = (now / 5) % 360;
    if (this.opts.fx < 2) {
      const t = (now % PING_MS) / PING_MS;
      ctx.globalAlpha = 0.45 * (1 - t);
      ctx.strokeStyle = glowColor(cycle);
      ctx.lineWidth = Math.max(1.5, 5 * zoom);
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + 2 * t), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = this.rainbowStyle(x, y, (now / 1000) * Math.PI, RAINBOW_FILL, cycle);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, 4 * zoom);
    ctx.strokeStyle = stock.key;
    ctx.stroke();
    ctx.fillStyle = stock.paper;
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  /** A spinning rainbow wheel around (x, y), or a hue-cycling colour where conic gradients are missing or fx is minimal. */
  private rainbowStyle(x: number, y: number, rot: number, stops: string[], cycle: number): CanvasGradient | string {
    if (!this.hasConic || this.opts.fx >= 2) return fillColor(cycle);
    const g = this.ctx.createConicGradient(rot, x, y);
    const n = stops.length;
    for (let k = 0; k < n; k++) g.addColorStop(k / n, stops[k]);
    g.addColorStop(1, stops[0]);
    return g;
  }

  // ---------------------------------------------------------------- cells

  private collectCells(world: World, cam: Camera, alpha: number, dtMs: number, player: Organism | null, now: number): void {
    const visible = this.visible;
    visible.length = 0;
    const pt = this.pt;
    const w = cam.width;
    const h = cam.height;
    const zoom = cam.zoom;
    const frameNo = this.frameNo;
    const dt = Math.min(dtMs, 50) / 1000;
    const nowRoll = performance.now() / 10000;
    const tick = world.tick;
    const flashTicks = 2 * ticksPerSecond(world.cfg);
    world.queryCells(cam.center, cam.viewRadius() + 1600, (c: Cell) => {
      let v = this.views.get(c.id);
      const fresh = !v;
      if (!v) {
        v = new CellView(c.id, c.kind);
        this.views.set(c.id, v);
      }
      nlerp(v.p, c.prev, c.p, alpha);
      if (!cam.toScreen(v.p, pt)) return;
      const r = c.r;
      const reach = (r + 10) * zoom;
      if (pt.x < -reach || pt.y < -reach || pt.x > w + reach || pt.y > h + reach) return;
      v.sx = pt.x;
      v.sy = pt.y;
      v.lx = (pt.x - w / 2) / zoom;
      v.ly = (pt.y - h / 2) / zoom;
      v.kind = c.kind;
      v.hue = c.hue;
      v.simR = r;
      v.mass = c.totalMass;
      v.packShare = c.packed > 0 ? c.packed / v.mass : 0;
      if (fresh || !this.opts.sizeSpring || frameNo - v.seen > 5) {
        v.dr = r;
        v.vr = 0;
      } else {
        // Slightly under-damped spring toward the sim radius.
        const k = 900;
        const damping = 2 * 0.55 * Math.sqrt(k);
        v.vr += ((r - v.dr) * k - v.vr * damping) * dt;
        v.dr += v.vr * dt;
        if (v.dr < 1) v.dr = 1;
      }
      v.seen = frameNo;
      v.spiky = c.kind === VIRUS;
      v.agitated = false;
      v.roll = v.spiky ? 0 : (c.id / 1000 + nowRoll) % (Math.PI * 2);
      const owner = c.owner;
      v.own = player !== null && owner === player;
      v.name = owner ? owner.name : '';
      v.country = owner ? owner.country : '';
      v.resident = owner?.resident != null;
      v.rainbow = 0;
      if (owner && isRainbow(owner, tick)) {
        // Rainbow; in the last 2 s it switches to the cell's own colours at 2.5 Hz.
        const left = owner.rainbowUntil - tick;
        v.rainbow = left < flashTicks && Math.floor(now / 200) % 2 === 1 ? 2 : 1;
        v.agitated = true;
        if (this.opts.fx === 0 && r * zoom > 6 && now - v.lastSparkle > 60) this.sparkleTrail(v, c, cam, now);
      }
      visible.push(v);
    });
    visible.sort((a, b) => a.dr - b.dr || a.id - b.id);
    this.stats.cells = visible.length;

    if (frameNo % 60 === 0) {
      for (const [id, v] of this.views) if (frameNo - v.seen > 120) this.views.delete(id);
    }
  }

  /** One or two stars leaving the back edge of a rainbow cell. */
  private sparkleTrail(v: CellView, c: Cell, cam: Camera, now: number): void {
    v.lastSparkle = now;
    const { e, s } = cam.frame;
    const dx = (c.p.x - c.prev.x) * e.x + (c.p.y - c.prev.y) * e.y + (c.p.z - c.prev.z) * e.z;
    const dy = (c.p.x - c.prev.x) * s.x + (c.p.y - c.prev.y) * s.y + (c.p.z - c.prev.z) * s.z;
    v.mx = v.mx * 0.7 + dx * 0.3;
    v.my = v.my * 0.7 + dy * 0.3;
    const l = Math.hypot(v.mx, v.my);
    const back = l > 1e-9 ? Math.atan2(-v.my, -v.mx) : this.rand() * Math.PI * 2;
    const n = this.rand() < 0.5 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const a = back + (this.rand() - 0.5) * 1.6;
      const r = c.r * 0.95;
      this.fx.sparkle(v.p, Math.cos(a) * r, Math.sin(a) * r, Math.max(6, c.r * 0.15), (now / 5 + k * 120) % 360, now);
    }
  }

  private updateMembranes(world: World, cam: Camera, dtMs: number): void {
    const o = this.opts;
    const zoom = cam.zoom;
    const visible = this.visible;
    let budgetUse = 0;
    for (const v of visible) {
      const screenR = v.dr * zoom;
      v.detailed = o.membranes && screenR > 20 && zoom >= 0.4 && v.kind !== EJECTED;
      if (v.kind === VIRUS) v.detailed = o.membranes && screenR > 12;
      if (v.detailed) budgetUse += v.spiky ? 0 : Math.max(10, screenR * o.pointScale);
    }
    const budgetScale = budgetUse > o.pointBudget ? o.pointBudget / budgetUse : 1;
    let points = 0;
    const detailed: CellView[] = [];
    const maze = world.maze;
    const dents = o.wallDents && maze.enabled;
    for (const v of visible) {
      v.wallCount = 0;
      if (!v.detailed) {
        v.membrane.simple = true;
        continue;
      }
      const screenR = v.dr * zoom;
      const n = v.spiky
        ? 2 * Math.max(12, Math.min(Math.round(v.simR * 0.55), Math.round(screenR * 0.5)))
        : Math.max(10, Math.round(screenR * o.pointScale * budgetScale));
      v.membrane.ensure(n, v.dr);
      if (v.membrane.simple) v.membrane.reset(v.dr);
      v.membrane.simple = false;
      v.contacts.length = 0;
      points += n;
      detailed.push(v);
      if (dents && v.kind === PLAYER) this.wallConstraints(world, cam, v);
    }
    this.stats.points = points;

    if (o.contactDents) {
      for (let i = 0; i < detailed.length; i++) {
        const a = detailed[i];
        for (let j = i + 1; j < detailed.length; j++) {
          const b = detailed[j];
          const reach = a.dr + b.dr + 10;
          if (Math.abs(a.lx - b.lx) > reach || Math.abs(a.ly - b.ly) > reach) continue;
          if (Math.hypot(a.lx - b.lx, a.ly - b.ly) > reach) continue;
          a.contacts.push(b);
          b.contacts.push(a);
        }
      }
    }

    this.membraneAcc = Math.min(this.membraneAcc + dtMs, MEMBRANE_STEP_MS * 3);
    while (this.membraneAcc >= MEMBRANE_STEP_MS) {
      this.membraneAcc -= MEMBRANE_STEP_MS;
      for (const v of detailed) stepMembrane(v, this.rand);
    }
  }

  /** Nearest wall on each grid axis as camera-local half-planes. */
  private wallConstraints(world: World, cam: Camera, v: CellView): void {
    const maze = world.maze;
    const d = maze.districtAt(v.p, v.dr * 2);
    if (!d || d.collide(v.p, v.dr * 1.3, v.resident ? MASK_GHOST : MASK_REGULAR, null) < 0) return;
    const right = this.axisR;
    const down = this.axisD;
    d.axes(v.p, right, down);
    const e = cam.frame.e;
    const s = cam.frame.s;
    const rx = right.x * e.x + right.y * e.y + right.z * e.z;
    const ry = right.x * s.x + right.y * s.y + right.z * s.z;
    const dx = down.x * e.x + down.y * e.y + down.z * e.z;
    const dy = down.x * s.x + down.y * s.y + down.z * s.z;
    const walls = v.walls;
    let n = 0;
    const add = (nx: number, ny: number, dist: number) => {
      if (dist >= v.dr * 1.3) return;
      walls[n * 3] = nx;
      walls[n * 3 + 1] = ny;
      walls[n * 3 + 2] = dist;
      n++;
    };
    add(-rx, -ry, d.dL);
    add(rx, ry, d.dR);
    add(-dx, -dy, d.dT);
    add(dx, dy, d.dB);
    v.wallCount = n;
  }

  private drawGhosts(world: World, cam: Camera, now: number): void {
    const ctx = this.ctx;
    const ghosts = this.ghosts;
    const pt = this.pt;
    const p = this.tmp;
    const zoom = cam.zoom;
    let w = 0;
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      const t = (now - g.t0) / GHOST_MS;
      if (t >= 1) continue;
      ghosts[w++] = g;
      const eater = this.views.get(g.eaterId);
      if (eater && this.frameNo - eater.seen <= 1) {
        g.end.x = eater.p.x;
        g.end.y = eater.p.y;
        g.end.z = eater.p.z;
      } else {
        const c = world.cellsById.get(g.eaterId);
        if (c) {
          g.end.x = c.p.x;
          g.end.y = c.p.y;
          g.end.z = c.p.z;
        }
      }
      const tt = Math.max(0, t);
      nlerp(p, g.start, g.end, tt);
      if (!cam.toScreen(p, pt)) continue;
      const r = (this.opts.ghostShrink ? g.r * (1 - 0.7 * tt) : g.r) * zoom;
      ctx.globalAlpha = 1 - tt;
      if (g.kind === FOOD_KIND) {
        drawPellet(ctx, g.hue, pt.x, pt.y, r + 5 * zoom);
      } else {
        this.circle(pt.x, pt.y, r, g.kind === VIRUS ? VIRUS_FILL : fillColor(g.hue));
      }
    }
    ghosts.length = w;
    ctx.globalAlpha = 1;
    this.stats.ghosts = w;
  }

  /** Flat ink disc with the key outline; `band` (screen px) is the packed-mass halftone inside the rim. */
  private circle(x: number, y: number, r: number, fill: string, band = 0): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 0.5), 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (band >= 0.75 && this.halftone && r > band) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r - band / 2, 0, Math.PI * 2);
      ctx.lineWidth = band;
      ctx.strokeStyle = this.halftone;
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x, y, Math.max(r, 0.5), 0, Math.PI * 2);
    }
    const lw = keyline(r);
    if (lw > 0) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = stock.key;
      ctx.stroke();
    }
  }

  private drawCells(cam: Camera, now: number): void {
    const ctx = this.ctx;
    const zoom = cam.zoom;
    ctx.lineJoin = 'round';
    this.ensureTexture();
    for (const v of this.visible) {
      const fill = v.kind === VIRUS ? VIRUS_FILL : fillColor(v.hue);
      // Packed mass: a halftone band grows inside the rim (never outside: the cell really is
      // this small), up to 30 % of the radius as the packed share reaches half the cell.
      const band = v.packShare > 0 ? 0.3 * v.dr * Math.min(1, v.packShare * 2) * zoom : 0;
      const rainbow = v.rainbow === 1;
      const screenR = v.dr * zoom;
      if (!v.detailed) {
        if (rainbow) {
          ctx.beginPath();
          ctx.arc(v.sx, v.sy, Math.max(screenR, 0.5), 0, Math.PI * 2);
          this.paintRainbow(v, zoom, now);
        } else this.circle(v.sx, v.sy, screenR, fill, band);
        if (v.spiky) this.notches(v.sx, v.sy, screenR);
        continue;
      }
      const m = v.membrane;
      const n = m.n;
      const rad = m.rad;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + v.roll;
        const rr = rad[i];
        const x = v.sx + Math.cos(a) * rr * zoom;
        const y = v.sy + Math.sin(a) * rr * zoom;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      if (rainbow) {
        this.paintRainbow(v, zoom, now);
        continue;
      }
      ctx.fillStyle = fill;
      ctx.fill();
      if (band >= 0.75 && this.halftone) {
        // Inside the membrane's own clip only the inner half of this stroke shows: the band.
        ctx.save();
        ctx.clip();
        ctx.lineWidth = 2 * band;
        ctx.strokeStyle = this.halftone;
        ctx.stroke();
        ctx.restore();
      }
      ctx.lineWidth = keyline(screenR);
      ctx.strokeStyle = stock.key;
      ctx.stroke();
      if (v.spiky) this.notches(v.sx, v.sy, screenR);
    }
  }

  /** Virus mark: a ring of key-coloured notches inside the rim. */
  private notches(x: number, y: number, r: number): void {
    if (r < 6) return;
    const ctx = this.ctx;
    const n = 14;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * 2 * k) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(x + c * r * 0.62, y + s * r * 0.62);
      ctx.lineTo(x + c * r * 0.84, y + s * r * 0.84);
    }
    ctx.lineWidth = Math.max(1, Math.min(4, r * 0.08));
    ctx.lineCap = 'round';
    ctx.strokeStyle = stock.key;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /**
   * Fills the current path as a rainbow cell: a pale ink halo outside the membrane, a spinning wheel of
   * inks, and the key outline.
   */
  private paintRainbow(v: CellView, zoom: number, now: number): void {
    const ctx = this.ctx;
    const cycle = (now / 5 + v.id * 37) % 360;
    const rot = (now / 1000) * Math.PI + v.id;
    if (this.opts.fx < 2) {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = glowColor(cycle);
      ctx.lineWidth = Math.max(4, 36 * zoom);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = this.rainbowStyle(v.sx, v.sy, rot, RAINBOW_FILL, cycle);
    ctx.fill();
    const lw = keyline(v.dr * zoom);
    if (lw > 0) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = stock.key;
      ctx.stroke();
    }
  }

  private drawText(cam: Camera): void {
    const ctx = this.ctx;
    const zoom = cam.zoom;
    const dpr = this.dpr;
    for (const v of this.visible) {
      if (v.kind !== PLAYER) continue;
      const screenR = v.dr * zoom;
      if (screenR < 14) continue;
      let y = v.sy;
      const namePx = Math.max(v.dr * 0.3, 24) * zoom;
      // The flag sits left of the name, about its cap height; flag and name are centred together.
      const flags = this.flags;
      const flagH = flags && v.country && namePx >= 7 ? Math.min(28, namePx * 0.75) : 0;
      const flagW = (flagH * 4) / 3;
      if (v.name && namePx >= 7) {
        const s = textSprite(v.name, namePx, dpr);
        const sw = s.width / dpr;
        const sh = s.height / dpr;
        // The sprite's own padding (~0.15 × size) is the gap between flag and name.
        const shift = flagH > 0 ? flagW / 2 - namePx * 0.05 : 0;
        ctx.drawImage(s, v.sx - sw / 2 + shift, y - sh / 2, sw, sh);
        if (flagH > 0) flags!.draw(ctx, v.country, v.sx - sw / 2 + shift - flagW + namePx * 0.1, y - flagH / 2, flagH, this.opts.fx >= 2);
        y += sh / 2 + 2;
      } else if (flagH > 0) {
        flags!.draw(ctx, v.country, v.sx - flagW / 2, y - flagH / 2, flagH, this.opts.fx >= 2);
        y += flagH / 2 + 4;
      }
      if (v.own && this.opts.showMass) {
        const massPx = namePx * 0.5;
        if (massPx >= 6) {
          const s = textSprite(String(Math.floor(v.mass)), massPx, dpr);
          const sw = s.width / dpr;
          const sh = s.height / dpr;
          ctx.drawImage(s, v.sx - sw / 2, y - sh / 4, sw, sh);
        }
      }
    }
  }

  // ---------------------------------------------------------------- popups

  private drawPopups(cam: Camera, now: number): void {
    const ctx = this.ctx;
    const pt = this.pt;
    const dpr = this.dpr;
    const popups = this.popups;
    let w = 0;
    for (let i = 0; i < popups.length; i++) {
      const fx = popups[i];
      const t = (now - fx.t0) / POPUP_MS;
      if (t >= 1) continue;
      popups[w++] = fx;
      if (!cam.toScreen(fx.p, pt)) continue;
      const s = textSprite(fx.text, 22, dpr);
      const sw = s.width / dpr;
      const sh = s.height / dpr;
      ctx.globalAlpha = 1 - t * t;
      ctx.drawImage(s, pt.x - sw / 2, pt.y - sh / 2 - t * 50, sw, sh);
      ctx.globalAlpha = 1;
    }
    popups.length = w;
  }
}

/** Printed outline weight in CSS px: constant like a keyline, but never heavier than the small cell it outlines. */
function keyline(screenR: number): number {
  return screenR < 2 ? 0 : Math.min(3, Math.max(0.75, screenR * 0.3));
}
