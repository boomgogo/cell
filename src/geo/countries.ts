// NPC countries: a random pick weighted by population, so a colony is as likely to be "from" a country as a random
// person in the world is. The table holds the most populous countries (about 90 % of people); everyone else is one
// "other" bucket spread evenly over the remaining flags, so small countries still turn up.
import { FLAG_CODES } from '../assets/flagIndex.ts';
import { hash01 } from '../core/rng.ts';

/** Population in millions, rounded (UN World Population Prospects 2024, 2025 estimates). */
export const POPULATION: Record<string, number> = {
  in: 1464, cn: 1416, us: 347, id: 286, pk: 255, ng: 238, br: 213, bd: 176, ru: 144, et: 135,
  mx: 131, jp: 123, eg: 118, ph: 116, cd: 113, vn: 101, ir: 92, tr: 87, de: 84, th: 72,
  tz: 70, gb: 69, fr: 66, za: 65, it: 59, ke: 57, mm: 55, co: 53, kr: 52, sd: 51,
  ug: 51, es: 48, dz: 47, iq: 47, ar: 46, af: 44, ye: 41, ca: 40, ao: 39, ua: 38,
  ma: 38, pl: 38, uz: 37, my: 36, mz: 36, gh: 35, pe: 34, sa: 34, mg: 32, ci: 32,
  np: 30, cm: 30, ve: 28, ne: 28, au: 27, kp: 26, sy: 25, ml: 25, bf: 24, tw: 23,
  lk: 23, mw: 22, zm: 22, td: 21, cl: 20, kz: 20, ro: 19, so: 19, sn: 19, ec: 18,
  gt: 18, nl: 18, kh: 18, zw: 17,
};

/** World population in millions (same source). */
export const WORLD_POPULATION = 8232;

/**
 * Returns a picker from a uniform number in [0, 1) to a country code. `codes` are all the codes that have a flag;
 * those not in the table share the rest of the world's population evenly.
 */
export function countryPicker(codes: readonly string[]): (u: number) => string {
  const listed = Object.keys(POPULATION).filter((c) => codes.includes(c));
  const others = codes.filter((c) => !(c in POPULATION));
  const listedTotal = listed.reduce((s, c) => s + POPULATION[c], 0);
  const otherTotal = others.length ? Math.max(0, WORLD_POPULATION - listedTotal) : 0;
  const total = listedTotal + otherTotal;
  const cum = new Float64Array(listed.length);
  let acc = 0;
  for (let i = 0; i < listed.length; i++) cum[i] = acc += POPULATION[listed[i]] / total;
  return (u) => {
    // Binary search the cumulative shares.
    let lo = 0;
    let hi = listed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= u) lo = mid + 1;
      else hi = mid;
    }
    if (lo < listed.length) return listed[lo];
    const k = Math.floor(((u - acc) / (1 - acc)) * others.length);
    return others[Math.min(others.length - 1, Math.max(0, k))];
  };
}

/** Keeps country picks apart from other hashes of the same seed and id. */
const SALT = 0x5eed;
let pick: ((u: number) => string) | null = null;

/** The country of an NPC: a population-weighted pick over every flag, fixed by the world seed and the organism id. */
export function npcCountry(seed: number, id: number): string {
  pick ??= countryPicker(FLAG_CODES);
  return pick(hash01(seed, id, SALT));
}
