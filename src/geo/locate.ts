// The player's country (ISO 3166-1 alpha-2, upper case) for their flag. Tried in order, each with a timeout:
// Cloudflare's same-origin /cdn-cgi/trace (no third party), then country.is, then geojs.io, then the region of the
// browser language. Steps 2–3 send the visitor's IP to a third party, so they only run when the first fails.
// The answer is cached for a week. Loaded lazily after the first frame: it never delays the menu.

const CACHE_KEY = 'cell.country';
const CACHE_MS = 7 * 24 * 3600 * 1000;
const TIMEOUT_MS = 2500;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

export interface LocateDeps {
  fetch: Fetch;
  /** Browser language, e.g. navigator.language. */
  language: string;
  read(key: string): string | null;
  write(key: string, value: string): void;
  now(): number;
}

/** A usable country code, upper case, or null: rejects Cloudflare's XX (unknown) and T1 (Tor). */
export function validCode(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

/** The `loc=` line of a /cdn-cgi/trace response. */
export function parseTrace(text: string): string | null {
  const m = /^loc=(.*)$/m.exec(text);
  return validCode(m?.[1]);
}

const SOURCES: [string, (text: string) => string | null][] = [
  ['/cdn-cgi/trace', parseTrace],
  [
    'https://api.country.is/',
    (text) => {
      try {
        return validCode((JSON.parse(text) as { country?: string }).country);
      } catch {
        return null;
      }
    },
  ],
  ['https://get.geojs.io/v1/ip/country', validCode],
];

async function fetchText(deps: LocateDeps, url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { signal: ctl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The region part of a language tag (`en-AU` → `AU`), if any. */
export function languageRegion(lang: string): string | null {
  const m = /^[a-z]{2,3}[-_](?:[A-Za-z]{4}[-_])?([A-Za-z]{2})\b/i.exec(lang);
  return validCode(m?.[1]);
}

export async function locateCountry(deps: LocateDeps): Promise<string | null> {
  const cached = deps.read(CACHE_KEY);
  if (cached) {
    const [code, at] = cached.split('|');
    if (validCode(code) && deps.now() - Number(at) < CACHE_MS) return validCode(code);
  }
  for (const [url, parse] of SOURCES) {
    const text = await fetchText(deps, url);
    const code = text === null ? null : parse(text);
    if (code) {
      deps.write(CACHE_KEY, `${code}|${deps.now()}`);
      return code;
    }
  }
  // Not cached: the network may be back next visit.
  return languageRegion(deps.language);
}
