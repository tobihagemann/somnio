import type { CharacterRepository } from '@somnio/data';
import type { Logger } from '../logging.ts';
import type { PlayerCheckpoint } from './spaceActor.ts';

/** Which writer saved a checkpoint, as its failure record names it. */
export const CHECKPOINT_ORIGINS = ['periodic', 'disconnect', 'drop'] as const;
export type CheckpointOrigin = (typeof CHECKPOINT_ORIGINS)[number];

/**
 * Writes a checkpoint through `persistCheckpoint`'s single transaction. Three writers save a
 * player's checkpoint: the periodic pass (`'periodic'`), a disconnect's exit path (`'disconnect'`),
 * and a throw to the ground (`'drop'`, through `DropSaves`). Each snapshot's `lastSeen` is strictly
 * later than the player's last one, and the `last_seen` guard skips any write no newer than the row.
 * So whichever order they commit in, the newest snapshot stands, and no character row lands beside
 * another snapshot's inventory. A failed write is logged and swallowed, so no writer's caller sees it.
 */
export async function persistPlayerCheckpoint(
  snapshot: PlayerCheckpoint,
  characters: CharacterRepository,
  logger: Logger,
  context: { origin: CheckpointOrigin; space: string },
): Promise<void> {
  try {
    await characters.persistCheckpoint(snapshot.character, snapshot.inventory);
  } catch (error) {
    logger.error({ error: String(error), character_id: snapshot.character.id, ...context }, 'failed to persist player snapshot');
  }
}

interface DropSaveRequest {
  snapshot: PlayerCheckpoint;
  space: string;
}

interface DropSaveLane {
  /** The latest snapshot asked for while a write is in flight, which replaces any asked for before it. */
  pending: DropSaveRequest | undefined;
  /** Settles once no write is in flight and none is pending. */
  settled: Promise<void>;
}

/**
 * The saves a throw to the ground asks for, at most one in flight per character, keyed by
 * character id so every space a dreamer passes through shares one lane. A save asked for while one
 * is in flight waits in a single pending slot, which a later request replaces, and is written once
 * the one in flight settles, failed or not. So a loop of throws and pick-ups queues at most two
 * writes per dreamer rather than one per frame.
 */
export class DropSaves {
  private readonly lanes = new Map<string, DropSaveLane>();
  private readonly characters: CharacterRepository;
  private readonly logger: Logger;

  constructor(characters: CharacterRepository, logger: Logger) {
    this.characters = characters;
    this.logger = logger;
  }

  /** Writes the snapshot now, or once the write in flight for the character settles. Never awaited by gameplay. */
  request(snapshot: PlayerCheckpoint, space: string): void {
    const id = snapshot.character.id;
    const lane = this.lanes.get(id);
    if (lane !== undefined) {
      lane.pending = { snapshot, space };
      return;
    }
    const fresh: DropSaveLane = { pending: { snapshot, space }, settled: Promise.resolve() };
    this.lanes.set(id, fresh);
    fresh.settled = this.drain(id, fresh);
  }

  /** Drops the character's pending snapshot and resolves once the write in flight has settled. */
  async settle(characterId: string): Promise<void> {
    const lane = this.lanes.get(characterId);
    if (lane === undefined) return;
    lane.pending = undefined;
    await lane.settled;
  }

  private async drain(id: string, lane: DropSaveLane): Promise<void> {
    while (lane.pending !== undefined) {
      const { snapshot, space } = lane.pending;
      lane.pending = undefined;
      await persistPlayerCheckpoint(snapshot, this.characters, this.logger, { origin: 'drop', space });
    }
    this.lanes.delete(id);
  }
}
