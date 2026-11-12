import { BOUNTY_OBJECTIVES, SOMNIO_PROTOCOL_CONSTANTS, bountyId, bountyIdParts, decodeBountyMessage, requireObject } from '@somnio/protocol';
import type { BountyMessage, BountyObjective } from '@somnio/protocol';
import { hashString, seededSequence } from './hash.ts';
import { isTier } from './items.ts';
import type { Tier } from './items.ts';
import { monsterKind } from './monsterKinds.ts';
import type { BossKindId, MonsterKindId } from './monsterKinds.ts';
import type { Quest, QuestObjective } from './quests.ts';
import type { Sector } from './sector.ts';

/**
 * The bounty board's bounties: each world day, one for each land, a sector that keeps nightmares
 * alive, asking a dreamer to drive off nightmares of one of its kinds there or to gather the
 * trophies they leave. They follow from the day and the spawns alone, so every dreamer is offered
 * the same, and the server generates them from its sectors, since a `sector` frame carries no spawns.
 * A bounty taken is held by what it was on its day, so it is finished and paid as it was offered
 * whatever the board, the server, or the spawns do meanwhile.
 */

/**
 * The kinds a bounty names: every kind but a boss, which its one spawn keeps a single one of, long
 * between returns, for every dreamer to share. A boss's chamber is no land.
 */
export type BountyKindId = Exclude<MonsterKindId, BossKindId>;

/**
 * The lines a bounty says what it asks in, by kind and objective: core catalog keys taking the
 * count, whole for each kind, since German declines the kind's name. A drive-off counts only in the
 * bounty's land, which its title names; a trophy counts wherever its kind left it.
 */
export const BOUNTY_KINDS: Record<BountyKindId, Record<BountyObjective, string>> = {
  ghost: { driveOff: 'Drive off %@ Ghosts there.', collect: 'Gather %@ ghostly wisps from Ghosts.' },
  'skeleton-minion': { driveOff: 'Drive off %@ Skeletons there.', collect: 'Gather %@ old bones from Skeletons.' },
  'skeleton-warrior': { driveOff: 'Drive off %@ Skeleton Warriors there.', collect: 'Gather %@ cracked skulls from Skeleton Warriors.' },
};

export function isBountyKindId(value: string): value is BountyKindId {
  return Object.hasOwn(BOUNTY_KINDS, value);
}

/** The title every bounty goes by: a core catalog key taking its land's place name. */
export const BOUNTY_LABEL_KEY = 'Bounty: %@';

/** Where every bounty is taken on and turned in: any carrier of the bounty board's service. */
export const BOUNTY_BOARD = 'bountyBoard';

/** The most nightmares a bounty asks to drive off or trophies it asks to gather. */
const MOST_ASKED = 10;

export interface Bounty {
  day: number;
  land: string;
  monsterKind: BountyKindId;
  objective: BountyObjective;
  count: number;
  reward: { coins: number; gear: Tier };
}

/** A bounty's quest id, which names its day and what it asks, so it never turns into another bounty. */
export type BountyId = `bounty:${string}`;

export function bountyIdOf(bounty: Bounty): BountyId {
  return bountyId(bounty) as BountyId;
}

export function isBountyId(value: string): value is BountyId {
  return bountyIdParts(value) !== undefined;
}

export function bountyDay(id: BountyId): number {
  return bountyIdParts(id)!.day;
}

/** A land bounties are set in: a sector holding monster spawns of a kind a bounty names, with how many of each it keeps alive, in kind order. */
export interface BountyLand {
  name: string;
  kinds: { kind: BountyKindId; alive: number }[];
}

/** The lands of the sectors, in name order. */
export function bountyLands(sectors: readonly Pick<Sector, 'name' | 'monsterSpawns'>[]): BountyLand[] {
  return sectors
    .flatMap((sector) => {
      const alive = new Map<BountyKindId, number>();
      for (const spawn of sector.monsterSpawns) {
        if (isBountyKindId(spawn.kind)) alive.set(spawn.kind, (alive.get(spawn.kind) ?? 0) + spawn.maxAlive);
      }
      const kinds = [...alive].map(([kind, count]) => ({ kind, alive: count })).sort((a, b) => (a.kind < b.kind ? -1 : 1));
      return kinds.length === 0 ? [] : [{ name: sector.name, kinds }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * The bounties of a world day, one for each land, at most as many as a `quests` frame carries.
 * Each rolls one of its land's kinds and an objective from the day and the land. It asks twice as
 * many as the land keeps alive of the kind, at most `MOST_ASKED`, and pays the kind's bounty in
 * coins for each it asks and an item at the highest tier among the land's kinds.
 */
export function dayBounties(day: number, lands: readonly BountyLand[]): Bounty[] {
  return lands.slice(0, SOMNIO_PROTOCOL_CONSTANTS.maxBounties).map((land) => {
    const roll = seededSequence(hashString(`${day}:${land.name}`));
    const { kind, alive } = land.kinds[Math.floor(roll() * land.kinds.length)]!;
    const objective = BOUNTY_OBJECTIVES[Math.floor(roll() * BOUNTY_OBJECTIVES.length)]!;
    const count = Math.min(2 * alive, MOST_ASKED);
    const gear = Math.max(...land.kinds.map((candidate) => monsterKind(candidate.kind).tier)) as Tier;
    return { day, land: land.name, monsterKind: kind, objective, count, reward: { coins: count * monsterKind(kind).bounty, gear } };
  });
}

/**
 * The quest a bounty is: one objective, counted as a quest's are, given and taken by any bounty
 * board, and paying coins and an item.
 */
export function bountyQuest(bounty: Bounty): Quest {
  const { land, monsterKind: kind, objective, count, reward } = bounty;
  const labelKey = BOUNTY_KINDS[kind][objective];
  const asked: QuestObjective =
    objective === 'driveOff' ? { kind: 'driveOff', count, monsterKind: kind, sector: land, labelKey } : { kind: 'collect', count, monsterKind: kind, labelKey };
  return { labelKey: BOUNTY_LABEL_KEY, giver: BOUNTY_BOARD, turnIn: BOUNTY_BOARD, objectives: [asked], reward: { ...reward } };
}

/** The bounty a frame or a stored row says, or `undefined` for one of a kind or a tier this build does not know. */
export function bountyOf(message: BountyMessage): Bounty | undefined {
  const { day, land, monsterKind: kind, objective, count, reward } = message;
  if (!isBountyKindId(kind) || !isTier(reward.gear)) return undefined;
  return { day, land, monsterKind: kind, objective, count, reward: { coins: reward.coins, gear: reward.gear } };
}

/** The bounty a stored definition holds, read as the wire reads one, or `undefined` for anything else. */
export function bountyFromJSON(raw: unknown): Bounty | undefined {
  try {
    return bountyOf(decodeBountyMessage(requireObject(raw, 'definition'), 'definition'));
  } catch {
    return undefined;
  }
}
