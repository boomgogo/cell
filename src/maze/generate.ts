// Seeded, left-right symmetric maze generator for one district. Pure data, no sphere maths:
// output is a fine tile map in grid coordinates (tile (i, j) covers [i, i+1) × [j, j+1), y down) plus special points.
//
// Interior layout (fine tiles): perimeter wall 1 · avenue ring 8 · core · avenue ring 8 · perimeter wall 1.
// The core is a coarse maze (coarse tile = 4 fine) of m = 2n − 1 cells per axis: pillars at (even, even), corridors
// elsewhere, then connectors between pillars are filled while the maze stays connected with no dead ends.
// Large solid blocks become fine "pockets" (1-fine-tile corridors) with 2–3 gates.
import { createRng, type Rng } from '../core/rng.ts';
import { AVENUE_TILES, COARSE_TILES, MARGIN_TILES, PERIMETER_TILES, interiorTiles } from './layout.ts';

export const OPEN = 0;
export const SOLID = 1;
/** Ghost pen interior: open for ghosts, solid for everyone else. */
export const PEN = 2;
/** Pen door: open for ghosts, solid for everyone else. */
export const DOOR = 3;

export interface Maze {
  /** Pillars per core axis. */
  n: number;
  /** Grid size in fine tiles (including the plains margin). */
  size: number;
  tiles: Uint8Array;
  /** Dot positions as (gx, gy) pairs in grid coordinates. */
  dots: Float32Array;
  /**
   * Power pellets (gx, gy) pairs, 12 per district: 4 in the corner pockets (fine corridors), 4 in coarse
   * corridors (a mirrored pair above and one below the pen) and 4 on the avenue ring (middle of each side).
   */
  power: Float32Array;
  start: [number, number];
  pen: [number, number];
  /** Just outside the pen door. */
  penExit: [number, number];
  /** Scatter targets: top-right, top-left, bottom-right, bottom-left. */
  corners: [number, number][];
  pockets: number;
}

const CORE_OFFSET = MARGIN_TILES + PERIMETER_TILES + AVENUE_TILES;

/** Smallest supported core (the pen, its corridor ring and the four corner pockets need 13 coarse cells). */
export const MIN_PILLARS = 7;

export function generateMaze(n: number, seed: number): Maze {
  for (let attempt = 0; attempt < 20; attempt++) {
    const maze = tryGenerate(n, seed + attempt * 1013);
    if (maze && validateMaze(maze).length === 0) return maze;
  }
  throw new Error(`maze generation failed for n=${n} seed=${seed}`);
}

function tryGenerate(n: number, seed: number): Maze | null {
  const rng = createRng(seed);
  const m = 2 * n - 1;
  const coarse = growCoarse(n, m, rng);
  if (!coarse) return null;

  const W = interiorTiles(n);
  const G = W + 2 * MARGIN_TILES;
  const tiles = new Uint8Array(G * G);
  const set = (i: number, j: number, t: number) => {
    tiles[j * G + i] = t;
  };
  const get = (i: number, j: number) => (i < 0 || j < 0 || i >= G || j >= G ? OPEN : tiles[j * G + i]);

  // Perimeter wall with gates: avenue (8), coarse (4) and fine (1) wide, same positions on all four sides.
  const lo = MARGIN_TILES;
  const hi = MARGIN_TILES + W - 1;
  for (let k = lo; k <= hi; k++) {
    set(k, lo, SOLID);
    set(k, hi, SOLID);
    set(lo, k, SOLID);
    set(hi, k, SOLID);
  }
  const gates: [number, number][] = [
    [W / 2 - 4, 8],
    [Math.floor(W / 4) - 2, 4],
    [W - Math.floor(W / 4) - 2, 4],
    [4, 1],
    [W - 5, 1],
  ];
  for (const [start, width] of gates) {
    for (let k = start; k < start + width; k++) {
      set(lo + k, lo, OPEN);
      set(lo + k, hi, OPEN);
      set(lo, lo + k, OPEN);
      set(hi, lo + k, OPEN);
    }
  }

  // Core: coarse cells → 4×4 fine blocks.
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const v = coarse[r * m + c];
      if (v === OPEN) continue;
      for (let dj = 0; dj < COARSE_TILES; dj++) {
        for (let di = 0; di < COARSE_TILES; di++) set(CORE_OFFSET + c * COARSE_TILES + di, CORE_OFFSET + r * COARSE_TILES + dj, SOLID);
      }
    }
  }
  // Pen: 3×3 coarse cells at the centre, 1-tile ring, 4-tile door at the top centre.
  const pen0 = CORE_OFFSET + (n - 2) * COARSE_TILES;
  const penSize = 3 * COARSE_TILES;
  for (let j = 0; j < penSize; j++) {
    for (let i = 0; i < penSize; i++) {
      const ring = i === 0 || j === 0 || i === penSize - 1 || j === penSize - 1;
      set(pen0 + i, pen0 + j, ring ? SOLID : PEN);
    }
  }
  for (let i = penSize / 2 - 2; i < penSize / 2 + 2; i++) set(pen0 + i, pen0, DOOR);

  // Pockets: fully solid 3×3 coarse squares at even offsets in the left half (the mirror copies them).
  const pocketOrigins: [number, number][] = [];
  const taken = new Uint8Array(m * m);
  const squares: [number, number][] = [];
  for (let r = 0; r + 2 < m; r += 2) for (let c = 0; c + 2 <= n - 2; c += 2) squares.push([r, c]);
  // Corner squares first (they hold the power pellets), then the rest in random order.
  const isCorner = ([r, c]: [number, number]) => c === 0 && (r === 0 || r === m - 3);
  squares.sort((a, b) => Number(isCorner(b)) - Number(isCorner(a)) || rng() - 0.5);
  let powerLeft: [number, number][] = [];
  for (const [r, c] of squares) {
    let solid = true;
    for (let dr = 0; dr < 3 && solid; dr++) for (let dc = 0; dc < 3 && solid; dc++) solid = coarse[(r + dr) * m + c + dc] === SOLID && !taken[(r + dr) * m + c + dc];
    if (!solid) continue;
    const ox = CORE_OFFSET + c * COARSE_TILES;
    const oy = CORE_OFFSET + r * COARSE_TILES;
    if (!carvePocket(ox, oy, get, set, rng)) continue;
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) taken[(r + dr) * m + c + dc] = 1;
    pocketOrigins.push([ox, oy]);
    if (isCorner([r, c])) powerLeft.push([ox + 1.5, r === 0 ? oy + 1.5 : oy + 10.5]);
  }
  if (powerLeft.length < 2) return null;
  powerLeft = powerLeft.slice(0, 2);

  // Mirror the left half onto the right half.
  for (let j = 0; j < G; j++) for (let i = 0; i < G / 2; i++) tiles[j * G + (G - 1 - i)] = tiles[j * G + i];

  // Dots.
  const dotSet = new Map<string, [number, number]>();
  const addDot = (x: number, y: number) => {
    if (get(Math.floor(x), Math.floor(y)) !== OPEN) return;
    dotSet.set(`${Math.round(x * 2)},${Math.round(y * 2)}`, [x, y]);
  };
  // Pockets (and their mirrors): every open tile.
  for (const [ox, oy] of pocketOrigins) {
    for (const mx of [ox, G - ox - penSize]) {
      for (let j = 1; j < penSize - 1; j++) for (let i = 1; i < penSize - 1; i++) addDot(mx + i + 0.5, oy + j + 0.5);
    }
  }
  // Avenue ring: two lanes, 2 tiles in from each side of the avenue.
  for (const off of [PERIMETER_TILES + 2, PERIMETER_TILES + AVENUE_TILES - 2]) {
    const a = lo + off;
    const b = lo + W - off;
    for (let k = a; k <= b; k++) {
      addDot(k, a);
      addDot(k, b);
      addDot(a, k);
      addDot(b, k);
    }
  }
  // Core corridors: along the centre lines toward each open neighbour (or out to the avenue's inner lane).
  const coarseOpen = (r: number, c: number) => (r < 0 || c < 0 || r >= m || c >= m ? true : coarse[r * m + c] === OPEN);
  // From an edge cell's centre out to the avenue's inner lane.
  const toLane = CORE_OFFSET + 2 - (MARGIN_TILES + PERIMETER_TILES + AVENUE_TILES - 2);
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      if (!coarseOpen(r, c)) continue;
      const cx = CORE_OFFSET + c * COARSE_TILES + 2;
      const cy = CORE_OFFSET + r * COARSE_TILES + 2;
      addDot(cx, cy);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!coarseOpen(r + dr, c + dc)) continue;
        const outside = r + dr < 0 || c + dc < 0 || r + dr >= m || c + dc >= m;
        const steps = outside ? toLane : 2;
        for (let k = 1; k <= steps; k++) addDot(cx + dc * k, cy + dr * k);
      }
    }
  }
  const startX = G / 2;
  const startY = CORE_OFFSET + (n + 1) * COARSE_TILES + 2;
  const penY = CORE_OFFSET + (n - 1) * COARSE_TILES + 2;
  const exitY = CORE_OFFSET + (n - 3) * COARSE_TILES + 2;
  const power: number[] = [];
  for (const [x, y] of powerLeft) power.push(x, y, G - x, y);
  // Coarse corridors: the centre of an open coarse cell left of the middle column, one row band above the pen ring and
  // one below it (mirrored), picked at random.
  for (const [r0, r1] of [[1, n - 4], [n + 2, m - 2]]) {
    const cands: [number, number][] = [];
    for (let r = r0; r <= r1; r++) for (let c = 1; c <= n - 2; c++) if (coarse[r * m + c] === OPEN) cands.push([r, c]);
    if (cands.length === 0) return null;
    const [r, c] = cands[Math.floor(rng() * cands.length)];
    const x = CORE_OFFSET + c * COARSE_TILES + 2;
    power.push(x, CORE_OFFSET + r * COARSE_TILES + 2, G - x, CORE_OFFSET + r * COARSE_TILES + 2);
  }
  // Avenue ring: the middle of each side, in front of the avenue gate.
  const mid = lo + PERIMETER_TILES + AVENUE_TILES / 2;
  power.push(G / 2, mid, G / 2, G - mid, mid, G / 2, G - mid, G / 2);
  const skip = new Set<string>([`${Math.round(startX * 2)},${Math.round(startY * 2)}`]);
  for (let k = 0; k < power.length; k += 2) skip.add(`${Math.round(power[k] * 2)},${Math.round(power[k + 1] * 2)}`);
  const dots: number[] = [];
  for (const [key, [x, y]] of dotSet) if (!skip.has(key)) dots.push(x, y);

  const c0 = CORE_OFFSET + COARSE_TILES + 2;
  const c1 = G - c0;
  return {
    n,
    size: G,
    tiles,
    dots: new Float32Array(dots),
    power: new Float32Array(power),
    start: [startX, startY],
    pen: [G / 2, penY],
    penExit: [G / 2, exitY],
    corners: [
      [c1, c0],
      [c0, c0],
      [c1, c1],
      [c0, c1],
    ],
    pockets: pocketOrigins.length * 2,
  };
}

// ------------------------------------------------------------------ coarse core

function growCoarse(n: number, m: number, rng: Rng): Uint8Array | null {
  const g = new Uint8Array(m * m);
  const fixed = new Uint8Array(m * m);
  const at = (r: number, c: number) => r * m + c;
  for (let r = 0; r < m; r += 2) for (let c = 0; c < m; c += 2) g[at(r, c)] = SOLID;
  // Corner blocks (future power pellet pockets).
  for (const r0 of [0, m - 3]) {
    for (const c0 of [0, m - 3]) {
      for (let r = r0; r < r0 + 3; r++) {
        for (let c = c0; c < c0 + 3; c++) {
          g[at(r, c)] = SOLID;
          fixed[at(r, c)] = 1;
        }
      }
    }
  }
  // Pen (3×3 at the centre) and a corridor ring around it (the pillars in line with its sides are removed).
  for (let r = n - 2; r <= n; r++) {
    for (let c = n - 2; c <= n; c++) {
      g[at(r, c)] = PEN;
      fixed[at(r, c)] = 1;
    }
  }
  for (let k = n - 3; k <= n + 1; k++) {
    for (const [r, c] of [[n - 3, k], [n + 1, k], [k, n - 3], [k, n + 1]]) {
      g[at(r, c)] = OPEN;
      fixed[at(r, c)] = 1;
    }
  }
  if (!coarseValid(g, m)) return null;

  const candidates: number[] = [];
  for (let r = 0; r < m; r++) {
    for (let c = 0; c <= n - 1; c++) {
      if ((r % 2) + (c % 2) === 1 && !fixed[at(r, c)] && g[at(r, c)] === OPEN) candidates.push(at(r, c));
    }
  }
  shuffle(candidates, rng);
  const target = Math.round(candidates.length * 0.32);
  let filled = 0;
  for (const idx of candidates) {
    if (filled >= target) break;
    const r = Math.floor(idx / m);
    const c = idx % m;
    const cells = [idx];
    const mc = m - 1 - c;
    if (mc !== c) cells.push(at(r, mc));
    const changed: number[] = [];
    for (const k of cells) {
      if (g[k] !== OPEN) continue;
      g[k] = SOLID;
      changed.push(k);
    }
    // Intersections that became enclosed are filled too (they would be isolated otherwise).
    for (const k of cells) {
      const kr = Math.floor(k / m);
      const kc = k % m;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = kr + dr;
        const cc = kc + dc;
        if (rr < 0 || cc < 0 || rr >= m || cc >= m || rr % 2 === 0 || cc % 2 === 0 || g[at(rr, cc)] !== OPEN) continue;
        const enclosed = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => {
          const r2 = rr + a;
          const c2 = cc + b;
          return r2 >= 0 && c2 >= 0 && r2 < m && c2 < m && g[at(r2, c2)] !== OPEN;
        });
        if (enclosed && !fixed[at(rr, cc)]) {
          g[at(rr, cc)] = SOLID;
          changed.push(at(rr, cc));
        }
      }
    }
    if (coarseValid(g, m)) filled++;
    else for (const k of changed) g[k] = OPEN;
  }
  return g;
}

/**
 * Every open cell has ≥ 2 open neighbours (outside the core counts as open), all open cells connect to the ring, and
 * no two blocked cells touch only diagonally.
 */
function coarseValid(g: Uint8Array, m: number): boolean {
  const open = (r: number, c: number) => r < 0 || c < 0 || r >= m || c >= m || g[r * m + c] === OPEN;
  for (let r = 0; r + 1 < m; r++) {
    for (let c = 0; c + 1 < m; c++) {
      const a = open(r, c);
      const b = open(r, c + 1);
      const d = open(r + 1, c);
      const e = open(r + 1, c + 1);
      if ((a && e && !b && !d) || (!a && !e && b && d)) return false;
    }
  }
  const seen = new Uint8Array(m * m);
  const stack: number[] = [];
  let openCount = 0;
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      if (g[r * m + c] !== OPEN) continue;
      openCount++;
      let nb = 0;
      if (open(r + 1, c)) nb++;
      if (open(r - 1, c)) nb++;
      if (open(r, c + 1)) nb++;
      if (open(r, c - 1)) nb++;
      if (nb < 2) return false;
      if ((r === 0 || c === 0 || r === m - 1 || c === m - 1) && !seen[r * m + c]) {
        seen[r * m + c] = 1;
        stack.push(r * m + c);
      }
    }
  }
  let reached = stack.length;
  while (stack.length) {
    const k = stack.pop()!;
    const r = Math.floor(k / m);
    const c = k % m;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m || cc >= m) continue;
      const kk = rr * m + cc;
      if (g[kk] !== OPEN || seen[kk]) continue;
      seen[kk] = 1;
      reached++;
      stack.push(kk);
    }
  }
  return reached === openCount;
}

// ------------------------------------------------------------------ fine pockets

const POCKET = 3 * COARSE_TILES;
const PILLAR = [2, 4, 7, 9];

/** Turns a solid 12×12 fine block at (ox, oy) into a pocket maze with 2–3 gates. Returns false (block untouched) if it can't. */
function carvePocket(
  ox: number,
  oy: number,
  get: (i: number, j: number) => number,
  set: (i: number, j: number, t: number) => void,
  rng: Rng,
): boolean {
  const L = POCKET;
  // Gate candidates: ring tiles (not corners) whose outside neighbour is open.
  const cands: [number, number][] = [];
  for (let k = 1; k < L - 1; k++) {
    if (get(ox + k, oy - 1) === OPEN) cands.push([k, 0]);
    if (get(ox + k, oy + L) === OPEN) cands.push([k, L - 1]);
    if (get(ox - 1, oy + k) === OPEN) cands.push([0, k]);
    if (get(ox + L, oy + k) === OPEN) cands.push([L - 1, k]);
  }
  if (cands.length < 2) return false;
  shuffle(cands, rng);
  const gates: [number, number][] = [];
  const side = ([i, j]: [number, number]) => (j === 0 ? 0 : j === L - 1 ? 1 : i === 0 ? 2 : 3);
  for (const g of cands) {
    if (gates.length >= 3) break;
    if (gates.some((h) => side(h) === side(g) || Math.abs(h[0] - g[0]) + Math.abs(h[1] - g[1]) < 4)) continue;
    gates.push(g);
  }
  if (gates.length < 2) return false;

  const local = new Uint8Array(L * L);
  const at = (i: number, j: number) => j * L + i;
  for (let j = 0; j < L; j++) {
    for (let i = 0; i < L; i++) {
      const ring = i === 0 || j === 0 || i === L - 1 || j === L - 1;
      local[at(i, j)] = ring || (PILLAR.includes(i) && PILLAR.includes(j)) ? SOLID : OPEN;
    }
  }
  for (const [i, j] of gates) local[at(i, j)] = OPEN;
  const nearGate = (i: number, j: number) => gates.some(([gi, gj]) => Math.abs(gi - i) + Math.abs(gj - j) <= 1);
  const cand: number[] = [];
  for (let j = 1; j < L - 1; j++) {
    for (let i = 1; i < L - 1; i++) {
      if (local[at(i, j)] !== OPEN || nearGate(i, j)) continue;
      if (Number(PILLAR.includes(i)) + Number(PILLAR.includes(j)) === 1) cand.push(at(i, j));
    }
  }
  shuffle(cand, rng);
  const target = Math.round(cand.length * 0.35);
  let filled = 0;
  for (const k of cand) {
    if (filled >= target) break;
    local[k] = SOLID;
    if (pocketValid(local, L, gates)) filled++;
    else local[k] = OPEN;
  }
  if (!pocketValid(local, L, gates)) return false;
  for (let j = 0; j < L; j++) for (let i = 0; i < L; i++) set(ox + i, oy + j, local[at(i, j)]);
  return true;
}

function pocketValid(g: Uint8Array, L: number, gates: [number, number][]): boolean {
  const isGate = (i: number, j: number) => gates.some(([gi, gj]) => gi === i && gj === j);
  const open = (i: number, j: number) => (i < 0 || j < 0 || i >= L || j >= L ? true : g[j * L + i] === OPEN);
  const seen = new Uint8Array(L * L);
  const stack: number[] = [];
  let count = 0;
  for (let j = 0; j < L; j++) {
    for (let i = 0; i < L; i++) {
      if (g[j * L + i] !== OPEN) continue;
      count++;
      const nb = Number(open(i + 1, j)) + Number(open(i - 1, j)) + Number(open(i, j + 1)) + Number(open(i, j - 1));
      if (nb < 2) return false;
      if (isGate(i, j)) {
        seen[j * L + i] = 1;
        stack.push(j * L + i);
      }
    }
  }
  let reached = stack.length;
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % L;
    const j = Math.floor(k / L);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= L || jj >= L) continue;
      const kk = jj * L + ii;
      if (g[kk] !== OPEN || seen[kk]) continue;
      seen[kk] = 1;
      reached++;
      stack.push(kk);
    }
  }
  return reached === count;
}

// ------------------------------------------------------------------ validation (also used by tests)

/** Returns a list of problems; empty when the maze satisfies the generator invariants. */
export function validateMaze(maze: Maze): string[] {
  const { size: G, tiles } = maze;
  const problems: string[] = [];
  const t = (i: number, j: number) => (i < 0 || j < 0 || i >= G || j >= G ? OPEN : tiles[j * G + i]);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G / 2; i++) {
      if (tiles[j * G + i] !== tiles[j * G + G - 1 - i]) {
        problems.push(`asymmetric at ${i},${j}`);
        return problems;
      }
    }
  }
  // Open tiles (regular mask): connected, and no dead ends.
  const seen = new Uint8Array(G * G);
  const stack = [0];
  seen[0] = 1;
  let openCount = 0;
  for (let k = 0; k < G * G; k++) if (tiles[k] === OPEN) openCount++;
  let reached = 1;
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % G;
    const j = Math.floor(k / G);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= G || jj >= G) continue;
      const kk = jj * G + ii;
      if (tiles[kk] !== OPEN || seen[kk]) continue;
      seen[kk] = 1;
      reached++;
      stack.push(kk);
    }
  }
  if (reached !== openCount) problems.push(`disconnected: ${openCount - reached} open tiles unreachable`);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      if (t(i, j) !== OPEN) continue;
      const nb = [t(i + 1, j), t(i - 1, j), t(i, j + 1), t(i, j - 1)].filter((v) => v === OPEN).length;
      if (nb < 2) problems.push(`dead end at ${i},${j}`);
    }
  }
  // Diagonal-only solid contacts would make the wall outline ambiguous.
  for (let j = 0; j + 1 < G; j++) {
    for (let i = 0; i + 1 < G; i++) {
      const a = t(i, j) === SOLID;
      const b = t(i + 1, j) === SOLID;
      const c = t(i, j + 1) === SOLID;
      const d = t(i + 1, j + 1) === SOLID;
      if ((a && d && !b && !c) || (b && c && !a && !d)) problems.push(`diagonal contact at ${i},${j}`);
    }
  }
  if (maze.power.length !== 24) problems.push('expected 12 power pellets');
  for (let k = 0; k < maze.power.length; k += 2) {
    const x = maze.power[k];
    const y = maze.power[k + 1];
    // Spots sit on tile centres or on tile corners (coarse cell centres); every tile touching one must be open.
    for (const [ox, oy] of [[0, 0], [-0.5, 0], [0, -0.5], [-0.5, -0.5]]) {
      if (t(Math.floor(x + ox), Math.floor(y + oy)) !== OPEN) problems.push(`power pellet on a wall at ${x},${y}`);
    }
  }
  for (let k = 0; k < maze.dots.length; k += 2) {
    if (t(Math.floor(maze.dots[k]), Math.floor(maze.dots[k + 1])) !== OPEN) problems.push('dot on a wall');
  }
  return problems;
}

function shuffle<T>(a: T[], rng: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
}
