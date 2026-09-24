// 3D uniform hash grid over sphere surface points R·p.
// Entities are inserted by centre only; queries expand by the largest radius stored in the grid.
// Straight-line (chord) distance never exceeds surface distance, so a 3D box around the query point
// with half-size = surface radius is a correct superset. Queries only visit the buckets of that box that
// the sphere shell passes through (an area scan, not a volume scan).

export class Grid3 {
  readonly cellSize: number;
  readonly sphereRadius: number;
  private readonly inv: number;
  private readonly off: number;
  private readonly dims: number;
  private readonly buckets = new Map<number, number[]>();
  private readonly used: number[] = [];
  private readonly trackUsed: boolean;
  /** Largest entity radius inserted since the last clear (query expansion). */
  maxRadius = 0;

  constructor(cellSize: number, sphereRadius: number, dynamic: boolean) {
    this.cellSize = cellSize;
    this.sphereRadius = sphereRadius;
    this.inv = 1 / cellSize;
    this.off = Math.ceil(sphereRadius / cellSize) + 2;
    this.dims = 2 * this.off + 1;
    this.trackUsed = dynamic;
  }

  private key(ix: number, iy: number, iz: number): number {
    const d = this.dims;
    return ix + this.off + d * (iy + this.off + d * (iz + this.off));
  }

  insert(id: number, x: number, y: number, z: number, radius: number): void {
    const k = this.key(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv));
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    if (this.trackUsed && b.length === 0) this.used.push(k);
    b.push(id);
    if (radius > this.maxRadius) this.maxRadius = radius;
  }

  remove(id: number, x: number, y: number, z: number): boolean {
    const b = this.buckets.get(this.key(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv)));
    if (!b) return false;
    const i = b.indexOf(id);
    if (i < 0) return false;
    b[i] = b[b.length - 1];
    b.pop();
    return true;
  }

  clear(): void {
    for (const k of this.used) {
      const b = this.buckets.get(k);
      if (b) b.length = 0;
    }
    this.used.length = 0;
    this.maxRadius = 0;
  }

  /** Visits ids whose centre lies within the box [p − reach, p + reach], reach = radius + maxRadius. */
  query(x: number, y: number, z: number, radius: number, visit: (id: number) => void): void {
    const R = this.sphereRadius;
    const reach = Math.min(radius + this.maxRadius, 2 * R + this.cellSize);
    const cell = this.cellSize;
    const inv = this.inv;
    // Iterate the two axes where the shell is steepest; solve the third (major) axis from the sphere equation.
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    const major = az >= ax && az >= ay ? 2 : ay >= ax ? 1 : 0;
    const c = [x, y, z];
    const u = major === 0 ? 1 : 0;
    const v = major === 2 ? 1 : 2;
    const u0 = Math.floor((c[u] - reach) * inv);
    const u1 = Math.floor((c[u] + reach) * inv);
    const v0 = Math.floor((c[v] - reach) * inv);
    const v1 = Math.floor((c[v] + reach) * inv);
    const m0 = Math.floor((c[major] - reach) * inv);
    const m1 = Math.floor((c[major] + reach) * inv);
    if ((u1 - u0 + 1) * (v1 - v0 + 1) * (m1 - m0 + 1) <= 64) {
      this.scanBox(x, y, z, reach, visit);
      return;
    }
    const idx = [0, 0, 0];
    const R2hi = (R + 1) * (R + 1);
    const R2lo = (R - 1) * (R - 1);
    for (let iu = u0; iu <= u1; iu++) {
      const ulo = iu * cell;
      const uhi = ulo + cell;
      const uMin2 = ulo > 0 ? ulo * ulo : uhi < 0 ? uhi * uhi : 0;
      const uMax2 = Math.max(ulo * ulo, uhi * uhi);
      for (let iv = v0; iv <= v1; iv++) {
        const vlo = iv * cell;
        const vhi = vlo + cell;
        const vMin2 = vlo > 0 ? vlo * vlo : vhi < 0 ? vhi * vhi : 0;
        const vMax2 = Math.max(vlo * vlo, vhi * vhi);
        const minSq = uMin2 + vMin2;
        if (minSq > R2hi) continue;
        const mHi = Math.sqrt(R2hi - minSq);
        const mLo = Math.sqrt(Math.max(0, R2lo - (uMax2 + vMax2)));
        // Shell crosses this column at m ∈ [mLo, mHi] and m ∈ [−mHi, −mLo]; don't visit a shared bucket twice.
        const posLo = Math.floor(mLo * inv);
        let negHi = Math.floor(-mLo * inv);
        if (negHi >= posLo) negHi = posLo - 1;
        this.visitColumn(u, v, major, iu, iv, Math.max(m0, posLo), Math.min(m1, Math.floor(mHi * inv)), idx, visit);
        this.visitColumn(u, v, major, iu, iv, Math.max(m0, Math.floor(-mHi * inv)), Math.min(m1, negHi), idx, visit);
      }
    }
  }

  private scanBox(x: number, y: number, z: number, reach: number, visit: (id: number) => void): void {
    const inv = this.inv;
    const d = this.dims;
    const off = this.off;
    const x0 = Math.floor((x - reach) * inv);
    const x1 = Math.floor((x + reach) * inv);
    const y0 = Math.floor((y - reach) * inv);
    const y1 = Math.floor((y + reach) * inv);
    const z0 = Math.floor((z - reach) * inv);
    const z1 = Math.floor((z + reach) * inv);
    for (let iz = z0; iz <= z1; iz++) {
      const kz = d * (iz + off);
      for (let iy = y0; iy <= y1; iy++) {
        const kyz = d * (iy + off + kz);
        for (let ix = x0; ix <= x1; ix++) {
          const b = this.buckets.get(ix + off + kyz);
          if (b === undefined) continue;
          for (let i = 0; i < b.length; i++) visit(b[i]);
        }
      }
    }
  }

  private visitColumn(
    u: number,
    v: number,
    major: number,
    iu: number,
    iv: number,
    b0: number,
    b1: number,
    idx: number[],
    visit: (id: number) => void,
  ): void {
    const d = this.dims;
    const off = this.off;
    for (let im = b0; im <= b1; im++) {
      idx[u] = iu;
      idx[v] = iv;
      idx[major] = im;
      const b = this.buckets.get(idx[0] + off + d * (idx[1] + off + d * (idx[2] + off)));
      if (b === undefined) continue;
      for (let i = 0; i < b.length; i++) visit(b[i]);
    }
  }
}
