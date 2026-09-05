import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol'
import type { RedeemSessionMessage, RevokeSessionMessage } from '@somnio/protocol'
import type { ConnectionActor } from '../connection/connectionActor.ts'
import type { ConnectionDependencies } from '../connection/dependencies.ts'
import type { ConnectionOutbox } from '../connection/outbox.ts'
import type { Logger } from '../logging.ts'
import { completeAuthenticatedJoin, sendLoginResult } from './login.ts'

/**
 * Redeeming a token in place of a password login. Every failure — unknown, expired, revoked —
 * answers `badCredentials`, deliberately telling the client nothing about which. An over-cap
 * token is refused before the repository is reached, so an unauthenticated frame cannot drive an
 * unbounded digest.
 */
export async function handleRedeem(
  message: RedeemSessionMessage,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies
): Promise<void> {
  const outbox = connection.outbox
  const logger = dependencies.logger
  if (utf8ByteLength(message.token) > SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes) {
    sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
    return
  }
  try {
    const resolved = await dependencies.sessions.redeem(message.token)
    if (resolved === undefined) {
      sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
      return
    }
    // No rotation on redemption: rotating before `worldRouter.register` succeeds would invalidate the
    // credential on the first `alreadyLoggedIn` answer and break the client's bounded retry.
    await completeAuthenticatedJoin(resolved.accountId, connection, dependencies, false)
  } catch (error) {
    logger.error({ error: String(error) }, 'session redemption failed')
    sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
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
  dependencies: ConnectionDependencies
): Promise<void> {
  const outbox = connection.outbox
  const logger = dependencies.logger
  if (utf8ByteLength(message.token) > SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes) {
    sendSessionRevoked(outbox, false, logger)
    return
  }
  try {
    sendSessionRevoked(outbox, await dependencies.sessions.revoke(message.token, accountId), logger)
  } catch (error) {
    logger.error({ error: String(error) }, 'session revocation failed')
    sendSessionRevoked(outbox, false, logger)
  }
}

function sendSessionRevoked(outbox: ConnectionOutbox, revoked: boolean, logger: Logger): void {
  outbox.sendEncoded({ tag: 'sessionRevoked', payload: { revoked } }, logger)
}
