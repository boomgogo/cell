import { describe, expect, it } from 'vitest';
import { type VersionSource, version } from '../../scripts/version.ts';

const SHA = '7914c4460f3881d00c3622645355652f3d692a6f';

function source(opts: { env?: Record<string, string>; head?: string | null; status?: string }): VersionSource {
  return {
    env: opts.env ?? {},
    git: (args) => (args[0] === 'rev-parse' ? (opts.head === undefined ? `${SHA}\n` : opts.head) : (opts.status ?? '')),
    now: () => 1_760_000_000_000,
  };
}

describe('version', () => {
  it('is v. and the first 4 characters of the commit, and the commit for p3p2', () => {
    expect(version(false, source({}))).toEqual({ label: 'v.7914', build: '7914c4460f38', sha: SHA, dirty: false });
  });

  it('takes the commit of a Cloudflare git build, whatever the checkout says', () => {
    const v = version(false, source({ env: { WORKERS_CI_COMMIT_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' }, status: ' M src/game.ts' }));
    expect(v.label).toBe('v.abcd');
    expect(v.dirty).toBe(false);
  });

  it('keeps the label for a build with changes not committed, and gives p3p2 a build of its own', () => {
    const v = version(false, source({ status: ' M src/game.ts\n' }));
    expect(v.label).toBe('v.7914');
    expect(v.dirty).toBe(true);
    expect(v.build).toMatch(/^7914c4460f38-[0-9a-z]+$/);
    expect(v.build.length).toBeLessThanOrEqual(32);
  });

  it('is v.dev on the dev server, and without git', () => {
    expect(version(true, source({})).label).toBe('v.dev');
    const v = version(false, source({ head: null }));
    expect(v.label).toBe('v.dev');
    expect(v.build).toMatch(/^b-[0-9a-z]+$/);
  });
});
