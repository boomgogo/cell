// All tunables in one place. `base` = the reference rules, `tuned` = single-player tuning, `arcade` = tuned + mazes.
export interface GameConfig {
  preset: string;

  /** Simulation tick length (40 ms = 25 Hz). */
  tickMs: number;

  // World
  sphereRadius: number;
  /** Reference area (2·10⁸ units²) for the densities below: counts per this much sphere surface. */
  refArea: number;
  foodPerRefArea: number;
  foodSize: number;
  virusMinPerRefArea: number;
  virusMaxPerRefArea: number;
  npcPerRefArea: number;

  // Launches: a split piece, an ejected blob or a shot virus glides its boost (world units) in all, covering
  // 1/boostDivisor of what is left each tick.
  boostDivisor: number;

  // Viruses
  /** Radius of a new virus. */
  virusRadius: number;
  /** A virus fed up to this radius goes back to virusRadius and shoots a new virus. */
  virusShootRadius: number;
  virusShotBoost: number;

  // Ejected mass (W)
  /** Radius of an ejected blob. */
  ejectRadius: number;
  /** The ejecting cell loses the area of a disc this size (ejectCostRadius² / 100 mass). */
  ejectCostRadius: number;
  ejectCooldownTicks: number;
  ejectBoost: number;
  /** Ejected blobs leave up to this many radians either side of the aim. */
  ejectSpread: number;

  // Player cells
  startRadius: number;
  /** Decay stops here, and no split may leave a piece smaller. */
  minRadius: number;
  /** A cell that grows past this splits in two by itself (or stops growing at the cell limit). */
  autoSplitRadius: number;
  splitMinRadius: number;
  ejectMinRadius: number;
  /** Most cells one organism may have (species scale it). */
  cellLimit: number;
  speedScale: number;
  /** Share of mass lost per second. */
  decayRate: number;
  /** A split piece may merge back after mergeSeconds, or mergeSecondsPerRadius × its radius when that is longer. */
  mergeSeconds: number;
  mergeSecondsPerRadius: number;
  splitBoost: number;
  splitNoCollideTicks: number;

  // Eat rule
  eatSizeRatio: number;
  eatDepthDivisor: number;
  virusEatDepthDivisor: number;

  // Camera (view normalisation to a reference screen)
  viewBaseWidth: number;
  viewBaseHeight: number;
  maxWheelZoom: number;

  // Population
  activeZoneRadius: number;
  activeZoneMargin: number;
  npcRespawnTicks: number;

  // Render
  gridSpacing: number;
  /** Look: risograph inks on off-white paper (default) or on dark press stock. `?theme=` overrides. */
  theme: 'paper' | 'press';

  // Arcade mazes. Off in the base and tuned presets.
  mazes: boolean;
  /** Seed of the region/district layout. Independent of the world seed so the map is the same every game. */
  mapSeed: number;
  /** Fine maze tile in world units; coarse tiles are 4 fine tiles, avenues 8. */
  fineTile: number;
  /** Minimum plains between a district corner and its region edge. */
  districtMinMargin: number;
  /** Half-thickness of the drawn wall tubes (render only; the collision surface is the tile boundary). */
  wallRadius: number;
  /** Speed factor floor for a cell squeezed in a corridor narrower than its diameter. */
  squeezeMinSpeed: number;
  /** A cell bigger than the widest way out from where it is packs to this many units under it. */
  packMargin: number;
  /** Packed mass comes back as radius growth of at most this fraction per tick once there is room. */
  packRelease: number;
  /** Camera zoom factor inside maze districts (shows more of the maze), faded in near the district edge. */
  mazeZoom: number;
  /** Corner assist strength in corridors, 0 = off. */
  cornerAssist: number;
  /** Mass gain radius of a power pellet (the pellet is eaten like food; r² / 100 mass). */
  powerPelletSize: number;
  /** Seconds a power pellet spot stays empty after being eaten (± 25 % jitter). */
  powerRespawnSeconds: number;
  /** Rainbow state length after a power pellet. */
  rainbowSeconds: number;
  /** An exploded organism may grow to this many cells (virus pops stop at cellLimit). */
  explodeMaxCells: number;
  /** Ticks during which fresh explosion pieces can't be eaten or exploded. */
  explodeGraceTicks: number;
  /** At most this fraction of an exploded cell's mass becomes crumbs sized to the exploder. */
  explodeCrumbShare: number;
  /** Smallest piece an explosion makes (mass). */
  explodeMinMass: number;
  /** Push given to a cell that is touched but has no room left to explode. */
  explodeKnockback: number;
  residentsPerDistrict: number;
  ghostSmallMass: number;
  ghostMidMass: number;
  ghostSpeed: number;
  ghostRespawnSeconds: number;
  scatterSeconds: number;
  chaseSeconds: number;
  /** NPC path floods allowed per tick. */
  floodBudget: number;

  // NPC steering
  /** Turning cost as a share of the field's peak: 90° costs this much, a reversal twice as much. */
  botTurnCost: number;
  /** Pellets pull at full strength up to a cell mass of pellet mass / this; bigger cells care less about crumbs. */
  botFoodShare: number;
  /** A field weaker than this starts a wander goal (3× this ends it); the goal pulls with this strength. */
  botWanderEnter: number;
  /** A wander goal is dropped after this many ticks. */
  botWanderHoldTicks: number;
}
