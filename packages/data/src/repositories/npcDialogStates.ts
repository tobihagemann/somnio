import type { NPCDialogState } from '@somnio/core'
import type { SomnioDatabase } from '../db.ts'

/** Composite primary key of an `npc_dialog_states` row; the orphan prune diffs sets of these. */
export interface NPCDialogStateKey {
  sectorName: string
  npcIndex: number
}

export interface NPCDialogStateRepository {
  find(sectorName: string, npcIndex: number): Promise<NPCDialogState | undefined>
  loadAll(sectorName: string): Promise<NPCDialogState[]>
  allKeys(): Promise<NPCDialogStateKey[]>
  upsert(state: NPCDialogState): Promise<void>
  reset(sectorName: string, npcIndex: number): Promise<void>
  deleteOrphans(keys: readonly NPCDialogStateKey[]): Promise<void>
}

export class PostgresNPCDialogStateRepository implements NPCDialogStateRepository {
  private readonly db: SomnioDatabase

  constructor(db: SomnioDatabase) {
    this.db = db
  }

  async find(sectorName: string, npcIndex: number): Promise<NPCDialogState | undefined> {
    const row = await this.db
      .selectFrom('npc_dialog_states')
      .select(['sector_name', 'npc_index', 'script_step'])
      .where('sector_name', '=', sectorName)
      .where('npc_index', '=', npcIndex)
      .executeTakeFirst()
    return row === undefined ? undefined : decode(row)
  }

  async loadAll(sectorName: string): Promise<NPCDialogState[]> {
    const rows = await this.db
      .selectFrom('npc_dialog_states')
      .select(['sector_name', 'npc_index', 'script_step'])
      .where('sector_name', '=', sectorName)
      .execute()
    return rows.map(decode)
  }

  async allKeys(): Promise<NPCDialogStateKey[]> {
    const rows = await this.db.selectFrom('npc_dialog_states').select(['sector_name', 'npc_index']).execute()
    return rows.map((row) => ({ sectorName: row.sector_name, npcIndex: row.npc_index }))
  }

  async upsert(state: NPCDialogState): Promise<void> {
    await this.db
      .insertInto('npc_dialog_states')
      .values({ sector_name: state.sectorName, npc_index: state.npcIndex, script_step: state.scriptStep })
      .onConflict((conflict) =>
        conflict.columns(['sector_name', 'npc_index']).doUpdateSet({ script_step: state.scriptStep })
      )
      .execute()
  }

  async reset(sectorName: string, npcIndex: number): Promise<void> {
    await this.db
      .deleteFrom('npc_dialog_states')
      .where('sector_name', '=', sectorName)
      .where('npc_index', '=', npcIndex)
      .execute()
  }

  async deleteOrphans(keys: readonly NPCDialogStateKey[]): Promise<void> {
    if (keys.length === 0) return
    await this.db.transaction().execute(async (transaction) => {
      for (const key of keys) {
        await transaction
          .deleteFrom('npc_dialog_states')
          .where('sector_name', '=', key.sectorName)
          .where('npc_index', '=', key.npcIndex)
          .execute()
      }
    })
  }
}

function decode(row: { sector_name: string; npc_index: number; script_step: number }): NPCDialogState {
  return { sectorName: row.sector_name, npcIndex: row.npc_index, scriptStep: row.script_step }
}
