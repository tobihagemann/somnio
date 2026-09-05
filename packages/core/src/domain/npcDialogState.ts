/** One NPC's persisted dialog cursor. `scriptStep` is 1-based on disk; the runtime cursor is 0-based. */
export interface NPCDialogState {
  sectorName: string;
  npcIndex: number;
  scriptStep: number;
}
