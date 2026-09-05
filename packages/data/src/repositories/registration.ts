import type { Account, Character, Gender, InventoryRow } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { confusableSkeleton } from '../namePolicy/namePolicy.ts';
import { insertCharacter, newCharacter } from './characters.ts';
import { isUniqueViolation } from './errors.ts';
import { insertInventoryRows } from './inventoryRows.ts';

export interface RegistrationRequest {
  name: string;
  passwordHash: string;
  email: string;
  gender: Gender;
  figure: number;
  starterInventory: readonly InventoryRow[];
}

/** Surfaced from the unique-name constraint race so the handler maps it to a result code without parsing SQLSTATEs. */
export class RegistrationError extends Error {
  readonly kind = 'nicknameTaken';

  constructor() {
    super('nickname taken');
    this.name = 'RegistrationError';
  }
}

export interface RegistrationRepository {
  /** Provisions `(account, character, starter rows)` in one transaction so a partial registration never lands. */
  register(request: RegistrationRequest): Promise<{ account: Account; character: Character }>;
}

/**
 * Every name-uniqueness constraint (normalized + skeleton, both tables) maps to `nicknameTaken`,
 * whichever one the database reports first; a future UNIQUE column is not silently folded in.
 */
const NAME_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'accounts_name_normalized_key',
  'accounts_name_skeleton_key',
  'characters_name_normalized_key',
  'characters_name_skeleton_key',
]);

export class PostgresRegistrationRepository implements RegistrationRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async register(request: RegistrationRequest): Promise<{ account: Account; character: Character }> {
    const createdAt = new Date();
    const account: Account = {
      id: crypto.randomUUID(),
      name: request.name,
      passwordHash: request.passwordHash,
      email: request.email,
      createdAt,
    };
    const character = newCharacter(crypto.randomUUID(), request.name, request.figure, request.gender, createdAt);
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('accounts')
          .values({
            id: account.id,
            name: account.name,
            password_hash: account.passwordHash,
            email: account.email,
            created_at: createdAt,
            name_skeleton: confusableSkeleton(account.name),
          })
          .execute();
        await insertCharacter(transaction, account.id, character);
        await insertInventoryRows(transaction, character.id, request.starterInventory);
      });
    } catch (error) {
      if (isUniqueViolation(error, NAME_UNIQUE_CONSTRAINTS)) throw new RegistrationError();
      throw error;
    }
    return { account, character };
  }
}
