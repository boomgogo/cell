// The room's rules: the URL parameters that make the world, which every page in a room must share. A guest's page
// draws the host's world on its own mazes, so a page with `?preset=base` (no mazes) or another `mapSeed` would draw
// walls the host does not have. The first page in a room offers its rules; a page whose rules differ reloads with
// the room's.
import { NUMERIC_OVERRIDES, loadConfig } from '../config/index.ts';

export type Rules = Record<string, string>;

const DIFFICULTIES = ['easy', 'normal', 'hard'];
/** Every parameter that changes the rules, as `withRules` writes them. */
const RULE_PARAMS = ['preset', 'maze', 'difficulty', ...NUMERIC_OVERRIDES];

/** The rules of the world these parameters make, as plain strings. */
export function worldRules(params: URLSearchParams): Rules {
  const cfg = loadConfig(params);
  const d = params.get('difficulty');
  const rules: Rules = { preset: cfg.preset, mazes: cfg.mazes ? '1' : '0', difficulty: d !== null && DIFFICULTIES.includes(d) ? d : 'normal' };
  for (const key of NUMERIC_OVERRIDES) rules[key] = String(cfg[key]);
  return rules;
}

/**
 * Whether the room's rules (somebody else's data) make another world than `mine`. Only the rules this build knows
 * are compared; anything that is not a rules value at all is not a difference.
 */
export function rulesDiffer(room: unknown, mine: Rules): boolean {
  if (!room || typeof room !== 'object') return false;
  const r = room as Record<string, unknown>;
  return Object.keys(mine).some((k) => typeof r[k] === 'string' && r[k] !== mine[k]);
}

/** This page's address with the room's rules in place of its own; null when no address makes them. */
export function withRules(href: string, room: Rules): string | null {
  const url = new URL(href);
  const p = url.searchParams;
  for (const k of RULE_PARAMS) p.delete(k);
  if (room.preset && room.preset !== 'arcade') p.set('preset', room.preset);
  if (room.mazes === '0') p.set('maze', '0');
  if (room.difficulty && room.difficulty !== 'normal') p.set('difficulty', room.difficulty);
  const base = loadConfig(p);
  for (const key of NUMERIC_OVERRIDES) if (typeof room[key] === 'string' && room[key] !== String(base[key])) p.set(key, room[key]);
  const made = worldRules(p);
  return Object.keys(made).every((k) => typeof room[k] !== 'string' || room[k] === made[k]) ? url.toString() : null;
}
