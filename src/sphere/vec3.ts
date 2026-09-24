// Unit-sphere vector helpers. Positions are unit vectors; world distance = R · angle.
// Hot paths mutate `out` params to avoid allocations.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

/** Normalises in place. Returns the original length. */
export function normalize(a: Vec3): number {
  const l = Math.hypot(a.x, a.y, a.z);
  if (l > 0) {
    a.x /= l;
    a.y /= l;
    a.z /= l;
  }
  return l;
}

/** Angle between unit vectors, precise for tiny separations (atan2 form, not acos). */
export function angle(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z);
}

/** Unit tangent at p pointing along the great circle toward q. Returns false when q ≈ ±p. */
export function tangentToward(out: Vec3, p: Vec3, q: Vec3): boolean {
  const d = dot(p, q);
  const x = q.x - d * p.x;
  const y = q.y - d * p.y;
  const z = q.z - d * p.z;
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) return false;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return true;
}

/** Any unit vector perpendicular to p. */
export function anyTangent(out: Vec3, p: Vec3): Vec3 {
  // Cross with the axis least aligned with p.
  const ax = Math.abs(p.x);
  const ay = Math.abs(p.y);
  const az = Math.abs(p.z);
  if (ax <= ay && ax <= az) set(out, 0, -p.z, p.y);
  else if (ay <= az) set(out, -p.z, 0, p.x);
  else set(out, -p.y, p.x, 0);
  normalize(out);
  return out;
}

/**
 * Moves p along the great circle with unit tangent `dir` by `theta` radians (in place),
 * and parallel-transports `dir` so it stays the heading of the same great circle.
 */
export function moveAlong(p: Vec3, dir: Vec3, theta: number): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const px = p.x * c + dir.x * s;
  const py = p.y * c + dir.y * s;
  const pz = p.z * c + dir.z * s;
  dir.x = dir.x * c - p.x * s;
  dir.y = dir.y * c - p.y * s;
  dir.z = dir.z * c - p.z * s;
  p.x = px;
  p.y = py;
  p.z = pz;
}

const tmpDir = vec3();

/** Rotates p toward q by at most `theta` radians (never overshoots). Returns the angle actually moved. */
export function rotateToward(p: Vec3, q: Vec3, theta: number): number {
  const a = angle(p, q);
  if (a < 1e-12 || theta <= 0) return 0;
  if (!tangentToward(tmpDir, p, q)) return 0;
  const step = Math.min(theta, a);
  moveAlong(p, tmpDir, step);
  return step;
}

/**
 * Rotates v by the minimal rotation that takes unit vector `from` to unit vector `to` (Rodrigues).
 * Used to parallel-transport tangent frames along short camera moves.
 */
export function transport(v: Vec3, from: Vec3, to: Vec3): void {
  const kx = from.y * to.z - from.z * to.y;
  const ky = from.z * to.x - from.x * to.z;
  const kz = from.x * to.y - from.y * to.x;
  const s = Math.hypot(kx, ky, kz); // sin θ
  const c = from.x * to.x + from.y * to.y + from.z * to.z; // cos θ
  if (s < 1e-15) return;
  const ux = kx / s;
  const uy = ky / s;
  const uz = kz / s;
  const kdotv = ux * v.x + uy * v.y + uz * v.z;
  const cx = uy * v.z - uz * v.y;
  const cy = uz * v.x - ux * v.z;
  const cz = ux * v.y - uy * v.x;
  const t = 1 - c;
  const x = v.x * c + cx * s + ux * kdotv * t;
  const y = v.y * c + cy * s + uy * kdotv * t;
  const z = v.z * c + cz * s + uz * kdotv * t;
  v.x = x;
  v.y = y;
  v.z = z;
}

/** Uniformly random point on the unit sphere. `rand` returns [0,1). */
export function randomUnit(out: Vec3, rand: () => number): Vec3 {
  const z = 2 * rand() - 1;
  const phi = 2 * Math.PI * rand();
  const r = Math.sqrt(1 - z * z);
  out.x = r * Math.cos(phi);
  out.y = r * Math.sin(phi);
  out.z = z;
  return out;
}

/** Normalised lerp between two nearby unit vectors (render interpolation). */
export function nlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  normalize(out);
  return out;
}
