import { sql } from 'kysely';
import type { Account } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { isUniqueViolation } from './errors.ts';

/** Surfaced from the unique-email constraint race so the handler answers `emailExists` without parsing SQLSTATEs. */
export class EmailTakenError extends Error {
  constructor() {
    super('email taken');
    this.name = 'EmailTakenError';
  }
}

export interface AccountRepository {
  create(email: string, passwordHash: string): Promise<Account>;
  findByEmail(email: string): Promise<Account | undefined>;
  findById(id: string): Promise<Account | undefined>;
}

/** Only the email's constraint maps to `EmailTakenError`; a future UNIQUE column is not silently folded in. */
const EMAIL_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set(['accounts_email_normalized_key']);

const ACCOUNT_COLUMNS = ['id', 'password_hash', 'email', 'created_at'] as const;

type AccountRow = { id: string; password_hash: string; email: string; created_at: Date };

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
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

  async create(email: string, passwordHash: string): Promise<Account> {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    try {
      await this.db
        .insertInto('accounts')
        .values({
          id,
          password_hash: passwordHash,
          email,
          created_at: createdAt,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error, EMAIL_UNIQUE_CONSTRAINTS)) throw new EmailTakenError();
      throw error;
    }
    return { id, passwordHash, email, createdAt };
  }

  /** Looks up via the `email_normalized` generated column, so case- and NFKC-equivalent spellings of the registered address resolve to the same row. */
  async findByEmail(email: string): Promise<Account | undefined> {
    const row = await this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('email_normalized', '=', sql<string>`LOWER(NORMALIZE(${email}, NFKC))`)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }

  async findById(id: string): Promise<Account | undefined> {
    const row = await this.db.selectFrom('accounts').select(ACCOUNT_COLUMNS).where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }
}
