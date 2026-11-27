import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_POLICY } from '../../src/auth/sessionToken.ts';
import { PostgresSessionRepository } from '../../src/repositories/sessions.ts';
import type { IssuedSession } from '../../src/repositories/sessions.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('session repository', () => {
  let harness: DatabaseHarness;
  let sessions: PostgresSessionRepository;

  async function makeAccount(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, password_hash, email)
      VALUES (${id}, 'hash', ${`${name}@example.com`})`.execute(harness.db);
    return id;
  }

  beforeAll(async () => {
    harness = await startDatabase();
    sessions = new PostgresSessionRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('redeems an issued token back to its account', async () => {
    const accountId = await makeAccount('redeem-user');
    const issued = await sessions.issue(accountId, 3600);
    expect((await sessions.redeem(issued.token))?.accountId).toBe(accountId);
  });

  it('never stores the raw token', async () => {
    const accountId = await makeAccount('at-rest-user');
    const issued = await sessions.issue(accountId, 3600);
    const rows = await sql<{
      token_digest: string;
    }>`SELECT token_digest FROM sessions WHERE account_id = ${accountId}`.execute(harness.db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.token_digest).not.toBe(issued.token);
    expect(rows.rows[0]?.token_digest).toHaveLength(64);
  });

  it('resolves nothing for an unknown token', async () => {
    expect(await sessions.redeem('never-issued')).toBeUndefined();
  });

  it('resolves nothing for an expired token', async () => {
    const accountId = await makeAccount('expired-user');
    const issued = await sessions.issue(accountId, -60);
    expect(await sessions.redeem(issued.token)).toBeUndefined();
  });

  it('makes a revoked token unusable afterwards', async () => {
    const accountId = await makeAccount('revoke-user');
    const issued = await sessions.issue(accountId, 3600);
    expect(await sessions.redeem(issued.token)).toBeDefined();
    expect(await sessions.revoke(issued.token, accountId)).toBe(true);
    expect(await sessions.redeem(issued.token)).toBeUndefined();
  });

  it('reports nothing removed for an unknown token', async () => {
    expect(await sessions.revoke('never-issued', crypto.randomUUID())).toBe(false);
  });

  it("removes nothing when revoking another account's token", async () => {
    const owner = await makeAccount('revoke-owner');
    const other = await makeAccount('revoke-other');
    const issued = await sessions.issue(owner, 3600);
    expect(await sessions.revoke(issued.token, other)).toBe(false);
    expect(await sessions.redeem(issued.token)).toBeDefined();
  });

  it("leaves the account's other sessions intact on revoke", async () => {
    const accountId = await makeAccount('scope-user');
    const first = await sessions.issue(accountId, 3600);
    const second = await sessions.issue(accountId, 3600);
    await sessions.revoke(first.token, accountId);
    expect(await sessions.redeem(first.token)).toBeUndefined();
    expect(await sessions.redeem(second.token)).toBeDefined();
  });

  it('revokes every session of the account and reissues the held one with its expiry', async () => {
    const accountId = await makeAccount('others-user');
    const bystanderAccount = await makeAccount('others-bystander');
    const held = await sessions.issue(accountId, 3600);
    const first = await sessions.issue(accountId, 3600);
    const second = await sessions.issue(accountId, 3600);
    const bystander = await sessions.issue(bystanderAccount, 3600);
    const { ended, reissued } = await sessions.revokeAllAndReissue(accountId, held.token);
    expect(ended).toBe(2);
    expect(reissued?.token).not.toBe(held.token);
    expect(reissued?.expiresAt).toEqual(held.expiresAt);
    expect(await sessions.redeem(reissued?.token ?? '')).toEqual({ accountId, expiresAt: held.expiresAt });
    for (const revoked of [held, first, second]) expect(await sessions.redeem(revoked.token)).toBeUndefined();
    expect(await sessions.redeem(bystander.token)).toBeDefined();
  });

  it('revokes every session of the account and reissues none when none is held', async () => {
    const accountId = await makeAccount('others-none-held');
    const first = await sessions.issue(accountId, 3600);
    const second = await sessions.issue(accountId, 3600);
    expect(await sessions.revokeAllAndReissue(accountId, undefined)).toEqual({ ended: 2, reissued: undefined });
    expect(await sessions.redeem(first.token)).toBeUndefined();
    expect(await sessions.redeem(second.token)).toBeUndefined();
  });

  it('reissues nothing for a held row that has expired', async () => {
    const accountId = await makeAccount('others-expired-held');
    const expired = await sessions.issue(accountId, -60);
    const live = await sessions.issue(accountId, 3600);
    expect(await sessions.revokeAllAndReissue(accountId, expired.token)).toEqual({ ended: 1, reissued: undefined });
    expect(await sessions.redeem(live.token)).toBeUndefined();
    const rows = await sql<{ token_digest: string }>`SELECT token_digest FROM sessions WHERE account_id = ${accountId}`.execute(harness.db);
    expect(rows.rows).toHaveLength(0);
  });

  it('deletes an expired sibling without counting it as a session ended', async () => {
    const accountId = await makeAccount('others-expired-sibling');
    const held = await sessions.issue(accountId, 3600);
    await sessions.issue(accountId, 3600);
    await sessions.issue(accountId, -60);
    expect((await sessions.revokeAllAndReissue(accountId, held.token)).ended).toBe(1);
    const rows = await sql<{ token_digest: string }>`SELECT token_digest FROM sessions WHERE account_id = ${accountId}`.execute(harness.db);
    expect(rows.rows).toHaveLength(1);
  });

  it("counts the account's other live sessions, sparing the one named", async () => {
    const accountId = await makeAccount('count-user');
    const bystanderAccount = await makeAccount('count-bystander');
    const kept = await sessions.issue(accountId, 3600);
    await sessions.issue(accountId, 3600);
    await sessions.issue(accountId, -60);
    await sessions.issue(bystanderAccount, 3600);
    expect(await sessions.countAllExcept(accountId, kept.token)).toBe(1);
    expect(await sessions.countAllExcept(accountId, undefined)).toBe(2);
  });

  it('deletes only the aged-out rows', async () => {
    // Earlier cases in this file leave expired rows behind; sweep them so the `deleteExpired` count is exact.
    await sessions.deleteExpired(new Date());
    const accountId = await makeAccount('cleanup-user');
    const live = await sessions.issue(accountId, 3600);
    await sessions.issue(accountId, -60);
    expect(await sessions.deleteExpired(new Date())).toBe(1);
    expect(await sessions.redeem(live.token)).toBeDefined();
  });

  it('evicts the oldest sessions beyond the per-account cap', async () => {
    const accountId = await makeAccount('cap-user');
    const other = await makeAccount('cap-bystander');
    const bystander = await sessions.issue(other, 3600);
    // Ascending lifetimes so `expires_at` order matches issue order: the first is oldest.
    const issued: IssuedSession[] = [];
    for (let index = 0; index <= SESSION_POLICY.maxPerAccount; index += 1) {
      issued.push(await sessions.issue(accountId, 3600 + index));
    }
    expect(await sessions.redeem(issued[0]!.token)).toBeUndefined();
    for (const session of issued.slice(1)) expect(await sessions.redeem(session.token)).toBeDefined();
    expect(await sessions.redeem(bystander.token)).toBeDefined();
  });
});
