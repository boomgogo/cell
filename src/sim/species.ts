// Bacteria species. Players and NPCs share one species; rules read traits through here so later
// species can change them without touching the systems.
export interface SpeciesDef {
  id: string;
  name: string;
  speed: number;
  decay: number;
  eatRatio: number;
  mergeTime: number;
  maxCells: number;
  /** Eats pellets, power pellets, ejected mass and viruses. */
  eatsFood: boolean;
  canSplit: boolean;
  canEject: boolean;
  /** Mass never changes (resident ghosts). */
  fixedMass: boolean;
  /** Can pass ghost pen doors. */
  passesDoor: boolean;
}

export const COCCUS: SpeciesDef = {
  id: 'coccus',
  name: 'Coccus',
  speed: 1,
  decay: 1,
  eatRatio: 1,
  mergeTime: 1,
  maxCells: 1,
  eatsFood: true,
  canSplit: true,
  canEject: true,
  fixedMass: false,
  passesDoor: false,
};

/** Resident maze ghosts: fixed mass, no split/eject, don't eat food, pass pen doors. */
export function ghostSpecies(speed: number): SpeciesDef {
  return {
    id: 'ghost',
    name: 'Phage',
    speed,
    decay: 0,
    eatRatio: 1,
    mergeTime: 1,
    maxCells: 1,
    eatsFood: false,
    canSplit: false,
    canEject: false,
    fixedMass: true,
    passesDoor: true,
  };
}

export const SPECIES: Record<string, SpeciesDef> = { [COCCUS.id]: COCCUS };
