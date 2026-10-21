// Chrome, Firefox and WebKit in one room: every page builds the mazes itself from the map seed, and draws the host's
// world on them, so every engine has to build the same districts, tile for tile. A sort with a random comparator once
// made them differ (ai/next_1.md, bug 3). Opt-in: `npm run e2e:engines` (Playwright's own Firefox and WebKit:
// `npx playwright install firefox webkit`; WebKit on Linux also needs `sudo npx playwright install-deps webkit`).
import { type Browser, firefox, webkit } from '@playwright/test';
import { GAME, accept, createRoom, expect, host, play, player, status, test, why } from './p3p2.ts';

test.skip(why !== null, why ?? '');

/** A fingerprint of every district's tiles, as this page built them (all twelve, built now if not yet). */
const MAZES = () => {
  const maze = (window as unknown as { __game: { world: { maze: { district(i: number): { maze: { tiles: Uint8Array } } } } } }).__game.world.maze;
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    let h = 2166136261;
    for (const t of maze.district(i).maze.tiles) h = Math.imul(h ^ t, 16777619) >>> 0;
    out.push(h.toString(16));
  }
  return out;
};

async function launch(engine: typeof firefox): Promise<Browser | string> {
  try {
    // Not the config's Chrome channel and flags, which the test runner hands every launch.
    return await engine.launch({ channel: undefined, args: [] });
  } catch (e) {
    return String((e as Error).message).split('\n')[0];
  }
}

test('Chrome, Firefox and WebKit in one room: the same mazes, and the host’s world on each', async ({ browser, p3p2 }) => {
  test.setTimeout(120_000);
  const roomUrl = await createRoom(browser, p3p2, 'Engines');
  const ada = await player(browser, '/?mute=1&geo=0&district=8');
  const invite = await host(ada.page, roomUrl, 'Ada');
  await play(ada.page, 'Ada');
  const chrome = await ada.page.evaluate(MAZES);

  const others: { name: string; browser: Browser }[] = [];
  const skipped: string[] = [];
  for (const [name, engine] of [['Firefox', firefox], ['WebKit', webkit]] as const) {
    const b = await launch(engine);
    if (typeof b === 'string') skipped.push(`${name}: ${b}`);
    else others.push({ name, browser: b });
  }
  test.info().annotations.push(...skipped.map((d) => ({ type: 'skipped engine', description: d })));
  expect(others.length, `Firefox at least (${skipped.join('; ')})`).toBeGreaterThan(0);
  try {
    for (const { name, browser: b } of others) {
      const guest = await player(b, invite);
      await accept(guest.page, name);
      expect(await guest.page.evaluate(MAZES), `${name}'s districts`).toEqual(chrome);
      await play(guest.page, name);
      await expect.poll(async () => (await status(guest.page))?.human?.alive, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await status(guest.page))!.others.map((o) => o.name), { timeout: 15_000 }).toContain('Ada');
      expect(guest.errors, name).toEqual([]);
    }
  } finally {
    for (const { browser: b } of others) await b.close();
  }
  expect(ada.errors).toEqual([]);
  expect(GAME).toContain('localhost');
});
