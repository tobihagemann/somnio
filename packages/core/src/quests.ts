import { ROLES, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { QuestsMessage, Role, SectorView, Service } from '@somnio/protocol';
import questsJSON from '../data/quests.json' with { type: 'json' };
import { bountyDay, bountyIdOf, bountyOf, bountyQuest, isBountyId } from './bounties.ts';
import type { Bounty, BountyId } from './bounties.ts';
import { distance } from './geometry.ts';
import type { Point } from './geometry.ts';
import type { BaseItemId, Tier } from './items.ts';
import { FIRST_TEACHING, TEACHING_IDS, TRIAL_QUESTS, TRIAL_REWARDS, teaching, teachingStanding } from './lucidity.ts';
import type { HeldRank, TeachingId } from './lucidity.ts';
import { isMonsterKindId } from './monsterKinds.ts';
import type { MonsterKindId } from './monsterKinds.ts';
import { sectorPointInSpace } from './sector.ts';

/**
 * What a dreamer is asked to do, by a carrier (an NPC or a fixture, by its carrier id), and turned
 * in at one for what it pays. A master's trial is a quest, whose turn-in makes the role
 * (`TRIAL_QUESTS`). So is the task that gates a teaching, whose turn-in teaches its first rank
 * (`Teaching.gate`). A bounty is a quest held by its stored definition (`bountyQuest`).
 */

/** What a quest asks for, each with the catalog key of the line that says it. */
export type QuestObjective = { labelKey: string } & (
  | { kind: 'driveOff'; count: number; monsterKind?: MonsterKindId; sector?: string }
  /** Counted from the kind's trophy, picked up. */
  | { kind: 'collect'; count: number; monsterKind: MonsterKindId }
  /** Asking the carrier, by its id, to go on, or taking or turning in a quest at it. */
  | { kind: 'visit'; carrier: string }
  /**
   * Standing within `place`, sector-relative like every record's position, or anywhere in the
   * sector without one. Tacita's dialog is how a dreamer finds her trial's places, so a place
   * moves with its hint.
   */
  | { kind: 'reach'; sector: string; place?: { x: number; z: number; radius: number } }
  /** Health mended on other dreamers. */
  | { kind: 'mend'; amount: number }
);

/** What a turn-in pays besides what a trial or a gate grants: coins, practice to the teaching studied, and an item rolled at a tier. */
export interface QuestReward {
  coins?: number;
  practice?: number;
  gear?: Tier;
}

export interface Quest {
  /** The catalog key of its title. */
  labelKey: string;
  /** The carrier that gives it, by its id, or the service every carrier of which gives it, as a bounty board does a bounty. */
  giver: string;
  /** Where it is turned in, as `giver` says where it is given. */
  turnIn: string;
  /** A role to hold, or another quest to have turned in, before it is offered. */
  needs?: { role: Role } | { quest: QuestId };
  objectives: QuestObjective[];
  /** A dreamer holding it cannot swing. */
  withoutStriking?: boolean;
  /** A fall sets its progress back to nothing. */
  withoutFalling?: boolean;
  reward?: QuestReward;
}

export type QuestId = keyof typeof questsJSON;

/** The quests, by id. An id is persisted and travels the wire, so it is kebab-case like a record id. */
export const QUESTS = questsJSON as Record<QuestId, Quest>;

export const QUEST_IDS = Object.keys(QUESTS) as QuestId[];

export function isQuestId(value: string): value is QuestId {
  return Object.hasOwn(QUESTS, value);
}

export function quest(id: QuestId): Quest {
  return QUESTS[id];
}

/** The id of a quest a dreamer can hold: a committed quest's, or a bounty's. */
export type QuestOrBountyId = QuestId | BountyId;

/** A quest a dreamer holds, with what they have done toward each of its objectives, in order, and for a bounty what it is. */
export type ActiveQuest = { questId: QuestId; progress: number[]; definition?: undefined } | { questId: BountyId; progress: number[]; definition: Bounty };

/**
 * The quests a dreamer holds, and those they turned in, which are never offered again. A bounty is
 * offered on its own day alone.
 */
export interface QuestLog {
  active: ActiveQuest[];
  done: QuestOrBountyId[];
}

export const NO_QUESTS: QuestLog = { active: [], done: [] };

/** The progress at which an objective is met. */
export function objectiveGoal(objective: QuestObjective): number {
  switch (objective.kind) {
    case 'driveOff':
    case 'collect':
      return objective.count;
    case 'visit':
    case 'reach':
      return 1;
    case 'mend':
      return objective.amount;
  }
}

/** What a held quest is: the committed quest, or the bounty its stored definition says. */
export function heldQuest(held: ActiveQuest): Quest {
  return held.definition === undefined ? quest(held.questId) : bountyQuest(held.definition);
}

/** Whether every objective of a held quest is met, so it can be turned in. */
export function questComplete(held: ActiveQuest): boolean {
  return heldQuest(held).objectives.every((objective, index) => (held.progress[index] ?? 0) >= objectiveGoal(objective));
}

/** Whether a dreamer holding these quests cannot swing. A bounty never forbids it. */
export function forbidsStriking(active: readonly Pick<ActiveQuest, 'questId'>[]): boolean {
  return active.some(({ questId }) => isQuestId(questId) && quest(questId).withoutStriking === true);
}

/** The role a quest's turn-in makes the dreamer's: set for a master's trial alone. */
export function trialRole(questId: QuestOrBountyId): Role | undefined {
  return ROLES.find((role) => TRIAL_QUESTS[role] === questId);
}

/** The teaching whose first rank a quest's turn-in teaches: set for a gate alone. */
export function gatedTeaching(questId: QuestOrBountyId): TeachingId | undefined {
  return TEACHING_IDS.find((id) => teaching(id).gate === questId);
}

/** What a turn-in grants besides the practice it pays: the role and first teaching a trial gives, the teaching a gate teaches, and items and coins. */
export interface TurnInGrant {
  /** The role a trial makes the dreamer's. */
  role: Role | undefined;
  /** The teaching whose first rank it teaches: a trial's role's first, or a gate's. */
  teaches: TeachingId | undefined;
  /** The plain item a trial gives. */
  trialItem: BaseItemId | undefined;
  /** Whether it pays coins or gives an item, which one `inventory` frame carries to the dreamer. */
  paysInventory: boolean;
}

/** What turning in the held quest grants, which the server pays and the client says. */
export function turnInGrant(held: ActiveQuest): TurnInGrant {
  const reward = heldQuest(held).reward;
  const role = trialRole(held.questId);
  const trialItem = role === undefined ? undefined : TRIAL_REWARDS[role];
  return {
    role,
    teaches: role === undefined ? gatedTeaching(held.questId) : FIRST_TEACHING[role],
    trialItem,
    paysInventory: reward?.coins !== undefined || reward?.gear !== undefined || trialItem !== undefined,
  };
}

/** What of a dreamer's lucidity the quest rules read, which a `lucidity` frame satisfies too. */
interface QuestReader {
  role?: Role | undefined;
  ranks: readonly HeldRank[];
}

/** Whether a dreamer holds as many quests as they may, so they take on no other. */
export function questLogFull(log: QuestLog): boolean {
  return log.active.length >= SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests;
}

/**
 * Whether a dreamer may take the quest on: one they neither hold nor turned in, with room in the
 * log, its needs met, and for a trial no role and no other trial held, or for a gate its teaching
 * waiting on it.
 */
export function mayAccept(questId: QuestId, log: QuestLog, lucidity: QuestReader): boolean {
  if (questLogFull(log) || heldOrDone(questId, log)) return false;
  const needs = quest(questId).needs;
  if (needs !== undefined && ('role' in needs ? lucidity.role !== needs.role : !log.done.includes(needs.quest))) return false;
  if (trialRole(questId) !== undefined) return lucidity.role === undefined && !log.active.some((held) => trialRole(held.questId) !== undefined);
  const taught = gatedTeaching(questId);
  return taught === undefined || teachingStanding(lucidity.ranks, taught) === 'task';
}

/** Whether a dreamer may take the bounty on: one they neither hold nor turned in, with room in the log. */
export function mayTakeBounty(bounty: Bounty, log: QuestLog): boolean {
  return !questLogFull(log) && !heldOrDone(bountyIdOf(bounty), log);
}

function heldOrDone(questId: QuestOrBountyId, log: QuestLog): boolean {
  return log.done.includes(questId) || log.active.some((held) => held.questId === questId);
}

/** The held quest a dreamer may turn in: every objective met, and for a trial no role yet. */
export function turnInFor(questId: QuestOrBountyId, log: QuestLog, lucidity: QuestReader): ActiveQuest | undefined {
  const held = log.active.find((candidate) => candidate.questId === questId);
  if (held === undefined || !questComplete(held)) return undefined;
  return trialRole(questId) !== undefined && lucidity.role !== undefined ? undefined : held;
}

/** The `quests` frame of what the dreamer holds and turned in, and of the world day's bounties. */
export function questsMessage({ active, done }: QuestLog, bounties: readonly Bounty[]): QuestsMessage {
  return {
    active: active.map(({ questId, progress, definition }) => ({
      questId,
      progress: [...progress],
      ...(definition === undefined ? {} : { definition }),
    })),
    done: [...done],
    bounties: [...bounties],
  };
}

/**
 * What a `quests` frame says the dreamer holds and turned in, without any quest this build does
 * not know: a bounty held only with a definition it knows that is the one its id names.
 */
export function questsOf(message: QuestsMessage): QuestLog {
  return {
    active: message.active.flatMap(({ questId, progress, definition }): ActiveQuest[] => {
      if (isQuestId(questId)) return [{ questId, progress }];
      const bounty = definition === undefined ? undefined : bountyOf(definition);
      return bounty !== undefined && bountyIdOf(bounty) === questId ? [{ questId: bountyIdOf(bounty), progress, definition: bounty }] : [];
    }),
    done: message.done.filter((questId): questId is QuestOrBountyId => isQuestId(questId) || isBountyId(questId)),
  };
}

/** The bounties a `quests` frame offers, without any this build does not know. */
export function bountiesOf(message: QuestsMessage): Bounty[] {
  return message.bounties.flatMap((bounty) => bountyOf(bounty) ?? []);
}

/** The log without the bounties turned in on a day other than `day`, which block nothing since a bounty is offered on its own day alone. */
export function withoutPastBounties(log: QuestLog, day: number): QuestLog {
  const done = log.done.filter((questId) => !isBountyId(questId) || bountyDay(questId) === day);
  return done.length === log.done.length ? log : { ...log, done };
}

/** A line a quest is said in: one objective, or a run of objectives said by one line, with how many of the run are met. */
export interface ObjectiveLine {
  labelKey: string;
  objectives: QuestObjective[];
  done: number;
  goal: number;
}

/**
 * The lines a quest is said in, in order, with how far `progress` has come: a count toward the goal
 * of a single objective, or how many of a run are met, never which, as for a trial's hidden places.
 */
export function objectiveLines(said: Quest, progress: readonly number[]): ObjectiveLine[] {
  const lines: { labelKey: string; objectives: QuestObjective[]; indices: number[] }[] = [];
  said.objectives.forEach((objective, index) => {
    const last = lines.at(-1);
    if (last?.labelKey === objective.labelKey) {
      last.objectives.push(objective);
      last.indices.push(index);
    } else {
      lines.push({ labelKey: objective.labelKey, objectives: [objective], indices: [index] });
    }
  });
  return lines.map(({ labelKey, objectives, indices }) => {
    const reached = indices.map((index) => progress[index] ?? 0);
    if (objectives.length === 1) return { labelKey, objectives, done: Math.floor(reached[0]!), goal: objectiveGoal(objectives[0]!) };
    return { labelKey, objectives, done: objectives.filter((objective, index) => reached[index]! >= objectiveGoal(objective)).length, goal: objectives.length };
  });
}

/** What a carrier shows over its head to a dreamer. */
export type QuestMarker = 'offer' | 'turnIn' | 'inProgress';

/** A carrier as the quest rules see it: its id, and the service it carries, by which it gives and takes a bounty. */
export interface QuestCarrier {
  id: string;
  service?: Service | undefined;
}

/** Whether a quest's giver or turn-in, a carrier id or a service, names the carrier. */
export function questCarriedBy(giverOrTurnIn: string, carrier: QuestCarrier): boolean {
  return giverOrTurnIn === carrier.id || giverOrTurnIn === carrier.service;
}

/**
 * The marker a carrier shows a dreamer: `turnIn` while a quest they hold is ready to turn in there,
 * else `offer` while it gives a quest they may take on, of the committed ones or the day's
 * `bounties`, else `inProgress` while a quest they hold that is not finished yet is turned in
 * there, else none.
 */
export function markerFor(carrier: QuestCarrier, log: QuestLog, lucidity: QuestReader, bounties: readonly Bounty[]): QuestMarker | undefined {
  const returnedTo = log.active.filter((held) => questCarriedBy(heldQuest(held).turnIn, carrier));
  if (returnedTo.some((held) => turnInFor(held.questId, log, lucidity) !== undefined)) return 'turnIn';
  const offers =
    QUEST_IDS.some((questId) => questCarriedBy(quest(questId).giver, carrier) && mayAccept(questId, log, lucidity)) ||
    bounties.some((bounty) => questCarriedBy(bountyQuest(bounty).giver, carrier) && mayTakeBounty(bounty, log));
  if (offers) return 'offer';
  return returnedTo.some((held) => !questComplete(held)) ? 'inProgress' : undefined;
}

/** The log with the quest taken on, nothing done toward it. */
export function withAccepted(log: QuestLog, questId: QuestId): QuestLog {
  return { ...log, active: [...log.active, { questId, progress: quest(questId).objectives.map(() => 0) }] };
}

/** The log with the bounty taken on, nothing done toward it, held by its definition. */
export function withAcceptedBounty(log: QuestLog, bounty: Bounty): QuestLog {
  return { ...log, active: [...log.active, { questId: bountyIdOf(bounty), progress: bountyQuest(bounty).objectives.map(() => 0), definition: bounty }] };
}

/** The log without the quest held, as it is given up. */
export function withoutQuest(log: QuestLog, questId: QuestOrBountyId): QuestLog {
  return { ...log, active: log.active.filter((held) => held.questId !== questId) };
}

/** The log with the quest held turned in. */
export function withTurnedIn(log: QuestLog, questId: QuestOrBountyId): QuestLog {
  return { active: withoutQuest(log, questId).active, done: [...log.done, questId] };
}

/**
 * The log with each objective of each held quest moved to what `next` makes of it, no further than
 * its goal and never below nothing. The log itself when nothing moved.
 */
export function advancedQuests(log: QuestLog, next: (objective: QuestObjective, progress: number, held: Quest) => number): QuestLog {
  let moved = false;
  const active = log.active.map((held) => {
    const taken = heldQuest(held);
    const progress = taken.objectives.map((objective, index) => {
      const before = held.progress[index] ?? 0;
      return Math.max(0, Math.min(objectiveGoal(objective), next(objective, before, taken)));
    });
    if (progress.every((value, index) => value === (held.progress[index] ?? 0))) return held;
    moved = true;
    return { ...held, progress };
  });
  return moved ? { ...log, active } : log;
}

/** Whether driving off a nightmare of the kind, standing in the sector, counts toward the objective. */
export function drivesOff(objective: QuestObjective, monsterKind: MonsterKindId, sector: string): boolean {
  return objective.kind === 'driveOff' && (objective.monsterKind ?? monsterKind) === monsterKind && (objective.sector ?? sector) === sector;
}

/** Whether standing at `point`, in the sector's space and within the sector, meets the objective. */
export function reachedAt(objective: QuestObjective, sector: SectorView, point: Point): boolean {
  if (objective.kind !== 'reach' || objective.sector !== sector.name) return false;
  return objective.place === undefined || distance(sectorPointInSpace(sector, objective.place), point) <= objective.place.radius;
}

/** Whether a dreamer still collects the kind's trophy: a held quest has an unmet `collect` objective for it. */
export function collectsTrophy(log: QuestLog, monsterKind: MonsterKindId): boolean {
  return log.active.some((held) =>
    heldQuest(held).objectives.some(
      (objective, index) => objective.kind === 'collect' && objective.monsterKind === monsterKind && (held.progress[index] ?? 0) < objective.count,
    ),
  );
}

/** The catalog key of the trophy each nightmare kind leaves for a dreamer who collects it. It never enters the bag. */
export const TROPHIES: Record<MonsterKindId, string> = {
  ghost: 'Ghostly wisp',
  'skeleton-minion': 'Old bone',
  'skeleton-warrior': 'Cracked skull',
  necromancer: "Necromancer's sigil",
};

/** The catalog key of the kind's trophy; `undefined` for a kind this build does not know. */
export function trophyLabelKey(monsterKind: string): string | undefined {
  return isMonsterKindId(monsterKind) ? TROPHIES[monsterKind] : undefined;
}
