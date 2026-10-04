import type { NPCDialogState } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';

export interface NPCDialogStateRepository {
  find(sectorName: string, npcId: string): Promise<NPCDialogState | undefined>;
  loadAll(sectorName: string): Promise<NPCDialogState[]>;
  upsert(state: NPCDialogState): Promise<void>;
  reset(sectorName: string, npcId: string): Promise<void>;
}

export class PostgresNPCDialogStateRepository implements NPCDialogStateRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async find(sectorName: string, npcId: string): Promise<NPCDialogState | undefined> {
    const row = await this.db
      .selectFrom('npc_dialog_states')
      .select(['sector_name', 'npc_id', 'script_step'])
      .where('sector_name', '=', sectorName)
      .where('npc_id', '=', npcId)
      .executeTakeFirst();
    return row === undefined ? undefined : decode(row);
  }

  async loadAll(sectorName: string): Promise<NPCDialogState[]> {
    const rows = await this.db.selectFrom('npc_dialog_states').select(['sector_name', 'npc_id', 'script_step']).where('sector_name', '=', sectorName).execute();
    return rows.map(decode);
  }

  async upsert(state: NPCDialogState): Promise<void> {
    await this.db
      .insertInto('npc_dialog_states')
      .values({ sector_name: state.sectorName, npc_id: state.npcId, script_step: state.scriptStep })
      .onConflict((conflict) => conflict.columns(['sector_name', 'npc_id']).doUpdateSet({ script_step: state.scriptStep }))
      .execute();
  }

  async reset(sectorName: string, npcId: string): Promise<void> {
    await this.db.deleteFrom('npc_dialog_states').where('sector_name', '=', sectorName).where('npc_id', '=', npcId).execute();
  }
}

function decode(row: { sector_name: string; npc_id: string; script_step: number }): NPCDialogState {
  return { sectorName: row.sector_name, npcId: row.npc_id, scriptStep: row.script_step };
}
