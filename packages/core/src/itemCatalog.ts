/**
 * Display-name lookup for inventory rows by `(category, itemId)` pair, as a catalog key the
 * consumer resolves in its locale. The table covers the two starter items; an unknown pair
 * resolves to `undefined` so a missing wire entry surfaces rather than rendering a wrong label.
 */
export function itemCatalogKey(category: number, itemId: number): string | undefined {
  if (category === 0 && itemId === 0) return 'Purse';
  if (category === 1 && itemId === 0) return 'Cudgel';
  return undefined;
}
