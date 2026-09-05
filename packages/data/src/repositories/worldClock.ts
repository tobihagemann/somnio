import { BOOT_DEFAULT_WORLD_CLOCK } from '@somnio/core'
import type { WorldClock } from '@somnio/core'
import type { SomnioDatabase } from '../db.ts'

export interface WorldClockRepository {
  /** The boot default when `world_clock` is empty, so a fresh deployment starts from the seed time. */
  load(): Promise<WorldClock>
  save(clock: WorldClock): Promise<void>
}

export class PostgresWorldClockRepository implements WorldClockRepository {
  private readonly db: SomnioDatabase

  constructor(db: SomnioDatabase) {
    this.db = db
  }

  async load(): Promise<WorldClock> {
    const row = await this.db
      .selectFrom('world_clock')
      .select(['second', 'minute', 'hour', 'day', 'month', 'year'])
      .where('id', '=', true)
      .executeTakeFirst()
    return row === undefined ? { ...BOOT_DEFAULT_WORLD_CLOCK } : { ...row }
  }

  async save(clock: WorldClock): Promise<void> {
    const columns = {
      second: clock.second,
      minute: clock.minute,
      hour: clock.hour,
      day: clock.day,
      month: clock.month,
      year: clock.year,
    }
    await this.db
      .insertInto('world_clock')
      .values({ id: true, ...columns })
      .onConflict((conflict) => conflict.column('id').doUpdateSet(columns))
      .execute()
  }
}
