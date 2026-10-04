import { BOOT_DEFAULT_WORLD_SECONDS } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';

export interface WorldClockRepository {
  /** The boot default when `world_clock` is empty, so a fresh deployment starts from the seed time. */
  load(): Promise<number>;
  save(worldSeconds: number): Promise<void>;
}

export class PostgresWorldClockRepository implements WorldClockRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async load(): Promise<number> {
    const row = await this.db.selectFrom('world_clock').select('world_seconds').where('id', '=', true).executeTakeFirst();
    return row === undefined ? BOOT_DEFAULT_WORLD_SECONDS : row.world_seconds;
  }

  async save(worldSeconds: number): Promise<void> {
    await this.db
      .insertInto('world_clock')
      .values({ id: true, world_seconds: worldSeconds })
      .onConflict((conflict) => conflict.column('id').doUpdateSet({ world_seconds: worldSeconds }))
      .execute();
  }
}
