import { sql } from 'kysely';
import type { Account } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { confusableSkeleton } from '../namePolicy/namePolicy.ts';

export interface AccountRepository {
  create(name: string, passwordHash: string, email: string): Promise<Account>;
  findByName(name: string): Promise<Account | undefined>;
  findById(id: string): Promise<Account | undefined>;
}

const ACCOUNT_COLUMNS = ['id', 'name', 'password_hash', 'email', 'created_at'] as const;

type AccountRow = { id: string; name: string; password_hash: string; email: string; created_at: Date };

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    email: row.email,
    createdAt: row.created_at,
  };
}

export class PostgresAccountRepository implements AccountRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async create(name: string, passwordHash: string, email: string): Promise<Account> {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    await this.db
      .insertInto('accounts')
      .values({
        id,
        name,
        password_hash: passwordHash,
        email,
        created_at: createdAt,
        name_skeleton: confusableSkeleton(name),
      })
      .execute();
    return { id, name, passwordHash, email, createdAt };
  }

  /**
   * Looks up via the `name_normalized` generated column so case- and NFKC-equivalent variants of
   * the registered name resolve to the same row. NFKC only — cross-script confusables are a
   * separate layer (`name_skeleton`) and are intentionally not resolved at lookup time.
   */
  async findByName(name: string): Promise<Account | undefined> {
    const row = await this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('name_normalized', '=', sql<string>`LOWER(NORMALIZE(${name}, NFKC))`)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }

  async findById(id: string): Promise<Account | undefined> {
    const row = await this.db.selectFrom('accounts').select(ACCOUNT_COLUMNS).where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }
}
