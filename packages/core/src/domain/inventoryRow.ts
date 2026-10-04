import type { Hand } from '@somnio/protocol';

export interface InventoryRow {
  slot: number;
  itemId: string;
  quantity: number;
  equippedHand: Hand | undefined;
}
