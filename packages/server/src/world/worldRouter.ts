import type { SomnioMessage } from '@somnio/protocol'
import type { Sector } from '@somnio/core'
import type { CharacterRepository, NPCDialogStateRepository } from '@somnio/data'
import type { ConnectionActor } from '../connection/connectionActor.ts'
import { encodeOrWarn } from '../connection/encodeFrame.ts'
import type { Logger } from '../logging.ts'
import { persistPlayerCheckpoint } from './checkpointWriter.ts'
import { PerSectorActor } from './perSectorActor.ts'

/** The surface of the router the admin dispatcher consumes, so its tests can substitute a stub. */
export interface AdminWorldRouter {
  loggedInPlayerCount(): number
  kickByCharacterName(name: string): boolean
  broadcastToAllConnections(message: SomnioMessage): void
}

interface LoggedInEntry {
  actor: ConnectionActor
  normalizedName: string
}

/** Mirrors the `LOWER(NORMALIZE(name, NFKC))` collation of every `name_normalized` column. */
function normalize(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

/**
 * Cross-sector router: one `PerSectorActor` per loaded sector plus the logged-in connections
 * keyed by account (one character per account).
 */
export class WorldRouter implements AdminWorldRouter {
  private readonly sectorActors: Map<string, PerSectorActor>
  private readonly loggedIn = new Map<string, LoggedInEntry>()
  private readonly characters: CharacterRepository
  private readonly npcDialogStates: NPCDialogStateRepository
  private readonly logger: Logger

  private constructor(
    sectorActors: Map<string, PerSectorActor>,
    characters: CharacterRepository,
    npcDialogStates: NPCDialogStateRepository,
    logger: Logger
  ) {
    this.sectorActors = sectorActors
    this.characters = characters
    this.npcDialogStates = npcDialogStates
    this.logger = logger
  }

  /** Seeds each sector's dialog cursors from the repository before any connection arrives. */
  static async create(
    sectors: ReadonlyMap<string, Sector>,
    characters: CharacterRepository,
    npcDialogStates: NPCDialogStateRepository,
    logger: Logger,
    sectorLogger: Logger = logger
  ): Promise<WorldRouter> {
    const actors = new Map<string, PerSectorActor>()
    for (const [name, sector] of sectors) {
      const cursors = new Map<number, number>()
      for (const state of await npcDialogStates.loadAll(name)) cursors.set(state.npcIndex, state.scriptStep)
      actors.set(name, new PerSectorActor(sector, { logger: sectorLogger, initialDialogCursors: cursors }))
    }
    return new WorldRouter(actors, characters, npcDialogStates, logger)
  }

  sector(name: string): PerSectorActor | undefined {
    return this.sectorActors.get(name)
  }

  /** `false` when the account is already registered; the caller answers `alreadyLoggedIn`. */
  register(actor: ConnectionActor, accountId: string, characterName: string): boolean {
    if (this.loggedIn.has(accountId)) return false
    this.loggedIn.set(accountId, { actor, normalizedName: normalize(characterName) })
    return true
  }

  unregister(accountId: string): void {
    this.loggedIn.delete(accountId)
  }

  /** Logged-in *and attached* connections, so the post-register / pre-attach window is excluded. */
  loggedInPlayerCount(): number {
    let count = 0
    for (const entry of this.loggedIn.values()) {
      if (entry.actor.state.kind === 'attached') count += 1
    }
    return count
  }

  /** Disconnects every logged-in connection whose cached name matches; the connection's own exit path unregisters it. */
  kickByCharacterName(name: string): boolean {
    const needle = normalize(name)
    let kicked = false
    for (const entry of [...this.loggedIn.values()]) {
      if (entry.normalizedName !== needle) continue
      entry.actor.disconnectForAdminKick()
      kicked = true
    }
    return kicked
  }

  /** Every logged-in player's full checkpoint, per sector, through the guarded transaction. */
  async checkpointAll(): Promise<void> {
    for (const [sectorName, sector] of this.sectorActors) {
      for (const snapshot of sector.snapshotForCheckpoint()) {
        await persistPlayerCheckpoint(snapshot, this.characters, this.logger, { sector: sectorName })
      }
    }
  }

  /** One tick across every sector; a persistence failure logs and continues (the next emit rewrites the row). */
  async runAITickAcrossSectors(): Promise<void> {
    for (const [sectorName, sector] of this.sectorActors) {
      const digest = sector.runAITick()
      for (const state of digest.dialogUpserts) {
        try {
          await this.npcDialogStates.upsert(state)
        } catch (error) {
          this.logger.warn(
            { error: String(error), sector: sectorName, npc_index: state.npcIndex },
            'npc dialog upsert failed'
          )
        }
      }
      for (const npcIndex of digest.dialogResets) {
        try {
          await this.npcDialogStates.reset(sectorName, npcIndex)
        } catch (error) {
          this.logger.warn(
            { error: String(error), sector: sectorName, npc_index: npcIndex },
            'npc dialog reset failed'
          )
        }
      }
    }
  }

  /** Encode once and fan out to every attached connection; the attach gate keeps a `dateTick` from landing ahead of `loginResult`. */
  broadcastToAllConnections(message: SomnioMessage): void {
    const frame = encodeOrWarn(message, this.logger)
    if (frame === undefined) return
    for (const entry of [...this.loggedIn.values()]) {
      if (entry.actor.state.kind === 'attached') entry.actor.outbox.send(frame)
    }
  }

  /** Shutdown drain: every logged-in connection snapshots, broadcasts its leave, and flushes its outbox. */
  async drainAll(): Promise<void> {
    const entries = [...this.loggedIn.values()]
    await Promise.all(entries.map((entry) => entry.actor.drainForShutdown()))
    this.loggedIn.clear()
  }
}
