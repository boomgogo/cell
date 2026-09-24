// Globe minimap: the camera's hemisphere seen from outside, oriented with the camera's own screen axes so
// right on the globe is right on screen. Region borders, districts in their region colours, live power pellets,
// home, trail, and you.
import type { MazeWorld } from '../maze/walls.ts';
import type { Camera } from '../render/camera.ts';
import { glowColor, neon, stock } from '../render/canvas/palette.ts';
import type { Vec3 } from '../sphere/vec3.ts';
import { vec3 } from '../sphere/vec3.ts';

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  large = false;
  private readonly tmp = vec3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(): void {
    const css = this.canvas.clientWidth || 96;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (css === this.size && dpr === this.dpr) return;
    this.size = css;
    this.dpr = dpr;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
  }

  draw(
    maze: MazeWorld,
    cam: Camera,
    home: Vec3 | null,
    homeHue: number,
    trail: Float64Array,
    trailCount: number,
    player: Vec3 | null,
    power: Float64Array,
    powerCount: number,
  ): void {
    this.fit();
    const ctx = this.ctx;
    const S = this.size;
    const r = S / 2 - 3;
    const cx = S / 2;
    const cy = S / 2;
    const { c, e, s } = cam.frame;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = stock.paper;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const proj = (p: Vec3) => {
      const px = cx + (p.x * e.x + p.y * e.y + p.z * e.z) * r;
      const py = cy + (p.x * s.x + p.y * s.y + p.z * s.z) * r;
      return [px, py, p.x * c.x + p.y * c.y + p.z * c.z] as const;
    };
    const layout = maze.layout;
    // Region borders.
    ctx.lineWidth = 1;
    ctx.strokeStyle = stock.dots;
    ctx.beginPath();
    const p = this.tmp;
    for (const b of layout.borders) {
      const omega = Math.acos(Math.min(1, b.p0.x * b.p1.x + b.p0.y * b.p1.y + b.p0.z * b.p1.z));
      let started = false;
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
        const s1 = Math.sin(t * omega) / Math.sin(omega);
        p.x = b.p0.x * s0 + b.p1.x * s1;
        p.y = b.p0.y * s0 + b.p1.y * s1;
        p.z = b.p0.z * s0 + b.p1.z * s1;
        const [x, y, z] = proj(p);
        if (z < 0) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
    }
    ctx.stroke();
    // Districts.
    if (maze.enabled) {
      const G = layout.gridTiles;
      const lo = 8;
      const hi = G - 8;
      for (let i = 0; i < 12; i++) {
        const reg = layout.regions[i];
        if (reg.centre.x * c.x + reg.centre.y * c.y + reg.centre.z * c.z < 0.05) continue;
        ctx.beginPath();
        for (const [gx, gy] of [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]) {
          const [x, y] = proj(maze.gridPoint(i, gx, gy, p));
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = neon(reg.hue);
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // Live power pellets: small rainbow dots.
    for (let k = 0; k < powerCount; k++) {
      p.x = power[k * 3];
      p.y = power[k * 3 + 1];
      p.z = power[k * 3 + 2];
      const [x, y, z] = proj(p);
      if (z < 0.05) continue;
      ctx.fillStyle = glowColor(k * 47);
      ctx.beginPath();
      ctx.arc(x, y, S > 150 ? 2.2 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Trail.
    if (trailCount > 1) {
      ctx.strokeStyle = stock.key;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < trailCount; k += 2) {
        p.x = trail[k * 3];
        p.y = trail[k * 3 + 1];
        p.z = trail[k * 3 + 2];
        const [x, y, z] = proj(p);
        if (z < 0) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Home: on the far side it sits on the rim.
    if (home) {
      let [x, y, z] = proj(home);
      ctx.fillStyle = neon(homeHue);
      if (z < 0) {
        const l = Math.hypot(x - cx, y - cy) || 1;
        x = cx + ((x - cx) / l) * r;
        y = cy + ((y - cy) / l) * r;
        ctx.strokeStyle = neon(homeHue);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (player) {
      const [x, y] = proj(player);
      ctx.fillStyle = stock.key;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = stock.key;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
