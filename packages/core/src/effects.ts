/**
 * A number that deepens with the rank of the teaching behind it: `atRank1` at the first rank, and
 * `perRank` more for each rank after. A plain number holds at every rank.
 */
export type Scaled = number | { atRank1: number; perRank: number };

/** A scaled number at the rank given, from 1. */
export function scaled(value: Scaled, rank: number): number {
  return typeof value === 'number' ? value : value.atRank1 + value.perRank * (rank - 1);
}

/**
 * A timed effect on a dreamer or a nightmare, and what it changes while it holds. A share left out
 * is 1, so it changes nothing.
 */
export interface Effect {
  /** How long it holds, by the rank of the ability that applied it. */
  seconds: Scaled;
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
  /** The health a second it names for its holder, which makes it a heal over time, so a fall ends it. */
  healthPerSecond?: number;
  /** The harm it names to take in its holder's place, a shield's size. `harmTaken` does not read it. */
  absorb?: number;
}

/**
 * The timed effects, by id. An id travels the wire, so it is kebab-case like a teaching id. An
 * effect applied again to a holder that has it starts its seconds over rather than stacking.
 */
export const EFFECTS = {
  braced: { seconds: { atRank1: 4, perRank: 1 }, damageTaken: 0.5, movement: 'noRun' },
  challenged: { seconds: 6, turnsOnSource: true },
} as const satisfies Record<string, Effect>;
export type EffectId = keyof typeof EFFECTS;

export function isEffectId(value: string): value is EffectId {
  return Object.hasOwn(EFFECTS, value);
}

export function effect(effectId: EffectId): Effect {
  return EFFECTS[effectId];
}

/** How long the effect holds when an ability of the rank given applies it. */
export function effectSeconds(effectId: EffectId, rank: number): number {
  return scaled(effect(effectId).seconds, rank);
}
