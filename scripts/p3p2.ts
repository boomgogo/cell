// A p3p2 server on this machine, for trying Cell with friends and for its tests, started from a checkout of
// https://github.com/doublependu/p3p2 (no Docker needed: the server is one Node.js process).
//
// Usage: npm run p3p2 [-- --port 8080] [--password ...] [--data <folder>]
//        (P3P2_DIR: the checkout; else ~/Repos/p3p2, else the one beside this checkout, ../p3p2)
//
// Once: git clone https://github.com/doublependu/p3p2 ~/Repos/p3p2 && cd ~/Repos/p3p2 && npm ci --workspace server
//
// Then: open the portal it prints, log in with the password, and create a room whose game URL is the address you
// open the game at (`npm run dev -- --host`, http://<this machine's LAN address>:5173/). Press Open on the room's page:
// the game opens with the room's invite link and asks Join?. Open the same link in another browser, or on a phone on
// the same Wi-Fi. A database of p3p2 0.2 (`--data`) can't be opened by 0.1 again.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The p3p2 checkout: `P3P2_DIR`, else `~/Repos/p3p2`, else the one beside this checkout. */
export const P3P2_DIR =
  process.env.P3P2_DIR || [join(homedir(), 'Repos', 'p3p2'), join(import.meta.dirname, '..', '..', 'p3p2')].find((d) => existsSync(join(d, 'server', 'src', 'main.ts'))) || join(homedir(), 'Repos', 'p3p2');
export const PASSWORD = 'cell-local-test';

export interface P3p2Server {
  /** The portal, and the address rooms' URLs are built from. */
  url: string;
  password: string;
  close(): Promise<void>;
}

/** Why there is no server to start, or null when the checkout is ready. */
export function missing(dir = P3P2_DIR): string | null {
  if (!existsSync(join(dir, 'server', 'src', 'main.ts'))) return `no p3p2 checkout at ${dir}: git clone https://github.com/doublependu/p3p2 ${dir} (or set P3P2_DIR)`;
  if (!existsSync(join(dir, 'node_modules', 'hono'))) return `p3p2's server has no dependencies: cd ${dir} && npm ci --workspace server`;
  return null;
}

/** This machine's address on the local network, so a phone on the Wi-Fi can reach the server. */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

/** Starts a server with its database in memory (or in `data`), and resolves once its portal answers. */
export async function startP3p2(opts: { port: number; host?: string; password?: string; data?: string; quiet?: boolean }): Promise<P3p2Server> {
  const why = missing();
  if (why) throw new Error(why);
  const host = opts.host ?? '127.0.0.1';
  const password = opts.password ?? PASSWORD;
  const url = `http://${host}:${opts.port}`;
  const child: ChildProcess = spawn(process.execPath, [join(P3P2_DIR, 'server', 'src', 'main.ts')], {
    cwd: P3P2_DIR,
    env: {
      ...process.env,
      P3P2_PORT: String(opts.port),
      P3P2_HOST: host === '127.0.0.1' ? host : '0.0.0.0',
      P3P2_PUBLIC_URL: url,
      P3P2_DATA_DIR: opts.data ?? ':memory:',
      P3P2_OWNER_PASSWORD: password,
      P3P2_LOG_LEVEL: opts.quiet ? 'warn' : 'info',
    },
    stdio: opts.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const close = () =>
    new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  for (let t = 0; t < 100; t++) {
    if (exited) throw new Error(`the p3p2 server at ${url} stopped as it started`);
    try {
      const res = await fetch(`${url}/`, { redirect: 'manual' });
      if (res.status > 0) return { url, password, close };
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await close();
  throw new Error(`the p3p2 server at ${url} did not answer`);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(arg('port', '8080'));
  const host = lanAddress();
  const server = await startP3p2({ port, host, password: arg('password', PASSWORD), data: arg('data', ':memory:') });
  console.log(`\np3p2 server: ${server.url}  (portal password: ${server.password})`);
  console.log(`Create a room for the game at http://${host}:5173/ (npm run dev -- --host), or http://${host}:4173/ (npm run preview -- --host).`);
  console.log(`A bad connection: node ${join(P3P2_DIR, 'e2e/tools/lag-proxy.ts')} --listen ${port + 1} --to 127.0.0.1:${port} --latency 150, then open the invite link with port ${port + 1} in place of ${port}.\n`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
