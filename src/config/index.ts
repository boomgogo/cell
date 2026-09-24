import { baseConfig } from './base.ts';
import { arcadeConfig } from './arcade.ts';
import { tunedConfig } from './tuned.ts';
import type { GameConfig } from './types.ts';

export type { GameConfig } from './types.ts';

const PRESETS: Record<string, GameConfig> = { base: baseConfig, tuned: tunedConfig, arcade: arcadeConfig };

const NUMERIC_OVERRIDES = [
  'sphereRadius',
  'foodPerRefArea',
  'npcPerRefArea',
  'virusMinPerRefArea',
  'activeZoneRadius',
  'mapSeed',
  'cornerAssist',
] as const;

/** Preset from `?preset=` (default: arcade), with a few overrides for spikes, e.g. `?sphereRadius=8000`. */
export function loadConfig(params: URLSearchParams): GameConfig {
  const base = PRESETS[params.get('preset') ?? 'arcade'] ?? arcadeConfig;
  const cfg: GameConfig = { ...base };
  for (const key of NUMERIC_OVERRIDES) {
    const v = params.get(key);
    if (v !== null && Number.isFinite(Number(v))) cfg[key] = Number(v);
  }
  // The old names stay as aliases so earlier links, the e2e suite and bookmarks keep working.
  const theme = params.get('theme');
  if (theme === 'paper' || theme === 'light') cfg.theme = 'paper';
  else if (theme === 'press' || theme === 'dark' || theme === 'arcade') cfg.theme = 'press';
  if (params.get('maze') === '0') cfg.mazes = false;
  return cfg;
}

/** Scales a density per reference area to a whole-sphere count. */
export function perSphere(cfg: GameConfig, perRefArea: number): number {
  return Math.round((perRefArea * 4 * Math.PI * cfg.sphereRadius * cfg.sphereRadius) / cfg.refArea);
}
