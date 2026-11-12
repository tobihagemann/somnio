/**
 * A number that deepens with the rank of the teaching behind it: `atRank1` at the first rank, and
 * `perRank` more for each rank after. A plain number holds at every rank.
 */
export type Scaled = number | { atRank1: number; perRank: number };

/** A scaled number at the rank given, from 1. */
export function scaled(value: Scaled, rank: number): number {
  return typeof value === 'number' ? value : value.atRank1 + value.perRank * (rank - 1);
}

/** A scaled number at the rank given, or `fallback` for one left out. */
export function scaledOr<F>(value: Scaled | undefined, rank: number, fallback: F): number | F {
  return value === undefined ? fallback : scaled(value, rank);
}

/**
 * An effect on a dreamer or a nightmare, timed or held as long as its holder, and what it changes
 * while it holds. A share left out is 1, so it changes nothing.
 */
export interface Effect {
  /** How long it holds, by the rank of the ability that applied it; left out for an elite's trait, which holds as long as its holder. */
  seconds?: Scaled;
  /** The share of the harm that reaches its holder. */
  damageTaken?: number;
  /** The share of its holder's harm that lands. */
  damageDealt?: number;
  /** The limit on how its holder moves. `gaitAllowed` holds a holder of either limit to a jog. */
  movement?: 'noRun' | 'rooted';
  /** The share of the threat its holder's deeds raise. */
  threatGenerated?: number;
  /** Its holder, a nightmare, turns on the dreamer who applied it, whoever else it holds threat against. */
  turnsOnSource?: true;
  /** The health a second it gives its holder, by the rank of the ability that applied it, which makes it a heal over time, so a fall ends it. */
  healthPerSecond?: Scaled;
  /**
   * The harm it takes in its holder's place, by the rank of the ability that applied it, or at rank 1
   * for an elite's trait: a shield, worn down by each hit it takes and gone once it has taken all it
   * holds.
   */
  absorb?: Scaled;
  /** Nightmares leave its holder alone: off their tables, and out of whom they chase and strike, while it holds. */
  unseen?: true;
}

/**
 * The effects, by id: the abilities' timed ones and the elites' traits, which hold as long as their
 * holder. An id travels the wire, so it is kebab-case like a teaching id. An effect applied again
 * to a holder that has it starts its seconds over rather than stacking.
 */
export const EFFECTS = {
  braced: { seconds: { atRank1: 4, perRank: 1 }, damageTaken: 0.5, movement: 'noRun' },
  challenged: { seconds: 6, turnsOnSource: true },
  renewing: { seconds: 10, healthPerSecond: { atRank1: 2.5, perRank: 0.75 } },
  calmed: { seconds: 8, threatGenerated: 0.5 },
  warded: { seconds: 12, absorb: { atRank1: 12, perRank: 5 } },
  weakened: { seconds: { atRank1: 8, perRank: 2 }, damageDealt: 0.6 },
  bound: { seconds: { atRank1: 3, perRank: 1 }, movement: 'rooted' },
  veiled: { seconds: 5, unseen: true },
  stony: { damageTaken: 0.6 },
  shielded: { absorb: 15 },
} as const satisfies Record<string, Effect>;
export type EffectId = keyof typeof EFFECTS;

export function isEffectId(value: string): value is EffectId {
  return Object.hasOwn(EFFECTS, value);
}

export function effect(effectId: EffectId): Effect {
  return EFFECTS[effectId];
}

/** How long the effect holds when an ability of the rank given applies it; without end for a trait's. */
export function effectSeconds(effectId: EffectId, rank: number): number {
  return scaledOr(effect(effectId).seconds, rank, Number.POSITIVE_INFINITY);
}

/** The harm the effect takes in its holder's place when an ability of the rank given applies it, or an elite's trait at rank 1; 0 for an effect that is no shield. */
export function effectAbsorb(effectId: EffectId, rank: number): number {
  return scaledOr(effect(effectId).absorb, rank, 0);
}

/** The health a second the effect gives its holder when an ability of the rank given applies it; 0 for an effect that heals nothing. */
export function effectHealthPerSecond(effectId: EffectId, rank: number): number {
  return scaledOr(effect(effectId).healthPerSecond, rank, 0);
}
