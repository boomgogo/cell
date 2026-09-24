// Every game rule in one place. Systems call these instead of reading raw constants,
// so species traits and preset tuning apply everywhere.
import type { GameConfig } from '../config/types.ts';
import type { Cell } from './cell.ts';
import { PLAYER, VIRUS, EJECTED } from './cell.ts';
import type { Organism } from './organism.ts';

export const massToRadius = (mass: number): number => Math.sqrt(mass * 100);
export const radiusToMass = (r: number): number => (r * r) / 100;

export function ticksPerSecond(cfg: GameConfig): number {
  return 1000 / cfg.tickMs;
}

/** Full player speed in world units per tick (2.1106 / r^0.449 × 40 per 40 ms). */
export function speedPerTick(cfg: GameConfig, cell: Cell): number {
  const species = (cell.owner?.species.speed ?? 1) * (cell.owner?.speedFactor ?? 1);
  return ((2.1106 / Math.pow(cell.r, 0.449)) * 40 * cfg.speedScale * species * cfg.tickMs) / 40;
}

/** Distance moved this tick toward a target `dist` world units away. */
export function moveStep(cfg: GameConfig, cell: Cell, dist: number): number {
  if (dist < 1) return 0;
  return Math.min(speedPerTick(cfg, cell) * (Math.min(dist, 32) / 32), dist);
}

/** Can `eater` eat `prey` by kind (ignores size and distance)? */
export function canEatKind(eater: Cell, prey: Cell, virusCount: number, virusMax: number): boolean {
  if (eater.kind === PLAYER) return prey.kind === PLAYER || (eater.owner?.species.eatsFood ?? true);
  if (eater.kind === VIRUS) return prey.kind === EJECTED && virusCount < virusMax;
  return false;
}

export function bigEnoughToEat(cfg: GameConfig, eaterR: number, preyR: number, eaterSpeciesRatio = 1): boolean {
  return eaterR >= preyR * cfg.eatSizeRatio * eaterSpeciesRatio;
}

/** Centre distance below which the bigger cell swallows the smaller one. */
export function eatReach(cfg: GameConfig, eaterR: number, preyR: number, virusEatingEjected: boolean): number {
  const div = virusEatingEjected ? cfg.virusEatDepthDivisor : cfg.eatDepthDivisor;
  return eaterR - preyR / div;
}

/** Ticks from a player cell's birth until it may merge back: longer for big cells, scaled by species. */
export function mergeDelayTicks(cfg: GameConfig, cell: Cell): number {
  const seconds = Math.max(cfg.mergeSeconds, cfg.mergeSecondsPerRadius * cell.r);
  return seconds * (cell.owner?.species.mergeTime ?? 1) * ticksPerSecond(cfg);
}

/** Is the organism in the rainbow state? */
export function isRainbow(org: Organism | null, tick: number): boolean {
  return org !== null && tick < org.rainbowUntil;
}

/**
 * Piece masses when a rainbow cell of mass `m` explodes a cell of mass `M`, or null when there is nothing
 * to split into (no room for another cell, or less than two minimum pieces of mass). The first entry is the largest
 * chunk, which the exploded cell keeps. About half of the rest are crumbs of 0.3–0.7 m (together at most
 * explodeCrumbShare · M) that the exploder can eat at once; the others are chunks of at most M/3 for the chain to explode
 * next. Small cells that can't make that many pieces split in half. The masses sum to M. `room` is how many extra cells
 * the victim may still have.
 */
export function fragmentMasses(cfg: GameConfig, M: number, m: number, room: number, rng: () => number): number[] | null {
  const minMass = cfg.explodeMinMass;
  if (room < 1 || M < 2 * minMass) return null;
  let n = Math.round(4 + 2 * Math.log2(Math.max(M / Math.max(m, 1e-6), 1)));
  n = Math.min(Math.max(5, Math.min(14, n)), room + 1);

  const crumbs: number[] = [];
  const budget = M * cfg.explodeCrumbShare;
  let crumbTotal = 0;
  for (let k = 0; k < Math.floor(n / 2); k++) {
    let c = m * (0.3 + 0.4 * rng());
    if (crumbTotal + c > budget) {
      // Always one crumb if the budget allows any.
      if (k > 0) break;
      c = budget;
    }
    if (c < minMass) break;
    crumbs.push(c);
    crumbTotal += c;
  }

  const count = n - crumbs.length;
  const rest = M - crumbTotal;
  // With fewer than three chunks the M/3 cap can't hold (only when the victim is nearly out of room).
  const cap = count >= 3 ? M / 3 : rest;
  const chunks: number[] = [];
  let weights = 0;
  for (let k = 0; k < count; k++) {
    const w = 0.15 + rng() ** 2;
    chunks.push(w);
    weights += w;
  }
  for (let k = 0; k < count; k++) chunks[k] = (chunks[k] / weights) * rest;
  // Clamp to the cap and hand the excess to the chunks below it, in proportion.
  for (let iter = 0; iter < 16; iter++) {
    let excess = 0;
    let below = 0;
    for (let k = 0; k < count; k++) {
      if (chunks[k] > cap) {
        excess += chunks[k] - cap;
        chunks[k] = cap;
      } else if (chunks[k] < cap) below += chunks[k];
    }
    if (excess < 1e-9 || below <= 0) break;
    for (let k = 0; k < count; k++) if (chunks[k] < cap) chunks[k] += (excess * chunks[k]) / below;
  }
  chunks.sort((a, b) => b - a);
  // Pieces under the minimum go back into the largest chunk.
  const out: number[] = [chunks[0]];
  for (const c of [...chunks.slice(1), ...crumbs]) {
    if (c >= minMass) out.push(c);
    else out[0] += c;
  }
  return out.length >= 2 ? out : [M / 2, M / 2];
}

/**
 * Virus pop: masses of the pieces that burst off a cell of `mass` with `slots` free cell slots; the cell keeps the rest
 * (at least `minPiece`). One free slot splits the cell in half. Otherwise a few large pieces come first, the first
 * 15–22 % of the cell and each next one 45–60 % of the one before, while they stay above 4 × minPiece; then every slot
 * left gets a piece of `minPiece`, as far as the mass goes. So a big cell bursts into a spray of crumbs around a few
 * chunks, and a small one into crumbs only.
 */
export function popPieces(mass: number, slots: number, minPiece: number, rng: () => number): number[] {
  const out: number[] = [];
  if (slots < 1 || mass < 2 * minPiece) return out;
  if (slots === 1) {
    out.push(mass / 2);
    return out;
  }
  let rest = mass;
  let piece = mass * (0.15 + 0.07 * rng());
  while (out.length < slots && piece >= 4 * minPiece && rest - piece >= minPiece) {
    out.push(piece);
    rest -= piece;
    piece *= 0.45 + 0.15 * rng();
  }
  while (out.length < slots && rest - minPiece >= minPiece) {
    out.push(minPiece);
    rest -= minPiece;
  }
  return out;
}

/** Movement factor for a cell squeezed in a corridor narrower than its diameter. */
export function squeezeSpeed(cfg: GameConfig, squeeze: number): number {
  return squeeze >= 1 ? 1 : Math.max(cfg.squeezeMinSpeed, squeeze);
}

export function maxCells(cfg: GameConfig, cell: Cell): number {
  return Math.round(cfg.cellLimit * (cell.owner?.species.maxCells ?? 1));
}

/** Share of its mass a cell keeps through one second of decay. */
function decayKeep(cfg: GameConfig, cell: Cell): number {
  return 1 - cfg.decayRate * (cell.owner?.species.decay ?? 1);
}

/** Radius after one second of decay. Cells at minRadius or below don't decay, and decay never takes one under it. */
export function decayedRadius(cfg: GameConfig, cell: Cell): number {
  const r = cell.r;
  return r <= cfg.minRadius ? r : Math.max(cfg.minRadius, Math.sqrt(r * r * decayKeep(cfg, cell)));
}

/** Packed mass after one second of decay: the same share as the rest of the cell. */
export function decayedPacked(cfg: GameConfig, cell: Cell): number {
  return cell.packed * decayKeep(cfg, cell);
}

/**
 * Radius after one packing step for a cell of radius r carrying `packed` mass, where the widest way out
 * has radius `room` (Infinity in the open). Bigger than the way out: straight down to room − packMargin (the caller
 * packs the rest). A cell that still fits (up to `room`) is left alone, so a cell hugging a wall with its centre in a
 * corridor's edge tile doesn't pack a sliver. Packed and with room to spare: back toward the full size, growing at most
 * packRelease per tick up to room − packMargin, and only while the cell isn't pressed into a wall (`clearance` ≥ r − 1).
 * The caller keeps the mass: packed += (r² − new r²) / 100.
 */
export function packedRadius(cfg: GameConfig, r: number, packed: number, room: number, clearance: number): number {
  const cap = room - cfg.packMargin;
  // A room that can't hold a start-size cell only shows up for a centre pushed into a wall corner: leave it be.
  if (cap < cfg.minRadius) return r;
  if (r > room) return cap;
  if (packed <= 0 || r >= cap || clearance < r - 1) return r;
  return Math.min(cap, Math.sqrt(r * r + packed * 100), r * (1 + cfg.packRelease));
}

/** Zoom for a total cell radius on a viewport of w×h CSS px (before wheel zoom). */
export function viewScale(cfg: GameConfig, sumRadius: number, w: number, h: number): number {
  const base = Math.pow(Math.min(64 / Math.max(sumRadius, 1), 1), 0.4);
  return base * Math.max(h / cfg.viewBaseHeight, w / cfg.viewBaseWidth);
}
