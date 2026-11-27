import { SESSION_POLICY, makeSessionToken, sessionTokenDigest } from '../auth/sessionToken.ts';
import type { SomnioDatabase } from '../db.ts';

/** One issued session: the raw bearer token (returned to the client exactly once) plus its expiry. */
export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** How many other live sessions `revokeAllAndReissue` ended, and the token that replaced the held one, when one did. */
export interface RevokedSessions {
  ended: number;
  reissued: IssuedSession | undefined;
}

/** A redeemed session resolved back to its owner. */
export interface ResolvedSession {
  accountId: string;
  expiresAt: Date;
}

export interface SessionRepository {
  /** Mints a token, persists its digest, and returns the raw value — unrecoverable afterwards. */
  issue(accountId: string, lifetimeSeconds: number): Promise<IssuedSession>;
  /** Resolves a raw token, or `undefined` when unknown, expired, or revoked — deliberately indistinguishable. */
  redeem(token: string): Promise<ResolvedSession | undefined>;
  /**
   * Deletes the row for `token` only when it belongs to `accountId`, and reports whether a row was
   * removed. The account is part of the match, so a caller holding someone else's token cannot
   * delete their session, and `false` cannot be read as "that token does not exist".
   */
  revoke(token: string, accountId: string): Promise<boolean>;
  /**
   * Deletes every row of `accountId`, including `heldToken`'s, so no copy of any of them can be
   * redeemed again. When `heldToken` had a live row in this account, a fresh token replaces it in the
   * same transaction with the same expiry. The connection that held it stays remembered exactly as
   * long as before. `ended` counts the other unexpired rows, as `countAllExcept` counts them.
   */
  revokeAllAndReissue(accountId: string, heldToken: string | undefined): Promise<RevokedSessions>;
  /** How many of `accountId`'s unexpired rows other than `heldToken`'s there are: the sessions other browsers could still resume. */
  countAllExcept(accountId: string, heldToken: string | undefined): Promise<number>;
  /** Bulk cleanup of expired rows; expiry is already enforced on the read path. */
  deleteExpired(asOf: Date): Promise<number>;
}

export class PostgresSessionRepository implements SessionRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  /**
   * The insert and the cap eviction share one transaction: a stored digest whose raw token was
   * never sent would hold a cap slot for its whole lifetime and evict a token the player is using.
   */
  async issue(accountId: string, lifetimeSeconds: number): Promise<IssuedSession> {
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
    return await this.db.transaction().execute(async (transaction) => {
      const issued = await insertSession(transaction, accountId, expiresAt);
      // Ordered by `expires_at` (indexed) rather than `created_at`: callers pass one lifetime, so
      // the two order identically, and with mixed lifetimes the cap evicts the soonest to expire.
      await transaction
        .deleteFrom('sessions')
        .where('account_id', '=', accountId)
        .where('token_digest', 'not in', (query) =>
          query
            .selectFrom('sessions')
            .select('token_digest')
            .where('account_id', '=', accountId)
            .orderBy('expires_at', 'desc')
            .limit(SESSION_POLICY.maxPerAccount),
        )
        .execute();
      return issued;
    });
  }

  /** Expiry is filtered in SQL against a bound timestamp, so one clock decides for issue, redeem, and cleanup. */
  async redeem(token: string): Promise<ResolvedSession | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .select(['account_id', 'expires_at'])
      .where('token_digest', '=', sessionTokenDigest(token))
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    return row === undefined ? undefined : { accountId: row.account_id, expiresAt: row.expires_at };
  }

  async revoke(token: string, accountId: string): Promise<boolean> {
    const deleted = await this.db
      .deleteFrom('sessions')
      .where('token_digest', '=', sessionTokenDigest(token))
      .where('account_id', '=', accountId)
      .returning('token_digest')
      .execute();
    return deleted.length > 0;
  }

  async revokeAllAndReissue(accountId: string, heldToken: string | undefined): Promise<RevokedSessions> {
    const now = new Date();
    const heldDigest = heldToken === undefined ? undefined : sessionTokenDigest(heldToken);
    return await this.db.transaction().execute(async (transaction) => {
      const deleted = await transaction.deleteFrom('sessions').where('account_id', '=', accountId).returning(['token_digest', 'expires_at']).execute();
      const live = deleted.filter((row) => row.expires_at > now);
      const held = live.find((row) => row.token_digest === heldDigest);
      if (held === undefined) return { ended: live.length, reissued: undefined };
      return { ended: live.length - 1, reissued: await insertSession(transaction, accountId, held.expires_at) };
    });
  }

  async countAllExcept(accountId: string, heldToken: string | undefined): Promise<number> {
    let query = this.db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('expires_at', '>', new Date());
    if (heldToken !== undefined) query = query.where('token_digest', '!=', sessionTokenDigest(heldToken));
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async deleteExpired(asOf: Date): Promise<number> {
    const deleted = await this.db.deleteFrom('sessions').where('expires_at', '<=', asOf).returning('token_digest').execute();
    return deleted.length;
  }
}

/** Mints a token and stores its digest, inside the caller's transaction. */
async function insertSession(db: SomnioDatabase, accountId: string, expiresAt: Date): Promise<IssuedSession> {
  const token = makeSessionToken();
  await db
    .insertInto('sessions')
    .values({ token_digest: sessionTokenDigest(token), account_id: accountId, expires_at: expiresAt })
    .execute();
  return { token, expiresAt };
}
