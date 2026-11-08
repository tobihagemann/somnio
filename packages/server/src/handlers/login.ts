import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { Locale, LoginMessage, LoginResult } from '@somnio/protocol';
import { SESSION_POLICY, hasBeenPlayed, postgresNormalizedKey, verifyAccountPassword } from '@somnio/data';
import { holdsUnholdableCharacter } from '@somnio/core';
import type { Character } from '@somnio/core';
import type { CloseDecision, ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import { joinCharacter, sendCharacters } from './characters.ts';

/**
 * Login: look up the account by its email, verify the password (paying the Argon2id cost for an
 * unknown account too, so the two failures are indistinguishable by timing), then the shared
 * authentication. An email with a character no account's email holds (a control character, a lone
 * surrogate) is answered `badCredentials` before anything is counted. An address past its budget of
 * failed logins, or an email past its account budget, is answered `throttled` before the lookup.
 */
export async function handleLogin(message: LoginMessage, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<CloseDecision> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  if (
    utf8ByteLength(message.password) > SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes ||
    utf8ByteLength(message.email) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    holdsUnholdableCharacter(message.email)
  ) {
    sendLoginResult(outbox, 'badCredentials', logger);
    return { kind: 'keepOpen' };
  }
  const limiter = dependencies.attemptLimiter;
  // The address first, so a throttled address cannot drain an account's budget.
  if (!limiter.admit('login', connection.clientAddress)) {
    sendLoginResult(outbox, 'throttled', logger);
    return { kind: 'keepOpen' };
  }
  // Keyed as `findByEmail` matches, so every spelling of one account draws on one budget.
  const emailKey = postgresNormalizedKey(message.email);
  if (!dependencies.accountLimiter.admit('account', emailKey)) {
    sendLoginResult(outbox, 'throttled', logger);
    return { kind: 'keepOpen' };
  }
  try {
    const account = await dependencies.accounts.findByEmail(message.email);
    const verified = await verifyAccountPassword(message.password, account?.passwordHash);
    if (account === undefined || !verified) {
      // The operator's only signal of a guessing run: the wire answer is deliberately uniform.
      // The submitted email is never logged: the gameplay log is readable over `/admin`, and an
      // unknown string may be a password typed into the wrong field. A known account is named by
      // its id.
      logger.warn(account === undefined ? { known_account: false } : { known_account: true, account_id: account.id }, 'login rejected: bad credentials');
      sendLoginResult(outbox, 'badCredentials', logger);
      return { kind: 'keepOpen' };
    }
    // Only a verified login gets its attempts back. A lookup that throws keeps them spent, so
    // attempts are not free while the database is failing.
    limiter.refund('login', connection.clientAddress);
    dependencies.accountLimiter.refund('account', emailKey);
    // Strictly request-gated: a client that never asked receives no `sessionToken` frame at all.
    return await completeAuthentication(account.id, connection, dependencies, message.requestSessionToken === true, message.locale ?? 'en');
  } catch (error) {
    logger.error({ error: String(error) }, 'login failed');
    sendLoginResult(outbox, 'badCredentials', logger);
    return { kind: 'keepOpen' };
  }
}

/**
 * The authentication shared by a password login and a redeemed session: router registration, the
 * account's characters, `loginResult(ok)`, the request-gated token, the count of other sessions,
 * then the character card. The account is registered before anything is read, and stays registered
 * while the player chooses, so no second browser can sit on the same card. A resume, the call that
 * carries `redeemedToken`, joins the character played last instead of showing the card, when there
 * is one. `locale` is what NPCs speak to the player in for the rest of the connection.
 */
export async function completeAuthentication(
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
  issueSessionToken: boolean,
  locale: Locale,
  redeemedToken?: string,
): Promise<CloseDecision> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  if (!dependencies.worldRouter.register(connection, accountId)) {
    sendLoginResult(outbox, 'alreadyLoggedIn', logger);
    return { kind: 'keepOpen' };
  }
  let characters: Character[];
  try {
    characters = await dependencies.characters.findByAccount(accountId);
  } catch (error) {
    logger.error({ error: String(error) }, 'character list failed');
    dependencies.worldRouter.unregister(accountId);
    sendLoginResult(outbox, 'badCredentials', logger);
    return { kind: 'keepOpen' };
  }
  const admitted = connection.markAuthenticated(accountId);
  if (admitted.kind === 'close') {
    dependencies.worldRouter.unregister(accountId);
    return admitted;
  }
  sendLoginResult(outbox, 'ok', logger);
  connection.locale = locale;
  connection.sessionToken = redeemedToken;
  if (issueSessionToken) await issueToken(accountId, connection, dependencies);
  // After the issue, so the count spares the row this browser is about to hold.
  await sendOtherSessions(accountId, connection, dependencies);
  const lastPlayed = characters.find(hasBeenPlayed);
  if (redeemedToken === undefined || lastPlayed === undefined || !(await joinCharacter(lastPlayed, accountId, connection, dependencies))) {
    sendCharacters(outbox, characters, logger);
  }
  return { kind: 'keepOpen' };
}

/**
 * A failure here is logged and swallowed: the player is already authenticated. Issued only once the
 * connection holds the account on the card, so no token is minted for an authentication the card
 * refused. A revoke on the card or in the world can then end it.
 */
async function issueToken(accountId: string, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<void> {
  try {
    const session = await dependencies.sessions.issue(accountId, SESSION_POLICY.defaultLifetimeSeconds);
    connection.sessionToken = session.token;
    const remaining = Math.max(0, Math.round((session.expiresAt.getTime() - Date.now()) / 1000));
    connection.outbox.sendEncoded({ tag: 'sessionToken', payload: { token: session.token, expiresInSeconds: remaining } }, dependencies.logger);
  } catch (error) {
    dependencies.logger.warn({ error: String(error) }, 'session token issuance failed');
  }
}

/** A failure here is logged and swallowed like an issuance's. The client then offers no Log Out Other Browsers until the next login or resume. */
async function sendOtherSessions(accountId: string, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<void> {
  try {
    const count = await dependencies.sessions.countAllExcept(accountId, connection.sessionToken);
    connection.outbox.sendEncoded({ tag: 'otherSessions', payload: { count } }, dependencies.logger);
  } catch (error) {
    dependencies.logger.warn({ error: String(error) }, 'other sessions count failed');
  }
}

export function sendLoginResult(outbox: ConnectionOutbox, result: LoginResult, logger: Logger): void {
  outbox.sendEncoded({ tag: 'loginResult', payload: { result } }, logger);
}
