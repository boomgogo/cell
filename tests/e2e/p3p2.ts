// Friends on one machine: a p3p2 server for each test (scripts/p3p2.ts, from a p3p2 checkout), and the steps a
// player takes through p3p2's portal, the menu (which hosts and answers invites, src/ui/friends.ts) and p3p2's panel,
// as p3p2's own tests take them (its e2e/tests/helpers.ts).
import { type Browser, type BrowserContext, type BrowserContextOptions, type Page, test as base, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join as joinPath } from 'node:path';
import { P3P2_DIR, type P3p2Server, missing, startP3p2 } from '../../scripts/p3p2.ts';

export { expect };

/** Where the tests' build is served (playwright.config.ts), and so the game URL of every test room. */
export const GAME = 'http://localhost:4180/';
/** The first of the tests' server ports: each worker has its own. */
const PORTS = 18200;

/** Why the multiplayer tests can't run here, or null. */
export const why = missing();

export const test = base.extend<{ p3p2: P3p2Server }>({
  p3p2: async ({}, use, info) => {
    const server = await startP3p2({ port: PORTS + info.parallelIndex, quiet: true });
    await use(server);
    await server.close();
  },
});

/** Logs in to the portal and creates a room for the tests' game; returns its room URL. */
export async function createRoom(browser: Browser, server: P3p2Server, name: string, players?: number): Promise<string> {
  const context = await browser.newContext();
  const portal = await context.newPage();
  await portal.goto(`${server.url}/`);
  await portal.getByLabel('Password').fill(server.password);
  await portal.getByRole('button', { name: 'Log in' }).click();
  await portal.getByLabel('Game URL').fill(GAME);
  await portal.getByLabel('Room name').fill(name);
  if (players !== undefined) await portal.getByLabel('Most players').fill(String(players));
  await portal.getByRole('button', { name: 'Create room' }).click();
  await expect(portal.getByRole('heading', { name })).toBeVisible();
  const roomUrl = await portal.getByLabel('Room URL').inputValue();
  await context.close();
  return roomUrl;
}

export interface Player {
  page: Page;
  context: BrowserContext;
  errors: string[];
}

export const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
export const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

/** A player with a browser profile of their own (two tabs of one profile are one player to p3p2). */
export async function player(browser: Browser, url: string, options: BrowserContextOptions = DESKTOP): Promise<Player> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(url, GAME).toString());
  await page.waitForFunction(() => (window as unknown as { __game?: { world: { tick: number } } }).__game?.world.tick! > 5);
  return { page, context, errors };
}

/** A name on the menu, then "Play with friends" with the room URL; returns the invite link the panel shows to send. */
export async function host(page: Page, roomUrl: string, name: string): Promise<string> {
  await page.fill('#nick', name);
  if (await page.locator('#host-form').isHidden()) await page.locator('#friends').click();
  await page.fill('#room-url', roomUrl);
  await page.click('#create');
  const link = page.getByLabel('Invite link', { exact: true });
  await expect(link).toBeVisible();
  const invite = await link.inputValue();
  await inRoom(page, true);
  await closePanel(page);
  return invite;
}

/** A name on the menu, and yes to "Join?" on a page opened from an invite. */
export async function accept(page: Page, name: string, tap = false): Promise<void> {
  const join = page.locator('#play');
  await expect(join).toHaveText('Join');
  await expect(join).toBeEnabled();
  await page.fill('#nick', name);
  if (tap) await join.tap();
  else await join.click();
  await inRoom(page, false);
}

/** Opens an invite and says yes. */
export async function join(browser: Browser, invite: string, name: string, options: BrowserContextOptions = DESKTOP): Promise<Player> {
  const p = await player(browser, invite, options);
  await accept(p.page, name, options.hasTouch === true);
  return p;
}

export async function closePanel(page: Page): Promise<void> {
  const close = page.getByRole('dialog', { name: 'Multiplayer' }).getByRole('button', { name: 'Close' });
  if (await close.isVisible()) await close.click();
}

/** What the page knows of its room (Net.status). */
export interface NetStatus {
  inRoom: boolean;
  host: boolean;
  guests: number;
  cells: number;
  food: number;
  human: { alive: boolean; mass: number; x: number; y: number; z: number } | null;
  others: { name: string; mass: number; x: number; y: number; z: number }[];
  saved: boolean;
  saveBytes: [number, number];
  sent: { view: number; save: number; views: number; ms: number };
  tickMs: number;
}

export function status(page: Page): Promise<NetStatus | null> {
  // A page that is reloading (into a room's rules, say) has nothing to say yet.
  return page.evaluate(() => (window as unknown as { __net?: () => { status(): NetStatus } | null }).__net?.()?.status() ?? null).catch(() => null);
}

/** Waits until the page is in its room, as its host or as a guest. */
export async function inRoom(page: Page, asHost: boolean): Promise<void> {
  await expect.poll(async () => {
    const s = await status(page);
    return s?.inRoom === true && s.host === asHost;
  }, { timeout: 20_000 }).toBe(true);
}

/** PLAY with a name. In a room the name is the room's, and the menu shows it. */
export async function play(page: Page, name: string, tap = false): Promise<void> {
  const nick = page.locator('#nick');
  if (await nick.isEditable()) await nick.fill(name);
  else await expect(nick).toHaveValue(name);
  if (tap) await page.locator('#play').tap();
  else await page.click('#play');
  await expect(page.locator('#menu')).toBeHidden();
}

/** Distance in world units between two points on the default sphere (R 16 000). */
export function apart(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(d) * 16000;
}

/** p3p2's lag proxy, from its checkout: latency each way, and a way to cut every connection. */
export async function lagProxy(to: string, latency: number): Promise<{ port: number; drop(): number; close(): Promise<void> }> {
  const m = (await import(pathToFileURL(joinPath(P3P2_DIR, 'e2e', 'tools', 'lag-proxy.ts')).href)) as {
    startLagProxy(o: { listen: number; host?: string; to: { host: string; port: number }; latency: number; jitter: number }): Promise<{ port: number; drop(): number; close(): Promise<void> }>;
  };
  const u = new URL(to);
  return m.startLagProxy({ listen: 0, host: '127.0.0.1', to: { host: u.hostname, port: Number(u.port) }, latency, jitter: 20 });
}
