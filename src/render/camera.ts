// Sphere camera: centre + carried-along screen directions, eased zoom.
import type { GameConfig } from '../config/types.ts';
import { viewScale } from '../sim/rules.ts';
import { Frame, type Vec2 } from '../sphere/frame.ts';
import { type Vec3, angle, copy, rotateToward, vec3 } from '../sphere/vec3.ts';

export class Camera {
  readonly cfg: GameConfig;
  readonly R: number;
  readonly frame = new Frame(vec3(0, 0, 1));
  /** CSS px per world unit. */
  zoom = 1;
  wheelZoom = 1;
  /** Debug override (spike slider); 0 = off. */
  zoomOverride = 0;
  width = 1;
  height = 1;
  /**
   * Maze districts: returns how far inside a district c is (0–1) and writes the district's screen-up
   * direction (a unit tangent at c). With `alignEnabled` the camera turns toward it at up to weight × maxTurn rad/s;
   * zoom is scaled toward `mazeZoom` by the same weight.
   */
  district: ((c: Vec3, up: Vec3, right: Vec3) => number) | null = null;
  alignEnabled = true;
  mazeZoom = 1;
  maxTurn = (120 * Math.PI) / 180;
  /** Current district weight (0 in the plains). */
  districtWeight = 0;
  private readonly up = vec3();
  private readonly right = vec3();
  private hasRight = false;
  private readonly tmp = vec3();
  private readonly local: Vec2 = { x: 0, y: 0 };

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
    this.R = cfg.sphereRadius;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  jumpTo(p: Vec3, sumRadius: number): void {
    this.frame.moveTo(p);
    if (this.district) {
      this.hasRight = true;
      this.districtWeight = this.district(this.frame.c, this.up, this.right);
      // Snap straight to the district's orientation.
      if (this.alignEnabled) for (let k = 0; k < 8 && this.districtWeight > 0; k++) this.turnToward(1000, 1);
    }
    this.zoom = this.targetZoom(sumRadius);
  }

  targetZoom(sumRadius: number): number {
    if (this.zoomOverride > 0) return this.zoomOverride;
    return Math.max(0.02, viewScale(this.cfg, sumRadius, this.width, this.height) * this.wheelZoom * this.mazeFactor());
  }

  /** Zoom factor of the maze zoom-out at the current district weight (1 in the plains). */
  private mazeFactor(): number {
    if (this.zoomOverride > 0) return 1;
    // Portrait screens see less maze across, so they zoom out a bit more.
    const mazeZoom = this.width < this.height ? this.mazeZoom * 0.75 : this.mazeZoom;
    return 1 - (1 - mazeZoom) * this.districtWeight;
  }

  /** The zoom without the maze zoom-out: sets the floor grid's strength so it matches inside and outside mazes. */
  get gridZoom(): number {
    return this.zoom / this.mazeFactor();
  }

  /** Eases view = (view + target)/2 and zoom = (9·zoom + target)/10 per 60 Hz frame, made frame-rate independent. */
  follow(target: Vec3, sumRadius: number, dtMs: number): void {
    const frames = dtMs / (1000 / 60);
    const kPos = 1 - Math.pow(0.5, frames);
    const kZoom = 1 - Math.pow(0.9, frames);
    const a = angle(this.frame.c, target);
    if (a > 0) {
      const next = copy(this.tmp, this.frame.c);
      rotateToward(next, target, a * kPos);
      this.frame.moveTo(next);
    }
    this.hasRight = true;
    this.districtWeight = this.district ? this.district(this.frame.c, this.up, this.right) : 0;
    this.zoom += (this.targetZoom(sumRadius) - this.zoom) * kZoom;
    if (this.alignEnabled && this.districtWeight > 0) this.turnToward(dtMs, this.districtWeight);
  }

  private turnToward(dtMs: number, w: number): void {
    const f = this.frame;
    // Wanted s = −up. s' = s·cosδ − e·sinδ, so sinδ = up·e and cosδ = −up·s.
    const up = this.up;
    const delta = Math.atan2(up.x * f.e.x + up.y * f.e.y + up.z * f.e.z, -(up.x * f.s.x + up.y * f.s.y + up.z * f.s.z));
    // Grid axes aren't exactly perpendicular away from the district centre: split the error between them.
    const rt = this.right;
    let rightDelta = Math.atan2(rt.x * f.s.x + rt.y * f.s.y + rt.z * f.s.z, rt.x * f.e.x + rt.y * f.e.y + rt.z * f.e.z);
    if (rightDelta - delta > Math.PI) rightDelta -= 2 * Math.PI;
    else if (delta - rightDelta > Math.PI) rightDelta += 2 * Math.PI;
    const target = this.hasRight ? (delta + rightDelta) / 2 : delta;
    const maxStep = w * this.maxTurn * (dtMs / 1000);
    // Ease: turn a fraction of the remaining angle, capped by the rate.
    const step = Math.max(-maxStep, Math.min(maxStep, target * Math.min(1, (dtMs / 1000) * 4)));
    if (Math.abs(step) < 1e-6) return;
    const c = Math.cos(step);
    const s = Math.sin(step);
    const ex = f.e.x * c + f.s.x * s;
    const ey = f.e.y * c + f.s.y * s;
    const ez = f.e.z * c + f.s.z * s;
    const sx = f.s.x * c - f.e.x * s;
    const sy = f.s.y * c - f.e.y * s;
    const sz = f.s.z * c - f.e.z * s;
    f.e.x = ex;
    f.e.y = ey;
    f.e.z = ez;
    f.s.x = sx;
    f.s.y = sy;
    f.s.z = sz;
    f.orthonormalize();
  }

  addWheel(deltaY: number): void {
    this.wheelZoom = Math.min(this.cfg.maxWheelZoom, Math.max(1, this.wheelZoom * Math.pow(0.9, deltaY / 100)));
  }

  /** Unit vector → screen CSS px. Returns false when behind the visible cap. */
  toScreen(p: Vec3, out: Vec2): boolean {
    const cos = this.frame.project(this.R, p, out);
    out.x = this.width / 2 + out.x * this.zoom;
    out.y = this.height / 2 + out.y * this.zoom;
    return cos > 0;
  }

  toScreenXYZ(x: number, y: number, z: number, out: Vec2): boolean {
    const cos = this.frame.projectXYZ(this.R, x, y, z, out);
    out.x = this.width / 2 + out.x * this.zoom;
    out.y = this.height / 2 + out.y * this.zoom;
    return cos > 0;
  }

  toWorld(sx: number, sy: number, out: Vec3): Vec3 {
    return this.frame.unproject(this.R, (sx - this.width / 2) / this.zoom, (sy - this.height / 2) / this.zoom, out);
  }

  /** Distance in world units from the centre to a screen corner. */
  viewRadius(): number {
    return Math.hypot(this.width, this.height) / 2 / this.zoom;
  }

  get center(): Vec3 {
    return this.frame.c;
  }

  /** Local helper so callers don't allocate. */
  get scratch(): Vec2 {
    return this.local;
  }
}
