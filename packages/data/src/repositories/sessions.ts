import { SESSION_POLICY, makeSessionToken, sessionTokenDigest } from '../auth/sessionToken.ts'
import type { SomnioDatabase } from '../db.ts'

/** One issued session: the raw bearer token (returned to the client exactly once) plus its expiry. */
export interface IssuedSession {
  token: string
  expiresAt: Date
}

/** A redeemed session resolved back to its owner. */
export interface ResolvedSession {
  accountId: string
  expiresAt: Date
}

export interface SessionRepository {
  /** Mints a token, persists its digest, and returns the raw value — unrecoverable afterwards. */
  issue(accountId: string, lifetimeSeconds: number): Promise<IssuedSession>
  /** Resolves a raw token, or `undefined` when unknown, expired, or revoked — deliberately indistinguishable. */
  redeem(token: string): Promise<ResolvedSession | undefined>
  /**
   * Deletes the row for `token` only when it belongs to `accountId`, and reports whether a row was
   * removed. The account is part of the match, so a caller holding someone else's token cannot
   * delete their session, and `false` cannot be read as "that token does not exist".
   */
  revoke(token: string, accountId: string): Promise<boolean>
  /** Bulk cleanup of expired rows; expiry is already enforced on the read path. */
  deleteExpired(asOf: Date): Promise<number>
}

export class PostgresSessionRepository implements SessionRepository {
  private readonly db: SomnioDatabase

  constructor(db: SomnioDatabase) {
    this.db = db
  }

  /**
   * The insert and the cap eviction share one transaction: a stored digest whose raw token was
   * never sent would hold a cap slot for its whole lifetime and evict a token the player is using.
   */
  async issue(accountId: string, lifetimeSeconds: number): Promise<IssuedSession> {
    const token = makeSessionToken()
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000)
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('sessions')
        .values({ token_digest: sessionTokenDigest(token), account_id: accountId, expires_at: expiresAt })
        .execute()
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
            .limit(SESSION_POLICY.maxPerAccount)
        )
        .execute()
    })
    return { token, expiresAt }
  }

  /** Expiry is filtered in SQL against a bound timestamp, so one clock decides for issue, redeem, and cleanup. */
  async redeem(token: string): Promise<ResolvedSession | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .select(['account_id', 'expires_at'])
      .where('token_digest', '=', sessionTokenDigest(token))
      .where('expires_at', '>', new Date())
      .executeTakeFirst()
    return row === undefined ? undefined : { accountId: row.account_id, expiresAt: row.expires_at }
  }

  async revoke(token: string, accountId: string): Promise<boolean> {
    const deleted = await this.db
      .deleteFrom('sessions')
      .where('token_digest', '=', sessionTokenDigest(token))
      .where('account_id', '=', accountId)
      .returning('token_digest')
      .execute()
    return deleted.length > 0
  }

  async deleteExpired(asOf: Date): Promise<number> {
    const deleted = await this.db
      .deleteFrom('sessions')
      .where('expires_at', '<=', asOf)
      .returning('token_digest')
      .execute()
    return deleted.length
  }
}
