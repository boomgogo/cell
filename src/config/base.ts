// Base preset: the reference rules. `tuned` and `arcade` are built from it.
import type { GameConfig } from './types.ts';

export const baseConfig: GameConfig = {
  preset: 'base',
  tickMs: 40,

  sphereRadius: 16000,
  refArea: 2e8,
  foodPerRefArea: 7000,
  foodSize: 10,
  virusMinPerRefArea: 50,
  virusMaxPerRefArea: 100,
  npcPerRefArea: 50,

  boostDivisor: 9,

  virusRadius: 100,
  virusShootRadius: Math.sqrt(20000), // mass 200
  virusShotBoost: 780,

  ejectRadius: 40,
  ejectCostRadius: 45,
  ejectCooldownTicks: 3,
  ejectBoost: 780,
  ejectSpread: 0.3,

  startRadius: Math.sqrt(1000), // mass 10
  minRadius: Math.sqrt(1000),
  autoSplitRadius: 1500,
  splitMinRadius: 60,
  ejectMinRadius: Math.sqrt(3200), // mass 32
  cellLimit: 16,
  speedScale: 1,
  decayRate: 0.002,
  mergeSeconds: 30,
  mergeSecondsPerRadius: 0.2,
  splitBoost: 780,
  splitNoCollideTicks: 15,

  eatSizeRatio: 1.1401,
  eatDepthDivisor: 3,
  virusEatDepthDivisor: 20,

  viewBaseWidth: 1920,
  viewBaseHeight: 1080,
  maxWheelZoom: 4,

  activeZoneRadius: 8000,
  activeZoneMargin: 1500,
  npcRespawnTicks: 50,

  gridSpacing: 50,
  theme: 'paper',

  // Arcade values live here too so every preset is a complete config; `mazes: false` turns the mode off.
  mazes: false,
  mapSeed: 1,
  fineTile: 140,
  districtMinMargin: 2000,
  wallRadius: 14,
  squeezeMinSpeed: 0.35,
  // A cell bigger than the way out packs to 1 unit under it (a prototype got every overgrown cell out with that,
  // 840 cases, r 72–250); 4 % per tick swells a cell back to full size in about 0.25–0.5 s.
  packMargin: 1,
  packRelease: 0.04,
  mazeZoom: 0.6,
  cornerAssist: 0.5,
  powerPelletSize: 30,
  // 15 s (was 45 s) so power comes round often enough for everyone, NPCs included.
  powerRespawnSeconds: 15,
  rainbowSeconds: 8,
  // The first design said 32; the arcade arena (seed 2) hit it with 10 knockbacks (14.7 % of rainbow touches) when one
  // rainbow NPC kept exploding the same victim's pieces. 48 leaves room for another step of the chain.
  explodeMaxCells: 48,
  explodeGraceTicks: 6,
  explodeCrumbShare: 0.3,
  explodeMinMass: 2,
  explodeKnockback: 300,
  residentsPerDistrict: 4,
  ghostSmallMass: 30,
  ghostMidMass: 400,
  ghostSpeed: 1.25,
  ghostRespawnSeconds: 5,
  scatterSeconds: 7,
  chaseSeconds: 20,
  floodBudget: 12,

  // NPCs commit to a direction and, when nothing nearby is worth turning for, to a far goal.
  botTurnCost: 0.35,
  botFoodShare: 0.002,
  botWanderEnter: 0.02,
  botWanderHoldTicks: 300,
};
