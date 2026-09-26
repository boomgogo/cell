// Country flags (a sense of playing with people around the world): one WebP atlas of every ISO flag, loaded lazily after
// the first frame. Canvas text can't draw flags (Windows has no flag emoji), so flags are atlas cells: drawn next to cell
// names on the canvas, and as CSS backgrounds in the leaderboard. NPC countries are picked by population.
import atlasUrl from '../../assets/flags.webp';
import { FLAG_CODES, FLAG_COLS, FLAG_H, FLAG_W } from '../../assets/flagIndex.ts';
import { npcCountry } from '../../geo/countries.ts';
import type { Organism } from '../../sim/organism.ts';
import { stock } from './palette.ts';

/** Leaderboard flag size in CSS px. */
const ROW_W = 16;
const ROW_H = 12;

export class Flags {
  private readonly img: HTMLImageElement;
  private readonly slots = new Map<string, number>();

  constructor(img: HTMLImageElement) {
    this.img = img;
    FLAG_CODES.forEach((c, i) => this.slots.set(c, i));
  }

  has(code: string): boolean {
    return this.slots.has(code);
  }

  /** Draws the flag with its top-left at (x, y), `h` CSS px tall, with a key outline unless `plain`. */
  draw(ctx: CanvasRenderingContext2D, code: string, x: number, y: number, h: number, plain: boolean): void {
    const i = this.slots.get(code);
    if (i === undefined) return;
    const w = (h * 4) / 3;
    ctx.drawImage(this.img, (i % FLAG_COLS) * FLAG_W, Math.floor(i / FLAG_COLS) * FLAG_H, FLAG_W, FLAG_H, x, y, w, h);
    if (plain) return;
    ctx.lineWidth = Math.max(1, Math.min(2, h / 12));
    ctx.strokeStyle = stock.key;
    ctx.strokeRect(x, y, w, h);
  }

  /** Inline CSS for a leaderboard flag (an atlas cell as a background), or '' when there is none. */
  css(code: string): string {
    const i = this.slots.get(code);
    if (i === undefined) return '';
    const rows = Math.ceil(FLAG_CODES.length / FLAG_COLS);
    return (
      `background:url(${atlasUrl}) -${(i % FLAG_COLS) * ROW_W}px -${Math.floor(i / FLAG_COLS) * ROW_H}px/` +
      `${FLAG_COLS * ROW_W}px ${rows * ROW_H}px`
    );
  }
}

/** Loads and decodes the atlas. */
export async function loadFlags(): Promise<Flags> {
  const img = new Image();
  img.src = atlasUrl;
  await img.decode();
  return new Flags(img);
}

/** Gives every NPC colony a country; the human's comes from locate.ts and resident phages have none. */
export function assignCountries(organisms: readonly Organism[], seed: number): void {
  for (const o of organisms) if (!o.isHuman && !o.resident) o.country = npcCountry(seed, o.id);
}
