import { ROLES } from '@somnio/protocol';
import type { Service, Role } from '@somnio/protocol';
import type { AbilityId } from './abilities.ts';
import type { BaseItemId } from './items.ts';
import type { QuestId } from './quests.ts';

/**
 * What a dreamer grows into: a role taken for good when a master takes their passed trial as
 * done, and the role's teachings, each a stack of ranks built up by practice out in the world.
 */

export interface Teaching {
  role: Role;
  /** The catalog key of the teaching's display name. */
  labelKey: string;
  maxRank: number;
  /** The rank of another teaching to hold before this one can be studied or its quest taken on. */
  needs?: { teachingId: string; rank: number };
  /** The quest whose turn-in teaches the first rank; practice builds only the ranks after it. */
  gate?: QuestId;
  /** The ability its first rank teaches, which its further ranks deepen. */
  ability?: AbilityId;
}

/** The teachings, by id. An id is persisted and travels the wire, so it is kebab-case like a record id. */
export const TEACHINGS = {
  strike: { role: 'fighter', labelKey: 'Strike', maxRank: 5 },
  guard: { role: 'fighter', labelKey: 'Guard', maxRank: 3, needs: { teachingId: 'strike', rank: 1 } },
  'follow-through': {
    role: 'fighter',
    labelKey: 'Follow-through',
    maxRank: 3,
    needs: { teachingId: 'strike', rank: 2 },
    gate: 'follow-through-task',
  },
  'balance-recovery': { role: 'fighter', labelKey: 'Balance recovery', maxRank: 3 },
  toughening: { role: 'fighter', labelKey: 'Toughening', maxRank: 5 },
  cleave: { role: 'fighter', labelKey: 'Cleave', maxRank: 3, needs: { teachingId: 'strike', rank: 1 }, ability: 'cleave' },
  challenge: { role: 'fighter', labelKey: 'Challenge', maxRank: 1, needs: { teachingId: 'guard', rank: 1 }, ability: 'challenge' },
  brace: { role: 'fighter', labelKey: 'Brace', maxRank: 3, needs: { teachingId: 'guard', rank: 1 }, ability: 'brace' },
  lunge: { role: 'fighter', labelKey: 'Lunge', maxRank: 3, needs: { teachingId: 'strike', rank: 2 }, ability: 'lunge' },
  rally: { role: 'fighter', labelKey: 'Rally', maxRank: 3, needs: { teachingId: 'balance-recovery', rank: 1 }, ability: 'rally' },
  touch: { role: 'healer', labelKey: 'Touch', maxRank: 3 },
  depth: { role: 'healer', labelKey: 'Depth', maxRank: 5, needs: { teachingId: 'touch', rank: 1 } },
  'drawing-back': {
    role: 'healer',
    labelKey: 'Drawing back',
    maxRank: 1,
    needs: { teachingId: 'touch', rank: 2 },
    gate: 'drawing-back-task',
  },
  'spirit-deepening': { role: 'healer', labelKey: 'Spirit deepening', maxRank: 5 },
  'deep-mend': { role: 'healer', labelKey: 'Deep mend', maxRank: 3, needs: { teachingId: 'touch', rank: 1 }, ability: 'deep-mend' },
  renewal: { role: 'healer', labelKey: 'Renewal', maxRank: 3, needs: { teachingId: 'touch', rank: 2 }, ability: 'renewal' },
  radiance: { role: 'healer', labelKey: 'Radiance', maxRank: 3, needs: { teachingId: 'depth', rank: 1 }, ability: 'radiance' },
  calm: { role: 'healer', labelKey: 'Calm', maxRank: 1, needs: { teachingId: 'touch', rank: 1 }, ability: 'calm' },
  ward: { role: 'mystic', labelKey: 'Ward', maxRank: 3, ability: 'ward' },
  weaken: { role: 'mystic', labelKey: 'Weaken', maxRank: 3, needs: { teachingId: 'ward', rank: 1 }, ability: 'weaken' },
  bind: { role: 'mystic', labelKey: 'Bind', maxRank: 3, needs: { teachingId: 'weaken', rank: 1 }, ability: 'bind' },
  'dream-bolt': { role: 'mystic', labelKey: 'Dream-bolt', maxRank: 3, needs: { teachingId: 'ward', rank: 1 }, ability: 'dream-bolt' },
  veil: { role: 'mystic', labelKey: 'Veil', maxRank: 1, needs: { teachingId: 'bind', rank: 1 }, ability: 'veil' },
  'sense-the-fallen': { role: 'mystic', labelKey: 'Sense the fallen', maxRank: 1, needs: { teachingId: 'ward', rank: 1 } },
  'mystic-spirit-deepening': { role: 'mystic', labelKey: 'Spirit deepening', maxRank: 5 },
} as const satisfies Record<string, Teaching>;
export type TeachingId = keyof typeof TEACHINGS;

export const TEACHING_IDS = Object.keys(TEACHINGS) as TeachingId[];

export function teaching(id: TeachingId): Teaching {
  return TEACHINGS[id];
}

/** The quest each master gives a dreamer with no role. Only its turn-in makes the role theirs. */
export const TRIAL_QUESTS: Record<Role, QuestId> = { fighter: 'fighter-trial', healer: 'healer-trial', mystic: 'mystic-trial' };

/** The teaching a dreamer is taught, and set to study, on taking the role. */
export const FIRST_TEACHING: Record<Role, TeachingId> = { fighter: 'strike', healer: 'touch', mystic: 'ward' };

/** What a trial gives besides its role, plain: the Healer their Moonstone, and the Mystic a focus. */
export const TRIAL_REWARDS: Partial<Record<Role, BaseItemId>> = { healer: 'moonstone', mystic: 'wand' };

/** What doing a thing adds toward the next rank of the teaching studied. */
export const PRACTICE = {
  /** For a nightmare fading within the share radius, in full to each dreamer there. */
  nightmare: 10,
  perHealthMended: 0.25,
  /** The share of `perHealthMended` a Healer earns mending themselves. */
  selfMendShare: 0.5,
  /** For a raise done, shared among every Healer who held on in proportion to the seconds each held. The share of one who has left the space is forfeited. */
  raise: 10,
} as const;

export interface TeachingRank {
  teachingId: TeachingId;
  rank: number;
  /** What the dreamer has done toward the next rank. */
  practice: number;
}

/** A rank as far as a rule reads it, which a rank off the wire satisfies too. */
export type HeldRank = Pick<TeachingRank, 'rank'> & { teachingId: string };

export interface Lucidity {
  role: Role | undefined;
  ranks: TeachingRank[];
  /** The one teaching practice builds toward. */
  study: TeachingId | undefined;
}

export const NO_LUCIDITY: Lucidity = { role: undefined, ranks: [], study: undefined };

const ROLE_LABEL_KEYS: Record<Role, string> = { fighter: 'Fighter', healer: 'Healer', mystic: 'Mystic' };

/** The catalog key of a role's display name. */
export function roleLabelKey(role: Role): string {
  return ROLE_LABEL_KEYS[role];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isTeachingId(value: string): value is TeachingId {
  return Object.hasOwn(TEACHINGS, value);
}

export function rankOf(ranks: readonly HeldRank[], teachingId: string): number {
  return ranks.find((held) => held.teachingId === teachingId)?.rank ?? 0;
}

/** The ranks with one teaching's entry replaced, or added when the dreamer held none. */
export function withRank(ranks: readonly TeachingRank[], held: TeachingRank): TeachingRank[] {
  return ranks.some((other) => other.teachingId === held.teachingId)
    ? ranks.map((other) => (other.teachingId === held.teachingId ? held : other))
    : [...ranks, held];
}

/** The practice the next rank takes, for a dreamer holding `rank` ranks of the teaching. */
export function practiceNeeded(rank: number): number {
  return 20 + 15 * rank;
}

/** The need of the teaching the dreamer does not meet yet, if any. */
export function unmetNeed(ranks: readonly HeldRank[], teachingId: TeachingId): Teaching['needs'] {
  const needs = teaching(teachingId).needs;
  return needs !== undefined && rankOf(ranks, needs.teachingId) < needs.rank ? needs : undefined;
}

/**
 * Where a teaching stands for a dreamer of its role: `mastered` at its last rank, `later` while a
 * need is unmet, `task` while its first rank waits on its gate's quest, and `open` to study
 * otherwise. A master sets a dreamer to study an `open` teaching and offers the quest of a `task` one.
 */
export type TeachingStanding = 'mastered' | 'later' | 'task' | 'open';

export function teachingStanding(ranks: readonly HeldRank[], teachingId: TeachingId): TeachingStanding {
  const taught = teaching(teachingId);
  const rank = rankOf(ranks, teachingId);
  if (rank >= taught.maxRank) return 'mastered';
  if (unmetNeed(ranks, teachingId) !== undefined) return 'later';
  return taught.gate !== undefined && rank === 0 ? 'task' : 'open';
}

/** The role a master teaches; `undefined` for a service that is no master's. */
export function masterRole(service: 'fighterMaster' | 'healerMaster' | 'mysticMaster'): Role;
export function masterRole(service: Service): Role | undefined;
export function masterRole(service: Service): Role | undefined {
  switch (service) {
    case 'fighterMaster':
      return 'fighter';
    case 'healerMaster':
      return 'healer';
    case 'mysticMaster':
      return 'mystic';
    case 'shopkeeper':
    case 'bountyBoard':
      return undefined;
  }
}
