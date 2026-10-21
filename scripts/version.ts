// The build's version, from the commit it is built from. Read by vite.config.ts.
//
// - The label in the bottom-right corner: "v." and the first 4 characters of the commit ("v.dev" on the dev server).
// - The build id for p3p2 (`game.version`): players on different builds are kept in different rooms, as their pages
//   would not understand each other's messages. The first 12 characters of the commit, and the build time when the
//   working tree has changes that are not committed, so two such builds of one commit do not share a room.
import { execFileSync } from 'node:child_process';

export interface Version {
  /** "v.7914", or "v.dev". */
  label: string;
  /** For p3p2: at most 32 characters, no spaces. */
  build: string;
  /** The commit, or '' when there is none to read. */
  sha: string;
  /** The working tree has changes that are not committed: the build is not exactly that commit. */
  dirty: boolean;
}

export interface VersionSource {
  env: Record<string, string | undefined>;
  /** `git <args>`'s output, or null when git is not there. */
  git(args: string[]): string | null;
  now(): number;
}

/** The version of a build (`dev` false) or of the dev server. */
export function version(dev: boolean, src: VersionSource = system): Version {
  if (dev) return { label: 'v.dev', build: 'dev', sha: '', dirty: false };
  // Cloudflare's git builds set WORKERS_CI_COMMIT_SHA, on a clean checkout of that commit.
  const ci = src.env.WORKERS_CI_COMMIT_SHA?.trim();
  const sha = (ci || src.git(['rev-parse', 'HEAD']) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return { label: 'v.dev', build: `b-${src.now().toString(36)}`, sha: '', dirty: false };
  const dirty = !ci && (src.git(['status', '--porcelain']) ?? '').trim() !== '';
  const build = sha.slice(0, 12) + (dirty ? `-${src.now().toString(36)}` : '');
  return { label: `v.${sha.slice(0, 4)}`, build, sha, dirty };
}

const system: VersionSource = {
  env: process.env,
  git(args) {
    try {
      return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};
