import type { Condition, Energy, Gait, Role } from '@somnio/protocol';
import type { Body } from './collision.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { effect } from './effects.ts';
import type { EffectId } from './effects.ts';
import { clamp, distance } from './geometry.ts';
import type { Point } from './geometry.ts';
import { angularDistance, headingFromVector } from './heading.ts';
import type { Heading } from './heading.ts';
import { itemWeapon } from './items.ts';
import type { ItemId } from './items.ts';
import { forbidsStriking, rankOf } from './lucidity.ts';
import type { HeldRank, Lucidity, TaskSpec, TeachingId } from './lucidity.ts';
import type { MonsterKind } from './monsterKinds.ts';

/**
 * Fighting, mending, and the three pools: every starting value in one table, and the rules over
 * it that the server applies and the client follows. The numbers are tuned in play.
 */
export const COMBAT = {
  /** Every pool's maximum before any rank raises it. */
  basePool: 100,

  bareHands: { damage: 4, balanceCost: 8 },
  swingSeconds: 1.0,
  /** A dreamer's chance to land a swing. */
  hitChance: 0.75,
  damagePerStrikeRank: 3,
  /** The share of the swing interval each Follow-through rank takes off. */
  swingSecondsPerFollowThroughRank: 0.1,
  /** How wide in front of a dreamer a swing looks for a nightmare to meet. */
  swingArcDegrees: 120,
  /** A swing slows the dreamer who makes it to this share of their speed, for this long. */
  swingSlow: { factor: 0.7, seconds: 0.4 },
  /** What each Guard rank takes off a nightmare's hit chance. */
  hitChancePerGuardRank: 0.08,
  /** What an empty balance adds to a nightmare's hit chance, scaled linearly down to nothing at full. */
  emptyBalanceHitChance: 0.3,

  /** Balance a second of running costs. */
  runDrainPerSecond: 10,
  /** Balance a second of standing recovers. */
  balancePerSecond: 12,
  balancePace: { walk: 1.0, jog: 0.4, run: 0 },
  /** The share each Balance recovery rank adds to the recovery. */
  balancePerRecoveryRank: 0.25,
  /** A winded dreamer stays winded until their balance is back to this. */
  windedUntil: 15,
  healthPerSecond: 0.5,
  spiritPerSecond: 1,
  healthPerTougheningRank: 10,
  spiritPerDeepeningRank: 10,

  /** `reach` is how far apart, centre to centre, a Healer and the dreamer they mend stand at most. */
  mend: { health: 10, healthPerDepthRank: 5, spiritCost: 8, seconds: 1, reach: 3 },
  raise: { seconds: 6, spiritCost: 40, healthFraction: 0.25, graceSeconds: 5 },
  /** The threat each point of health mended raises against the Healer, shared among the nightmares holding threat against the dreamer mended. A hit raises as much threat as the harm it lands. */
  threatPerHealthMended: 0.5,
  /** The share of each pool a dreamer who gave up wakes with. */
  weakenedFraction: 0.25,

  /** How far beyond contact a swing, a strike, or a Moonstone still reaches. */
  reachSlack: 0.25,
  /** How far from a fading nightmare a dreamer still shares its bounty and earns practice. */
  shareRadius: 6,
  /** How long a nightmare driven off lingers before it is gone. */
  fadeSeconds: 1,
} as const;

/** The bands between the maximum and none, from the top, each above its share of the maximum. */
const HARMED_BANDS = [
  { condition: 'grazed', above: 0.75 },
  { condition: 'wounded', above: 0.5 },
  { condition: 'hurt', above: 0.25 },
  { condition: 'failing', above: 0 },
] as const;

/** The band a health total stands in: hale only at the maximum, then by quarters. Anything above zero is still standing. */
export function conditionOf(current: number, max: number): Condition {
  if (current <= 0) return 'fallen';
  if (current >= max) return 'hale';
  const part = current / max;
  for (const band of HARMED_BANDS) if (part > band.above) return band.condition;
  return 'failing';
}

/** The middle of a condition's band as a share of the maximum: what a bar shows of a health known only by its band. */
export function conditionMidpoint(condition: Condition): number {
  if (condition === 'hale') return 1;
  if (condition === 'fallen') return 0;
  const at = HARMED_BANDS.findIndex((band) => band.condition === condition);
  const top = at === 0 ? 1 : HARMED_BANDS[at - 1]!.above;
  return (top + HARMED_BANDS[at]!.above) / 2;
}

/** A pool's share of its maximum. A maximum of zero or less comes only from a broken frame, and would not divide to a share. */
export function poolShare(current: number, max: number): number {
  return max > 0 ? clamp(current / max, 0, 1) : 0;
}

/** Winded begins at an empty balance and ends only once it is back to the threshold. */
export function windedAfter(wasWinded: boolean, balance: number): boolean {
  if (balance <= 0) return true;
  return wasWinded && balance < COMBAT.windedUntil;
}

/**
 * Winded is not saved, so a join starts it from the balance alone. Server and client both start
 * here and both fold `windedAfter` over the same balances afterwards, which is what keeps them agreed.
 */
export function windedOnJoin(balance: number): boolean {
  return balance < COMBAT.windedUntil;
}

/** The share of the standing recovery a dreamer's balance gets: none while running, and none on the move while winded. */
export function balancePace(motion: Gait | 'standing', winded: boolean): number {
  if (motion === 'standing') return 1;
  return winded ? 0 : COMBAT.balancePace[motion];
}

/** The gait a dreamer asking for `gait` moves at: no faster than a jog while an effect they hold limits how they move. */
export function gaitAllowed(gait: Gait, effects: readonly EffectId[]): Gait {
  return gait === 'run' && effects.some((effectId) => effect(effectId).movement !== undefined) ? 'jog' : gait;
}

export function balancePerSecond(ranks: readonly HeldRank[]): number {
  return COMBAT.balancePerSecond * (1 + COMBAT.balancePerRecoveryRank * rankOf(ranks, 'balance-recovery'));
}

export interface Swing {
  damage: number;
  balanceCost: number;
  /** How long until the next swing. */
  seconds: number;
}

/**
 * The swing a dreamer makes with what they hold in hand: bare hands for nothing, the weapon's for
 * a weapon, and `undefined` for anything else, which does not swing.
 */
export function swingFor(itemInHand: string | undefined, ranks: readonly HeldRank[]): Swing | undefined {
  const weapon = itemInHand === undefined ? COMBAT.bareHands : itemWeapon(itemInHand);
  if (weapon === undefined) return undefined;
  return {
    damage: weapon.damage + COMBAT.damagePerStrikeRank * rankOf(ranks, 'strike'),
    balanceCost: weapon.balanceCost,
    seconds: COMBAT.swingSeconds * (1 - COMBAT.swingSecondsPerFollowThroughRank * rankOf(ranks, 'follow-through')),
  };
}

/**
 * The swing a dreamer makes now, if they can make one: the task they hold does not forbid
 * striking, what they hold in hand swings, and their balance covers its cost.
 */
export function swingAllowed(task: TaskSpec | undefined, itemInHand: string | undefined, ranks: readonly HeldRank[], balance: number): Swing | undefined {
  if (task !== undefined && forbidsStriking(task)) return undefined;
  const swing = swingFor(itemInHand, ranks);
  return swing !== undefined && balance >= swing.balanceCost ? swing : undefined;
}

/** What slot 1 does at the target. */
export type EngageAction = 'attack' | 'mend';

/** What a target is to slot 1. */
export type EngageTarget = 'nightmare' | 'dreamer';

/** What a kit needs in hand: `mainHand` bare hands or a weapon, `moonstone` the Moonstone. */
export type HandNeed = 'mainHand' | 'moonstone';

/** Whether what is in hand serves a kit, for slot 1 and the abilities alike. */
export function handAllows(need: HandNeed, itemInHand: string | undefined): boolean {
  switch (need) {
    case 'mainHand':
      return itemInHand === undefined || itemWeapon(itemInHand) !== undefined;
    case 'moonstone':
      return itemInHand === ('moonstone' satisfies ItemId);
  }
}

/**
 * What slot 1 does at a target: Attack at a nightmare not yet driven off, with bare hands or a
 * weapon in hand, and Mend at a dreamer, the Healer themselves included, for a Healer with the
 * Moonstone in hand. At anything else it does nothing, and cannot be switched on. The Moonstone does
 * not swing, so one hand never does both.
 */
export function engageAction(target: EngageTarget | undefined, role: Role | undefined, itemInHand: string | undefined): EngageAction | undefined {
  if (target === 'nightmare') return handAllows('mainHand', itemInHand) ? 'attack' : undefined;
  if (target === 'dreamer' && role === 'healer' && handAllows('moonstone', itemInHand)) return 'mend';
  return undefined;
}

/** Whether a Healer at `from` mends a standing dreamer at `to`. Raising a fallen one takes touch, as `reaches` measures it. */
export function mendReaches(from: Point, to: Point): boolean {
  return distance(from, to) <= COMBAT.mend.reach;
}

/** How far apart a dreamer and a body of `radius` stand at most when one reaches the other: contact, and the reach slack beyond. */
export function reachDistance(radius: number): number {
  return SOMNIO_CONSTANTS.playerRadius + radius + COMBAT.reachSlack;
}

/** Whether a dreamer at `from` reaches a body, or is reached by it. */
export function reaches(from: Point, body: Body): boolean {
  return distance(from, body) <= reachDistance(body.radius);
}

/**
 * Whether a swing meets the body: it stands in reach, inside the arc in front of the dreamer. One
 * whose centre lies within the dreamer's own radius is in front wherever they face.
 */
export function swingMeets(from: Point, facing: Heading, body: Body): boolean {
  if (!reaches(from, body)) return false;
  return (
    distance(from, body) < SOMNIO_CONSTANTS.playerRadius ||
    Math.abs(angularDistance(facing, headingFromVector(body.x - from.x, body.z - from.z))) <= COMBAT.swingArcDegrees / 2
  );
}

/** A nightmare's chance to land its strike: higher the emptier the dreamer's balance, lower with Guard. */
export function strikeChance(kind: MonsterKind, balance: number, balanceMax: number, ranks: readonly HeldRank[]): number {
  const unsteady = COMBAT.emptyBalanceHitChance * (1 - balance / balanceMax);
  return clamp(kind.hitChance - COMBAT.hitChancePerGuardRank * rankOf(ranks, 'guard') + unsteady, 0, 1);
}

/**
 * An amount an effect or a rank changed, as the whole number a pool holds: rounded once, half up,
 * before it touches the pool.
 */
export function wholeAmount(amount: number): number {
  return Math.round(amount);
}

/**
 * The harm a hit of `amount` lands: its share by the `damageDealt` of each effect its dealer holds
 * and the `damageTaken` of each its taker holds, whole, and never less than 1.
 */
export function harmTaken(amount: number, dealer: readonly EffectId[], taker: readonly EffectId[]): number {
  return shieldedHarm(amount, dealer, taker, 0).landed;
}

/**
 * A hit of `amount` on a taker behind a shield still holding `shield`: the shield takes what it can
 * of the hit's share before it is made whole, and the rest lands, whole and never less than 1. A hit
 * the shield takes all of lands nothing.
 */
export function shieldedHarm(amount: number, dealer: readonly EffectId[], taker: readonly EffectId[], shield: number): { landed: number; absorbed: number } {
  const share = amount * effectShare(dealer, 'damageDealt') * effectShare(taker, 'damageTaken');
  const absorbed = Math.min(shield, share);
  return { landed: absorbed === share && absorbed > 0 ? 0 : Math.max(1, wholeAmount(share - absorbed)), absorbed };
}

/**
 * The threat a deed of `amount` raises against a nightmare: its share by the `threatGenerated` of
 * each effect the doer holds.
 */
export function threatRaised(amount: number, doer: readonly EffectId[]): number {
  return amount * effectShare(doer, 'threatGenerated');
}

/** The product of the share `key` of each effect held. */
function effectShare(effects: readonly EffectId[], key: 'damageDealt' | 'damageTaken' | 'threatGenerated'): number {
  return effects.reduce((product, effectId) => product * (effect(effectId)[key] ?? 1), 1);
}

/** The teaching that deepens each role's Spirit. */
const SPIRIT_DEEPENING: Record<Role, TeachingId | undefined> = { fighter: undefined, healer: 'spirit-deepening', mystic: 'mystic-spirit-deepening' };

/** Each pool's maximum: Health by Toughening, Spirit by the Spirit deepening of the dreamer's role. */
export function maxPools({ role, ranks }: Pick<Lucidity, 'role' | 'ranks'>): Pick<Energy, 'healthMax' | 'balanceMax' | 'spiritMax'> {
  const deepening = role === undefined ? undefined : SPIRIT_DEEPENING[role];
  return {
    healthMax: COMBAT.basePool + COMBAT.healthPerTougheningRank * rankOf(ranks, 'toughening'),
    balanceMax: COMBAT.basePool,
    spiritMax: COMBAT.basePool + (deepening === undefined ? 0 : COMBAT.spiritPerDeepeningRank * rankOf(ranks, deepening)),
  };
}

/** Every pool at the maximum the role and ranks give. */
export function fullPools(lucidity: Pick<Lucidity, 'role' | 'ranks'>): Energy {
  const maxima = maxPools(lucidity);
  return { healthCurrent: maxima.healthMax, balanceCurrent: maxima.balanceMax, spiritCurrent: maxima.spiritMax, ...maxima };
}

/** The health one touch of the Moonstone restores. */
export function mendAmount(ranks: readonly HeldRank[]): number {
  return COMBAT.mend.health + COMBAT.mend.healthPerDepthRank * rankOf(ranks, 'depth');
}

/**
 * The work, in pace-seconds, that the Healers holding on to a raise add over `seconds`: each adds
 * one a second once their pause, from `pausedSeconds`, is over. Both sides pace a raise by it.
 */
export function raiseWorkOver(pausedSeconds: readonly number[], seconds: number): number {
  return pausedSeconds.reduce((sum, paused) => sum + Math.max(0, seconds - paused), 0);
}

/** The seconds the Healers holding on to a raise take to add `work` more, the inverse of `raiseWorkOver`; never, with none holding on. */
export function raiseSecondsFor(work: number, pausedSeconds: readonly number[]): number {
  const paceFrom = [...pausedSeconds].sort((a, b) => a - b);
  if (paceFrom.length === 0) return Infinity;
  let pace = 1;
  let at = paceFrom[0]!;
  let left = work;
  while (pace < paceFrom.length && left > pace * (paceFrom[pace]! - at)) {
    left -= pace * (paceFrom[pace]! - at);
    at = paceFrom[pace]!;
    pace += 1;
  }
  return at + left / pace;
}
