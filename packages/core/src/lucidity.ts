import { ROLES } from '@somnio/protocol';
import type { NPCService, Role } from '@somnio/protocol';

/**
 * What a dreamer grows into: a role taken for good when a master takes their passed trial as
 * done, and the role's teachings, each a stack of ranks built up by practice out in the world.
 */

/** What a master asks for: before taking a dreamer on, or before teaching a gated teaching. */
export type TaskSpec =
  /** Falling sets a `withoutFalling` count back to zero. */
  | { kind: 'driveOff'; count: number; withoutFalling?: boolean }
  /** A dreamer holding a `withoutStriking` task cannot swing. `labelKey` is the catalog key of the sector's display name. */
  | { kind: 'reach'; sector: string; labelKey: string; withoutStriking?: boolean }
  /** Health mended on other dreamers. */
  | { kind: 'mend'; amount: number };

export interface Teaching {
  role: Role;
  /** The catalog key of the teaching's display name. */
  labelKey: string;
  maxRank: number;
  /** The rank of another teaching to hold before this one can be studied or its task asked for. */
  needs?: { teachingId: string; rank: number };
  /** The task whose completion teaches the first rank; practice builds only the ranks after it. */
  gate?: TaskSpec;
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
    gate: { kind: 'driveOff', count: 3, withoutFalling: true },
  },
  'balance-recovery': { role: 'fighter', labelKey: 'Balance recovery', maxRank: 3 },
  toughening: { role: 'fighter', labelKey: 'Toughening', maxRank: 5 },
  touch: { role: 'healer', labelKey: 'Touch', maxRank: 3 },
  depth: { role: 'healer', labelKey: 'Depth', maxRank: 5, needs: { teachingId: 'touch', rank: 1 } },
  'drawing-back': {
    role: 'healer',
    labelKey: 'Drawing back',
    maxRank: 1,
    needs: { teachingId: 'touch', rank: 2 },
    gate: { kind: 'mend', amount: 60 },
  },
  'spirit-deepening': { role: 'healer', labelKey: 'Spirit deepening', maxRank: 5 },
} as const satisfies Record<string, Teaching>;
export type TeachingId = keyof typeof TEACHINGS;

export const TEACHING_IDS = Object.keys(TEACHINGS) as TeachingId[];

export function teaching(id: TeachingId): Teaching {
  return TEACHINGS[id];
}

/** What each master asks of a dreamer before taking them on. Passing it commits nothing. */
export const TRIALS: Record<Role, TaskSpec> = {
  fighter: { kind: 'driveOff', count: 1 },
  healer: { kind: 'reach', sector: 'NorthWood', labelKey: 'North Wood', withoutStriking: true },
};

/** The teaching a dreamer is taught, and set to study, on taking the role. */
export const FIRST_TEACHING: Record<Role, TeachingId> = { fighter: 'strike', healer: 'touch' };

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

export interface LucidityTask {
  /** The role of the master who set it. */
  role: Role;
  /** The gated teaching it earns; `undefined` for the role's trial. */
  teachingId: TeachingId | undefined;
  progress: number;
}

export interface Lucidity {
  role: Role | undefined;
  ranks: TeachingRank[];
  /** The one teaching practice builds toward. */
  study: TeachingId | undefined;
  /** A dreamer holds at most one trial or task. */
  task: LucidityTask | undefined;
}

export const NO_LUCIDITY: Lucidity = { role: undefined, ranks: [], study: undefined, task: undefined };

const ROLE_LABEL_KEYS: Record<Role, string> = { fighter: 'Fighter', healer: 'Healer' };

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
 * need is unmet, `task` while its first rank waits on its gate's task, and `open` to study
 * otherwise. A master sets a dreamer to study an `open` teaching and sets the task of a `task` one.
 */
export type TeachingStanding = 'mastered' | 'later' | 'task' | 'open';

export function teachingStanding(ranks: readonly HeldRank[], teachingId: TeachingId): TeachingStanding {
  const taught = teaching(teachingId);
  const rank = rankOf(ranks, teachingId);
  if (rank >= taught.maxRank) return 'mastered';
  if (unmetNeed(ranks, teachingId) !== undefined) return 'later';
  return taught.gate !== undefined && rank === 0 ? 'task' : 'open';
}

/** Whether a master could have set the task: a trial, or the gate of a teaching of the task's own role. */
export function isSoundTask(task: Pick<LucidityTask, 'role' | 'teachingId'>): boolean {
  if (task.teachingId === undefined) return true;
  const taught = teaching(task.teachingId);
  return taught.gate !== undefined && taught.role === task.role;
}

/**
 * What a held task asks for. The server holds only sound tasks, but a client whose teachings differ
 * from the server's can read one naming a teaching it knows without a gate, which asks for nothing.
 */
export function taskSpec(task: Pick<LucidityTask, 'role' | 'teachingId'>): TaskSpec | undefined {
  return task.teachingId === undefined ? TRIALS[task.role] : teaching(task.teachingId).gate;
}

/** The progress at which a task is done. */
export function taskGoal(spec: TaskSpec): number {
  switch (spec.kind) {
    case 'driveOff':
      return spec.count;
    case 'reach':
      return 1;
    case 'mend':
      return spec.amount;
  }
}

/** Whether a dreamer holding the task cannot swing. */
export function forbidsStriking(spec: TaskSpec): boolean {
  return spec.kind === 'reach' && spec.withoutStriking === true;
}

/** The role a master teaches; `undefined` for a service that is no master's. */
export function masterRole(service: 'fighterMaster' | 'healerMaster'): Role;
export function masterRole(service: NPCService): Role | undefined;
export function masterRole(service: NPCService): Role | undefined {
  switch (service) {
    case 'fighterMaster':
      return 'fighter';
    case 'healerMaster':
      return 'healer';
    case 'shopkeeper':
      return undefined;
  }
}
