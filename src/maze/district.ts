// One maze district on the sphere. The maze lives on an equiangular gnomonic chart:
// grid coordinate g ↔ chart x = (g − G/2)·F ↔ X = tan(x/R), point = normalize(c + X·e + Y·s). Grid lines are great
// circles, so walls are exact great-circle arcs and all distances below are exact sphere distances.
//
// Collision needs no stored geometry: from the tile the centre is in, walk left/right/up/down to the first solid tile
// (the nearest wall edge in that row/column), and add convex wall corners whose Voronoi quadrant holds the centre.
import type { Vec3 } from '../sphere/vec3.ts';
import { DOOR, type Maze, OPEN, SOLID } from './generate.ts';
import { MARGIN_TILES, type Region } from './layout.ts';

/** Masks: regular cells treat the pen and its door as walls; resident ghosts only real walls. */
export const MASK_REGULAR = 0;
export const MASK_GHOST = 1;
export type WallMask = typeof MASK_REGULAR | typeof MASK_GHOST;

/** Clearance is only measured up to this distance (anything wider counts as open plains). */
export const CLEARANCE_CAP = 600;

export class District {
  readonly index: number;
  readonly region: Region;
  readonly R: number;
  /** Fine tile size (world units) and grid size in tiles. */
  readonly F: number;
  readonly G: number;
  readonly maze: Maze;
  readonly tiles: Uint8Array;
  readonly c: Vec3;
  readonly e: Vec3;
  readonly s: Vec3;
  /** Width classes: max radius for fine corridors, coarse corridors, avenues. */
  readonly classRadius: number[];
  /** tan of each grid line's chart coordinate and 1/sqrt(1 + tan²). */
  private readonly lineT: Float64Array;
  private readonly lineInv: Float64Array;
  private readonly vertexQuad: Uint8Array[];
  /** Per-tile clearance (max over centre and corners), world units, capped. 0 inside walls. */
  readonly tileClear: Float32Array;
  /**
   * Per-tile escape radius: the biggest cell that can travel from the tile to the open plains, i.e. the
   * narrowest tile clearance on the widest path out. Infinity where the way out is open plains, 0 on solid tiles.
   */
  readonly escape: Float32Array;
  /** Connected components of tiles with enough clearance for each width class (0 = not passable). */
  readonly labels: Int32Array[];
  /** Scratch from the last `locate` call. */
  gx = 0;
  gy = 0;
  pc = 0;
  /** From the last `collide`: distances to the nearest wall on each axis (Infinity if none within reach). */
  dL = Infinity;
  dR = Infinity;
  dT = Infinity;
  dB = Infinity;
  /** From the last `collide`: nearest wall distance (Infinity if none within reach). */
  minDist = Infinity;
  private contourCache: Float32Array[] | null = null;
  private doorCache: Float32Array | null = null;

  constructor(index: number, region: Region, R: number, fineTile: number, maze: Maze) {
    this.index = index;
    this.region = region;
    this.R = R;
    this.F = fineTile;
    this.G = maze.size;
    this.maze = maze;
    this.tiles = maze.tiles;
    this.c = region.centre;
    this.e = region.e;
    this.s = region.s;
    this.classRadius = [fineTile / 2, fineTile * 2, fineTile * 4];
    const G = this.G;
    this.lineT = new Float64Array(G + 1);
    this.lineInv = new Float64Array(G + 1);
    for (let i = 0; i <= G; i++) {
      const t = Math.tan(((i - G / 2) * fineTile) / R);
      this.lineT[i] = t;
      this.lineInv[i] = 1 / Math.sqrt(1 + t * t);
    }
    this.vertexQuad = [this.buildVertices(MASK_REGULAR), this.buildVertices(MASK_GHOST)];
    this.tileClear = this.buildClearance();
    this.escape = this.buildEscape();
    this.labels = this.labelThresholds().map((t) => this.buildLabels(t));
  }

  // ---------------------------------------------------------------- coordinates

  /** Sets gx, gy, pc for unit vector p. Returns false when p is on the far side of the chart. */
  locate(p: Vec3): boolean {
    const pc = p.x * this.c.x + p.y * this.c.y + p.z * this.c.z;
    this.pc = pc;
    if (pc < 0.2) return false;
    const pe = p.x * this.e.x + p.y * this.e.y + p.z * this.e.z;
    const ps = p.x * this.s.x + p.y * this.s.y + p.z * this.s.z;
    const k = this.R / this.F;
    this.gx = k * Math.atan(pe / pc) + this.G / 2;
    this.gy = k * Math.atan(ps / pc) + this.G / 2;
    return true;
  }

  /** Grid coordinates → unit vector. */
  point(gx: number, gy: number, out: Vec3): Vec3 {
    const X = Math.tan(((gx - this.G / 2) * this.F) / this.R);
    const Y = Math.tan(((gy - this.G / 2) * this.F) / this.R);
    const x = this.c.x + X * this.e.x + Y * this.s.x;
    const y = this.c.y + X * this.e.y + Y * this.s.y;
    const z = this.c.z + X * this.e.z + Y * this.s.z;
    const l = Math.hypot(x, y, z);
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
    return out;
  }

  /** Unit tangents at p along +x (right) and +y (down) grid directions. */
  axes(p: Vec3, right: Vec3, down: Vec3): void {
    const de = p.x * this.e.x + p.y * this.e.y + p.z * this.e.z;
    right.x = this.e.x - de * p.x;
    right.y = this.e.y - de * p.y;
    right.z = this.e.z - de * p.z;
    let l = Math.hypot(right.x, right.y, right.z) || 1;
    right.x /= l;
    right.y /= l;
    right.z /= l;
    const ds = p.x * this.s.x + p.y * this.s.y + p.z * this.s.z;
    down.x = this.s.x - ds * p.x;
    down.y = this.s.y - ds * p.y;
    down.z = this.s.z - ds * p.z;
    l = Math.hypot(down.x, down.y, down.z) || 1;
    down.x /= l;
    down.y /= l;
    down.z /= l;
  }

  /** Is the grid point inside the maze interior (inside the perimeter's outer face)? */
  inInterior(gx: number, gy: number): boolean {
    const lo = MARGIN_TILES;
    const hi = this.G - MARGIN_TILES;
    return gx >= lo && gy >= lo && gx <= hi && gy <= hi;
  }

  tile(i: number, j: number): number {
    const G = this.G;
    return i < 0 || j < 0 || i >= G || j >= G ? OPEN : this.tiles[j * G + i];
  }

  solid(i: number, j: number, mask: WallMask): boolean {
    const G = this.G;
    if (i < 0 || j < 0 || i >= G || j >= G) return false;
    const t = this.tiles[j * G + i];
    return mask === MASK_REGULAR ? t !== OPEN : t === SOLID;
  }

  // ---------------------------------------------------------------- collision

  /**
   * Adds the wall push-out for a circle at p with radius r into `push` (a tangent vector in world units; pass null to
   * only measure). Returns the squeeze factor (1 = free, < 1 = narrower than the diameter) or −1 if the centre is
   * inside a wall. Also sets dL/dR/dT/dB and minDist.
   */
  collide(p: Vec3, r: number, mask: WallMask, push: Vec3 | null): number {
    this.dL = this.dR = this.dT = this.dB = this.minDist = Infinity;
    if (!this.locate(p)) return 1;
    const G = this.G;
    const range = Math.ceil((r * 1.1) / this.F) + 1;
    const gx = this.gx;
    const gy = this.gy;
    if (gx < -range || gy < -range || gx > G + range || gy > G + range) return 1;
    const ip = Math.floor(gx);
    const jp = Math.floor(gy);
    if (this.solid(ip, jp, mask)) return -1;
    const R = this.R;
    const T = this.lineT;
    const INV = this.lineInv;
    const pc = this.pc;
    const pe = p.x * this.e.x + p.y * this.e.y + p.z * this.e.z;
    const ps = p.x * this.s.x + p.y * this.s.y + p.z * this.s.z;
    const c = this.c;

    let xL = ip - range;
    let xR = ip + range + 1;
    let yT = jp - range;
    let yB = jp + range + 1;
    for (let i = ip; i >= ip - range; i--) {
      if (!this.solid(i - 1, jp, mask)) continue;
      xL = i;
      const sn = (pe - T[i] * pc) * INV[i];
      this.dL = R * Math.asin(Math.min(1, Math.max(0, sn)));
      if (push && this.dL < r) addLinePush(push, p, this.e, c, T[i], INV[i], sn, 1, r - this.dL);
      break;
    }
    for (let i = ip + 1; i <= ip + range; i++) {
      if (!this.solid(i, jp, mask)) continue;
      xR = i;
      const sn = (pe - T[i] * pc) * INV[i];
      this.dR = R * Math.asin(Math.min(1, Math.max(0, -sn)));
      if (push && this.dR < r) addLinePush(push, p, this.e, c, T[i], INV[i], sn, -1, r - this.dR);
      break;
    }
    for (let j = jp; j >= jp - range; j--) {
      if (!this.solid(ip, j - 1, mask)) continue;
      yT = j;
      const sn = (ps - T[j] * pc) * INV[j];
      this.dT = R * Math.asin(Math.min(1, Math.max(0, sn)));
      if (push && this.dT < r) addLinePush(push, p, this.s, c, T[j], INV[j], sn, 1, r - this.dT);
      break;
    }
    for (let j = jp + 1; j <= jp + range; j++) {
      if (!this.solid(ip, j, mask)) continue;
      yB = j;
      const sn = (ps - T[j] * pc) * INV[j];
      this.dB = R * Math.asin(Math.min(1, Math.max(0, -sn)));
      if (push && this.dB < r) addLinePush(push, p, this.s, c, T[j], INV[j], sn, -1, r - this.dB);
      break;
    }
    let min = Math.min(this.dL, this.dR, this.dT, this.dB);

    // Convex corners inside the free rectangle whose quadrant contains the centre.
    const quad = this.vertexQuad[mask];
    const i0 = Math.max(0, xL);
    const i1 = Math.min(G, xR);
    const j0 = Math.max(0, yT);
    const j1 = Math.min(G, yB);
    const F2 = this.F * this.F * 0.9;
    const r2 = r * r;
    const e = this.e;
    const s = this.s;
    for (let j = j0; j <= j1; j++) {
      const dy = gy - j;
      if (dy * dy * F2 > r2) continue;
      const row = j * (G + 1);
      for (let i = i0; i <= i1; i++) {
        const q = quad[row + i];
        if (q === 0) continue;
        const dx = gx - i;
        if ((dx * dx + dy * dy) * F2 > r2) continue;
        if (q === 1 ? dx < 0 || dy < 0 : q === 2 ? dx > 0 || dy < 0 : q === 3 ? dx < 0 || dy > 0 : dx > 0 || dy > 0) continue;
        const X = T[i];
        const Y = T[j];
        let vx = c.x + X * e.x + Y * s.x;
        let vy = c.y + X * e.y + Y * s.y;
        let vz = c.z + X * e.z + Y * s.z;
        const vl = Math.hypot(vx, vy, vz);
        vx /= vl;
        vy /= vl;
        vz /= vl;
        const cx = p.y * vz - p.z * vy;
        const cy = p.z * vx - p.x * vz;
        const cz = p.x * vy - p.y * vx;
        const pv = p.x * vx + p.y * vy + p.z * vz;
        const d = R * Math.atan2(Math.hypot(cx, cy, cz), pv);
        if (d < min) min = d;
        if (!push || d >= r || d < 1e-6) continue;
        // Away from the corner along the great circle through it.
        let tx = pv * p.x - vx;
        let ty = pv * p.y - vy;
        let tz = pv * p.z - vz;
        const tl = Math.hypot(tx, ty, tz);
        if (tl < 1e-12) continue;
        const k = (r - d) / tl;
        tx *= k;
        ty *= k;
        tz *= k;
        push.x += tx;
        push.y += ty;
        push.z += tz;
      }
    }
    this.minDist = min;
    let squeeze = 1;
    if (this.dL + this.dR < 2 * r) squeeze = (this.dL + this.dR) / (2 * r);
    if (this.dT + this.dB < 2 * r) squeeze = Math.min(squeeze, (this.dT + this.dB) / (2 * r));
    return squeeze;
  }

  /** Distance from p to the nearest wall, up to `cap` (−1 inside a wall). */
  clearance(p: Vec3, cap: number, mask: WallMask): number {
    const f = this.collide(p, cap, mask, null);
    if (f < 0) return -1;
    return Math.min(cap, this.minDist);
  }

  /** Grid coordinates of the nearest open spot (just across the closest tile edge) for a centre inside a wall. */
  exitFromWall(mask: WallMask, out: { gx: number; gy: number }): boolean {
    const gx = this.gx;
    const gy = this.gy;
    const ip = Math.floor(gx);
    const jp = Math.floor(gy);
    let best = Infinity;
    const eps = 1e-3;
    for (let k = 1; k <= 24 && k - 1 < best; k++) {
      if (!this.solid(ip - k, jp, mask) && gx - (ip - k + 1) < best) {
        best = gx - (ip - k + 1);
        out.gx = ip - k + 1 - eps;
        out.gy = gy;
      }
      if (!this.solid(ip + k, jp, mask) && ip + k - gx < best) {
        best = ip + k - gx;
        out.gx = ip + k + eps;
        out.gy = gy;
      }
      if (!this.solid(ip, jp - k, mask) && gy - (jp - k + 1) < best) {
        best = gy - (jp - k + 1);
        out.gx = gx;
        out.gy = jp - k + 1 - eps;
      }
      if (!this.solid(ip, jp + k, mask) && jp + k - gy < best) {
        best = jp + k - gy;
        out.gx = gx;
        out.gy = jp + k + eps;
      }
    }
    return best < Infinity;
  }

  /** True when the straight chart segment between two points crosses a wall (sampled every ≤ ½ tile). */
  blocked(a: Vec3, b: Vec3, mask: WallMask): boolean {
    if (!this.locate(a)) return false;
    const ax = this.gx;
    const ay = this.gy;
    if (!this.locate(b)) return false;
    const bx = this.gx;
    const by = this.gy;
    const G = this.G;
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > G && bx > G) || (ay > G && by > G)) return false;
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2) + 1;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (this.solid(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t), mask)) return true;
    }
    return false;
  }

  /** Tile index of grid coordinates, or −1 outside the grid. */
  tileIndex(gx: number, gy: number): number {
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    if (i < 0 || j < 0 || i >= this.G || j >= this.G) return -1;
    return j * this.G + i;
  }

  /** Escape radius at grid coordinates (Infinity outside the grid; 0 on solid tiles). */
  escapeAt(gx: number, gy: number): number {
    const t = this.tileIndex(gx, gy);
    return t < 0 ? Infinity : this.escape[t];
  }

  /** Width class for a radius: 0 fine, 1 coarse, 2 avenue, 3 plains only. */
  classOf(r: number): number {
    const cr = this.classRadius;
    return r <= cr[0] ? 0 : r <= cr[1] ? 1 : r <= cr[2] ? 2 : 3;
  }

  // ---------------------------------------------------------------- precomputation

  private buildVertices(mask: WallMask): Uint8Array {
    const G = this.G;
    const q = new Uint8Array((G + 1) * (G + 1));
    for (let j = 0; j <= G; j++) {
      for (let i = 0; i <= G; i++) {
        const tl = this.solid(i - 1, j - 1, mask);
        const tr = this.solid(i, j - 1, mask);
        const bl = this.solid(i - 1, j, mask);
        const br = this.solid(i, j, mask);
        if (Number(tl) + Number(tr) + Number(bl) + Number(br) !== 1) continue;
        q[j * (G + 1) + i] = tl ? 1 : tr ? 2 : bl ? 3 : 4;
      }
    }
    return q;
  }

  private buildClearance(): Float32Array {
    const G = this.G;
    const corner = new Float32Array((G + 1) * (G + 1));
    const p = { x: 0, y: 0, z: 1 };
    for (let j = 0; j <= G; j++) {
      for (let i = 0; i <= G; i++) {
        this.point(i, j, p);
        corner[j * (G + 1) + i] = Math.max(0, this.clearance(p, CLEARANCE_CAP, MASK_REGULAR));
      }
    }
    const out = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        if (this.solid(i, j, MASK_REGULAR)) continue;
        this.point(i + 0.5, j + 0.5, p);
        let best = Math.max(0, this.clearance(p, CLEARANCE_CAP, MASK_REGULAR));
        const r0 = j * (G + 1);
        const r1 = r0 + G + 1;
        best = Math.max(best, corner[r0 + i], corner[r0 + i + 1], corner[r1 + i], corner[r1 + i + 1]);
        out[j * G + i] = best;
      }
    }
    return out;
  }

  /**
   * Widest path out (a max-min path problem): a tile's escape radius is min(own clearance, best neighbour's escape),
   * seeded on the grid border. Relaxed in alternating forward/backward sweeps until nothing changes (≤ 6 passes on the
   * generated districts). Clearance at the cap counts as open plains.
   */
  private buildEscape(): Float32Array {
    const G = this.G;
    const N = G * G;
    const width = new Float32Array(N);
    const out = new Float32Array(N);
    for (let t = 0; t < N; t++) {
      if (this.tiles[t] !== OPEN) continue;
      const i = t % G;
      const j = (t - i) / G;
      width[t] = this.tileClear[t] >= CLEARANCE_CAP - 10 ? Infinity : this.tileClear[t];
      if (i === 0 || j === 0 || i === G - 1 || j === G - 1) out[t] = width[t];
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (let k = 0; k < 2 * N; k++) {
        const t = k < N ? k : 2 * N - 1 - k;
        if (!width[t]) continue;
        const i = t % G;
        const best = Math.max(i > 0 ? out[t - 1] : 0, i < G - 1 ? out[t + 1] : 0, t >= G ? out[t - G] : 0, t < N - G ? out[t + G] : 0);
        const v = Math.min(width[t], best);
        if (v > out[t]) {
          out[t] = v;
          changed = true;
        }
      }
    }
    return out;
  }

  /**
   * Clearance threshold per width class for the reachability labels: 0.97 × the class's half-width, lowered to just
   * under the widest way out of the class's corridors where the district's gates are narrower than its corridors
   * (the avenue gates only let r ≈ 535 out of a 560 ring, so the ring never connected to the plains).
   */
  private labelThresholds(): number[] {
    const out: number[] = [];
    const G = this.G;
    for (const r of this.classRadius) {
      let wayOut = 0;
      for (let j = MARGIN_TILES; j < G - MARGIN_TILES; j++) {
        for (let i = MARGIN_TILES; i < G - MARGIN_TILES; i++) {
          const e = this.escape[j * G + i];
          if (e <= r && e > wayOut) wayOut = e;
        }
      }
      out.push(wayOut > r * 0.9 ? Math.min(r * 0.97, wayOut - 1) : r * 0.97);
    }
    out.push(CLEARANCE_CAP - 10);
    return out;
  }

  private buildLabels(threshold: number): Int32Array {
    const G = this.G;
    const labels = new Int32Array(G * G);
    const clear = this.tileClear;
    const stack: number[] = [];
    let next = 1;
    for (let k = 0; k < G * G; k++) {
      if (labels[k] || clear[k] < threshold) continue;
      labels[k] = next;
      stack.push(k);
      while (stack.length) {
        const t = stack.pop()!;
        const i = t % G;
        const j = (t - i) / G;
        if (i > 0 && !labels[t - 1] && clear[t - 1] >= threshold) {
          labels[t - 1] = next;
          stack.push(t - 1);
        }
        if (i < G - 1 && !labels[t + 1] && clear[t + 1] >= threshold) {
          labels[t + 1] = next;
          stack.push(t + 1);
        }
        if (j > 0 && !labels[t - G] && clear[t - G] >= threshold) {
          labels[t - G] = next;
          stack.push(t - G);
        }
        if (j < G - 1 && !labels[t + G] && clear[t + G] >= threshold) {
          labels[t + G] = next;
          stack.push(t + G);
        }
      }
      next++;
    }
    return labels;
  }

  // ---------------------------------------------------------------- render data

  /**
   * Closed outlines of the walls (SOLID tiles) in grid coordinates, inset by `inset` grid units toward the wall so a
   * stroke of that half-width has its outer edge on the collision surface. Long edges are subdivided every 4 tiles.
   */
  contours(inset: number): Float32Array[] {
    if (this.contourCache) return this.contourCache;
    const G = this.G;
    const solid = (i: number, j: number) => this.tile(i, j) === SOLID;
    // Directed unit edges with the wall on the (screen, y-down) right-hand side, keyed by start point.
    const next = new Map<number, number[]>();
    const key = (x: number, y: number) => y * (G + 1) + x;
    const edges: number[] = [];
    const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
      const id = edges.length / 4;
      edges.push(x0, y0, x1, y1);
      const k = key(x0, y0);
      const list = next.get(k);
      if (list) list.push(id);
      else next.set(k, [id]);
    };
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        if (!solid(i, j)) continue;
        if (!solid(i, j - 1)) addEdge(i, j, i + 1, j);
        if (!solid(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1);
        if (!solid(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1);
        if (!solid(i - 1, j)) addEdge(i, j + 1, i, j);
      }
    }
    const used = new Uint8Array(edges.length / 4);
    const loops: Float32Array[] = [];
    for (let start = 0; start < used.length; start++) {
      if (used[start]) continue;
      const pts: number[] = [];
      let id = start;
      while (!used[id]) {
        used[id] = 1;
        pts.push(edges[id * 4], edges[id * 4 + 1]);
        const list = next.get(key(edges[id * 4 + 2], edges[id * 4 + 3]));
        const nxt = list?.find((n) => !used[n]);
        if (nxt === undefined) break;
        id = nxt;
      }
      // Drop collinear points, then inset each corner along the sum of its two edges' inward normals.
      const n = pts.length / 2;
      const corners: number[] = [];
      for (let k = 0; k < n; k++) {
        const px = pts[((k - 1 + n) % n) * 2];
        const py = pts[((k - 1 + n) % n) * 2 + 1];
        const x = pts[k * 2];
        const y = pts[k * 2 + 1];
        const nx = pts[((k + 1) % n) * 2];
        const ny = pts[((k + 1) % n) * 2 + 1];
        const d1x = Math.sign(x - px);
        const d1y = Math.sign(y - py);
        const d2x = Math.sign(nx - x);
        const d2y = Math.sign(ny - y);
        if (d1x === d2x && d1y === d2y) continue;
        // Right-hand normal of (dx, dy) in y-down coordinates is (−dy, dx).
        corners.push(x + inset * (-d1y - d2y), y + inset * (d1x + d2x));
      }
      const out: number[] = [];
      const m = corners.length / 2;
      for (let k = 0; k < m; k++) {
        const x0 = corners[k * 2];
        const y0 = corners[k * 2 + 1];
        const x1 = corners[((k + 1) % m) * 2];
        const y1 = corners[((k + 1) % m) * 2 + 1];
        const len = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        const parts = Math.max(1, Math.ceil(len / 4));
        for (let q = 0; q < parts; q++) out.push(x0 + ((x1 - x0) * q) / parts, y0 + ((y1 - y0) * q) / parts);
      }
      if (out.length >= 6) loops.push(new Float32Array(out));
    }
    this.contourCache = loops;
    return loops;
  }

  /** Door bars as (x0, y0, x1, y1) grid coordinates along each run of DOOR tiles. */
  doors(): Float32Array {
    if (this.doorCache) return this.doorCache;
    const G = this.G;
    const out: number[] = [];
    for (let j = 0; j < G; j++) {
      let i = 0;
      while (i < G) {
        if (this.tile(i, j) !== DOOR) {
          i++;
          continue;
        }
        const i0 = i;
        while (i < G && this.tile(i, j) === DOOR) i++;
        out.push(i0, j + 0.5, i, j + 0.5);
      }
    }
    this.doorCache = new Float32Array(out);
    return this.doorCache;
  }
}

/** push += sign · mag · (unit tangent at p perpendicular to the grid line with chart tan t along axis a). */
function addLinePush(push: Vec3, p: Vec3, a: Vec3, c: Vec3, t: number, inv: number, sn: number, sign: number, mag: number): void {
  // Plane normal n = (a − t·c)·inv; tangent component n − (p·n) p.
  let x = (a.x - t * c.x) * inv - sn * p.x;
  let y = (a.y - t * c.y) * inv - sn * p.y;
  let z = (a.z - t * c.z) * inv - sn * p.z;
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) return;
  const k = (sign * mag) / l;
  x *= k;
  y *= k;
  z *= k;
  push.x += x;
  push.y += y;
  push.z += z;
}
