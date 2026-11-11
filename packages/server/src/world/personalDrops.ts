import { MAX_PERSONAL_DROPS } from '@somnio/core';
import type { SpaceActor } from './spaceActor.ts';

/** A drop from a nightmare as the world counts it: the space it lies in and its id there. */
interface LaidDrop {
  space: SpaceActor;
  lootId: string;
}

/**
 * The drops from nightmares lying for each dreamer across every space of the world, oldest first.
 * One ledger serves every space, since a dreamer's drops wait in each space they left: past
 * `MAX_PERSONAL_DROPS` a new drop takes the oldest away wherever it lies, and a dreamer leaving the
 * world takes every one of theirs with them.
 */
export class PersonalDrops {
  private readonly byOwner = new Map<string, LaidDrop[]>();

  /** Counts a drop just laid for the owner in the space, and takes their oldest away past the cap. */
  laid(ownerId: string, space: SpaceActor, lootId: string): void {
    const drops = this.byOwner.get(ownerId) ?? [];
    drops.push({ space, lootId });
    this.byOwner.set(ownerId, drops);
    while (drops.length > MAX_PERSONAL_DROPS) {
      const oldest = drops.shift()!;
      oldest.space.letGoDrop(oldest.lootId);
    }
  }

  /** Stops counting a drop its owner picked up. */
  pickedUp(ownerId: string, space: SpaceActor, lootId: string): void {
    const drops = this.byOwner.get(ownerId)?.filter((drop) => drop.space !== space || drop.lootId !== lootId) ?? [];
    if (drops.length === 0) this.byOwner.delete(ownerId);
    else this.byOwner.set(ownerId, drops);
  }

  /** Takes away every drop lying for a dreamer who has left the world. */
  forget(ownerId: string): void {
    for (const { space, lootId } of this.byOwner.get(ownerId) ?? []) space.letGoDrop(lootId);
    this.byOwner.delete(ownerId);
  }
}
