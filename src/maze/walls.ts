// All maze districts of a world: lazy generation, district lookup, and the wall queries the sim uses —
// push-out, line of sight, free-spot search.
import type { GameConfig } from '../config/types.ts';
import { type Vec3, copy, moveAlong, normalize, vec3 } from '../sphere/vec3.ts';
import { CLEARANCE_CAP, District, MASK_REGULAR, type WallMask } from './district.ts';
import { generateMaze } from './generate.ts';
import { MARGIN_TILES, RegionLayout } from './layout.ts';

export class MazeWorld {
  readonly layout: RegionLayout;
  readonly R: number;
  readonly enabled: boolean;
  private readonly cfg: GameConfig;
  private readonly districts: (District | null)[] = new Array<District | null>(12).fill(null);
  /** Called once per district right after it is generated (the arcade layer adds its food and power pellets). */
  onBuilt: ((d: District) => void) | null = null;
  /** NPC path floods and ghost A* runs left this tick. */
  floodBudget = 0;
  ghostBudget = 0;
  private readonly push = vec3();
  private readonly exit = { gx: 0, gy: 0 };

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
    this.R = cfg.sphereRadius;
    this.layout = new RegionLayout(cfg);
    this.enabled = cfg.mazes && this.layout.pillars > 0;
  }

  get count(): number {
    return this.enabled ? 12 : 0;
  }

  isBuilt(i: number): boolean {
    return this.districts[i] !== null;
  }

  /** The district of region i, generating it on first use. */
  district(i: number): District {
    let d = this.districts[i];
    if (!d) {
      const maze = generateMaze(this.layout.pillars, this.cfg.mapSeed * 131 + i * 7);
      d = new District(i, this.layout.regions[i], this.R, this.cfg.fineTile, maze);
      this.districts[i] = d;
      this.onBuilt?.(d);
    }
    return d;
  }

  /** Generates the next missing district (for idle-time pre-generation). Returns false when all exist. */
  buildNext(near?: Vec3): boolean {
    if (!this.enabled) return false;
    let best = -1;
    let bestDot = -Infinity;
    for (let i = 0; i < 12; i++) {
      if (this.districts[i]) continue;
      const c = this.layout.regions[i].centre;
      const d = near ? near.x * c.x + near.y * c.y + near.z * c.z : -i;
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    if (best < 0) return false;
    this.district(best);
    return true;
  }

  /** Chart grid coordinates of p in region i's district frame, without generating the district. */
  private gridOf(i: number, p: Vec3, out: { gx: number; gy: number }): boolean {
    const reg = this.layout.regions[i];
    const pc = p.x * reg.centre.x + p.y * reg.centre.y + p.z * reg.centre.z;
    if (pc < 0.2) return false;
    const pe = p.x * reg.e.x + p.y * reg.e.y + p.z * reg.e.z;
    const ps = p.x * reg.s.x + p.y * reg.s.y + p.z * reg.s.z;
    const k = this.R / this.cfg.fineTile;
    const G = this.layout.gridTiles;
    out.gx = k * Math.atan(pe / pc) + G / 2;
    out.gy = k * Math.atan(ps / pc) + G / 2;
    return true;
  }

  private readonly g = { gx: 0, gy: 0 };

  /** Grid coordinates of region i's district → unit vector, without generating the district. */
  gridPoint(i: number, gx: number, gy: number, out: Vec3): Vec3 {
    const reg = this.layout.regions[i];
    const G = this.layout.gridTiles;
    const F = this.cfg.fineTile;
    const X = Math.tan(((gx - G / 2) * F) / this.R);
    const Y = Math.tan(((gy - G / 2) * F) / this.R);
    out.x = reg.centre.x + X * reg.e.x + Y * reg.s.x;
    out.y = reg.centre.y + X * reg.e.y + Y * reg.s.y;
    out.z = reg.centre.z + X * reg.e.z + Y * reg.s.z;
    normalize(out);
    return out;
  }

  /** Region index whose district grid (margin included, widened by `extra` world units) contains p, or −1. */
  regionWithGridAt(p: Vec3, extra = 0): number {
    if (!this.enabled) return -1;
    const i = this.layout.regionAt(p);
    if (!this.gridOf(i, p, this.g)) return -1;
    const G = this.layout.gridTiles;
    const m = extra / this.cfg.fineTile;
    const { gx, gy } = this.g;
    return gx >= -m && gy >= -m && gx <= G + m && gy <= G + m ? i : -1;
  }

  /** The district whose grid contains p (generated on demand), or null in the open plains. */
  districtAt(p: Vec3, extra = 0): District | null {
    const i = this.regionWithGridAt(p, extra);
    return i < 0 ? null : this.district(i);
  }

  /** Inside a maze interior (perimeter included)? Pure geometry: never generates. */
  inInterior(p: Vec3, extra = 0): boolean {
    if (!this.enabled) return false;
    const i = this.layout.regionAt(p);
    if (!this.gridOf(i, p, this.g)) return false;
    const G = this.layout.gridTiles;
    const lo = MARGIN_TILES - extra / this.cfg.fineTile;
    const hi = G - lo;
    return this.g.gx >= lo && this.g.gy >= lo && this.g.gx <= hi && this.g.gy <= hi;
  }

  /**
   * Widest way out from p: the escape radius of the maze tile under p, Infinity outside maze interiors,
   * and 0 when p is inside a wall (unknown for this instant; the wall rescue moves it).
   */
  roomAt(p: Vec3): number {
    if (!this.inInterior(p)) return Infinity;
    const d = this.districtAt(p);
    if (!d || !d.locate(p)) return Infinity;
    return d.escapeAt(d.gx, d.gy);
  }

  /** Nearest wall distance at the position left by the last `resolve` (Infinity when no wall is within reach). */
  lastMin = Infinity;

  /**
   * Moves a circle out of the walls (summed push-out passes; a centre inside a wall is first moved across the nearest
   * tile edge). Returns the squeeze factor (1 = free) and sets `lastMin`. `pushOut` receives the total push.
   */
  resolve(p: Vec3, r: number, mask: WallMask, pushOut?: Vec3): number {
    if (pushOut) pushOut.x = pushOut.y = pushOut.z = 0;
    this.lastMin = Infinity;
    const d = this.districtAt(p, r + this.cfg.fineTile);
    if (!d) return 1;
    const push = this.push;
    for (let pass = 0; pass < 3; pass++) {
      push.x = push.y = push.z = 0;
      const f = d.collide(p, r, mask, push);
      if (f < 0) {
        if (!d.exitFromWall(mask, this.exit)) return 1;
        const bx = p.x;
        const by = p.y;
        const bz = p.z;
        d.point(this.exit.gx, this.exit.gy, p);
        if (pushOut) {
          pushOut.x += p.x - bx;
          pushOut.y += p.y - by;
          pushOut.z += p.z - bz;
        }
        continue;
      }
      const len = Math.hypot(push.x, push.y, push.z);
      if (len < 1e-3) break;
      if (pushOut) {
        pushOut.x += push.x;
        pushOut.y += push.y;
        pushOut.z += push.z;
      }
      push.x /= len;
      push.y /= len;
      push.z /= len;
      moveAlong(p, push, len / this.R);
      normalize(p);
    }
    const squeeze = d.collide(p, r, mask, null);
    this.lastMin = squeeze < 0 ? 0 : d.minDist;
    return squeeze < 0 ? 1 : squeeze;
  }

  /** Nearest wall distance at p, measured up to `cap` (Infinity beyond; 0 inside a wall). */
  clearanceAt(p: Vec3, cap: number, mask: WallMask): number {
    const d = this.districtAt(p, cap + this.cfg.fineTile);
    if (!d) return Infinity;
    const f = d.collide(p, cap, mask, null);
    return f < 0 ? 0 : d.minDist;
  }

  /** Is the straight path between a and b blocked by a wall? */
  blocked(a: Vec3, b: Vec3, mask: WallMask = MASK_REGULAR): boolean {
    const d = this.districtAt(a, 0) ?? this.districtAt(b, 0);
    return d ? d.blocked(a, b, mask) : false;
  }

  /** Room for a circle of radius r at p? */
  isFree(p: Vec3, r: number, mask: WallMask = MASK_REGULAR): boolean {
    const d = this.districtAt(p, r + this.cfg.fineTile);
    if (!d) return true;
    const cl = d.clearance(p, Math.max(r, 1), mask);
    return cl >= r;
  }

  /**
   * Nearest spot with room for radius r (searching tiles outward from p, up to maxTiles). Writes it to `out` and
   * returns true; false when nothing fits nearby.
   */
  nearestFree(p: Vec3, r: number, out: Vec3, maxTiles = 40): boolean {
    const d = this.districtAt(p, r + this.cfg.fineTile);
    copy(out, p);
    if (!d || this.isFree(p, r)) return true;
    if (!d.locate(p)) return true;
    const G = d.G;
    const ci = Math.floor(d.gx);
    const cj = Math.floor(d.gy);
    const need = Math.min(r, CLEARANCE_CAP - 10);
    for (let ring = 0; ring <= maxTiles; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let j = cj - ring; j <= cj + ring; j++) {
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if (i < 0 || j < 0 || i >= G || j >= G) {
            // Outside the grid is open plains.
            if (r <= CLEARANCE_CAP) continue;
          } else if (d.tileClear[j * G + i] < need) continue;
          const dd = (i + 0.5 - d.gx) ** 2 + (j + 0.5 - d.gy) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = j * G + i;
          }
        }
      }
      if (best >= 0) {
        const i = best % G;
        const j = (best - i) / G;
        // Tile clearance may come from a corner; try the centre and corners, keep the first that fits.
        for (const [ox, oy] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) {
          d.point(i + ox, j + oy, out);
          if (this.isFree(out, r)) return true;
        }
      }
    }
    copy(out, p);
    return false;
  }
}
