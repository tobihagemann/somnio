import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol'
import type { LoginMessage } from '@somnio/protocol'
import { SESSION_POLICY, verifyAccountPassword } from '@somnio/data'
import { arrivalSpawn, isWalkable, sectorPixelCenter } from '@somnio/core'
import type { Character, GridPoint, Sector } from '@somnio/core'
import type { ConnectionActor } from '../connection/connectionActor.ts'
import type { ConnectionDependencies } from '../connection/dependencies.ts'
import type { ConnectionOutbox } from '../connection/outbox.ts'
import type { Logger } from '../logging.ts'

/**
 * Login: look up the account, verify the password (paying the Argon2id cost for an unknown
 * account too, so the two failures are indistinguishable by timing), then the shared join.
 */
export async function handleLogin(
  message: LoginMessage,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies
): Promise<void> {
  const outbox = connection.outbox
  const logger = dependencies.logger
  if (
    utf8ByteLength(message.password) > SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes ||
    utf8ByteLength(message.nickname) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes
  ) {
    sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
    return
  }
  try {
    const account = await dependencies.accounts.findByName(message.nickname)
    const verified = await verifyAccountPassword(message.password, account?.passwordHash)
    if (account === undefined || !verified) {
      // The operator's only signal of a guessing run: the wire answer is deliberately uniform.
      // The submitted name is recorded only when it names an account: an unknown string may be
      // a password typed into the wrong field, and the gameplay log is readable over `/admin`.
      logger.warn(
        account === undefined ? { known_account: false } : { known_account: true, name: message.nickname },
        'login rejected: bad credentials'
      )
      sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
      return
    }
    // Strictly request-gated: a client that never asked receives no `sessionToken` frame at all,
    // which is what keeps `helloVersion` at 3.
    await completeAuthenticatedJoin(
      account.id,
      connection,
      dependencies,
      message.requestSessionToken === true
    )
  } catch (error) {
    logger.error({ error: String(error) }, 'login failed')
    sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
  }
}

/**
 * The join shared by a password login and a redeemed session: character and inventory lookup,
 * router registration, `loginResult(ok)`, attach, the request-gated token, then `dateTick`.
 */
export async function completeAuthenticatedJoin(
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
  issueSessionToken: boolean
): Promise<void> {
  const outbox = connection.outbox
  const logger = dependencies.logger
  try {
    const character = (await dependencies.characters.findByAccount(accountId))[0]
    if (character === undefined) {
      sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
      return
    }
    const inventory = await dependencies.inventories.loadAll(character.id)

    if (!dependencies.worldRouter.register(connection, accountId, character.name)) {
      sendLoginResult(outbox, LOGIN_RESULT.alreadyLoggedIn, logger)
      return
    }
    const sectorActor = dependencies.worldRouter.sector(character.currentSector)
    if (sectorActor === undefined) {
      logger.error({ sector: character.currentSector }, 'starter sector missing from cache')
      dependencies.worldRouter.unregister(accountId)
      sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
      return
    }

    let resolvedCharacter: Character = character
    const spawn = resolvedSpawn(character, sectorActor.staticSector)
    if (spawn !== undefined) {
      // Bump `lastSeen` so the snapshot's stale-write guard accepts the corrected row.
      resolvedCharacter = { ...character, position: spawn, lastSeen: new Date() }
      try {
        await dependencies.characters.snapshot(resolvedCharacter)
      } catch (error) {
        logger.warn(
          { error: String(error), name: character.name, spawn: `${spawn.x},${spawn.y}` },
          'failed to persist resolved spawn point'
        )
      }
    }

    sendLoginResult(outbox, LOGIN_RESULT.ok, logger)
    try {
      const entityIndex = sectorActor.attach(resolvedCharacter, [...inventory], outbox)
      connection.markAttached(entityIndex, resolvedCharacter.currentSector, accountId)
      logger.info({ name: character.name, sector: character.currentSector }, 'player joined')
      // Issued only once the player is in the world: a token minted before a join that then
      // failed would outlive it for 30 days with nothing able to revoke it.
      if (issueSessionToken) await issueToken(accountId, outbox, dependencies)
      outbox.sendEncoded(
        { tag: 'dateTick', payload: dependencies.worldClock.currentDateTickMessage() },
        logger
      )
    } catch (error) {
      logger.error({ error: String(error) }, 'failed to attach to sector')
      dependencies.worldRouter.unregister(accountId)
      // A second `loginResult` after the `ok`: without it the client waits in `awaitingEnterSector`
      // forever. `badCredentials` is the one terminal code both clients act on identically.
      sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
    }
  } catch (error) {
    logger.error({ error: String(error) }, 'join failed')
    sendLoginResult(outbox, LOGIN_RESULT.badCredentials, logger)
  }
}

/** A failure here is logged and swallowed: the player is already authenticated. */
async function issueToken(
  accountId: string,
  outbox: ConnectionOutbox,
  dependencies: ConnectionDependencies
): Promise<void> {
  try {
    const session = await dependencies.sessions.issue(accountId, SESSION_POLICY.defaultLifetimeSeconds)
    const remaining = Math.max(0, Math.round((session.expiresAt.getTime() - Date.now()) / 1000))
    outbox.sendEncoded(
      { tag: 'sessionToken', payload: { token: session.token, expiresInSeconds: remaining } },
      dependencies.logger
    )
  } catch (error) {
    dependencies.logger.warn({ error: String(error) }, 'session token issuance failed')
  }
}

/**
 * Self-healing spawn for an unwalkable persisted position (the registration `(0, 0)` sentinel,
 * or a row stuck in geometry): the arrival portal, else the pixel center. `undefined` when the
 * position is already walkable.
 */
export function resolvedSpawn(character: Character, sector: Sector): GridPoint | undefined {
  if (isWalkable(sector, character.position)) return undefined
  return arrivalSpawn(sector) ?? sectorPixelCenter(sector)
}

export function sendLoginResult(
  outbox: ConnectionOutbox,
  result: (typeof LOGIN_RESULT)[keyof typeof LOGIN_RESULT],
  logger: Logger
): void {
  outbox.sendEncoded({ tag: 'loginResult', payload: { result } }, logger)
}
