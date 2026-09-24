// Cached outlined text (names, mass) on offscreen canvases, keyed by text + pixel size. Paper-coloured letters with a
// key outline: they sit on cell inks, so they reverse out of the ink like printed labels.
import { stock } from './palette.ts';
interface Entry {
  canvas: HTMLCanvasElement;
  used: number;
}

const cache = new Map<string, Entry>();
let frame = 0;
const FONT = '700 {px}px system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';

export function textFrame(): void {
  frame++;
  if (frame % 120 === 0) {
    for (const [k, e] of cache) if (frame - e.used > 240) cache.delete(k);
  }
}

/** Returns a canvas with `text` rendered at roughly `px` CSS px (bucketed), scaled for DPR. */
export function textSprite(text: string, px: number, dpr: number): HTMLCanvasElement {
  const size = Math.max(8, Math.min(160, Math.round(px / 2) * 2));
  const key = `${size}|${dpr}|${stock.key}|${text}`;
  let e = cache.get(key);
  if (!e) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    const font = FONT.replace('{px}', String(size * dpr));
    g.font = font;
    const pad = Math.ceil(size * 0.15 * dpr) + 2;
    c.width = Math.ceil(g.measureText(text).width) + pad * 2;
    c.height = Math.ceil(size * 1.25 * dpr) + pad * 2;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, size * 0.12 * dpr);
    g.strokeStyle = stock.key;
    g.fillStyle = stock.paper;
    g.strokeText(text, c.width / 2, c.height / 2);
    g.fillText(text, c.width / 2, c.height / 2);
    e = { canvas: c, used: frame };
    cache.set(key, e);
  }
  e.used = frame;
  return e.canvas;
}
