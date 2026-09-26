// Country flags: NPC countries follow world population and are fixed by seed and id; the player's country lookup
// tries Cloudflare's trace, then country.is, then geojs.io, then the browser language, with a week-long cache.
import { describe, expect, it } from 'vitest';
import { FLAG_CODES } from '../../src/assets/flagIndex.ts';
import { POPULATION, WORLD_POPULATION, countryPicker, npcCountry } from '../../src/geo/countries.ts';
import { type LocateDeps, languageRegion, locateCountry, parseTrace, validCode } from '../../src/geo/locate.ts';

describe('NPC countries', () => {
  it('every table country has a flag', () => {
    for (const c of Object.keys(POPULATION)) expect(FLAG_CODES).toContain(c);
  });

  it('picks by population share (within ±1 % over 100 k NPCs)', () => {
    const n = 100_000;
    const counts = new Map<string, number>();
    for (let id = 0; id < n; id++) {
      const c = npcCountry(12345, id);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const c of ['in', 'cn', 'us', 'id', 'br', 'de', 'au']) {
      expect(Math.abs((counts.get(c) ?? 0) / n - POPULATION[c] / WORLD_POPULATION)).toBeLessThan(0.01);
    }
    // Countries outside the table still turn up.
    const others = [...counts.keys()].filter((c) => !(c in POPULATION));
    expect(others.length).toBeGreaterThan(100);
  });

  it('is fixed by seed and id', () => {
    const a = Array.from({ length: 50 }, (_, id) => npcCountry(7, id));
    expect(Array.from({ length: 50 }, (_, id) => npcCountry(7, id))).toEqual(a);
    expect(Array.from({ length: 50 }, (_, id) => npcCountry(8, id))).not.toEqual(a);
  });

  it('covers [0, 1) at the ends', () => {
    const pick = countryPicker(FLAG_CODES);
    expect(FLAG_CODES).toContain(pick(0));
    expect(FLAG_CODES).toContain(pick(0.999999999));
  });
});

describe('locateCountry', () => {
  it('parses codes', () => {
    expect(parseTrace('fl=1\nh=cell.example\nip=1.2.3.4\nloc=AU\ntls=TLSv1.3\n')).toBe('AU');
    expect(parseTrace('loc=XX\n')).toBeNull();
    expect(parseTrace('loc=T1\n')).toBeNull();
    expect(parseTrace('<html>not found</html>')).toBeNull();
    expect(validCode(' nz\n')).toBe('NZ');
    expect(validCode('NZL')).toBeNull();
    expect(languageRegion('en-AU')).toBe('AU');
    expect(languageRegion('zh-Hant-TW')).toBe('TW');
    expect(languageRegion('en')).toBeNull();
  });

  /** Fake network: url → body (a string), an HTTP error (null) or a hang (undefined). */
  function deps(net: Record<string, string | null | undefined>, store = new Map<string, string>()): LocateDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetch: (url, init) => {
        calls.push(url);
        const body = net[url];
        if (body === undefined) {
          return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort'))));
        }
        return Promise.resolve({ ok: body !== null, text: () => Promise.resolve(body ?? '') });
      },
      language: 'de-CH',
      read: (k) => store.get(k) ?? null,
      write: (k, v) => void store.set(k, v),
      now: () => 1_000_000,
    };
  }

  const TRACE = '/cdn-cgi/trace';
  const IS = 'https://api.country.is/';
  const GEOJS = 'https://get.geojs.io/v1/ip/country';

  it('uses Cloudflare first and caches it', async () => {
    const store = new Map<string, string>();
    const d = deps({ [TRACE]: 'loc=JP\n' }, store);
    expect(await locateCountry(d)).toBe('JP');
    expect(d.calls).toEqual([TRACE]);
    const again = deps({}, store);
    expect(await locateCountry(again)).toBe('JP');
    expect(again.calls).toEqual([]);
  });

  it('falls back to country.is, then geojs.io', async () => {
    const d = deps({ [TRACE]: null, [IS]: '{"ip":"1.2.3.4","country":"BR"}' });
    expect(await locateCountry(d)).toBe('BR');
    expect(d.calls).toEqual([TRACE, IS]);
    const e = deps({ [TRACE]: 'loc=XX', [IS]: 'oops', [GEOJS]: 'KE\n' });
    expect(await locateCountry(e)).toBe('KE');
    expect(e.calls).toEqual([TRACE, IS, GEOJS]);
  });

  it('ends at the browser language, uncached, when every lookup fails', async () => {
    const store = new Map<string, string>();
    const d = deps({ [TRACE]: null, [IS]: null, [GEOJS]: null }, store);
    expect(await locateCountry(d)).toBe('CH');
    expect(store.size).toBe(0);
  });

  it('times out a hanging lookup', async () => {
    const d = deps({ [TRACE]: undefined, [IS]: '{"country":"FR"}' });
    expect(await locateCountry(d)).toBe('FR');
  }, 5000);

  it('ignores an expired cache', async () => {
    const store = new Map([['cell.country', `US|${1_000_000 - 8 * 24 * 3600 * 1000}`]]);
    const d = deps({ [TRACE]: 'loc=CA' }, store);
    expect(await locateCountry(d)).toBe('CA');
  });
});
