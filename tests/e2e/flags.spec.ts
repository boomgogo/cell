// Country flags (the player's from a stubbed /cdn-cgi/trace, NPCs' by population), the GitHub link on the menu, and
// no blank frames when adaptive quality changes level.
import { expect, test } from '@playwright/test';

interface GameHandle {
  state: string;
  human: { country: string };
  world: { tick: number; organisms: { isHuman: boolean; resident: unknown; country: string }[] };
  renderer: { flags: unknown; stats: { resizes: number }; canvas: HTMLCanvasElement };
  quality: { level: number; apply(o: unknown): void; enabled: boolean };
  opts: unknown;
  advance(ms: number): void;
}
type W = { __game: GameHandle };

test('flags: the player from the Cloudflare trace, NPCs by population, flags in the leaderboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/cdn-cgi/trace', (r) => r.fulfill({ body: 'fl=1\nip=1.2.3.4\nloc=NZ\n' }));
  await page.route(/country\.is|geojs\.io/, (r) => r.abort());
  await page.goto('/?seed=5&mute=1');
  await page.waitForFunction(() => (window as unknown as W).__game?.renderer.flags !== null, null, { timeout: 10_000 });
  await page.fill('#nick', 'kiwi');
  await page.click('#play');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__game.human.country)).toBe('nz');
  const { npcs, flagged, residentsFlagged } = await page.evaluate(() => {
    const o = (window as unknown as W).__game.world.organisms.filter((x) => !x.isHuman);
    const npc = o.filter((x) => !x.resident);
    return { npcs: npc.length, flagged: npc.filter((x) => /^[a-z]{2}$/.test(x.country)).length, residentsFlagged: o.filter((x) => x.resident && x.country).length };
  });
  expect(flagged).toBe(npcs);
  expect(residentsFlagged).toBe(0);
  await expect(page.locator('#lb li .fl').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('flags: every lookup failing still plays, without a player flag', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/cdn-cgi/trace', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await page.route(/country\.is|geojs\.io/, (r) => r.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { get: () => 'en' }));
  await page.goto('/?seed=5&mute=1');
  await page.waitForFunction(() => (window as unknown as W).__game?.renderer.flags !== null, null, { timeout: 10_000 });
  await page.click('#play');
  await expect(page.locator('#menu')).toBeHidden();
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => (window as unknown as W).__game.human.country)).toBe('');
  expect(errors).toEqual([]);
});

test('GitHub link on the menu', async ({ page }) => {
  await page.goto('/?seed=5&mute=1&geo=0');
  const link = page.locator('#menu #fork');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://github.com/boomgogo/cell');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveText('Fork me on GitHub');
  // The nick field keeps focus.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('nick');
});

test('adaptive quality: a level change never shows a blank frame', async ({ page }) => {
  await page.goto('/?seed=5&mute=1&geo=0&flags=0&manual=1');
  await page.waitForFunction(() => (window as unknown as W).__game?.world !== undefined);
  // Drive frames by hand and step the level through every change; after each frame the canvas must not be one colour.
  const blanks = await page.evaluate(() => {
    const g = (window as unknown as W).__game as unknown as GameHandle & { pendingResize: boolean };
    const c = g.renderer.canvas;
    const ctx = c.getContext('2d')!;
    const uniform = () => {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 4; i < d.length; i += 4 * 97) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
      return true;
    };
    let blank = 0;
    for (let k = 0; k < 5; k++) g.advance(16.7);
    for (const level of [1, 2, 3, 4, 5, 6, 3, 0]) {
      g.quality.level = level;
      g.quality.apply(g.opts);
      g.pendingResize = true;
      for (let k = 0; k < 3; k++) {
        g.advance(16.7);
        if (uniform()) blank++;
      }
    }
    return blank;
  });
  expect(blanks).toBe(0);
});
