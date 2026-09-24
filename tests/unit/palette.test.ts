// The risograph inks. The key carries every shape, so the key is what must contrast with the
// stock; inks that can meet at a region border must stay apart, also for deuteranopes (lightness survives colour blindness).
import { describe, expect, it } from 'vitest';
import { GHOSTS } from '../../src/ai/population.ts';
import { INKS, PAPER, PRESS, contrast, inkFor, inkSlot } from '../../src/render/canvas/palette.ts';

const lin = (c: number) => (c <= 10.31475 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const rgbLin = (hex: string) => [1, 3, 5].map((k) => lin(parseInt(hex.slice(k, k + 2), 16)));

function lab([r, g, b]: number[]): number[] {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** Viénot et al. (1999) deuteranopia simulation in linear RGB. */
function deuteranope(hex: string): number[] {
  const [r, g, b] = rgbLin(hex);
  const rg = 0.29275 * r + 0.70725 * g;
  return lab([rg, rg, Math.min(1, Math.max(0, -0.02234 * r + 0.02234 * g + b))]);
}

const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('risograph palette', () => {
  it('maps every hue to one of the 12 inks, and the 12 region hues to 12 distinct inks', () => {
    for (let h = 0; h < 360; h++) expect(INKS).toContain(inkFor(h));
    expect(new Set(Array.from({ length: 12 }, (_, k) => inkFor(k * 30))).size).toBe(12);
    // Stable across the wrap.
    expect(inkFor(359)).toBe(inkFor(0));
    expect(inkFor(-30)).toBe(inkFor(330));
    expect(inkFor(720 + 60)).toBe(inkFor(60));
    expect(inkSlot(14.4)).toBe(0);
    expect(inkSlot(15)).toBe(1);
  });

  it('key outlines contrast with both stocks (WCAG ≥ 4.5)', () => {
    expect(contrast(PAPER.key, PAPER.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PRESS.key, PRESS.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('inks two slots apart (possible map neighbours) differ by ≥ 15 L* and ≥ 18 ΔE for a deuteranope', () => {
    for (let k = 0; k < 12; k++) {
      const a = INKS[k];
      const b = INKS[(k + 2) % 12];
      const dL = Math.abs(lab(rgbLin(a))[0] - lab(rgbLin(b))[0]);
      expect(dL, `${k} vs ${(k + 2) % 12}: ΔL*`).toBeGreaterThanOrEqual(15);
      expect(dE(deuteranope(a), deuteranope(b)), `${k} vs ${(k + 2) % 12}: deuteranope ΔE`).toBeGreaterThanOrEqual(18);
    }
  });

  it('the four resident phages have inks of their own: distinct, and none of red, orange, amber, green, aqua or pink', () => {
    const slots = GHOSTS.map((g) => inkSlot(g.hue));
    expect(new Set(slots).size).toBe(4);
    // Coral red, burnt orange, aqua and pink would make the classic four-ghost set; amber is the classic hero's
    // colour; green is the virus.
    for (const s of slots) expect([0, 1, 2, 4, 6, 11]).not.toContain(s);
  });
});
