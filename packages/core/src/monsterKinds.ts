export interface MonsterKind {
  /** The display name an entity of this kind carries. */
  name: string;
  characterModelId: string;
  radius: number;
  metresPerSecond: number;
  /** How close a player has to come for the monster to give chase. */
  aggroRadius: number;
  /** How long a spawn waits before it fills a free slot. */
  respawnSeconds: number;
}

/** The kinds a monster spawn can name, by id. */
export const MONSTER_KINDS = {
  gespenst: { name: 'Gespenst', characterModelId: 'gespenst', radius: 0.3, metresPerSecond: 2.4, aggroRadius: 3.84, respawnSeconds: 60 },
} as const satisfies Record<string, MonsterKind>;
export type MonsterKindId = keyof typeof MONSTER_KINDS;

export const MONSTER_KIND_IDS = Object.keys(MONSTER_KINDS) as MonsterKindId[];

export function monsterKind(id: MonsterKindId): MonsterKind {
  return MONSTER_KINDS[id];
}
