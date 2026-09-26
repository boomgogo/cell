// Cached static layer: floor grid, region borders, junction emblems and wall tubes are drawn into an
// offscreen canvas 1.5× the screen and blitted with the camera's offset, rotation and zoom change. It is redrawn only
// when the camera has moved or turned too far, zoom changed > 2 %, or the style changed. The floor grid runs straight
// through the mazes: districts get no floor fill of their own. Riso print: walls and emblems
// are a key pass with the region's ink printed a hair out of register over it; the cache makes that free per frame.
import type { GameConfig } from '../../config/types.ts';
import type { District } from '../../maze/district.ts';
import type { World } from '../../sim/world.ts';
import { type Vec3, copy, dot, transport, vec3 } from '../../sphere/vec3.ts';
import { Camera } from '../camera.ts';
import { type BackgroundPattern, drawBackground } from './background.ts';
import { DOOR_COLOR, DOOR_LIGHT, inkFor, stock } from './palette.ts';
import { textSprite } from './text.ts';

const OVERSIZE = 1.5;

export interface LayerStyle {
  pattern: BackgroundPattern;
  /** Hue of the region under the camera. */
  hue: number;
  /** Paper stock (false: dark press stock). */
  light: boolean;
  /** Zoom that sets the grid's strength: the camera zoom without the maze zoom-out, so the grid looks the same inside
   * and outside districts. */
  gridZoom: number;
}

export class StaticLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cam: Camera;
  private readonly cfg: GameConfig;
  private valid = false;
  private readonly c0 = vec3(0, 0, 1);
  private readonly e0 = vec3(1, 0, 0);
  private z0 = 1;
  private dpr0 = 1;
  private key = '';
  private W = 0;
  private H = 0;
  private readonly pt = { x: 0, y: 0 };
  private readonly tmp = vec3();
  private readonly loops = new WeakMap<District, Float64Array[]>();
  /** Diagnostics. */
  redraws = 0;
  lastDrawMs = 0;
  lastCount = 0;
  /** Why the last redraw happened: invalid, style, size, zoom, move or turn. */
  lastReason = '';
  private light = false;

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.cam = new Camera(cfg);
  }

  invalidate(): void {
    this.valid = false;
  }

  /** Blits the layer for the main camera, redrawing it first when needed. Returns true if it was redrawn. */
  draw(main: CanvasRenderingContext2D, world: World, cam: Camera, dpr: number, style: LayerStyle): boolean {
    const W = Math.ceil(cam.width * OVERSIZE);
    const H = Math.ceil(cam.height * OVERSIZE);
    const key = `${style.pattern}|${style.light}`;
    let reason = !this.valid ? 'invalid' : key !== this.key ? 'style' : dpr !== this.dpr0 || W !== this.W || H !== this.H ? 'size' : '';
    const pt = this.pt;
    let angle = 0;
    let scale = 1;
    if (!reason) {
      scale = cam.zoom / this.z0;
      if (scale < 0.98 || scale > 1.02 || !cam.toScreen(this.c0, pt)) reason = 'zoom';
      else {
        const mx = ((OVERSIZE - 1) / 2) * cam.width * 0.8;
        const my = ((OVERSIZE - 1) / 2) * cam.height * 0.8;
        if (Math.abs(pt.x - cam.width / 2) > mx || Math.abs(pt.y - cam.height / 2) > my) reason = 'move';
        else {
          const e = copy(this.tmp, this.e0);
          transport(e, this.c0, cam.center);
          angle = Math.atan2(dot(e, cam.frame.s), dot(e, cam.frame.e));
          if (Math.abs(angle) > 0.06) reason = 'turn';
        }
      }
    }
    const redraw = reason !== '';
    if (redraw) {
      this.lastReason = reason;
      this.render(world, cam, dpr, style, W, H);
      this.key = key;
      pt.x = cam.width / 2;
      pt.y = cam.height / 2;
      angle = 0;
      scale = 1;
    }
    main.save();
    main.setTransform(dpr, 0, 0, dpr, 0, 0);
    main.translate(pt.x, pt.y);
    if (angle !== 0) main.rotate(angle);
    if (scale !== 1) main.scale(scale, scale);
    main.drawImage(this.canvas, -W / 2, -H / 2, W, H);
    main.restore();
    return redraw;
  }

  private render(world: World, cam: Camera, dpr: number, style: LayerStyle, W: number, H: number): void {
    const t0 = performance.now();
    this.redraws++;
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.W = W;
    this.H = H;
    this.dpr0 = dpr;
    this.z0 = cam.zoom;
    copy(this.c0, cam.frame.c);
    copy(this.e0, cam.frame.e);
    const lc = this.cam;
    copy(lc.frame.c, cam.frame.c);
    copy(lc.frame.e, cam.frame.e);
    copy(lc.frame.s, cam.frame.s);
    lc.zoom = cam.zoom;
    lc.resize(W, H);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    let count = drawBackground(ctx, lc, style.pattern, this.cfg.gridSpacing, !style.light, stock.dots, style.gridZoom, true);
    this.light = style.light;

    const maze = world.maze;
    if (maze.enabled) {
      const view = lc.viewRadius();
      const R = world.R;
      const layout = maze.layout;
      const reach = (layout.gridTiles / 2) * this.cfg.fineTile * Math.SQRT2;
      this.drawBorders(world, view);
      for (let i = 0; i < maze.count; i++) {
        if (R * Math.acos(Math.min(1, dot(layout.regions[i].centre, lc.center))) > view + reach) continue;
        count += this.drawDistrict(maze.district(i));
      }
    }
    this.lastCount = count;
    this.valid = true;
    this.lastDrawMs = performance.now() - t0;
  }

  /** Region borders (two-colour dashes) and junction emblems (three wedges + region numbers). */
  private drawBorders(world: World, view: number): void {
    const ctx = this.ctx;
    const lc = this.cam;
    const R = world.R;
    const layout = world.maze.layout;
    const zoom = lc.zoom;
    const cosView = Math.cos(Math.min(Math.PI, (view * 1.2) / R));
    const pt = this.pt;
    const p = this.tmp;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(1.5, 16 * zoom);
    ctx.globalAlpha = 0.75;
    const border = inkFor;
    const dash = Math.max(6, 120 * zoom);
    for (const b of layout.borders) {
      const omega = Math.acos(Math.min(1, dot(b.p0, b.p1)));
      const n = 32;
      ctx.beginPath();
      let started = false;
      let any = false;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
        const s1 = Math.sin(t * omega) / Math.sin(omega);
        p.x = b.p0.x * s0 + b.p1.x * s1;
        p.y = b.p0.y * s0 + b.p1.y * s1;
        p.z = b.p0.z * s0 + b.p1.z * s1;
        if (dot(p, lc.center) < cosView) {
          started = false;
          continue;
        }
        lc.toScreen(p, pt);
        any = true;
        if (started) ctx.lineTo(pt.x, pt.y);
        else ctx.moveTo(pt.x, pt.y);
        started = true;
      }
      if (!any) continue;
      ctx.setLineDash([dash, dash]);
      ctx.strokeStyle = border(layout.regions[b.a].hue);
      ctx.lineDashOffset = 0;
      ctx.stroke();
      ctx.strokeStyle = border(layout.regions[b.b].hue);
      ctx.lineDashOffset = dash;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const rEmblem = 420 * zoom;
    const off = misregister(zoom);
    for (const j of layout.junctions) {
      if (dot(j.p, lc.center) < cosView || !lc.toScreen(j.p, pt)) continue;
      if (rEmblem < 3) continue;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo(pt.x + off, pt.y + off);
        const a0 = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
        ctx.arc(pt.x + off, pt.y + off, rEmblem, a0, a0 + (2 * Math.PI) / 3);
        ctx.closePath();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = inkFor(layout.regions[j.regions[k]].hue);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1, 6 * zoom);
      ctx.strokeStyle = stock.key;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rEmblem, 0, Math.PI * 2);
      ctx.stroke();
      const label = j.regions.map((r) => r + 1).join(' · ');
      const s = textSprite(label, Math.max(10, 90 * zoom), this.dpr0);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(s, pt.x - s.width / this.dpr0 / 2, pt.y - s.height / this.dpr0 / 2, s.width / this.dpr0, s.height / this.dpr0);
    }
    ctx.restore();
  }

  /** Wall tubes and pen doors of one district (the floor grid shows through). Returns wall points drawn. */
  private drawDistrict(d: District): number {
    const ctx = this.ctx;
    const lc = this.cam;
    const cfg = this.cfg;
    const zoom = lc.zoom;
    const pt = this.pt;
    const hue = d.region.hue;
    const p = this.tmp;

    // Wall tubes: a key tube, then the region's ink inside it, printed out of register.
    const loops = this.loopPoints(d);
    let points = 0;
    ctx.beginPath();
    const w = lc.width;
    const h = lc.height;
    const pad = cfg.wallRadius * 2 * zoom + 4;
    for (const loop of loops) {
      const n = loop.length / 3;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < n; k++) {
        lc.toScreenXYZ(loop[k * 3], loop[k * 3 + 1], loop[k * 3 + 2], pt);
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      if (maxX >= -pad && maxY >= -pad && minX <= w + pad && minY <= h + pad) points += n;
    }
    const tube = cfg.wallRadius * 2 * zoom;
    const line = Math.max(1, 3.5 * zoom);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = stock.key;
    ctx.lineWidth = Math.max(1.5, tube);
    ctx.stroke();
    if (tube - 2 * line > 1) {
      const off = misregister(zoom);
      ctx.save();
      ctx.translate(off, off);
      ctx.strokeStyle = inkFor(hue);
      ctx.lineWidth = tube - 2 * line;
      ctx.stroke();
      ctx.restore();
    }
    // Pen doors.
    const doors = d.doors();
    ctx.beginPath();
    for (let k = 0; k < doors.length; k += 4) {
      d.point(doors[k], doors[k + 1], p);
      lc.toScreen(p, pt);
      ctx.moveTo(pt.x, pt.y);
      d.point(doors[k + 2], doors[k + 3], p);
      lc.toScreen(p, pt);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = this.light ? DOOR_LIGHT : DOOR_COLOR;
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(1.5, cfg.wallRadius * zoom);
    ctx.stroke();
    return points;
  }

  /** Wall outline points of a district as unit vectors (cached). */
  private loopPoints(d: District): Float64Array[] {
    let loops = this.loops.get(d);
    if (loops) return loops;
    const p: Vec3 = vec3();
    loops = d.contours(this.cfg.wallRadius / this.cfg.fineTile).map((loop) => {
      const out = new Float64Array((loop.length / 2) * 3);
      for (let k = 0; k < loop.length / 2; k++) {
        d.point(loop[k * 2], loop[k * 2 + 1], p);
        out[k * 3] = p.x;
        out[k * 3 + 1] = p.y;
        out[k * 3 + 2] = p.z;
      }
      return out;
    });
    this.loops.set(d, loops);
    return loops;
  }
}

/** Offset of the ink pass from the key pass: 2 px at zoom 1. */
const misregister = (zoom: number): number => Math.min(2, Math.max(0.5, 2 * zoom));
