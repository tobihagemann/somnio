import type { NightmareRank, TelegraphKind } from '@somnio/protocol';
import type { EffectId } from './effects.ts';
import type { Tier } from './items.ts';

export interface MonsterKind {
  /** The name an entity of this kind carries: a core catalog key, which the client translates. */
  name: string;
  /** The bestiary's ring it belongs to, which is the tier of what it drops. */
  tier: Tier;
  characterModelId: string;
  radius: number;
  metresPerSecond: number;
  /** How close a player has to come for the monster to give chase. */
  aggroRadius: number;
  /** How long a spawn waits before it fills a free slot, though at most a minute for its first fill after its space starts. */
  respawnSeconds: number;
  health: number;
  /** The health it recovers each second while at rest. */
  restHealthPerSecond: number;
  /** The gap between two of its strikes. */
  strikeSeconds: number;
  /** Its chance to land a strike on a dreamer at full balance with no Guard. */
  hitChance: number;
  damage: number;
  /** The balance a landed strike takes besides the health. */
  balanceDamage: number;
  /** Coins split among the standing dreamers near it when it fades. */
  bounty: number;
}

/**
 * The kinds a monster spawn can name, by id. The Ghost haunts the first ring. The skeletons of the
 * third ring hit harder than a Ghost, to meet the third ring's gear: a Skeleton is quick and frail,
 * a Skeleton Warrior slow and hard to drive off, and the Necromancer, a boss, outlasts any of them
 * by far and comes back only long after it is driven off.
 */
export const MONSTER_KINDS = {
  ghost: {
    name: 'Ghost',
    tier: 1,
    characterModelId: 'ghost',
    radius: 0.3,
    metresPerSecond: 2.4,
    aggroRadius: 3.84,
    respawnSeconds: 60,
    health: 60,
    restHealthPerSecond: 1,
    strikeSeconds: 1.5,
    hitChance: 0.6,
    damage: 9,
    balanceDamage: 5,
    bounty: 12,
  },
  'skeleton-minion': {
    name: 'Skeleton',
    tier: 3,
    characterModelId: 'skeleton-minion',
    radius: 0.3,
    metresPerSecond: 2.6,
    aggroRadius: 4.5,
    respawnSeconds: 45,
    health: 70,
    restHealthPerSecond: 1,
    strikeSeconds: 1.2,
    hitChance: 0.6,
    damage: 12,
    balanceDamage: 5,
    bounty: 14,
  },
  'skeleton-warrior': {
    name: 'Skeleton Warrior',
    tier: 3,
    characterModelId: 'skeleton-warrior',
    radius: 0.3,
    metresPerSecond: 2.2,
    aggroRadius: 4.5,
    respawnSeconds: 75,
    health: 160,
    restHealthPerSecond: 2,
    strikeSeconds: 1.8,
    hitChance: 0.65,
    damage: 20,
    balanceDamage: 10,
    bounty: 30,
  },
  necromancer: {
    name: 'Necromancer',
    tier: 3,
    characterModelId: 'necromancer',
    radius: 0.3,
    metresPerSecond: 2,
    aggroRadius: 6,
    respawnSeconds: 600,
    health: 900,
    restHealthPerSecond: 10,
    strikeSeconds: 2,
    hitChance: 0.7,
    damage: 24,
    balanceDamage: 12,
    bounty: 200,
  },
} as const satisfies Record<string, MonsterKind>;
export type MonsterKindId = keyof typeof MONSTER_KINDS;

export const MONSTER_KIND_IDS = Object.keys(MONSTER_KINDS) as MonsterKindId[];

export function monsterKind(id: MonsterKindId): MonsterKind {
  return MONSTER_KINDS[id];
}

/**
 * A move a nightmare telegraphs as a circle round where it stands. Once `seconds` have run it strikes
 * every dreamer inside, centre within `radius`, whom nightmares do not leave alone.
 */
export interface Telegraph {
  radius: number;
  seconds: number;
  damage: number;
  balanceDamage: number;
}

/** Each telegraphed move by its kind, which both sides read: the client fills its circle over `seconds`. */
export const TELEGRAPHS = {
  wail: { radius: 4, seconds: 2.5, damage: 45, balanceDamage: 15 },
} as const satisfies Record<TelegraphKind, Telegraph>;

/**
 * What a boss does besides striking, once it has a dreamer to chase. It wails (`TELEGRAPHS.wail`)
 * when one stands within the wail's circle, `firstWailSeconds` into a fight and then
 * `wailEverySeconds` after its last wail struck, holding still until the wail strikes. Every
 * `callEverySeconds`, from the start of a fight, it calls up to `perCall` minions of the kind
 * `minions.kind` round it, within `withinMetres`, while fewer than `maxAlive` stand. Its fight ends
 * once it has had no one to chase for `giveUpSeconds`.
 */
export interface BossMoves {
  giveUpSeconds: number;
  firstWailSeconds: number;
  wailEverySeconds: number;
  minions: { kind: MonsterKindId; maxAlive: number; perCall: number; callEverySeconds: number; withinMetres: number };
}

/** The bosses' moves, by their kind. A nightmare of one of these kinds spawns as a boss and never as an elite. */
export const BOSS_MOVES = {
  necromancer: {
    giveUpSeconds: 5,
    firstWailSeconds: 4,
    wailEverySeconds: 10,
    minions: { kind: 'skeleton-minion', maxAlive: 4, perCall: 2, callEverySeconds: 15, withinMetres: 3 },
  },
} as const satisfies Partial<Record<MonsterKindId, BossMoves>>;
export type BossKindId = keyof typeof BOSS_MOVES;

/** The moves of a boss of the kind, or `undefined` for a kind that is no boss. */
export function bossMoves(id: MonsterKindId): BossMoves | undefined {
  const moves: Partial<Record<MonsterKindId, BossMoves>> = BOSS_MOVES;
  return moves[id];
}

/**
 * What sets an elite apart from its kind: an effect it holds as long as it stands, which every
 * harm meets on its way in. A trait whose effect can end, a shield spent, puts it on again whole
 * `renewSeconds` after the step that finds it gone.
 */
export interface EliteTrait {
  effectId: EffectId;
  renewSeconds?: number;
  /**
   * An elite's name for each kind it may be: a core catalog key, whole rather than a prefix, since
   * a German adjective takes the noun's gender.
   */
  names: Record<Exclude<MonsterKindId, BossKindId>, string>;
}

/** The traits an elite rolls one of as it spawns, by id. An id travels the wire, so it is kebab-case like an effect id. */
export const ELITE_TRAITS = {
  stony: { effectId: 'stony', names: { ghost: 'Stony Ghost', 'skeleton-minion': 'Stony Skeleton', 'skeleton-warrior': 'Stony Skeleton Warrior' } },
  shielded: {
    effectId: 'shielded',
    renewSeconds: 8,
    names: { ghost: 'Shielded Ghost', 'skeleton-minion': 'Shielded Skeleton', 'skeleton-warrior': 'Shielded Skeleton Warrior' },
  },
} as const satisfies Record<string, EliteTrait>;
export type EliteTraitId = keyof typeof ELITE_TRAITS;

export const ELITE_TRAIT_IDS = Object.keys(ELITE_TRAITS) as EliteTraitId[];

export function isEliteTraitId(value: string): value is EliteTraitId {
  return Object.hasOwn(ELITE_TRAITS, value);
}

export function eliteTrait(id: EliteTraitId): EliteTrait {
  return ELITE_TRAITS[id];
}

/** How many times its kind's health an elite has. */
export const ELITE_HEALTH_SHARE = 2.5;

/** The health a nightmare of the kind spawns with, and rests back up to: more for an elite, and a boss's own kind's health. */
export function nightmareHealth(kind: MonsterKind, rank: NightmareRank | undefined): number {
  return rank === 'elite' ? Math.round(kind.health * ELITE_HEALTH_SHARE) : kind.health;
}

/**
 * The catalog key a nightmare is named by, from its kind's name and the trait it carries: an elite
 * by its trait's name for its kind, and any other by its kind's name.
 */
export function nightmareLabelKey(kindName: string, trait: EliteTraitId | undefined): string {
  const kindId = MONSTER_KIND_IDS.find((id) => MONSTER_KINDS[id].name === kindName);
  if (kindId === undefined || trait === undefined) return kindName;
  const names: Partial<Record<MonsterKindId, string>> = eliteTrait(trait).names;
  return names[kindId] ?? kindName;
}
