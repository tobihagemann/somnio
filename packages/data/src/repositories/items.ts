import type { Kysely } from 'kysely';
import { isAffixId, isBagPlace, isBaseItemId, isEquipSlot, isRarity, isTier, slotsFor } from '@somnio/core';
import type { BaggedItem, EquipSlot, Inventory, ItemInstance, RolledAffix } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError } from './errors.ts';

/** A character's items are written only with the character: at creation and through `persistCheckpoint`. */
export interface ItemRepository {
  /** The character's coins and items, the bag in place order. */
  load(characterId: string): Promise<Inventory>;
}

export class PostgresItemRepository implements ItemRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async load(characterId: string): Promise<Inventory> {
    const { coins } = await this.db.selectFrom('characters').select('coins').where('id', '=', characterId).executeTakeFirstOrThrow();
    const rows = await this.db
      .selectFrom('items')
      .select(['id', 'base_id', 'tier', 'rarity', 'affixes', 'equipped_slot', 'bag_place'])
      .where('character_id', '=', characterId)
      .orderBy('id')
      .execute();
    const equipped: Inventory['equipped'] = {};
    const bag: BaggedItem[] = [];
    for (const row of rows) {
      const item = decodeItem(row);
      if (row.equipped_slot === null) bag.push({ place: decodeBagPlace(row.bag_place, bag), item });
      else equipped[decodeEquippedSlot(row.equipped_slot, item)] = item;
    }
    return { coins, equipped, bag: bag.sort((a, b) => a.place - b.place) };
  }
}

type ItemRecord = {
  id: string;
  base_id: string;
  tier: number;
  rarity: string;
  affixes: unknown;
};

function decodeItem(row: ItemRecord): ItemInstance {
  if (!isBaseItemId(row.base_id)) throw new RepositoryDecodingError('base_id', row.base_id);
  if (!isTier(row.tier)) throw new RepositoryDecodingError('tier', String(row.tier));
  if (!isRarity(row.rarity)) throw new RepositoryDecodingError('rarity', row.rarity);
  return { id: row.id, baseId: row.base_id, tier: row.tier, rarity: row.rarity, affixes: decodeAffixes(row.affixes) };
}

function decodeAffixes(raw: unknown): RolledAffix[] {
  if (!Array.isArray(raw)) throw new RepositoryDecodingError('affixes', JSON.stringify(raw));
  return raw.map((entry: unknown) => {
    const { affixId, value } = (typeof entry === 'object' && entry !== null ? entry : {}) as { affixId?: unknown; value?: unknown };
    if (typeof affixId !== 'string' || !isAffixId(affixId) || !Number.isInteger(value)) throw new RepositoryDecodingError('affixes', JSON.stringify(raw));
    return { affixId, value: value as number };
  });
}

/** An item is worn only in a slot its base fits. */
function decodeEquippedSlot(raw: string, item: ItemInstance): EquipSlot {
  if (!isEquipSlot(raw) || !slotsFor(item.baseId).includes(raw)) throw new RepositoryDecodingError('equipped_slot', raw);
  return raw;
}

/** A bagged item lies at a place in the bag, one item to a place. */
function decodeBagPlace(raw: number | null, bag: readonly BaggedItem[]): number {
  if (raw === null || !isBagPlace(raw) || bag.some(({ place }) => place === raw)) throw new RepositoryDecodingError('bag_place', String(raw));
  return raw;
}

/** Writes each item of the inventory as a row of the character's: the worn in their slots, the bag's at their places. Its coins are the character row's. */
export async function insertItems(db: Kysely<Database>, characterId: string, inventory: Inventory): Promise<void> {
  const worn = (Object.entries(inventory.equipped) as [EquipSlot, ItemInstance][]).map(([slot, item]) => ({ item, equipped_slot: slot, bag_place: null }));
  const bagged = inventory.bag.map(({ place, item }) => ({ item, equipped_slot: null, bag_place: place }));
  const rows = [...worn, ...bagged].map(({ item: { id, baseId, tier, rarity, affixes }, equipped_slot, bag_place }) => ({
    id,
    character_id: characterId,
    base_id: baseId,
    tier,
    rarity,
    affixes: JSON.stringify(affixes),
    equipped_slot,
    bag_place,
  }));
  if (rows.length > 0) await db.insertInto('items').values(rows).execute();
}
