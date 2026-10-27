// Friends on one machine: a p3p2 server for each test (scripts/p3p2.ts, from a p3p2 checkout), and the steps a
// player takes through p3p2's portal and p3p2's panel (its Join?, the invite link, Close), as p3p2's own tests take
// them (its e2e/tests/helpers.ts, at 0.2).
import { type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, test as base, expect } from '@playwright/test';
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

/** A room, from its owner's side: its page in the portal, and the invite link everybody joins it with. */
export interface Owner {
  portal: Page;
  invite: string;
  close(): Promise<void>;
}

/** Logs in to the portal and creates a room for the tests' game. `players`: how many may join, if not the default. */
export async function createRoom(browser: Browser, server: P3p2Server, name: string, players?: number): Promise<Owner> {
  const context = await browser.newContext();
  const portal = await context.newPage();
  // Not the server's address: once a room is on its front page, that is the front page.
  await portal.goto(`${server.url}/login`);
  await portal.getByLabel('Password').fill(server.password);
  await portal.getByRole('button', { name: 'Log in' }).click();
  await portal.getByLabel('Game URL').fill(GAME);
  await portal.getByLabel('Room name').fill(name);
  if (players !== undefined) await portal.getByLabel('Most players').fill(String(players));
  await portal.getByRole('button', { name: 'Create room' }).click();
  await expect(portal.getByRole('heading', { name })).toBeVisible();
  return { portal, invite: await portal.getByLabel('Invite link', { exact: true }).inputValue(), close: () => context.close() };
}

/**
 * Puts the room on the server's front page, its link without the last `hidden` characters. That makes a new invite:
 * returns the link whole, and as the front page shows it, a dash for each character left out.
 */
export async function onFrontPage(owner: Owner, hidden: number): Promise<{ whole: string; shown: string }> {
  await owner.portal.getByLabel("On this server's front page").selectOption(String(hidden));
  await owner.portal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(owner.portal.locator('b.mono')).toHaveText(new RegExp(`^[0-9a-z]{${hidden}}$`));
  const whole = await owner.portal.getByLabel('Invite link', { exact: true }).inputValue();
  return { whole, shown: whole.slice(0, -hidden) + '-'.repeat(hidden) };
}

/** The owner removes a player, on the room's page in the portal. */
export async function kick(owner: Owner, name: string): Promise<void> {
  await owner.portal.reload();
  await owner.portal.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Kick' }).click();
}

/** An invite link that goes through another address of its server, such as a lag proxy in front of it. */
export function through(invite: string, server: string, other: string): string {
  return invite.replace(`=${server}/`, `=${other}/`);
}

/** The invite of `invite` on the page at `url`, with that page's own parameters (`?district=`, `?mute=`, …). */
export function withInvite(url: string, invite: string): string {
  const u = new URL(url, GAME);
  u.searchParams.set('room', new URL(invite).searchParams.get('room')!);
  return u.toString();
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

/** p3p2's panel, open: a Join?, or the room. */
export function panel(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Multiplayer' });
}

/** p3p2's button, in the corner. */
export function button(page: Page): Locator {
  return page.locator('p3p2-panel').getByRole('button', { name: /^Multiplayer/ });
}

/**
 * The first one in, who hosts: opens the room's invite on this page and says yes to the panel's Join? with a name.
 * Returns the invite link the panel shows to pass on (with this page's parameters, as p3p2 makes it).
 */
export async function host(page: Page, invite: string, name: string): Promise<string> {
  await page.goto(withInvite(page.url(), invite));
  await page.waitForFunction(() => (window as unknown as { __game?: { world: { tick: number } } }).__game?.world.tick! > 5);
  await accept(page, name, false, true);
  await page.locator('#friends').click();
  const link = panel(page).getByLabel('Invite link', { exact: true });
  await expect(link).toBeVisible();
  const shared = await link.inputValue();
  await closePanel(page);
  return shared;
}

/** Yes to the panel's Join? on a page opened from an invite, with a name ('' for none: the room gives one). */
export async function accept(page: Page, name: string, tap = false, asHost = false): Promise<void> {
  const join = panel(page).getByRole('button', { name: 'Join', exact: true });
  await expect(join).toBeEnabled();
  await panel(page).getByLabel('Your name').fill(name);
  if (tap) await join.tap();
  else await join.click();
  await inRoom(page, asHost);
}

/** Opens an invite and says yes. */
export async function join(browser: Browser, invite: string, name: string, options: BrowserContextOptions = DESKTOP): Promise<Player> {
  const p = await player(browser, invite, options);
  await accept(p.page, name, options.hasTouch === true);
  return p;
}

export async function closePanel(page: Page): Promise<void> {
  const close = panel(page).getByRole('button', { name: 'Close' });
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
