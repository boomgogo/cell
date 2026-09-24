// Background patterns on the sphere: honeycomb (default), cube-sphere grid, organic dots.
import { hash01 } from '../../core/rng.ts';
import { FACE_ANGULAR_RADIUS, ICO_EDGE_ARC, ICO_FACES, type IcoFace, faceCoords } from '../../sphere/icosa.ts';
import { dot, vec3 } from '../../sphere/vec3.ts';
import type { Camera } from '../camera.ts';

export type BackgroundPattern = 'hex' | 'cube' | 'dots' | 'none';
export const PATTERNS: BackgroundPattern[] = ['hex', 'cube', 'dots', 'none'];

const uv = { u: 0, v: 0 };
const pt = { x: 0, y: 0 };

/** Lattice level so on-screen spacing stays ≥ minPx; returns world spacing. */
function levelSpacing(spacing: number, zoom: number, minPx: number): number {
  let s = spacing;
  while (s * zoom < minPx) s *= 2;
  return s;
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pattern: BackgroundPattern,
  spacing: number,
  dark: boolean,
  color?: string,
  alphaZoom = cam.zoom,
  /** Opaque colour (the riso dot grid): full strength at normal zoom, fading out when zoomed far out. */
  solid = false,
): number {
  if (pattern === 'none') return 0;
  // Grid alpha = 0.2 × zoom. Below ~0.05 the grid is effectively invisible, so skip the work. `alphaZoom` lets the
  // maze zoom-out keep the grid's strength; the lattice level still follows the real zoom.
  const alpha = Math.min(0.2, 0.2 * alphaZoom);
  if (alpha < 0.05) return 0;
  ctx.save();
  ctx.globalAlpha = solid ? Math.min(1, alpha * 5) : color ? Math.min(0.28, alpha * 1.4) : alpha;
  ctx.strokeStyle = color ?? (dark ? '#aaaaaa' : '#000000');
  ctx.fillStyle = color ?? (dark ? '#aaaaaa' : '#000000');
  ctx.lineWidth = 1;
  let n = 0;
  if (pattern === 'hex') n = drawHex(ctx, cam, levelSpacing(spacing, cam.zoom, 24));
  else if (pattern === 'cube') n = drawCube(ctx, cam, levelSpacing(spacing, cam.zoom, 24));
  else n = drawDots(ctx, cam, levelSpacing(spacing * 1.6, cam.zoom, 26));
  ctx.restore();
  return n;
}

// ------------------------------------------------------------------ honeycomb

let rowA = new Float32Array(0);
let rowB = new Float32Array(0);

/** Projects plane point (i, j) of a face at frequency f into screen px. */
function projectLattice(cam: Camera, face: IcoFace, f: number, i: number, j: number): boolean {
  const u = i / f;
  const v = j / f;
  const x = face.a.x + face.ab.x * u + face.ac.x * v;
  const y = face.a.y + face.ab.y * u + face.ac.y * v;
  const z = face.a.z + face.ab.z * u + face.ac.z * v;
  const l = Math.hypot(x, y, z);
  return cam.toScreenXYZ(x / l, y / l, z / l, pt);
}

function drawHex(ctx: CanvasRenderingContext2D, cam: Camera, spacing: number): number {
  const R = cam.R;
  const f = Math.max(1, Math.round((ICO_EDGE_ARC * R) / spacing));
  const view = cam.viewRadius() + spacing * 2;
  const viewAngle = view / R;
  const c = cam.center;
  const w = cam.width;
  const h = cam.height;
  const margin = spacing * cam.zoom * 2;
  // Lattice spacing shrinks to ~0.65× near icosahedron vertices (gnomonic subdivision).
  const k = Math.ceil(view / (((ICO_EDGE_ARC * R) / f) * 0.62)) + 2;
  let edges = 0;
  ctx.beginPath();
  for (const face of ICO_FACES) {
    if (Math.acos(Math.max(-1, Math.min(1, dot(face.n, c)))) > FACE_ANGULAR_RADIUS + viewAngle) continue;
    if (!faceCoords(face, c, uv)) continue;
    const i0 = uv.u * f;
    const j0 = uv.v * f;
    const jmin = Math.max(0, Math.floor(j0 - k));
    const jmax = Math.min(f - 1, Math.ceil(j0 + k));
    if (jmin > jmax) continue;
    const imin = Math.max(0, Math.floor(i0 - k));
    const imaxAll = Math.min(f - 1, Math.ceil(i0 + k));
    if (imin > imaxAll) continue;
    const width = imaxAll - imin + 2;
    if (rowA.length < width * 3) {
      rowA = new Float32Array(width * 3);
      rowB = new Float32Array(width * 3);
    }
    // down(i, j) centroid at (i + 2/3, j + 2/3); rows cache screen x, y, visible flag.
    let prevRow = rowA;
    let curRow = rowB;
    const fillDownRow = (row: Float32Array, j: number) => {
      const imax = Math.min(imaxAll, f - 2 - j);
      for (let i = imin; i <= imax; i++) {
        const o = (i - imin) * 3;
        const ok = projectLattice(cam, face, f, i + 2 / 3, j + 2 / 3);
        row[o] = pt.x;
        row[o + 1] = pt.y;
        row[o + 2] = ok ? 1 : 0;
      }
    };
    if (jmin > 0) fillDownRow(prevRow, jmin - 1);
    for (let j = jmin; j <= jmax; j++) {
      fillDownRow(curRow, j);
      const imax = Math.min(imaxAll, f - 1 - j);
      for (let i = imin; i <= imax; i++) {
        if (!projectLattice(cam, face, f, i + 1 / 3, j + 1 / 3)) continue;
        const ux = pt.x;
        const uy = pt.y;
        if (ux < -margin || uy < -margin || ux > w + margin || uy > h + margin) continue;
        const o = (i - imin) * 3;
        // Neighbour across edge (i+1,j)-(i,j+1): down(i,j) or the face-edge midpoint.
        if (i + j <= f - 2) {
          if (curRow[o + 2]) {
            ctx.moveTo(ux, uy);
            ctx.lineTo(curRow[o], curRow[o + 1]);
            edges++;
          }
        } else if (projectLattice(cam, face, f, i + 0.5, j + 0.5)) {
          ctx.moveTo(ux, uy);
          ctx.lineTo(pt.x, pt.y);
          edges++;
        }
        // Neighbour across edge (i,j)-(i,j+1): down(i-1,j) or midpoint at i = 0.
        if (i >= 1) {
          if (i - 1 >= imin && curRow[o - 3 + 2]) {
            ctx.moveTo(ux, uy);
            ctx.lineTo(curRow[o - 3], curRow[o - 2]);
            edges++;
          }
        } else if (projectLattice(cam, face, f, 0, j + 0.5)) {
          ctx.moveTo(ux, uy);
          ctx.lineTo(pt.x, pt.y);
          edges++;
        }
        // Neighbour across edge (i,j)-(i+1,j): down(i,j-1) or midpoint at j = 0.
        if (j >= 1) {
          // prevRow holds down-row j−1 (filled for j = jmin when jmin > 0).
          if (prevRow[o + 2]) {
            ctx.moveTo(ux, uy);
            ctx.lineTo(prevRow[o], prevRow[o + 1]);
            edges++;
          }
        } else if (projectLattice(cam, face, f, i + 0.5, 0)) {
          ctx.moveTo(ux, uy);
          ctx.lineTo(pt.x, pt.y);
          edges++;
        }
      }
      const t = prevRow;
      prevRow = curRow;
      curRow = t;
    }
  }
  ctx.stroke();
  return edges;
}

// ------------------------------------------------------------------ cube-sphere grid

const CUBE_FACES = [
  { n: vec3(1, 0, 0), u: vec3(0, 1, 0), v: vec3(0, 0, 1) },
  { n: vec3(-1, 0, 0), u: vec3(0, 0, 1), v: vec3(0, 1, 0) },
  { n: vec3(0, 1, 0), u: vec3(0, 0, 1), v: vec3(1, 0, 0) },
  { n: vec3(0, -1, 0), u: vec3(1, 0, 0), v: vec3(0, 0, 1) },
  { n: vec3(0, 0, 1), u: vec3(1, 0, 0), v: vec3(0, 1, 0) },
  { n: vec3(0, 0, -1), u: vec3(0, 1, 0), v: vec3(1, 0, 0) },
];
const CUBE_CORNER_ANGLE = Math.acos(1 / Math.sqrt(3));
const Q = Math.PI / 4;

function drawCube(ctx: CanvasRenderingContext2D, cam: Camera, spacing: number): number {
  const R = cam.R;
  const lines = Math.max(1, Math.round((Math.PI / 2) * R / spacing));
  const step = Math.PI / 2 / lines;
  const view = cam.viewRadius() + spacing;
  const viewAngle = view / R;
  const c = cam.center;
  const range = viewAngle * 1.6;
  const samples = 12;
  let n = 0;
  ctx.beginPath();
  for (const F of CUBE_FACES) {
    const cn = dot(c, F.n);
    if (Math.acos(Math.max(-1, Math.min(1, cn))) > CUBE_CORNER_ANGLE + viewAngle || cn <= 0.05) continue;
    const a0 = Math.atan2(dot(c, F.u), cn);
    const b0 = Math.atan2(dot(c, F.v), cn);
    const amin = Math.max(-Q, a0 - range);
    const amax = Math.min(Q, a0 + range);
    const bmin = Math.max(-Q, b0 - range);
    const bmax = Math.min(Q, b0 + range);
    if (amin >= amax || bmin >= bmax) continue;
    for (let pass = 0; pass < 2; pass++) {
      const [lo, hi, olo, ohi] = pass === 0 ? [amin, amax, bmin, bmax] : [bmin, bmax, amin, amax];
      for (let kk = Math.ceil((lo + Q) / step); -Q + kk * step <= hi; kk++) {
        const fixed = Math.tan(-Q + kk * step);
        let started = false;
        for (let s = 0; s <= samples; s++) {
          const other = Math.tan(olo + ((ohi - olo) * s) / samples);
          const tu = pass === 0 ? fixed : other;
          const tv = pass === 0 ? other : fixed;
          const x = F.n.x + F.u.x * tu + F.v.x * tv;
          const y = F.n.y + F.u.y * tu + F.v.y * tv;
          const z = F.n.z + F.u.z * tu + F.v.z * tv;
          const l = Math.hypot(x, y, z);
          if (!cam.toScreenXYZ(x / l, y / l, z / l, pt)) {
            started = false;
            continue;
          }
          if (started) ctx.lineTo(pt.x, pt.y);
          else ctx.moveTo(pt.x, pt.y);
          started = true;
        }
        n++;
      }
    }
  }
  ctx.stroke();
  return n;
}

// ------------------------------------------------------------------ organic dots

function drawDots(ctx: CanvasRenderingContext2D, cam: Camera, spacing: number): number {
  const R = cam.R;
  const f = Math.max(1, Math.round((ICO_EDGE_ARC * R) / spacing));
  const view = cam.viewRadius() + spacing;
  const viewAngle = view / R;
  const c = cam.center;
  const k = Math.ceil(view / (((ICO_EDGE_ARC * R) / f) * 0.62)) + 1;
  const w = cam.width;
  const h = cam.height;
  let n = 0;
  ctx.beginPath();
  for (let fi = 0; fi < ICO_FACES.length; fi++) {
    const face = ICO_FACES[fi];
    if (Math.acos(Math.max(-1, Math.min(1, dot(face.n, c)))) > FACE_ANGULAR_RADIUS + viewAngle) continue;
    if (!faceCoords(face, c, uv)) continue;
    const i0 = uv.u * f;
    const j0 = uv.v * f;
    for (let j = Math.max(0, Math.floor(j0 - k)); j <= Math.min(f, Math.ceil(j0 + k)); j++) {
      for (let i = Math.max(0, Math.floor(i0 - k)); i <= Math.min(f - j, Math.ceil(i0 + k)); i++) {
        const hx = hash01(fi, i, j);
        const hy = hash01(j, fi, i);
        if (!projectLattice(cam, face, f, i + (hx - 0.5) * 0.7, j + (hy - 0.5) * 0.7)) continue;
        if (pt.x < -10 || pt.y < -10 || pt.x > w + 10 || pt.y > h + 10) continue;
        const r = spacing * cam.zoom * (0.06 + 0.1 * hash01(i, j, fi));
        ctx.moveTo(pt.x + r, pt.y);
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        n++;
      }
    }
  }
  ctx.fill();
  return n;
}
