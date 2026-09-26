import { type Vec3, vec3 } from '../sphere/vec3.ts';
import type { Cell } from './cell.ts';
import type { Controller } from './controller.ts';
import { COCCUS, type SpeciesDef } from './species.ts';

export type GhostStyle = 'chaser' | 'ambusher' | 'flanker' | 'shy';

export interface Resident {
  district: number;
  style: GhostStyle;
  /** 0 = small (fine corridors), 1 = mid-size (coarse corridors). */
  tier: number;
}

/** One controller (human or NPC) owning up to 16 cells. */
export class Organism {
  readonly id: number;
  name: string;
  /** Country for the flag next to the name: ISO 3166-1 alpha-2, lower case; '' for none. Presentation only. */
  country = '';
  hue: number;
  species: SpeciesDef = COCCUS;
  readonly cells: Cell[] = [];
  controller: Controller;
  readonly isHuman: boolean;

  // Intent: the only way controllers act on the world.
  readonly target: Vec3 = vec3(0, 0, 1);
  wantSplit = false;
  wantEject = false;
  lastEjectTick = -1e9;

  alive = false;
  /** Tick at which a dead NPC respawns. */
  respawnTick = 0;

  // Dormant state (outside the active zone).
  dormant = false;
  readonly dormantP: Vec3 = vec3(0, 0, 1);
  readonly dormantHeading: Vec3 = vec3(1, 0, 0);
  dormantMass = 0;

  // Arcade
  /** Speed multiplier on top of the species. */
  speedFactor = 1;
  /** Tick until which this organism is in the rainbow state (explodes bigger cells it touches). */
  rainbowUntil = 0;
  /** Explosions made in the current rainbow period (chain counter). */
  explodeCount = 0;
  /** Resident ghost data; null for everyone else. */
  resident: Resident | null = null;
  /** Respawn point and fixed mass (residents). */
  home: Vec3 | null = null;
  baseMass = 0;

  // Stats
  spawnTick = 0;
  kills = 0;
  peakMass = 0;
  lastMass = 0;

  constructor(id: number, name: string, hue: number, controller: Controller, isHuman: boolean) {
    this.id = id;
    this.name = name;
    this.hue = hue;
    this.controller = controller;
    this.isHuman = isHuman;
  }

  /** Total mass (packed mass included), or the dormant record. */
  get mass(): number {
    if (this.dormant) return this.dormantMass;
    let m = 0;
    for (const c of this.cells) m += c.totalMass;
    return m;
  }

  get sumRadius(): number {
    let s = 0;
    for (const c of this.cells) s += c.r;
    return s;
  }

  largestCell(): Cell | null {
    let best: Cell | null = null;
    for (const c of this.cells) if (!best || c.r > best.r) best = c;
    return best;
  }

  /** Normalised average of cell positions (the camera centre). */
  center(out: Vec3): Vec3 {
    if (this.dormant || this.cells.length === 0) {
      out.x = this.dormantP.x;
      out.y = this.dormantP.y;
      out.z = this.dormantP.z;
      return out;
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of this.cells) {
      x += c.p.x;
      y += c.p.y;
      z += c.p.z;
    }
    const l = Math.hypot(x, y, z) || 1;
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
    return out;
  }
}
