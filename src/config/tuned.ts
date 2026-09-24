// Tuned preset: single-player tuning. Starts identical to the base preset; every override
// gets a comment with the reason once playtests / arena runs justify it.
import { baseConfig } from './base.ts';
import type { GameConfig } from './types.ts';

export const tunedConfig: GameConfig = {
  ...baseConfig,
  preset: 'tuned',
};
