// World layout for the arcade mode: 12 regions around the icosahedron vertices (the faces of a
// dodecahedron), each with a maze district at its centre, a hue, a name and a fruit. Region borders are the 30
// dodecahedron edges; the 20 junctions where three regions meet are the icosahedron face centres.
import type { GameConfig } from '../config/types.ts';
import { createRng } from '../core/rng.ts';
import { ICO_EDGE_ARC, ICO_FACES, ICO_FACE_VERTS, ICO_VERTS } from '../sphere/icosa.ts';
import { type Vec3, anyTangent, cross, dot, vec3 } from '../sphere/vec3.ts';

export interface Region {
  index: number;
  centre: Vec3;
  /** District "right" and "down" axes (unit tangents at the centre). */
  e: Vec3;
  s: Vec3;
  hue: number;
  name: string;
  fruit: string;
  neighbours: number[];
}

export interface Border {
  a: number;
  b: number;
  /** End points: the two junctions the border runs between. */
  p0: Vec3;
  p1: Vec3;
}

export interface Junction {
  p: Vec3;
  regions: [number, number, number];
}

/** Hue slots (30° apart) with a matching name and fruit. */
const SLOTS: [string, string][] = [
  ['Cherry Commons', '🍒'],
  ['Orange Oasis', '🍊'],
  ['Lemon Loop', '🍋'],
  ['Pear Plaza', '🍐'],
  ['Apple Alley', '🍏'],
  ['Melon Maze', '🍉'],
  ['Coconut Cove', '🥥'],
  ['Blueberry Bay', '🫐'],
  ['Kiwi Corner', '🥝'],
  ['Grape Grove', '🍇'],
  ['Peach Park', '🍑'],
  ['Strawberry Sprawl', '🍓'],
];

/** Fine tiles: perimeter wall 1, avenue ring 8, plains margin 8 around the grid. */
export const PERIMETER_TILES = 1;
export const AVENUE_TILES = 8;
export const MARGIN_TILES = 8;
export const COARSE_TILES = 4;

/** Interior width in fine tiles for n pillars per core axis. */
export const interiorTiles = (n: number): number => 8 * n - 4 + 2 * (PERIMETER_TILES + AVENUE_TILES);

export class RegionLayout {
  readonly R: number;
  readonly regions: Region[];
  readonly borders: Border[] = [];
  readonly junctions: Junction[] = [];
  /** Pillars per core axis (odd ≥ 7), or 0 when the sphere is too small for mazes. */
  readonly pillars: number;
  /** Fine grid size including margins, and interior half-size in world units. */
  readonly gridTiles: number;
  readonly halfInterior: number;
  readonly fineTile: number;

  constructor(cfg: GameConfig) {
    const R = cfg.sphereRadius;
    this.R = R;
    this.fineTile = cfg.fineTile;
    const rng = createRng(cfg.mapSeed * 7919 + 17);
    const edgeCos = Math.cos(ICO_EDGE_ARC);
    const adj: number[][] = ICO_VERTS.map((a, i) =>
      ICO_VERTS.map((b, j) => ({ j, d: dot(a, b) })).filter(({ j, d }) => j !== i && Math.abs(d - edgeCos) < 1e-6).map(({ j }) => j),
    );
    const order = hueOrder(adj);
    this.regions = ICO_VERTS.map((v, i) => {
      const e = anyTangent(vec3(), v);
      const t = cross(vec3(), e, v);
      const a = rng() * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const er = vec3(e.x * ca + t.x * sa, e.y * ca + t.y * sa, e.z * ca + t.z * sa);
      const s = cross(vec3(), er, v);
      const slot = order.indexOf(i);
      return { index: i, centre: v, e: er, s, hue: slot * 30, name: SLOTS[slot][0], fruit: SLOTS[slot][1], neighbours: adj[i] };
    });
    ICO_FACES.forEach((f, fi) => this.junctions.push({ p: f.n, regions: ICO_FACE_VERTS[fi] }));
    for (let i = 0; i < 12; i++) {
      for (const j of adj[i]) {
        if (j < i) continue;
        const faces = ICO_FACE_VERTS.map((fv, fi) => ({ fv, fi })).filter(({ fv }) => fv.includes(i) && fv.includes(j));
        this.borders.push({ a: i, b: j, p0: ICO_FACES[faces[0].fi].n, p1: ICO_FACES[faces[1].fi].n });
      }
    }

    // Largest odd pillar count whose district corner stays districtMinMargin inside the region (inradius = edge/2).
    const inradius = (ICO_EDGE_ARC / 2) * R;
    let pillars = 0;
    if (cfg.mazes) {
      for (let n = 7; n < 99; n += 2) {
        const h = (interiorTiles(n) * cfg.fineTile) / 2;
        const t = Math.tan(h / R);
        const corner = Math.acos(1 / Math.sqrt(1 + 2 * t * t)) * R;
        if (corner > inradius - cfg.districtMinMargin) break;
        pillars = n;
      }
    }
    this.pillars = pillars;
    this.gridTiles = pillars ? interiorTiles(pillars) + 2 * MARGIN_TILES : 0;
    this.halfInterior = pillars ? (interiorTiles(pillars) * cfg.fineTile) / 2 : 0;
  }

  /** Region whose centre is nearest to p. */
  regionAt(p: Vec3): number {
    let best = 0;
    let bestDot = -2;
    for (let i = 0; i < 12; i++) {
      const d = dot(p, this.regions[i].centre);
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Fraction of the sphere covered by district interiors (equiangular squares), used to scale plains food.
   */
  mazeShare(): number {
    if (!this.pillars) return 0;
    const R = this.R;
    const h = this.halfInterior;
    const N = 64;
    const du = (2 * h) / N;
    let area = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const X = Math.tan((-h + (i + 0.5) * du) / R);
        const Y = Math.tan((-h + (j + 0.5) * du) / R);
        const d = 1 + X * X + Y * Y;
        area += (((1 + X * X) * (1 + Y * Y)) / Math.pow(d, 1.5)) * du * du;
      }
    }
    return (12 * area) / (4 * Math.PI * R * R);
  }
}

/**
 * Orders the 12 regions around the hue circle so neighbouring regions are never adjacent in the order (≥ 60° apart).
 * The complement of the icosahedron graph has minimum degree 6 = n/2, so a Hamiltonian cycle exists (Dirac).
 */
function hueOrder(adj: number[][]): number[] {
  const n = adj.length;
  const path = [0];
  const used = new Array<boolean>(n).fill(false);
  used[0] = true;
  const ok = (a: number, b: number) => !adj[a].includes(b);
  const search = (): boolean => {
    if (path.length === n) return ok(path[n - 1], path[0]);
    const last = path[path.length - 1];
    for (let k = 0; k < n; k++) {
      if (used[k] || !ok(last, k)) continue;
      used[k] = true;
      path.push(k);
      if (search()) return true;
      path.pop();
      used[k] = false;
    }
    return false;
  };
  if (!search()) throw new Error('no hue order');
  return path;
}
