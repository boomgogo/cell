// Arcade preset: the tuned preset + maze districts, rainbow power pellets and resident ghosts, on the riso
// paper stock (`?theme=press` for the dark stock).
// Every override carries its reason once playtests or arena runs justify it.
import { tunedConfig } from './tuned.ts';
import type { GameConfig } from './types.ts';

export const arcadeConfig: GameConfig = {
  ...tunedConfig,
  preset: 'arcade',
  mazes: true,
};
