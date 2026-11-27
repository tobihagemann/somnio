import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { RedeemSessionMessage, RevokeSessionMessage } from '@somnio/protocol';
import type { CloseDecision, ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import { completeAuthentication, holdSessionToken, sendLoginResult } from './login.ts';

/**
 * Redeeming a token in place of a password login. Every failure — unknown, expired, revoked —
 * answers `badCredentials`, deliberately telling the client nothing about which. An over-cap
 * token is refused before the repository is reached, so an unauthenticated frame cannot drive an
 * unbounded digest. A redeem is outside the pre-login limit: a 256-bit token cannot be guessed,
 * and a spent address budget must not refuse a valid resume.
 */
export async function handleRedeem(message: RedeemSessionMessage, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<CloseDecision> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  if (utf8ByteLength(message.token) > SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes) {
    sendLoginResult(outbox, 'badCredentials', logger);
    return { kind: 'keepOpen' };
  }
  try {
    const resolved = await dependencies.sessions.redeem(message.token);
    if (resolved === undefined) {
      sendLoginResult(outbox, 'badCredentials', logger);
      return { kind: 'keepOpen' };
    }
    // No rotation on redemption: rotating before `worldRouter.register` succeeds would invalidate the
    // credential on the first `alreadyLoggedIn` answer and break the client's bounded retry.
    return await completeAuthentication(resolved.accountId, connection, dependencies, false, message.locale ?? 'en', message.token);
  } catch (error) {
    logger.error({ error: String(error) }, 'session redemption failed');
    sendLoginResult(outbox, 'badCredentials', logger);
    return { kind: 'keepOpen' };
  }
}

/**
 * Revocation is its own request-gated message with an acknowledgement, never a side effect of
 * disconnect. The connection's own account scopes the delete, so a player cannot revoke another
 * account's session by presenting a token they merely obtained.
 */
export async function handleRevoke(
  message: RevokeSessionMessage,
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  if (utf8ByteLength(message.token) > SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes) {
    sendSessionRevoked(outbox, false, logger);
    return;
  }
  try {
    sendSessionRevoked(outbox, await dependencies.sessions.revoke(message.token, accountId), logger);
  } catch (error) {
    logger.error({ error: String(error) }, 'session revocation failed');
    sendSessionRevoked(outbox, false, logger);
  }
}

/**
 * Ends the other sessions and also the token this connection redeemed or was issued, so a copy taken
 * from this browser ends with them. When that token was still live, its replacement reaches this
 * browser before the answer, and the player stays in the world. The server records the held token
 * rather than the client naming it, so the request needs no token the client may not have saved yet.
 */
export async function handleRevokeOthers(accountId: string, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  try {
    const { ended, reissued } = await dependencies.sessions.revokeAllAndReissue(accountId, connection.sessionToken);
    if (reissued === undefined) connection.sessionToken = undefined;
    else holdSessionToken(reissued, connection, logger);
    sendOtherSessionsRevoked(outbox, true, ended, logger);
  } catch (error) {
    logger.error({ error: String(error) }, 'other sessions revocation failed');
    sendOtherSessionsRevoked(outbox, false, 0, logger);
  }
}

function sendSessionRevoked(outbox: ConnectionOutbox, revoked: boolean, logger: Logger): void {
  outbox.sendEncoded({ tag: 'sessionRevoked', payload: { revoked } }, logger);
}

function sendOtherSessionsRevoked(outbox: ConnectionOutbox, revoked: boolean, count: number, logger: Logger): void {
  outbox.sendEncoded({ tag: 'otherSessionsRevoked', payload: { revoked, count } }, logger);
}
