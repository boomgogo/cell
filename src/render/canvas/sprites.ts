// Pellets: flat ink squares, bucketed by ink so a frame sets one fillStyle per ink.
import { inkFor, inkSlot } from './palette.ts';

export const PELLET_BUCKETS = 12;

export const hueBucket = inkSlot;

/** Draws one pellet of screen radius r centred at (x, y) (ghosts and special food; the bulk is batched). */
export function drawPellet(ctx: CanvasRenderingContext2D, hue: number, x: number, y: number, r: number): void {
  const s = pelletSide(r);
  ctx.fillStyle = inkFor(hue);
  ctx.fillRect(x - s / 2, y - s / 2, s, s);
}

/** Side of the square drawn for a pellet of screen radius r (about the circle's area). */
export const pelletSide = (r: number): number => Math.max(1.5, r * 1.7);
