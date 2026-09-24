// Icosahedral lattice for the honeycomb background.
// Each of the 20 faces is subdivided with frequency f. Lattice point (i, j) on face ABC is
// normalize(A + (B−A)·i/f + (C−A)·j/f). The honeycomb is the dual: hexagon corners are triangle
// centroids, so every coordinate needed is a plane point at a fractional (i, j).
import { type Vec3, vec3 } from './vec3.ts';

const PHI = (1 + Math.sqrt(5)) / 2;

const RAW_VERTS: [number, number, number][] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];

/** Vertex indices of the 20 faces (into ICO_VERTS). */
export const ICO_FACE_VERTS: [number, number, number][] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

export interface IcoFace {
  a: Vec3;
  /** B − A and C − A (plane edge vectors). */
  ab: Vec3;
  ac: Vec3;
  /** Unit face normal (points at the face centre). */
  n: Vec3;
  /** Distance of the face plane from the origin. */
  h: number;
  /** Inverse Gram matrix for barycentric solves. */
  g00: number;
  g01: number;
  g11: number;
}

export const ICO_VERTS: Vec3[] = RAW_VERTS.map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return vec3(x / l, y / l, z / l);
});

/** Edge arc of the icosahedron on the unit sphere (≈ 1.1071 rad). */
export const ICO_EDGE_ARC = Math.acos(
  ICO_VERTS[0].x * ICO_VERTS[1].x + ICO_VERTS[0].y * ICO_VERTS[1].y + ICO_VERTS[0].z * ICO_VERTS[1].z,
);

export const ICO_FACES: IcoFace[] = ICO_FACE_VERTS.map(([ia, ib, ic]) => {
  const a = ICO_VERTS[ia];
  const b = ICO_VERTS[ib];
  const c = ICO_VERTS[ic];
  const ab = vec3(b.x - a.x, b.y - a.y, b.z - a.z);
  const ac = vec3(c.x - a.x, c.y - a.y, c.z - a.z);
  const nx = a.x + b.x + c.x;
  const ny = a.y + b.y + c.y;
  const nz = a.z + b.z + c.z;
  const nl = Math.hypot(nx, ny, nz);
  const n = vec3(nx / nl, ny / nl, nz / nl);
  const h = a.x * n.x + a.y * n.y + a.z * n.z;
  const d00 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const d01 = ab.x * ac.x + ab.y * ac.y + ab.z * ac.z;
  const d11 = ac.x * ac.x + ac.y * ac.y + ac.z * ac.z;
  const det = d00 * d11 - d01 * d01;
  return { a, ab, ac, n, h, g00: d11 / det, g01: -d01 / det, g11: d00 / det };
});

/** Angular radius of a face (centre to vertex, ≈ 0.6524 rad). */
export const FACE_ANGULAR_RADIUS = Math.acos(
  ICO_FACES[0].n.x * ICO_FACES[0].a.x + ICO_FACES[0].n.y * ICO_FACES[0].a.y + ICO_FACES[0].n.z * ICO_FACES[0].a.z,
);

/** Barycentric-style lattice coordinates (u, v ∈ face when u,v ≥ 0, u+v ≤ 1) of p's gnomonic projection. */
export function faceCoords(face: IcoFace, p: Vec3, out: { u: number; v: number }): boolean {
  const pn = p.x * face.n.x + p.y * face.n.y + p.z * face.n.z;
  if (pn <= 1e-6) return false;
  const k = face.h / pn;
  const qx = p.x * k - face.a.x;
  const qy = p.y * k - face.a.y;
  const qz = p.z * k - face.a.z;
  const b0 = qx * face.ab.x + qy * face.ab.y + qz * face.ab.z;
  const b1 = qx * face.ac.x + qy * face.ac.y + qz * face.ac.z;
  out.u = face.g00 * b0 + face.g01 * b1;
  out.v = face.g01 * b0 + face.g11 * b1;
  return true;
}

/** Unit vector for fractional lattice coordinates (i, j) at frequency f. */
export function latticePoint(face: IcoFace, f: number, i: number, j: number, out: Vec3): Vec3 {
  const u = i / f;
  const v = j / f;
  const x = face.a.x + face.ab.x * u + face.ac.x * v;
  const y = face.a.y + face.ab.y * u + face.ac.y * v;
  const z = face.a.z + face.ab.z * u + face.ac.z * v;
  const l = Math.hypot(x, y, z);
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Frequency giving an average lattice spacing of about `spacing` world units on a sphere of radius R. */
export function frequencyFor(R: number, spacing: number): number {
  return Math.max(1, Math.round((ICO_EDGE_ARC * R) / spacing));
}
