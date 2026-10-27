// Start → play → die → respawn, on desktop and phone viewports, for the
// arcade (default) and base presets. The arcade run also checks the maze HUD (minimap, district banner, points), the
// home arrow, the paper floor inside a maze and in the plains, and a rainbow explosion. Also: leaderboard masses and
// the dark press stock.
import { execFileSync } from 'node:child_process';
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
    // Arcade calls the box Mass (the points are the score there); base keeps Score.
    await expect(page.locator('#score')).toHaveText(preset === 'arcade' ? /Mass \d+/ : /Score: \d+/);
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

    // Drop a huge NPC cell onto the player so it gets eaten on the next tick. In arcade the pieces of the NPC it just
    // exploded, next to it and no longer afraid of it, may have eaten it already: eaten all the same.
    await page.evaluate(() => {
      const g = (window as unknown as W).__game;
      if (g.human.cells.length === 0) return;
      const npc = g.world.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length > 0)!;
      const target = g.human.cells[0].p;
      const c = npc.cells[0];
      Object.assign(c.p, target);
      Object.assign(c.prev, target);
      c.r = 400;
    });
    await expect(page.locator('#death')).toHaveText(preset === 'arcade' ? /Eaten.* · [\d,]+ points · peak mass \d+/ : /Eaten/, { timeout: 5000 });
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

test('menu links: more games on Muon.Day, and Play with friends opens p3p2’s panel with p3p2.me, at load and after a death', async ({ page }) => {
  await page.goto('/?seed=5&mute=1&geo=0');
  const more = page.locator('#menu #more-games');
  const panel = page.getByRole('dialog', { name: 'Multiplayer' });
  const p3p2 = panel.getByRole('link', { name: 'p3p2.me' });
  for (const when of ['load', 'death']) {
    await expect(more, when).toBeVisible();
    await expect(more).toHaveText('More games on Muon.Day');
    await expect(more).toHaveAttribute('href', 'https://muon.day');
    await expect(more).toHaveAttribute('target', '_blank');
    await expect(page.locator('#friends')).toHaveText('Play with friends');
    await page.locator('#friends').click();
    await expect(panel).toContainText('Open the invite link from the server.');
    await expect(p3p2).toHaveAttribute('href', 'https://p3p2.me/');
    await expect(p3p2).toHaveAttribute('target', '_blank');
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    if (when === 'death') break;
    await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);
    await page.click('#play');
    await expect(page.locator('#menu')).toBeHidden();
    await page.evaluate(() => {
      const g = (window as unknown as W).__game;
      const npc = g.world.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length > 0)!;
      const c = npc.cells[0];
      Object.assign(c.p, g.human.cells[0].p);
      Object.assign(c.prev, g.human.cells[0].p);
      c.r = 400;
    });
    await expect(page.locator('#death')).toHaveText(/Eaten/, { timeout: 5000 });
  }
});

test('the menu fits a 320 px screen, and a phone on its side scrolls to all of it', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 740, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/?seed=5&mute=1&geo=0');
    const panel = page.locator('#menu .panel');
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const id of ['#play', '#friends', '#fork', '#more-games']) {
      const el = page.locator(id);
      await el.scrollIntoViewIfNeeded();
      // Scrolled into view, an element can sit a fraction of a pixel past the edge.
      const b = (await el.boundingBox())!;
      expect(b.y, id).toBeGreaterThanOrEqual(-0.5);
      expect(b.y + b.height, id).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(b.x + b.width, id).toBeLessThanOrEqual(viewport.width);
    }
  }
});

test('the version, from the commit, in the corner nothing else uses', async ({ page }, info) => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  await page.goto('/?seed=5&mute=1&geo=0');
  const ver = page.locator('#ver');
  await expect(ver).toHaveText(`v.${sha.slice(0, 4)}`);
  await expect(ver).toBeVisible();
  await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);
  await page.click('#play');
  await expect(page.locator('#menu')).toBeHidden();
  if (info.project.name === 'phone') await expect(page.locator('#btn-split')).toBeVisible();
  const v = (await ver.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(v.x + v.width).toBeLessThanOrEqual(vp.width);
  expect(v.y + v.height).toBeLessThanOrEqual(vp.height);
  for (const id of ['#leaderboard', '#score', '#arcade-hud', '#minimap', '#mute', '#btn-split', '#btn-eject', '#banner', 'p3p2-panel']) {
    const el = page.locator(id);
    if (!(await el.isVisible())) continue;
    const b = (await el.boundingBox())!;
    const overlap = v.x < b.x + b.width && b.x < v.x + v.width && v.y < b.y + b.height && b.y < v.y + v.height;
    expect(overlap, `${id} covers the version`).toBe(false);
  }
});

test('p3p2’s button: in its top-right corner, over nothing of the game’s, on the menu and in play; its panel fits', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'it makes its own phones');
  type Box = { x: number; y: number; width: number; height: number };
  const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const views = [
    { width: 1280, height: 800, touch: false },
    { width: 412, height: 915, touch: true },
    { width: 320, height: 640, touch: true },
    // A phone on its side: the leaderboard shows the top 5 and your own row, and ends above Split and W.
    { width: 740, height: 360, touch: true },
  ];
  for (const v of views) {
    const at = `${v.width}×${v.height}`;
    const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.touch, hasTouch: v.touch });
    const page = await context.newPage();
    await page.goto('/?seed=5&mute=1&geo=0&district=6');
    await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);
    const pill = page.locator('p3p2-panel').getByRole('button', { name: /^Multiplayer/ });
    await expect(pill, at).toBeVisible();
    const clear = async (ids: string[], what: string) => {
      const p = (await pill.boundingBox())!;
      expect(Math.round(p.y), at).toBe(12);
      expect(Math.round(v.width - p.x - p.width), at).toBe(12);
      for (const id of ids) {
        const el = page.locator(id);
        if (!(await el.isVisible())) continue;
        expect(overlap(p, (await el.boundingBox())!), `${at}, ${what}: the button covers ${id}`).toBe(false);
      }
    };
    await clear(['#nick', '#play', '#friends', '#fork', '#more-games', '#leaderboard', '#minimap', '#mute', '#banner'], 'menu');

    if (v.touch) await page.locator('#play').tap();
    else await page.click('#play');
    await expect(page.locator('#menu')).toBeHidden();
    if (v.touch) await expect(page.locator('#btn-split')).toBeVisible();
    await page.waitForTimeout(800);
    await clear(['#leaderboard', '#score', '#arcade-hud', '#minimap', '#mute', '#btn-split', '#btn-eject', '#banner', '#ver'], 'play');
    if (v.touch) {
      const board = (await page.locator('#leaderboard').boundingBox())!;
      for (const id of ['#btn-split', '#btn-eject']) expect(overlap(board, (await page.locator(id).boundingBox())!), `${at}: the leaderboard covers ${id}`).toBe(false);
    }

    if (v.touch) await pill.tap();
    else await pill.click();
    const dialog = page.getByRole('dialog', { name: 'Multiplayer' });
    await expect(dialog).toBeVisible();
    const d = (await dialog.boundingBox())!;
    expect(d.x, at).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width, at).toBeLessThanOrEqual(v.width);
    expect(d.y + d.height, at).toBeLessThanOrEqual(v.height);
    await context.close();
  }
});

test('Enter twice in the name field plays once', async ({ page }) => {
  await page.goto('/?seed=5&mute=1&geo=0');
  await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 10);
  await page.evaluate(() => {
    const g = (window as unknown as W).__game as unknown as { play(name: string): void; plays: number };
    const play = g.play.bind(g);
    g.plays = 0;
    g.play = (name) => {
      g.plays++;
      play(name);
    };
  });
  await page.locator('#nick').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('#menu')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ((window as unknown as W).__game as unknown as { plays: number }).plays)).toBe(1);
});
