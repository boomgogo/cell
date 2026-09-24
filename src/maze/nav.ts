// Radius-aware path flood over a district's fine tiles: Dijkstra from one tile through tiles with enough
// clearance for the mover, recording path cost, predecessor and first hop for every reached tile. One instance is
// shared by all controllers (it is used synchronously inside a think), so there are no per-NPC grid buffers.
import type { District, WallMask } from './district.ts';
import { DOOR, PEN } from './generate.ts';

const SQRT2 = Math.SQRT2;
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

export class Flood {
  district: District | null = null;
  start = -1;
  /** Path cost in tiles. Valid only where `reached(t)`. */
  cost = new Float32Array(0);
  parent = new Int32Array(0);
  first = new Int32Array(0);
  /** Tiles reached by the last run, in order of settlement. */
  list = new Int32Array(0);
  count = 0;
  private stamp = new Uint32Array(0);
  private settled = new Uint32Array(0);
  private cur = 0;
  private heap = new Float64Array(0);
  private heapSize = 0;

  private ensure(n: number): void {
    if (this.cost.length === n) return;
    this.cost = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.first = new Int32Array(n);
    this.list = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.settled = new Uint32Array(n);
    this.heap = new Float64Array(n * 8);
    this.cur = 0;
  }

  reached(t: number): boolean {
    return t >= 0 && t < this.stamp.length && this.settled[t] === this.cur;
  }

  /**
   * Floods from tile `start` for a mover of radius `r`. Stops after `maxNodes` settled tiles or beyond `maxCost` tiles.
   * With `goal` ≥ 0 it runs as A* (octile heuristic) and stops once the goal is settled. The start tile is always
   * included even when it lacks clearance (the mover is already there).
   */
  run(d: District, start: number, r: number, mask: WallMask, maxNodes: number, maxCost: number, goal = -1): void {
    const G = d.G;
    const n = G * G;
    this.ensure(n);
    this.district = d;
    this.start = start;
    this.count = 0;
    if (++this.cur === 0xffffffff) {
      this.stamp.fill(0);
      this.settled.fill(0);
      this.cur = 1;
    }
    const cur = this.cur;
    if (start < 0 || start >= n) return;
    const cost = this.cost;
    const stamp = this.stamp;
    const settled = this.settled;
    const parent = this.parent;
    const first = this.first;
    const clear = d.tileClear;
    const tiles = d.tiles;
    const ghost = mask === 1;
    const gi = goal >= 0 ? goal % G : 0;
    const gj = goal >= 0 ? (goal - gi) / G : 0;
    const K = SQRT2 - 1;
    const h = (i: number, j: number) => {
      if (goal < 0) return 0;
      const dx = i > gi ? i - gi : gi - i;
      const dy = j > gj ? j - gj : gj - j;
      return dx > dy ? dx + K * dy : dy + K * dx;
    };
    const ok = (v: number) => clear[v] >= r || (ghost && (tiles[v] === PEN || tiles[v] === DOOR));
    this.heapSize = 0;
    stamp[start] = cur;
    cost[start] = 0;
    parent[start] = -1;
    first[start] = start;
    this.push(Math.round(h(start % G, (start - (start % G)) / G) * 64), start);
    while (this.heapSize > 0 && this.count < maxNodes) {
      const top = this.pop();
      const t = top % 65536;
      if (settled[t] === cur) continue;
      const c = cost[t];
      const i = t % G;
      const j = (t - i) / G;
      if (Math.round((c + h(i, j)) * 64) !== (top - t) / 65536) continue;
      settled[t] = cur;
      this.list[this.count++] = t;
      if (t === goal) break;
      if (c > maxCost) continue;
      for (let k = 0; k < 8; k++) {
        const ii = i + DI[k];
        const jj = j + DJ[k];
        if (ii < 0 || jj < 0 || ii >= G || jj >= G) continue;
        const v = jj * G + ii;
        if (settled[v] === cur || !ok(v)) continue;
        if (k >= 4 && (!ok(j * G + ii) || !ok(jj * G + i))) continue;
        const nc = c + (k >= 4 ? SQRT2 : 1);
        if (stamp[v] === cur && cost[v] <= nc) continue;
        stamp[v] = cur;
        cost[v] = nc;
        parent[v] = t;
        first[v] = t === start ? v : first[t];
        this.push(Math.round((nc + h(ii, jj)) * 64), v);
      }
    }
  }

  /** The tile `ahead` steps along the path from the start toward t (or t itself when closer). */
  stepToward(t: number, ahead: number): number {
    if (!this.reached(t)) return -1;
    // Walk back from t, keeping the last `ahead + 1` tiles in a small ring.
    const ring = RING;
    let n = 0;
    let v = t;
    while (v >= 0 && v !== this.start) {
      ring[n % ring.length] = v;
      n++;
      v = this.parent[v];
      if (n > 4096) break;
    }
    if (n === 0) return t;
    const k = Math.min(ahead, n);
    return ring[(n - k + ring.length * 8) % ring.length];
  }

  private push(key: number, node: number): void {
    const h = this.heap;
    let i = this.heapSize++;
    const val = key * 65536 + node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= val) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = val;
  }

  private pop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h[--this.heapSize];
    let i = 0;
    const n = this.heapSize;
    while (true) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const m = r < n && h[r] < h[l] ? r : l;
      if (h[m] >= last) break;
      h[i] = h[m];
      i = m;
    }
    h[i] = last;
    return top;
  }
}

const RING = new Int32Array(32);

/** One flood buffer shared by every controller (floods run synchronously inside a think). */
export const sharedFlood = new Flood();
