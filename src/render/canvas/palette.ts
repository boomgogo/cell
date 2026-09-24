// Colours: a risograph print. Twelve flat spot inks addressed by hue (region hues are slot × 30, so every
// region keeps its own ink), one dark "key" for every outline, on off-white paper — or the same inks on dark stock with
// the key inverted. No gradients, no glows.
//
// Inks two slots apart can meet at a region border (the region hue order only guarantees ≥ 2 slots between neighbours),
// so every such pair differs by ≥ 15 L* and stays apart under deuteranopia (tests/unit/palette.test.ts).
// Slots 0, 2, 5, 9 and 11 are the hand-picked inks; 7 is a blue darkened to a navy and the other six
// were balanced around them.
export const INKS = [
  '#ff665e', // 0 coral red
  '#d9622b', // 1 burnt orange
  '#ffc846', // 2 amber
  '#c9dc6a', // 3 lime
  '#3fa34d', // 4 green
  '#00a98f', // 5 emerald
  '#6fcfcf', // 6 aqua
  '#173f7a', // 7 navy
  '#6a8fe6', // 8 cornflower
  '#7b4fbf', // 9 purple
  '#7e3490', // 10 plum
  '#f28ec0', // 11 pink
];

export interface Stock {
  /** Floor. */
  paper: string;
  /** Floor dot grid. */
  dots: string;
  /** Every outline and on-canvas text outline. */
  key: string;
  /** How strongly a district's ink screens its floor. */
  screen: number;
}

export const PAPER: Stock = { paper: '#f7f4ec', dots: '#ddd6c5', key: '#241f1c', screen: 0.06 };
export const PRESS: Stock = { paper: '#1b1a17', dots: '#3a352d', key: '#f7f4ec', screen: 0.1 };

/** The stock being printed on; set by setStock when the theme changes. */
export let stock: Stock = PAPER;
const inkIndex = new Uint8Array(360);
for (let h = 0; h < 360; h++) inkIndex[h] = Math.round(h / 30) % 12;

export const inkSlot = (hue: number): number => inkIndex[((Math.round(hue) % 360) + 360) % 360];
export const inkFor = (hue: number): string => INKS[inkSlot(hue)];

/** Fill of a cell, pellet or wall of this hue. */
export const fillColor = inkFor;
/** Outline of a cell of this hue: the key (one stroke colour per frame). */
export const ringColor = (_hue: number): string => stock.key;
/** Bright colour of a hue (sparks, pings, minimap). */
export const glowColor = inkFor;
/** Wall and border colour of a region hue (both stocks). */
export const neon = inkFor;
export const wallLight = inkFor;

export const VIRUS_FILL = INKS[4];
export const DOOR_COLOR = INKS[11];
export const DOOR_LIGHT = INKS[10];

/** Rainbow wheel: six inks round the wheel, outlined in key. */
export const RAINBOW_FILL = [0, 2, 4, 5, 8, 9].map((k) => INKS[k]);

let screens = new Map<string, string>();

export function setStock(dark: boolean): void {
  stock = dark ? PRESS : PAPER;
  screens = new Map();
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The stock with a region's ink screened over it, optionally blended toward a neighbour's (w ∈ [0, 0.5]). */
export function floorColor(hue: number, otherHue = hue, w = 0): string {
  const key = `${inkSlot(hue)}|${inkSlot(otherHue)}|${w}`;
  let c = screens.get(key);
  if (c) return c;
  const p = rgb(stock.paper);
  const a = rgb(inkFor(hue));
  const b = rgb(inkFor(otherHue));
  const s = stock.screen;
  const ch = (k: number) => Math.round(p[k] + (a[k] + (b[k] - a[k]) * w - p[k]) * s);
  c = `rgb(${ch(0)},${ch(1)},${ch(2)})`;
  screens.set(key, c);
  return c;
}

// ------------------------------------------------------------------ contrast (tests and the playtest checks)

const lin = (c: number) => (c <= 0.04045 * 255 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
