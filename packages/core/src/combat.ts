import type { Condition, Energy, Gait } from '@somnio/protocol';
import type { Body } from './collision.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { clamp, distance } from './geometry.ts';
import type { Point } from './geometry.ts';
import { angularDistance, headingFromVector } from './heading.ts';
import type { Heading } from './heading.ts';
import { itemWeapon } from './items.ts';
import { forbidsStriking, rankOf } from './lucidity.ts';
import type { HeldRank, TaskSpec } from './lucidity.ts';
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

  mend: { health: 10, healthPerDepthRank: 5, spiritCost: 8, seconds: 1 },
  raise: { seconds: 6, spiritCost: 40, healthFraction: 0.25, graceSeconds: 5 },
  /** The share of each pool a dreamer who gave up wakes with. */
  weakenedFraction: 0.25,

  /** How far beyond contact a swing, a strike, or a Mondstein still reaches. */
  reachSlack: 0.25,
  /** How far from a fading nightmare a dreamer still shares its bounty and earns practice. */
  shareRadius: 6,
  /** How long a nightmare driven off lingers before it is gone. */
  fadeSeconds: 1,
} as const;

/** The band a health total stands in. Anything above zero is still standing. */
export function conditionOf(current: number, max: number): Condition {
  if (current <= 0) return 'fallen';
  const part = current / max;
  if (part > 0.75) return 'hale';
  if (part > 0.5) return 'wounded';
  if (part > 0.25) return 'hurt';
  return 'failing';
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
 * striking, what they hold in hand swings, and their balance covers its cost. The server makes a
 * swing on this and the client asks for one on it, each at the swing rhythm on its own clock.
 */
export function swingAllowed(task: TaskSpec | undefined, itemInHand: string | undefined, ranks: readonly HeldRank[], balance: number): Swing | undefined {
  if (task !== undefined && forbidsStriking(task)) return undefined;
  const swing = swingFor(itemInHand, ranks);
  return swing !== undefined && balance >= swing.balanceCost ? swing : undefined;
}

/** Whether a dreamer at `from` reaches a body, or is reached by it: as far as contact, and the reach slack beyond. */
export function reaches(from: Point, body: Body): boolean {
  return distance(from, body) <= SOMNIO_CONSTANTS.playerRadius + body.radius + COMBAT.reachSlack;
}

/**
 * The body a swing meets: the nearest one it reaches inside the arc in front of the dreamer. One
 * whose centre lies within the dreamer's own radius is in front wherever they face.
 */
export function swingTarget<T extends Body>(from: Point, facing: Heading, bodies: Iterable<T>): T | undefined {
  let met: T | undefined;
  let away = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    const candidate = distance(from, body);
    if (candidate >= away || !reaches(from, body)) continue;
    const inFront =
      candidate < SOMNIO_CONSTANTS.playerRadius ||
      Math.abs(angularDistance(facing, headingFromVector(body.x - from.x, body.z - from.z))) <= COMBAT.swingArcDegrees / 2;
    if (!inFront) continue;
    met = body;
    away = candidate;
  }
  return met;
}

/** A nightmare's chance to land its strike: higher the emptier the dreamer's balance, lower with Guard. */
export function strikeChance(kind: MonsterKind, balance: number, balanceMax: number, ranks: readonly HeldRank[]): number {
  const unsteady = COMBAT.emptyBalanceHitChance * (1 - balance / balanceMax);
  return clamp(kind.hitChance - COMBAT.hitChancePerGuardRank * rankOf(ranks, 'guard') + unsteady, 0, 1);
}

export function maxPools(ranks: readonly HeldRank[]): Pick<Energy, 'healthMax' | 'balanceMax' | 'spiritMax'> {
  return {
    healthMax: COMBAT.basePool + COMBAT.healthPerTougheningRank * rankOf(ranks, 'toughening'),
    balanceMax: COMBAT.basePool,
    spiritMax: COMBAT.basePool + COMBAT.spiritPerDeepeningRank * rankOf(ranks, 'spirit-deepening'),
  };
}

/** Every pool at the maximum the ranks give. */
export function fullPools(ranks: readonly HeldRank[]): Energy {
  const maxima = maxPools(ranks);
  return { healthCurrent: maxima.healthMax, balanceCurrent: maxima.balanceMax, spiritCurrent: maxima.spiritMax, ...maxima };
}

/** The health one touch of the Mondstein restores. */
export function mendAmount(ranks: readonly HeldRank[]): number {
  return COMBAT.mend.health + COMBAT.mend.healthPerDepthRank * rankOf(ranks, 'depth');
}
