// Friends in one world, through a real p3p2 server on this machine (tests/e2e/p3p2.ts starts one for each test,
// from a p3p2 checkout: see scripts/p3p2.ts). Each player is a browser profile of its own. The host's page runs the
// world; the guests' pages draw what it sends them (src/net/Net.ts).
//
// Skipped, with the reason, when there is no p3p2 checkout. Runs in the desktop project only: the phone test makes
// its own phone.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { MAX_PLAYERS } from '../../src/net/Net.ts';
import { GAME, PHONE, accept, apart, createRoom, expect, host, inRoom, join, lagProxy, play, player, status, test, why } from './p3p2.ts';

interface GameHandle {
  state: string;
  points: number;
  camera: { frame: { c: { x: number; y: number; z: number } } };
  human: { alive: boolean; name: string; cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] };
  world: {
    tick: number;
    maze: { layout: { regionAt(p: unknown): number } };
    organisms: { name: string; isHuman: boolean; alive: boolean; cells: { p: { x: number; y: number; z: number }; prev: { x: number; y: number; z: number }; r: number }[] }[];
  };
}
type W = { __game: GameHandle };

test.skip(why !== null, why ?? '');
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'one run is enough: the phone test makes its own phone'));

/** The district the page's camera is in. */
const district = (page: Page) => page.evaluate(() => (window as unknown as W).__game.world.maze.layout.regionAt((window as unknown as W).__game.camera.frame.c));

/** On the host's page: where it has the colony named `name`, or null. */
const colonyOnHost = (page: Page, name: string) =>
  page.evaluate((n) => {
    const o = (window as unknown as W).__game.world.organisms.find((x) => x.isHuman && x.name === n && x.cells.length > 0);
    if (!o) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of o.cells) {
      x += c.p.x;
      y += c.p.y;
      z += c.p.z;
    }
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  }, name);

/** Moves the mouse a little to one side of the screen's centre: the player's cell heads that way. */
async function steer(page: Page, dx: number, dy: number): Promise<void> {
  const vp = page.viewportSize()!;
  await page.mouse.move(vp.width / 2 + dx, vp.height / 2 + dy, { steps: 4 });
}

test('alone: nothing asks a server anything, and the room code never loads', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto('/?mute=1&geo=0');
  await page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 50);
  await play(page, 'Solo');
  await page.waitForTimeout(1500);
  expect(sockets).toEqual([]);
  expect(requests.filter((u) => !u.startsWith(GAME))).toEqual([]);
  expect(requests.filter((u) => /\/assets\/(Net|p3p2-core|p3p2-panel)-/.test(u))).toEqual([]);
  expect(await status(page)).toBeNull();
});

test('two players: one world, starting in one district; the guest steers, eats, and is eaten', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Friday');
  const ada = await player(browser, '/?mute=1&geo=0&district=3');
  const invite = await host(ada.page, roomUrl, 'Ada');
  await expect(ada.page.locator('#friends')).toHaveText('Friends · 1');
  await expect(ada.page.locator('#room')).toHaveText(/In Friday · 1 player · you run this world/);

  // Grace's page would start in district 7; in the room it looks where Ada looks.
  const grace = await join(browser, `${invite}&district=7`, 'Grace');
  await expect.poll(() => district(grace.page)).toBe(3);
  await expect(grace.page.locator('#room')).toHaveText(/2 players · Ada runs this world/);
  await expect(ada.page.locator('#friends')).toHaveText('Friends · 2');

  await play(ada.page, 'Ada');
  await play(grace.page, 'Grace');
  // Grace's colony is in Ada's world, in Ada's district, and Grace's page draws it where Ada's world has it.
  await expect.poll(() => colonyOnHost(ada.page, 'Grace')).not.toBeNull();
  const onHost = (await colonyOnHost(ada.page, 'Grace'))!;
  expect(await ada.page.evaluate((p) => (window as unknown as W).__game.world.maze.layout.regionAt(p), onHost)).toBe(3);
  await expect.poll(async () => (await status(grace.page))?.human?.alive).toBe(true);
  await expect.poll(async () => {
    const s = (await status(grace.page))!;
    const h = await colonyOnHost(ada.page, 'Grace');
    return h && s.human ? apart(h, s.human) : 1e9;
  }).toBeLessThan(150);
  // Each sees the other: Grace started near Ada, who was playing.
  expect(apart((await colonyOnHost(ada.page, 'Ada'))!, onHost)).toBeLessThan(1500);
  await expect.poll(async () => (await status(grace.page))!.others.map((o) => o.name)).toContain('Ada');
  await expect.poll(async () => (await status(grace.page))!.food).toBeGreaterThan(50);

  // Grace steers: her colony moves in Ada's world, and she scores for what she eats.
  for (const [dx, dy] of [[300, 0], [0, 300], [-300, 0], [0, -300], [300, 0]]) {
    await steer(grace.page, dx, dy);
    await grace.page.waitForTimeout(800);
  }
  const moved = (await colonyOnHost(ada.page, 'Grace'))!;
  expect(apart(moved, onHost)).toBeGreaterThan(100);
  await expect.poll(() => grace.page.evaluate(() => (window as unknown as W).__game.points), { timeout: 15_000 }).toBeGreaterThan(0);

  // Ada's page drops a big cell of hers onto Grace's colony: Grace is told, by name, and PLAY puts her back.
  await ada.page.evaluate(() => {
    const g = (window as unknown as W).__game;
    const prey = g.world.organisms.find((o) => o.isHuman && o.name === 'Grace' && o.cells.length > 0)!;
    const c = g.human.cells[0];
    Object.assign(c.p, prey.cells[0].p);
    Object.assign(c.prev, prey.cells[0].p);
    c.r = 400;
  });
  await expect(grace.page.locator('#death')).toHaveText(/Eaten by Ada · [\d,]+ points · peak mass \d+/, { timeout: 10_000 });
  await expect(grace.page.locator('#menu')).toBeVisible();
  await grace.page.click('#play');
  await expect(grace.page.locator('#menu')).toBeHidden();
  await expect.poll(() => colonyOnHost(ada.page, 'Grace')).not.toBeNull();
  await expect.poll(async () => (await status(grace.page))?.human?.alive).toBe(true);
  expect([...ada.errors, ...grace.errors]).toEqual([]);
});

test('one name, the menu’s: hosting and joining by it, Play alone, no name, a bad room URL, and removed', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Names');
  const ada = await player(browser, '/?mute=1&geo=0');
  // Not a room URL: the menu says so, and there is no room.
  await ada.page.fill('#nick', 'Ada');
  await ada.page.click('#friends');
  await ada.page.fill('#room-url', 'not a room');
  await ada.page.click('#create');
  await expect(ada.page.locator('#host-status')).toHaveText(/doesn't look like a room URL/);
  expect(await status(ada.page)).toBeNull();
  const invite = await host(ada.page, roomUrl, 'Ada');
  // The panel has the invite, and Ada by the menu's name, and no name field; the menu's is the room's now.
  await ada.page.click('#friends');
  const panel = ada.page.getByRole('dialog', { name: 'Multiplayer' });
  await expect(panel.locator('.members')).toHaveText(/Ada/);
  await expect(panel.getByLabel('Your name')).toHaveCount(0);
  await expect(ada.page.locator('#nick')).toHaveValue('Ada');
  await expect(ada.page.locator('#nick')).not.toBeEditable();

  // Bob opens the invite: "Join?" on the menu. Play alone plays alone, and a reload wouldn't ask again.
  const bob = await player(browser, invite);
  await expect(bob.page.locator('#invite')).toHaveText(/^Join Names on 127\.0\.0\.1:\d+\?Hosted by Ada · 1 player$/);
  await expect(bob.page.locator('#friends')).toBeHidden();
  await bob.page.fill('#nick', 'Bob');
  await bob.page.click('#alone');
  await expect(bob.page.locator('#menu')).toBeHidden();
  expect(new URL(bob.page.url()).searchParams.has('room')).toBe(false);
  expect(await status(bob.page)).toBeNull();

  // Cat joins with no name: she is the name the room gives her, on her menu and in Ada's panel.
  const cat = await join(browser, invite, '');
  const nick = cat.page.locator('#nick');
  await expect(nick).toHaveValue(/^Player \d+$/);
  await expect(nick).not.toBeEditable();
  const catName = await nick.inputValue();
  await expect(panel.locator('.members')).toContainText(catName);
  await play(cat.page, catName);
  await expect.poll(() => colonyOnHost(ada.page, catName)).not.toBeNull();

  // Ada removes her: Cat's menu says so, the panel stays shut, and the name is hers to change again.
  await panel.getByRole('button', { name: `Remove ${catName}` }).click();
  await expect(cat.page.locator('#room')).toHaveText('You were removed from the room.', { timeout: 10_000 });
  await expect(cat.page.locator('#friends')).toHaveText('Play with friends');
  await expect(cat.page.getByRole('dialog', { name: 'Multiplayer' })).toBeHidden();
  await expect(nick).toBeEditable();
  expect([...ada.errors, ...bob.errors, ...cat.errors]).toEqual([]);
});

test('the host leaves: the next player carries the world on, and a third plays in it', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Carry on');
  const ada = await player(browser, '/?mute=1&geo=0&district=5');
  const invite = await host(ada.page, roomUrl, 'Ada');
  const grace = await join(browser, invite, 'Grace');
  await play(ada.page, 'Ada');
  await play(grace.page, 'Grace');
  await expect.poll(async () => (await status(grace.page))?.human?.alive).toBe(true);
  // A save reaches Grace's page every 5 s.
  await expect.poll(async () => (await status(grace.page))!.saved, { timeout: 15_000 }).toBe(true);
  const was = (await status(grace.page))!.human!;

  await ada.context.close();
  await inRoom(grace.page, true);
  const now = (await status(grace.page))!;
  // Her colony where the save had it (at most 5 s back), alive, in a world with colonies in it.
  expect(now.human?.alive).toBe(true);
  expect(apart(now.human!, was)).toBeLessThan(1500);
  expect(now.cells).toBeGreaterThan(20);

  const lin = await join(browser, invite, 'Lin');
  await expect.poll(async () => (await status(lin.page))!.others.map((o) => o.name), { timeout: 15_000 }).toContain('Grace');
  await play(lin.page, 'Lin');
  await expect.poll(() => colonyOnHost(grace.page, 'Lin')).not.toBeNull();
  expect([...grace.errors, ...lin.errors]).toEqual([]);
});

test('a reload: back in the room, and PLAY gives the same colony back', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Reload');
  const ada = await player(browser, '/?mute=1&geo=0&district=2');
  const invite = await host(ada.page, roomUrl, 'Ada');
  const grace = await join(browser, invite, 'Grace');
  await play(grace.page, 'Grace');
  await expect.poll(async () => (await status(grace.page))?.human?.alive).toBe(true);
  await steer(grace.page, 250, 0);
  await grace.page.waitForTimeout(1500);
  const before = (await colonyOnHost(ada.page, 'Grace'))!;

  await grace.page.reload();
  await grace.page.waitForFunction(() => (window as unknown as W).__game?.world.tick > 5);
  await inRoom(grace.page, false);
  await grace.page.click('#play');
  await expect.poll(async () => (await status(grace.page))?.human?.alive).toBe(true);
  // One colony of Grace's on the host, the one she had (it held still while her page was away).
  expect(await ada.page.evaluate(() => (window as unknown as W).__game.world.organisms.filter((o) => o.isHuman && o.name === 'Grace' && o.cells.length > 0).length)).toBe(1);
  expect(apart((await colonyOnHost(ada.page, 'Grace'))!, before)).toBeLessThan(600);
  expect([...ada.errors, ...grace.errors]).toEqual([]);
});

test('a bad connection: 150 ms each way and a cut, and the guest still steers', async ({ browser, p3p2 }) => {
  const proxy = await lagProxy(p3p2.url, 150);
  try {
    const roomUrl = (await createRoom(browser, p3p2, 'Far away')).replace(`:${new URL(p3p2.url).port}/`, `:${proxy.port}/`);
    const ada = await player(browser, '/?mute=1&geo=0&district=4');
    const invite = await host(ada.page, roomUrl, 'Ada');
    const grace = await join(browser, invite, 'Grace');
    await play(grace.page, 'Grace');
    await expect.poll(async () => (await status(grace.page))?.human?.alive, { timeout: 15_000 }).toBe(true);
    expect(proxy.drop()).toBeGreaterThan(0);
    await inRoom(grace.page, false);
    await inRoom(ada.page, true);
    const before = (await colonyOnHost(ada.page, 'Grace'))!;
    for (const [dx, dy] of [[0, 300], [300, 0], [0, -300]]) {
      await steer(grace.page, dx, dy);
      await grace.page.waitForTimeout(1000);
    }
    await expect.poll(async () => apart((await colonyOnHost(ada.page, 'Grace'))!, before), { timeout: 10_000 }).toBeGreaterThan(80);
    // And her page draws her colony where the host has it, give or take what the delay moves it.
    await expect.poll(async () => {
      const s = (await status(grace.page))!;
      const h = await colonyOnHost(ada.page, 'Grace');
      return h && s.human ? apart(h, s.human) : 1e9;
    }).toBeLessThan(300);
    expect([...ada.errors, ...grace.errors]).toEqual([]);
  } finally {
    await proxy.close();
  }
});

test('a phone: in by the invite, the panel by touch and on the screen, PLAY by touch, a finger steers', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Pocket');
  const ada = await player(browser, '/?mute=1&geo=0&district=6');
  const invite = await host(ada.page, roomUrl, 'Ada');
  const phone = await player(browser, invite, PHONE);
  const vp = phone.page.viewportSize()!;
  const onScreen = async (box: { x: number; y: number; width: number; height: number } | null) => {
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5);
  };
  await expect(phone.page.locator('#invite')).toContainText('Hosted by Ada');
  await onScreen(await phone.page.locator('#alone').boundingBox());
  await accept(phone.page, 'Kit', true);
  await expect(phone.page.locator('#friends')).toHaveText('Friends · 2');
  await phone.page.locator('#friends').tap();
  const dialog = phone.page.getByRole('dialog', { name: 'Multiplayer' });
  await expect(dialog).toBeVisible();
  await onScreen(await dialog.boundingBox());
  await dialog.getByRole('button', { name: 'Close' }).tap();
  await expect(dialog).toBeHidden();
  await play(phone.page, 'Kit', true);
  await expect(phone.page.locator('#btn-split')).toBeVisible();
  await expect.poll(() => colonyOnHost(ada.page, 'Kit')).not.toBeNull();
  const before = (await colonyOnHost(ada.page, 'Kit'))!;

  // A thumb down to the right of the cell, held and moved a little, as a person steers.
  const cdp = await phone.context.newCDPSession(phone.page);
  const x = vp.width / 2 + 120;
  const y = vp.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 0; i < 20; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (i % 2), y: y + 40 * Math.sin(i / 3), id: 1 }] });
    await phone.page.waitForTimeout(100);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => apart((await colonyOnHost(ada.page, 'Kit'))!, before)).toBeGreaterThan(60);
  expect([...ada.errors, ...phone.errors]).toEqual([]);
});

test('rules: a guest opened with other rules reloads into the room’s', async ({ browser, p3p2 }) => {
  const roomUrl = await createRoom(browser, p3p2, 'Rules');
  const ada = await player(browser, '/?mute=1&geo=0');
  const invite = await host(ada.page, roomUrl, 'Ada');
  const grace = await player(browser, `${invite}&preset=base`);
  await accept(grace.page, 'Grace');
  // The room's world has mazes: her page comes back without ?preset=base, with them.
  await expect.poll(() => grace.page.url(), { timeout: 20_000 }).not.toContain('preset=base');
  await grace.page.waitForFunction(() => (window as unknown as { __game?: { world: { maze: { enabled: boolean } } } }).__game?.world.maze.enabled === true);
  await inRoom(grace.page, false);
  await play(grace.page, 'Grace');
  await expect.poll(() => colonyOnHost(ada.page, 'Grace')).not.toBeNull();
});

test('a full world: the next PLAY waits, watching costs no zone, and what hosting sends', async ({ browser, p3p2 }) => {
  test.setTimeout(120_000);
  const roomUrl = await createRoom(browser, p3p2, 'Full house');
  const ada = await player(browser, '/?mute=1&geo=0&district=0');
  const invite = await host(ada.page, roomUrl, 'Ada');
  const small = { viewport: { width: 640, height: 400 } };
  const guests = [];
  for (let i = 1; i <= MAX_PLAYERS; i++) guests.push(await join(browser, invite, `P${i}`, small));
  await play(ada.page, 'Ada');
  for (let i = 1; i < MAX_PLAYERS; i++) {
    await play(guests[i - 1].page, `P${i}`);
    await expect.poll(() => colonyOnHost(ada.page, `P${i}`), { timeout: 15_000 }).not.toBeNull();
  }
  // One more: back to the menu, saying why. It watches: the host sends it its views, and runs no zone for it.
  const last = guests[MAX_PLAYERS - 1];
  await expect(last.page.locator('#nick')).toHaveValue(`P${MAX_PLAYERS}`);
  await last.page.click('#play');
  await expect(last.page.locator('#death')).toHaveText(new RegExp(`This world is full: ${MAX_PLAYERS} playing`), { timeout: 10_000 });
  await expect(last.page.locator('#menu')).toBeVisible();
  expect(await colonyOnHost(ada.page, `P${MAX_PLAYERS}`)).toBeNull();
  await expect.poll(async () => (await status(last.page))!.others.length).toBeGreaterThan(0);
  expect(await ada.page.evaluate(() => (window as unknown as { __game: { world: { observers: unknown[] } } }).__game.world.observers.length)).toBe(MAX_PLAYERS - 1);

  // What the host sends, over 10 s: each guest's views, and the saves (every 5 s, to everybody).
  const tick = () => ada.page.evaluate(() => (window as unknown as W).__game.world.tick);
  const t0 = await tick();
  const start = (await status(ada.page))!;
  await ada.page.waitForTimeout(10_000);
  const end = (await status(ada.page))!;
  const ticks = (await tick()) - t0;
  const seconds = (end.sent.ms - start.sent.ms) / 1000;
  const cost = {
    guests: end.guests,
    hostTicksPerSecond: +(ticks / seconds).toFixed(1),
    viewBytesPerGuestPerSecond: Math.round((end.sent.view - start.sent.view) / seconds / end.guests),
    viewsPerGuestPerSecond: +((end.sent.views - start.sent.views) / seconds / end.guests).toFixed(1),
    hostUpBytesPerSecond: Math.round((end.sent.view - start.sent.view + end.sent.save - start.sent.save) / seconds),
    save: { raw: end.saveBytes[0], packed: end.saveBytes[1] },
  };
  console.log('What hosting sends:', JSON.stringify(cost));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/friends-cost.json', JSON.stringify(cost, null, 1));
  // A view every two ticks of the host's world (Net.ts, VIEW_TICKS). Per tick, not per second: nine pages on a
  // 4-core laptop, beside the other tests, can slow the host's world itself below its 25 ticks a second.
  expect((end.sent.views - start.sent.views) / end.guests / ticks).toBeGreaterThan(0.45);
  // Under the server's largest frame, in parts.
  expect(cost.save.packed).toBeGreaterThan(0);
  expect([...ada.errors, ...guests.flatMap((g) => g.errors)]).toEqual([]);
});
