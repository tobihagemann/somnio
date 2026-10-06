import type { SomnioMessage } from '@somnio/protocol';
import type { NPCDialogState } from '@somnio/core';
import type { CharacterRepository, NPCDialogStateRepository } from '@somnio/data';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import { encodeOrWarn } from '../connection/encodeFrame.ts';
import type { Logger } from '../logging.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { persistPlayerCheckpoint } from './checkpointWriter.ts';
import { SpaceActor } from './spaceActor.ts';
import type { TickDigest } from './spaceActor.ts';

/** The surface of the router the admin dispatcher consumes, so its tests can substitute a stub. */
export interface AdminWorldRouter {
  loggedInPlayerCount(): number;
  kickByCharacterName(name: string): boolean;
  broadcastToAllConnections(message: SomnioMessage): void;
}

interface LoggedInEntry {
  actor: ConnectionActor;
  /** Absent between the account's registration and its character being loaded. */
  normalizedName: string | undefined;
}

/** Mirrors the `LOWER(NORMALIZE(name, NFKC))` collation of every `name_normalized` column. */
function normalize(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/**
 * Cross-space router: one `SpaceActor` per space of the world plus the logged-in connections
 * keyed by account (one character per account).
 */
export class WorldRouter implements AdminWorldRouter {
  readonly world: LoadedWorld;
  private readonly spaceActors: Map<string, SpaceActor>;
  private readonly loggedIn = new Map<string, LoggedInEntry>();
  private readonly characters: CharacterRepository;
  private readonly npcDialogStates: NPCDialogStateRepository;
  private readonly logger: Logger;

  private constructor(
    world: LoadedWorld,
    spaceActors: Map<string, SpaceActor>,
    characters: CharacterRepository,
    npcDialogStates: NPCDialogStateRepository,
    logger: Logger,
  ) {
    this.world = world;
    this.spaceActors = spaceActors;
    this.characters = characters;
    this.npcDialogStates = npcDialogStates;
    this.logger = logger;
  }

  /** Seeds each space's dialog cursors from the repository, sector by sector, before any connection arrives. */
  static async create(
    world: LoadedWorld,
    characters: CharacterRepository,
    npcDialogStates: NPCDialogStateRepository,
    logger: Logger,
    spaceLogger: Logger = logger,
  ): Promise<WorldRouter> {
    const actors = new Map<string, SpaceActor>();
    for (const [id, space] of world.spaces) {
      const initialDialogStates: NPCDialogState[] = [];
      for (const sector of space.sectors) initialDialogStates.push(...(await npcDialogStates.loadAll(sector.name)));
      actors.set(id, new SpaceActor(world, id, { logger: spaceLogger, initialDialogStates }));
    }
    return new WorldRouter(world, actors, characters, npcDialogStates, logger);
  }

  space(id: string): SpaceActor | undefined {
    return this.spaceActors.get(id);
  }

  /**
   * Reserves the account for the connection, before anything of it is read: a join that read
   * first could load rows a departing connection's checkpoint is about to replace. `false` when
   * the account is already registered; the caller answers `alreadyLoggedIn`.
   */
  register(actor: ConnectionActor, accountId: string): boolean {
    if (this.loggedIn.has(accountId)) return false;
    this.loggedIn.set(accountId, { actor, normalizedName: undefined });
    return true;
  }

  /** Supplies the name `kickByCharacterName` matches, once the character is loaded. Until then the entry matches no kick. */
  nameRegistered(accountId: string, characterName: string): void {
    const entry = this.loggedIn.get(accountId);
    if (entry !== undefined) entry.normalizedName = normalize(characterName);
  }

  unregister(accountId: string): void {
    this.loggedIn.delete(accountId);
  }

  /** Logged-in *and attached* connections, so the post-register / pre-attach window is excluded. */
  loggedInPlayerCount(): number {
    let count = 0;
    for (const entry of this.loggedIn.values()) {
      if (entry.actor.state.kind === 'attached') count += 1;
    }
    return count;
  }

  /** Disconnects every logged-in connection whose cached name matches; the connection's own exit path unregisters it. */
  kickByCharacterName(name: string): boolean {
    const needle = normalize(name);
    let kicked = false;
    for (const entry of [...this.loggedIn.values()]) {
      if (entry.normalizedName !== needle) continue;
      entry.actor.disconnectForAdminKick();
      kicked = true;
    }
    return kicked;
  }

  /** Every logged-in player's full checkpoint, per space, through the guarded transaction. */
  async checkpointAll(): Promise<void> {
    for (const [spaceId, space] of this.spaceActors) {
      for (const snapshot of space.snapshotForCheckpoint()) {
        await persistPlayerCheckpoint(snapshot, this.characters, this.logger, { space: spaceId });
      }
    }
  }

  /** One simulation step across every space, returning what it leaves to persist. */
  runTickAcrossSpaces(elapsedSeconds: number): TickDigest {
    const digest: TickDigest = { dialogUpserts: [], dialogResets: [] };
    for (const space of this.spaceActors.values()) {
      const stepped = space.step(elapsedSeconds);
      digest.dialogUpserts.push(...stepped.dialogUpserts);
      digest.dialogResets.push(...stepped.dialogResets);
    }
    return digest;
  }

  /** A persistence failure logs and continues (the next emit rewrites the row). */
  async persistDialogDigest(digest: TickDigest): Promise<void> {
    for (const state of digest.dialogUpserts) {
      try {
        await this.npcDialogStates.upsert(state);
      } catch (error) {
        this.logger.warn({ error: String(error), sector: state.sectorName, npc: state.npcId }, 'npc dialog upsert failed');
      }
    }
    for (const { sectorName, npcId } of digest.dialogResets) {
      try {
        await this.npcDialogStates.reset(sectorName, npcId);
      } catch (error) {
        this.logger.warn({ error: String(error), sector: sectorName, npc: npcId }, 'npc dialog reset failed');
      }
    }
  }

  flushMoves(): void {
    for (const space of this.spaceActors.values()) space.flushMoves();
  }

  /** Encode once and fan out to every attached connection; the attach gate keeps an `adminSay` from landing ahead of `loginResult`. */
  broadcastToAllConnections(message: SomnioMessage): void {
    const frame = encodeOrWarn(message, this.logger);
    if (frame === undefined) return;
    for (const entry of [...this.loggedIn.values()]) {
      if (entry.actor.state.kind === 'attached') entry.actor.outbox.send(frame);
    }
  }

  /** Shutdown drain: every logged-in connection snapshots, broadcasts its leave, and flushes its outbox. */
  async drainAll(): Promise<void> {
    const entries = [...this.loggedIn.values()];
    await Promise.all(entries.map((entry) => entry.actor.drainForShutdown()));
    this.loggedIn.clear();
  }
}
