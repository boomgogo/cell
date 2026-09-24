// Start → play → die → respawn, on desktop and phone viewports, for the
// arcade (default) and base presets. The arcade run also checks the maze HUD (minimap, district banner, points), the
// home arrow, the paper floor inside a maze and in the plains, and a rainbow explosion. Also: leaderboard masses and
// the dark press stock.
import { expect, test, type Page } from '@playwright/test';

interface GameHandle {
  state: string;
  points: number;
  human: { alive: boolean; mass: number; cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] };
  world: {
    tick: number;
    maze: { enabled: boolean; inInterior(p: unknown): boolean };
    organisms: { isHuman: boolean; alive: boolean; dormant: boolean; resident: unknown; cells: { p: { x: number; y: number; z: number }; r: number; prev: { x: number; y: number; z: number } }[] }[];
  };
}
type W = { __game: GameHandle };

/** Most common canvas colour on a sparse pixel grid: the floor. */
function floorColour(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = document.getElementById('game') as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const counts = new Map<number, number>();
    for (let y = 0; y < c.height; y += 13) {
      for (let x = 0; x < c.width; x += 13) {
        const i = (y * c.width + x) * 4;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let best = 0;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return [best >> 16, (best >> 8) & 255, best & 255];
  });
}

/** Paper stock. A district's ink is screened over it at 6 %, so allow a little per channel. */
const PAPER = [0xf7, 0xf4, 0xec];
const PRESS = [0x1b, 0x1a, 0x17];
const near = (c: number[], ref: number[], tol: number) => c.every((v, k) => Math.abs(v - ref[k]) <= tol);

for (const preset of ['arcade', 'base']) {
  test(`${preset}: menu → play → eaten → play again`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?seed=5&preset=${preset}&mute=1`);
    await expect(page.locator('#play')).toBeVisible();
    await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);

    await page.fill('#nick', 'e2e');
    await page.click('#play');
    await expect(page.locator('#menu')).toBeHidden();
    await expect(page.locator('#score')).toHaveText(/Score: \d+/);
    if (info.project.name === 'phone') await expect(page.locator('#btn-split')).toBeVisible();

    if (preset === 'arcade') {
      await expect(page.locator('#minimap')).toBeVisible();
      await expect(page.locator('#arcade-hud')).toBeVisible();
      await expect(page.locator('#banner')).toHaveText(/\d+ · [A-Z ]+/);
      // Spawned on a district start tile, inside the maze, on the same light floor as the plains.
      expect(await page.evaluate(() => (window as unknown as W).__game.world.maze.inInterior((window as unknown as W).__game.human.cells[0].p))).toBe(true);
      await expect(page.locator('#home-arrow')).toBeHidden();
      expect(near(await floorColour(page), PAPER, 16)).toBe(true);
    }

    // Every leaderboard row carries a rank and a mass.
    await expect(page.locator('#lb li').first().locator('.rk')).toHaveText('1.');
    await expect(page.locator('#lb li').first().locator('.ms')).toHaveText(/^\d{1,3}(,\d{3})*$/);

    // Steer for a moment (touch on phone, mouse on desktop) and check the cell moved.
    const before = await page.evaluate(() => ({ ...(window as unknown as W).__game.human.cells[0].p }));
    const vp = page.viewportSize()!;
    if (info.project.name === 'phone') await page.touchscreen.tap(vp.width * 0.9, vp.height * 0.5);
    else await page.mouse.move(vp.width * 0.9, vp.height * 0.5);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({ ...(window as unknown as W).__game.human.cells[0].p }));
    expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeGreaterThan(1e-3);

    if (preset === 'arcade') {
      // Far from home, the home arrow appears.
      await page.evaluate(() => {
        const g = (window as unknown as W).__game;
        const c = g.human.cells[0];
        const p = { x: -c.p.x, y: -c.p.y, z: -c.p.z };
        const l = Math.hypot(p.x + 0.3, p.y, p.z);
        Object.assign(c.p, { x: (p.x + 0.3) / l, y: p.y / l, z: p.z / l });
        Object.assign(c.prev, c.p);
        (g as unknown as { camera: { jumpTo(p: unknown, r: number): void } }).camera.jumpTo(c.p, c.r);
      });
      await expect(page.locator('#home-arrow')).toBeVisible();

      // Rainbow: in the plains (same light floor as in the maze), a bigger NPC touching the rainbow player
      // explodes into pieces it keeps.
      await page.evaluate(() => {
        const g = (window as unknown as W).__game as unknown as {
          human: { cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] };
          world: {
            R: number;
            arcade: { grantRainbow(o: unknown): void };
            maze: { layout: { junctions: { p: { x: number; y: number; z: number } }[]; regions: { centre: { x: number; y: number; z: number } }[]; regionAt(p: unknown): number } };
            organisms: { id: number; isHuman: boolean; alive: boolean; dormant: boolean; resident: unknown; cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] }[];
          };
          camera: { jumpTo(p: unknown, r: number): void };
        };
        // 2 000 units from a junction toward its region's centre: open plains, away from borders and the junction emblem.
        const layout = g.world.maze.layout;
        const j = layout.junctions[0].p;
        const c0 = layout.regions[layout.regionAt(j)].centre;
        const cj = c0.x * j.x + c0.y * j.y + c0.z * j.z;
        const ux = c0.x - cj * j.x;
        const uy = c0.y - cj * j.y;
        const uz = c0.z - cj * j.z;
        const ul = Math.hypot(ux, uy, uz);
        const b = 2000 / g.world.R;
        const at = {
          x: j.x * Math.cos(b) + (ux / ul) * Math.sin(b),
          y: j.y * Math.cos(b) + (uy / ul) * Math.sin(b),
          z: j.z * Math.cos(b) + (uz / ul) * Math.sin(b),
        };
        const me = g.human.cells[0];
        Object.assign(me.p, at);
        Object.assign(me.prev, at);
        g.camera.jumpTo(at, me.r);
      });
      await page.waitForTimeout(300);
      expect(near(await floorColour(page), PAPER, 16)).toBe(true);
      const npcId = await page.evaluate(() => {
        const g = (window as unknown as W).__game as unknown as {
          human: { cells: { p: { x: number; y: number; z: number }; r: number }[] };
          world: {
            R: number;
            arcade: { grantRainbow(o: unknown): void };
            organisms: { id: number; isHuman: boolean; alive: boolean; dormant: boolean; resident: unknown; cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] }[];
          };
        };
        const me = g.human.cells[0];
        const at = me.p;
        g.world.arcade.grantRainbow(g.human);
        const npc = g.world.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length === 1)!;
        const c = npc.cells[0];
        c.r = 300;
        // East of the player along a tangent, overlapping by 150 units: the NPC flees a rainbow cell and the moved cell is
        // only re-indexed at the end of the next tick, so a bare touch could separate first.
        const a = (me.r + c.r - 150) / g.world.R;
        const tx = -at.y;
        const ty = at.x;
        const tl = Math.hypot(tx, ty) || 1;
        const p = { x: at.x * Math.cos(a) + (tx / tl) * Math.sin(a), y: at.y * Math.cos(a) + (ty / tl) * Math.sin(a), z: at.z * Math.cos(a) };
        Object.assign(c.p, p);
        Object.assign(c.prev, p);
        return npc.id;
      });
      await expect(page.locator('#power')).toBeVisible();
      await expect
        .poll(() => page.evaluate((id) => (window as unknown as W).__game.world.organisms.find((o) => (o as unknown as { id: number }).id === id)!.cells.length, npcId))
        .toBeGreaterThan(1);
      await page.evaluate(() => {
        ((window as unknown as W).__game.human as unknown as { rainbowUntil: number }).rainbowUntil = 0;
      });
    }

    // Drop a huge NPC cell onto the player so it gets eaten on the next tick.
    await page.evaluate(() => {
      const g = (window as unknown as W).__game;
      const npc = g.world.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length > 0)!;
      const target = g.human.cells[0].p;
      const c = npc.cells[0];
      Object.assign(c.p, target);
      Object.assign(c.prev, target);
      c.r = 400;
    });
    await expect(page.locator('#death')).toHaveText(/Eaten/, { timeout: 5000 });
    await expect(page.locator('#menu')).toBeVisible();

    await page.click('#play');
    await expect(page.locator('#menu')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__game.human.alive)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('press stock: dark floor, and the old ?theme=dark name still works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?seed=5&theme=dark&mute=1');
  await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);
  await page.click('#play');
  await expect(page.locator('#menu')).toBeHidden();
  await page.waitForTimeout(300);
  // The region's ink is screened over the dark stock at 10 %.
  expect(near(await floorColour(page), PRESS, 26)).toBe(true);
  expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(true);
  expect(errors).toEqual([]);
});
