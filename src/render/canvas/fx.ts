// Render-only effects: explosion pops, shockwaves and sparks, and the rainbow sparkle trail. Fixed pools, no
// per-frame allocation. Each effect is anchored to a world point (unit vector) and offset in screen-aligned world units,
// so it stays put while the camera moves (the camera's slow district alignment turn is negligible over < 1 s).
import type { Vec3 } from '../../sphere/vec3.ts';
import type { Camera } from '../camera.ts';
import { glowColor, stock } from './palette.ts';

const MAX_PARTICLES = 512;
const MAX_RINGS = 16;
const MAX_POPS = 8;
const BUCKETS = 12;
const POP_MS = 180;
const RING_MS = 450;

/** Particle kinds: a streak along its velocity (explosion spark) or a four-point star (rainbow trail). */
const STREAK = 0;
const STAR = 1;

export class Fx {
  // Particles: anchor (x, y, z), offset and velocity in world units (ox, oy, vx, vy), birth time and life, hue, kind, size.
  private readonly pa = new Float64Array(MAX_PARTICLES * 3);
  private readonly pv = new Float32Array(MAX_PARTICLES * 4);
  private readonly pt = new Float64Array(MAX_PARTICLES * 2);
  private readonly ph = new Uint16Array(MAX_PARTICLES);
  private readonly pk = new Uint8Array(MAX_PARTICLES);
  private readonly ps = new Float32Array(MAX_PARTICLES);
  private pn = 0;
  // Shockwave rings: anchor, start radius, end radius, width (world units), birth time, hue.
  private readonly ra = new Float64Array(MAX_RINGS * 3);
  private readonly rv = new Float64Array(MAX_RINGS * 5);
  private rn = 0;
  // Pops: anchor, radius, hue, birth time.
  private readonly oa = new Float64Array(MAX_POPS * 3);
  private readonly ov = new Float64Array(MAX_POPS * 3);
  private on = 0;
  private readonly pt2 = { x: 0, y: 0 };
  private readonly rand = Math.random;

  get particles(): number {
    return this.pn;
  }

  /** Pop, shockwave and a burst of sparks for a cell of radius r exploding at p. `sparks` scales the spark count. */
  explosion(p: Vec3, r: number, hue: number, now: number, sparks: number): void {
    if (this.on < MAX_POPS) {
      const k = this.on++;
      this.oa[k * 3] = p.x;
      this.oa[k * 3 + 1] = p.y;
      this.oa[k * 3 + 2] = p.z;
      this.ov[k * 3] = r;
      this.ov[k * 3 + 1] = hue;
      this.ov[k * 3 + 2] = now;
    }
    if (this.rn < MAX_RINGS) {
      const k = this.rn++;
      this.ra[k * 3] = p.x;
      this.ra[k * 3 + 1] = p.y;
      this.ra[k * 3 + 2] = p.z;
      this.rv[k * 5] = r;
      this.rv[k * 5 + 1] = r * 2.6;
      this.rv[k * 5 + 2] = Math.max(12, r * 0.12);
      this.rv[k * 5 + 3] = now;
      this.rv[k * 5 + 4] = hue;
    }
    const n = Math.round(Math.min(48, 24 + r / 20) * sparks);
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2;
      const speed = r * (1.5 + 2 * this.rand()) + 120;
      const h = i % 2 === 0 ? hue : (hue + 60 * i) % 360;
      this.particle(p, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, Math.cos(a) * speed, Math.sin(a) * speed, now, 500 + 300 * this.rand(), h, STREAK, 0);
    }
  }

  /** A small, quick ring for a rainbow touch that knocked a cell back instead of exploding it. */
  bounce(p: Vec3, r: number, hue: number, now: number): void {
    if (this.rn >= MAX_RINGS) return;
    const k = this.rn++;
    this.ra[k * 3] = p.x;
    this.ra[k * 3 + 1] = p.y;
    this.ra[k * 3 + 2] = p.z;
    this.rv[k * 5] = r;
    this.rv[k * 5 + 1] = r * 1.5;
    this.rv[k * 5 + 2] = Math.max(6, r * 0.06);
    this.rv[k * 5 + 3] = now;
    this.rv[k * 5 + 4] = hue;
  }

  /** A packed cell swelling back to its full size: a soft ring leaving its membrane. */
  swell(p: Vec3, r: number, hue: number, now: number): void {
    if (this.rn >= MAX_RINGS) return;
    const k = this.rn++;
    this.ra[k * 3] = p.x;
    this.ra[k * 3 + 1] = p.y;
    this.ra[k * 3 + 2] = p.z;
    this.rv[k * 5] = r;
    this.rv[k * 5 + 1] = r * 1.8;
    this.rv[k * 5 + 2] = Math.max(8, r * 0.1);
    this.rv[k * 5 + 3] = now;
    this.rv[k * 5 + 4] = hue;
  }

  /** A small star at offset (ox, oy) world units from p, drifting slowly (rainbow trail). */
  sparkle(p: Vec3, ox: number, oy: number, size: number, hue: number, now: number): void {
    const a = this.rand() * Math.PI * 2;
    const drift = 15 + 25 * this.rand();
    this.particle(p, ox, oy, Math.cos(a) * drift, Math.sin(a) * drift, now, 500, hue, STAR, size);
  }

  private particle(p: Vec3, ox: number, oy: number, vx: number, vy: number, now: number, life: number, hue: number, kind: number, size: number): void {
    if (this.pn >= MAX_PARTICLES) return;
    const k = this.pn++;
    this.pa[k * 3] = p.x;
    this.pa[k * 3 + 1] = p.y;
    this.pa[k * 3 + 2] = p.z;
    this.pv[k * 4] = ox;
    this.pv[k * 4 + 1] = oy;
    this.pv[k * 4 + 2] = vx;
    this.pv[k * 4 + 3] = vy;
    this.pt[k * 2] = now;
    this.pt[k * 2 + 1] = life;
    this.ph[k] = hue;
    this.pk[k] = kind;
    this.ps[k] = size;
  }

  /** Pops (drawn over the cells), then rings and particles. dtMs advances the particles. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number, dtMs: number): void {
    if (this.on + this.rn + this.pn === 0) return;
    const zoom = cam.zoom;
    const pt = this.pt2;
    ctx.save();

    let w = 0;
    for (let k = 0; k < this.on; k++) {
      const t = (now - this.ov[k * 3 + 2]) / POP_MS;
      if (t >= 1) continue;
      this.copyPop(k, w++);
      if (t < 0 || !cam.toScreenXYZ(this.oa[k * 3], this.oa[k * 3 + 1], this.oa[k * 3 + 2], pt)) continue;
      ctx.globalAlpha = 0.9 * (1 - t);
      ctx.fillStyle = t < 0.4 ? stock.paper : glowColor(this.ov[k * 3 + 1]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(2, this.ov[k * 3] * zoom * (1 + 0.25 * t)), 0, Math.PI * 2);
      ctx.fill();
    }
    this.on = w;

    w = 0;
    for (let k = 0; k < this.rn; k++) {
      const t = (now - this.rv[k * 5 + 3]) / RING_MS;
      if (t >= 1) continue;
      this.copyRing(k, w++);
      if (t < 0 || !cam.toScreenXYZ(this.ra[k * 3], this.ra[k * 3 + 1], this.ra[k * 3 + 2], pt)) continue;
      const r0 = this.rv[k * 5];
      const r1 = this.rv[k * 5 + 1];
      const e = 1 - (1 - t) * (1 - t);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = glowColor(this.rv[k * 5 + 4] + t * 300);
      ctx.lineWidth = Math.max(1, this.rv[k * 5 + 2] * zoom * (1 - 0.9 * t));
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, (r0 + (r1 - r0) * e) * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rn = w;

    // Particles: advance, drop the dead, then stroke them in hue buckets (one path per bucket).
    const dt = Math.min(dtMs, 50) / 1000;
    const drag = Math.pow(0.9, dt * 60);
    w = 0;
    for (let k = 0; k < this.pn; k++) {
      if (now - this.pt[k * 2] >= this.pt[k * 2 + 1]) continue;
      this.pv[k * 4 + 2] *= drag;
      this.pv[k * 4 + 3] *= drag;
      this.pv[k * 4] += this.pv[k * 4 + 2] * dt;
      this.pv[k * 4 + 1] += this.pv[k * 4 + 3] * dt;
      this.copyParticle(k, w++);
    }
    this.pn = w;
    ctx.globalAlpha = 0.9;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, 5 * zoom);
    for (let b = 0; b < BUCKETS; b++) {
      let any = false;
      ctx.beginPath();
      for (let k = 0; k < this.pn; k++) {
        if (Math.round(this.ph[k] / (360 / BUCKETS)) % BUCKETS !== b) continue;
        if (!cam.toScreenXYZ(this.pa[k * 3], this.pa[k * 3 + 1], this.pa[k * 3 + 2], pt)) continue;
        const life = 1 - (now - this.pt[k * 2]) / this.pt[k * 2 + 1];
        const x = pt.x + this.pv[k * 4] * zoom;
        const y = pt.y + this.pv[k * 4 + 1] * zoom;
        if (this.pk[k] === STREAK) {
          const len = 0.05 * life * zoom;
          ctx.moveTo(x, y);
          ctx.lineTo(x - this.pv[k * 4 + 2] * len, y - this.pv[k * 4 + 3] * len);
        } else {
          const s = Math.max(1.5, this.ps[k] * zoom * life);
          ctx.moveTo(x - s, y);
          ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s);
          ctx.lineTo(x, y + s);
        }
        any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = glowColor(b * (360 / BUCKETS));
      ctx.stroke();
    }
    ctx.restore();
  }

  private copyPop(from: number, to: number): void {
    if (from === to) return;
    for (let i = 0; i < 3; i++) {
      this.oa[to * 3 + i] = this.oa[from * 3 + i];
      this.ov[to * 3 + i] = this.ov[from * 3 + i];
    }
  }

  private copyRing(from: number, to: number): void {
    if (from === to) return;
    for (let i = 0; i < 3; i++) this.ra[to * 3 + i] = this.ra[from * 3 + i];
    for (let i = 0; i < 5; i++) this.rv[to * 5 + i] = this.rv[from * 5 + i];
  }

  private copyParticle(from: number, to: number): void {
    if (from === to) return;
    for (let i = 0; i < 3; i++) this.pa[to * 3 + i] = this.pa[from * 3 + i];
    for (let i = 0; i < 4; i++) this.pv[to * 4 + i] = this.pv[from * 4 + i];
    this.pt[to * 2] = this.pt[from * 2];
    this.pt[to * 2 + 1] = this.pt[from * 2 + 1];
    this.ph[to] = this.ph[from];
    this.pk[to] = this.pk[from];
    this.ps[to] = this.ps[from];
  }
}
