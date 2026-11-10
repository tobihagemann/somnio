import type { Energy } from '@somnio/protocol';
import type { Body } from './collision.ts';
import { COMBAT, handAllows } from './combat.ts';
import type { EngageTarget, HandNeed } from './combat.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { scaled } from './effects.ts';
import type { EffectId, Scaled } from './effects.ts';
import { distance } from './geometry.ts';
import type { Point } from './geometry.ts';
import { TEACHING_IDS, rankOf, teaching } from './lucidity.ts';
import type { HeldRank, TeachingId } from './lucidity.ts';
import { SPEECH } from './speech.ts';

/**
 * The abilities on the belt's slots 2–6, each taught by a teaching's first rank and deepened by its
 * further ranks, and the rules over them that the server applies and the client follows. Slot 1 is
 * not one of them: its swings and mends keep their own rhythm and never start or wait on a cooldown
 * here. The numbers are tuned in play.
 */

/** The pool an ability spends. */
export type AbilityPool = 'balance' | 'spirit';

/**
 * What an ability lands on, from the dreamer's one target. An `enemy` ability lands on the target
 * while it is a nightmare not yet driven off, in range. An `ally` ability lands on the target while
 * it is a standing dreamer in range, the caster included, and on the caster while the target is no
 * dreamer. A `self` ability lands on the caster, and an `area` one on the bodies round the caster.
 */
export type AbilityAim = 'enemy' | 'ally' | 'self' | 'area';

/** What an ability does where it lands. */
export type AbilityDeed =
  /** A swing at every nightmare a swing meets, for a share of the swing's damage. */
  | { kind: 'strike'; damageShare: Scaled }
  /** A timed effect, holding for its seconds at the ability's rank. */
  | { kind: 'effect'; effectId: EffectId }
  /** A leap to the recipient, as far as the ability's range, which the caster's client moves them through. */
  | { kind: 'leap'; metresPerSecond: number }
  /** Some of a pool given back at once. */
  | { kind: 'restore'; pool: AbilityPool; amount: Scaled };

export interface Ability {
  pool: AbilityPool;
  cost: number;
  cooldownSeconds: Scaled;
  aim: AbilityAim;
  /** How far beyond contact a body stands at most to be reached: the target for `enemy` and `ally`, every body round the caster for `area`. */
  range: number;
  /** Which bodies round the caster an `area` ability lands on, of those still standing. */
  among?: EngageTarget;
  /** What the caster holds in hand to use it, by the rule slot 1 holds to; left out when the hand does not matter. */
  hand?: HandNeed;
  /** How long it names to channel before it lands. The server lands every ability the moment it is used. */
  channelSeconds?: Scaled;
  does: AbilityDeed;
}

/** The abilities, by id, each taught by the teaching that names it as its `ability`. An id travels the wire. */
export const ABILITIES = {
  cleave: {
    pool: 'balance',
    cost: 16,
    cooldownSeconds: 6,
    aim: 'area',
    range: COMBAT.reachSlack,
    among: 'nightmare',
    hand: 'mainHand',
    does: { kind: 'strike', damageShare: { atRank1: 0.6, perRank: 0.2 } },
  },
  challenge: {
    pool: 'balance',
    cost: 10,
    cooldownSeconds: 20,
    aim: 'area',
    range: 5,
    among: 'nightmare',
    hand: 'mainHand',
    does: { kind: 'effect', effectId: 'challenged' },
  },
  brace: { pool: 'balance', cost: 15, cooldownSeconds: 15, aim: 'self', range: 0, hand: 'mainHand', does: { kind: 'effect', effectId: 'braced' } },
  lunge: {
    pool: 'balance',
    cost: 12,
    cooldownSeconds: { atRank1: 10, perRank: -2 },
    aim: 'enemy',
    range: 3,
    hand: 'mainHand',
    does: { kind: 'leap', metresPerSecond: 6 },
  },
  /** A shout heard as far as a said line carries, centre to centre. */
  rally: {
    pool: 'balance',
    cost: 10,
    cooldownSeconds: 30,
    aim: 'area',
    range: SPEECH.say.reachMetres - 2 * SOMNIO_CONSTANTS.playerRadius,
    among: 'dreamer',
    hand: 'mainHand',
    does: { kind: 'restore', pool: 'balance', amount: { atRank1: 20, perRank: 5 } },
  },
} as const satisfies Record<string, Ability>;
export type AbilityId = keyof typeof ABILITIES;

export function isAbilityId(value: string): value is AbilityId {
  return Object.hasOwn(ABILITIES, value);
}

/** The teaching whose first rank teaches the ability. */
export function abilityTeaching(abilityId: AbilityId): TeachingId {
  return TEACHING_IDS.find((id) => teaching(id).ability === abilityId)!;
}

export function ability(abilityId: AbilityId): Ability {
  return ABILITIES[abilityId];
}

/** The rank the dreamer holds of the teaching that teaches the ability; 0 when they hold none. */
export function abilityRank(ranks: readonly HeldRank[], abilityId: AbilityId): number {
  return rankOf(ranks, abilityTeaching(abilityId));
}

export function abilityCooldownSeconds(abilityId: AbilityId, rank: number): number {
  return scaled(ability(abilityId).cooldownSeconds, rank);
}

/** The abilities a dreamer's ranks teach, in the order of the teachings that teach them, which is the belt's order. */
export function abilitiesTaught(ranks: readonly HeldRank[]): AbilityId[] {
  return TEACHING_IDS.flatMap((id) => {
    const ability = teaching(id).ability;
    return ability !== undefined && rankOf(ranks, id) >= 1 ? [ability] : [];
  });
}

/** The short wait every ability use starts before any ability can be used again. */
export const GLOBAL_COOLDOWN_SECONDS = 0.75;

/** A body an ability may land on, as its rules see it: what it is to slot 1, nothing for an NPC, and whether it has fallen. */
export interface AbilityBody extends Body {
  kind: EngageTarget | undefined;
  fallen: boolean;
}

function withinRange(caster: Point, body: Body, range: number): boolean {
  return distance(caster, body) <= SOMNIO_CONSTANTS.playerRadius + body.radius + range;
}

/** The bodies an `area` ability lands on round the caster: those of its `among` that stand, within its range. */
export function areaRecipients<B extends AbilityBody>(ability: Ability, caster: Point, bodies: Iterable<B>): B[] {
  return [...bodies].filter((body) => body.kind === ability.among && !body.fallen && withinRange(caster, body, ability.range));
}

/**
 * Who an ability lands on, or is centred on, from the caster's one target; `undefined` when there
 * is nobody. An `ally` ability falls back to the caster only when the target is no dreamer: at a
 * fallen dreamer, whom only slot 1 raises, or at one out of range, it lands on nobody.
 */
export function abilityRecipient<B extends AbilityBody>(ability: Ability, caster: B, target: B | undefined): B | undefined {
  switch (ability.aim) {
    case 'enemy':
      return target?.kind === 'nightmare' && withinRange(caster, target, ability.range) ? target : undefined;
    case 'ally':
      if (target?.kind !== 'dreamer') return caster;
      return !target.fallen && withinRange(caster, target, ability.range) ? target : undefined;
    case 'self':
    case 'area':
      return caster;
  }
}

/** What a rule reads of a dreamer to judge an ability use. */
export interface AbilityState<B extends AbilityBody> {
  caster: B;
  ranks: readonly HeldRank[];
  itemInHand: string | undefined;
  energy: Pick<Energy, 'balanceCurrent' | 'spiritCurrent'>;
  /** The caller's clock, in the unit of the ready times. */
  now: number;
  /** When the global cooldown ends. */
  globalReadyAt: number;
  /** When each ability's own cooldown ends; an ability left out is ready. */
  readyAt: Partial<Record<AbilityId, number>>;
}

/** Where each pool an ability spends or gives back lies in the pools, and its maximum. */
export const POOL_FIELDS = {
  balance: { current: 'balanceCurrent', max: 'balanceMax' },
  spirit: { current: 'spiritCurrent', max: 'spiritMax' },
} as const satisfies Record<AbilityPool, { current: keyof Energy; max: keyof Energy }>;

/**
 * Who the ability lands on if the dreamer uses it now, or `undefined` when they cannot: they stand,
 * hold its teaching, hold what its kit needs in hand, have its cost in its pool, are past both its
 * own cooldown and the global one, and it has a recipient.
 */
export function abilityAllowed<B extends AbilityBody>(state: AbilityState<B>, abilityId: AbilityId, target: B | undefined): B | undefined {
  const used = ability(abilityId);
  if (state.caster.fallen || abilityRank(state.ranks, abilityId) < 1) return undefined;
  if (used.hand !== undefined && !handAllows(used.hand, state.itemInHand)) return undefined;
  if (state.energy[POOL_FIELDS[used.pool].current] < used.cost) return undefined;
  if (state.now < state.globalReadyAt || state.now < (state.readyAt[abilityId] ?? state.now)) return undefined;
  return abilityRecipient(used, state.caster, target);
}
