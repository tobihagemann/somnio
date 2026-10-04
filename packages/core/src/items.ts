/** The items a character can carry, by id, each with the catalog key of its display name. */
export const ITEMS = {
  /** Its row's `quantity` is the coin count. */
  purse: { labelKey: 'Purse' },
  cudgel: { labelKey: 'Cudgel' },
} as const;
export type ItemId = keyof typeof ITEMS;

/**
 * The catalog key of an item's display name, which the consumer resolves in its locale. An unknown
 * id resolves to `undefined` so a missing entry surfaces rather than rendering a wrong label.
 */
export function itemLabelKey(itemId: string): string | undefined {
  return Object.hasOwn(ITEMS, itemId) ? ITEMS[itemId as ItemId].labelKey : undefined;
}
