export interface MonsterKind {
  /** The name an entity of this kind carries: a core catalog key, which the client translates. */
  name: string;
  characterModelId: string;
  radius: number;
  metresPerSecond: number;
  /** How close a player has to come for the monster to give chase. */
  aggroRadius: number;
  /** How long a spawn waits before it fills a free slot. */
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

/** The kinds a monster spawn can name, by id. */
export const MONSTER_KINDS = {
  ghost: {
    name: 'Ghost',
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
} as const satisfies Record<string, MonsterKind>;
export type MonsterKindId = keyof typeof MONSTER_KINDS;

export const MONSTER_KIND_IDS = Object.keys(MONSTER_KINDS) as MonsterKindId[];

export function monsterKind(id: MonsterKindId): MonsterKind {
  return MONSTER_KINDS[id];
}
