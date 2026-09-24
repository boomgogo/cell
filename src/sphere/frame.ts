// Tangent frame + azimuthal equidistant projection.
// A Frame is a centre point on the unit sphere with two screen directions: `e` (screen right) and
// `s` (screen down). The camera uses one that is parallel-transported as it moves, so there is no
// global north. AI and mechanics use short-lived frames as local 2D maps ("charts").
import { type Vec3, anyTangent, copy, cross, dot, normalize, transport, vec3 } from './vec3.ts';

export interface Vec2 {
  x: number;
  y: number;
}

export class Frame {
  readonly c: Vec3 = vec3(0, 0, 1);
  readonly e: Vec3 = vec3(1, 0, 0);
  readonly s: Vec3 = vec3(0, -1, 0); // e × c: viewed from outside the sphere, y down

  constructor(center?: Vec3) {
    if (center) this.reset(center);
  }

  /** Re-centres at p with an arbitrary orientation. */
  reset(p: Vec3): this {
    copy(this.c, p);
    normalize(this.c);
    anyTangent(this.e, this.c);
    cross(this.s, this.e, this.c);
    return this;
  }

  /** Moves the centre to p, carrying the screen directions along the shortest arc. */
  moveTo(p: Vec3): void {
    transport(this.e, this.c, p);
    transport(this.s, this.c, p);
    copy(this.c, p);
    normalize(this.c);
    this.orthonormalize();
  }

  orthonormalize(): void {
    const c = this.c;
    const e = this.e;
    const s = this.s;
    const d = dot(e, c);
    e.x -= d * c.x;
    e.y -= d * c.y;
    e.z -= d * c.z;
    normalize(e);
    // s = e × c keeps the handedness fixed: looking at the sphere from outside, x right, y down.
    cross(s, e, c);
  }

  /**
   * Azimuthal equidistant projection of unit vector p into this frame's local plane, in world units.
   * Distance from the centre is exact. Returns cos(angle to p) so callers can cull the far side.
   */
  project(R: number, p: Vec3, out: Vec2): number {
    const cosT = p.x * this.c.x + p.y * this.c.y + p.z * this.c.z;
    const tx = p.x * this.e.x + p.y * this.e.y + p.z * this.e.z;
    const ty = p.x * this.s.x + p.y * this.s.y + p.z * this.s.z;
    const sinT = Math.hypot(tx, ty);
    if (sinT < 1e-12) {
      out.x = 0;
      out.y = 0;
      return cosT;
    }
    const k = (R * Math.atan2(sinT, cosT)) / sinT;
    out.x = tx * k;
    out.y = ty * k;
    return cosT;
  }

  /** Projection of raw (x,y,z) without building a Vec3. */
  projectXYZ(R: number, px: number, py: number, pz: number, out: Vec2): number {
    const cosT = px * this.c.x + py * this.c.y + pz * this.c.z;
    const tx = px * this.e.x + py * this.e.y + pz * this.e.z;
    const ty = px * this.s.x + py * this.s.y + pz * this.s.z;
    const sinT = Math.hypot(tx, ty);
    if (sinT < 1e-12) {
      out.x = 0;
      out.y = 0;
      return cosT;
    }
    const k = (R * Math.atan2(sinT, cosT)) / sinT;
    out.x = tx * k;
    out.y = ty * k;
    return cosT;
  }

  /** Inverse projection: local plane (x,y) in world units → unit vector. */
  unproject(R: number, x: number, y: number, out: Vec3): Vec3 {
    const rho = Math.hypot(x, y);
    if (rho < 1e-9) return copy(out, this.c);
    const t = rho / R;
    const ct = Math.cos(t);
    const st = Math.sin(t) / rho;
    out.x = this.c.x * ct + (this.e.x * x + this.s.x * y) * st;
    out.y = this.c.y * ct + (this.e.y * x + this.s.y * y) * st;
    out.z = this.c.z * ct + (this.e.z * x + this.s.z * y) * st;
    return out;
  }

  /** Local tangent direction (x,y) → unit tangent vector at the centre. */
  tangent(x: number, y: number, out: Vec3): Vec3 {
    out.x = this.e.x * x + this.s.x * y;
    out.y = this.e.y * x + this.s.y * y;
    out.z = this.e.z * x + this.s.z * y;
    normalize(out);
    return out;
  }
}
