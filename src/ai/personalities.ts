// NPC personalities: weight presets + which actions are allowed.
export type PersonalityId = 'grazer' | 'hunter' | 'survivor' | 'scavenger' | 'trickster';

export interface Personality {
  id: PersonalityId;
  label: string;
  /** Interest weights. */
  food: number;
  prey: number;
  ejected: number;
  /** Follow big cells at a safe distance to pick up fragments. */
  shadow: number;
  /** Danger weights. */
  threat: number;
  virusAvoid: number;
  /** How strongly danger outweighs interest when choosing a direction. */
  caution: number;
  /** Threats further than 150 + this many of their own radii (edge distance) are ignored. */
  threatRange: number;
  splitKill: boolean;
  splitEscape: boolean;
  hideAtVirus: boolean;
  feedVirus: boolean;
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  grazer: {
    id: 'grazer',
    label: 'Grazer',
    food: 1,
    prey: 0,
    ejected: 1,
    shadow: 0,
    threat: 1.6,
    virusAvoid: 1,
    caution: 1.4,
    threatRange: 4,
    splitKill: false,
    splitEscape: false,
    hideAtVirus: false,
    feedVirus: false,
  },
  hunter: {
    id: 'hunter',
    label: 'Hunter',
    food: 0.6,
    prey: 2.2,
    ejected: 1.5,
    shadow: 0,
    threat: 0.8,
    virusAvoid: 1,
    caution: 0.7,
    threatRange: 2.5,
    splitKill: true,
    splitEscape: false,
    hideAtVirus: false,
    feedVirus: false,
  },
  survivor: {
    id: 'survivor',
    label: 'Survivor',
    food: 1,
    prey: 0.4,
    ejected: 1,
    shadow: 0,
    threat: 2.5,
    virusAvoid: 1.5,
    caution: 1.8,
    threatRange: 6,
    splitKill: false,
    splitEscape: true,
    hideAtVirus: true,
    feedVirus: false,
  },
  scavenger: {
    id: 'scavenger',
    label: 'Scavenger',
    food: 0.8,
    prey: 1.2,
    ejected: 3,
    shadow: 0.9,
    threat: 1.2,
    virusAvoid: 1,
    caution: 1.1,
    threatRange: 3.5,
    splitKill: false,
    splitEscape: false,
    hideAtVirus: false,
    feedVirus: false,
  },
  trickster: {
    id: 'trickster',
    label: 'Trickster',
    food: 0.8,
    prey: 1.2,
    ejected: 1,
    shadow: 0,
    threat: 1.1,
    virusAvoid: 1.2,
    caution: 1,
    threatRange: 3.5,
    splitKill: true,
    splitEscape: false,
    hideAtVirus: false,
    feedVirus: true,
  },
};

export interface Difficulty {
  /** Ticks between decisions (reaction time). */
  thinkTicks: number;
  /** Random aim error in radians. */
  aimNoise: number;
  /** Fraction of the human-equivalent view the NPC perceives. */
  perception: number;
  /** Chance per decision to overlook threats. */
  mistakeRate: number;
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', Difficulty> = {
  easy: { thinkTicks: 6, aimNoise: 0.35, perception: 0.7, mistakeRate: 0.15 },
  normal: { thinkTicks: 4, aimNoise: 0.15, perception: 0.9, mistakeRate: 0.05 },
  hard: { thinkTicks: 2, aimNoise: 0.04, perception: 1, mistakeRate: 0 },
};

export const PERSONALITY_MIX: [PersonalityId, number][] = [
  ['grazer', 0.3],
  ['hunter', 0.2],
  ['survivor', 0.2],
  ['scavenger', 0.15],
  ['trickster', 0.15],
];
