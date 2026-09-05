import { REGISTER_RESULT, SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol'
import type { RegisterMessage } from '@somnio/protocol'
import { CHARACTER_CLASS, GENDER, figureIndex } from '@somnio/core'
import type { CharacterClass, Gender } from '@somnio/core'
import { RegistrationError, hashPassword, validateForRegistration } from '@somnio/data'
import type { ConnectionActor } from '../connection/connectionActor.ts'
import type { ConnectionDependencies } from '../connection/dependencies.ts'
import type { ConnectionOutbox } from '../connection/outbox.ts'
import type { Logger } from '../logging.ts'
import { STARTER_INVENTORY } from './starterInventory.ts'

const CLASSES: readonly number[] = Object.values(CHARACTER_CLASS)
const GENDERS: readonly number[] = Object.values(GENDER)

/**
 * Registration: validate the raws, derive the figure, hash the password, then the transactional
 * registration. The unique-constraint race maps to `nicknameExists`; there is no pre-check.
 */
export async function handleRegister(
  message: RegisterMessage,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies
): Promise<void> {
  const outbox = connection.outbox
  const logger = dependencies.logger
  const passwordLength = utf8ByteLength(message.password)
  if (
    message.password !== message.passwordRepeat ||
    passwordLength < SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes ||
    passwordLength > SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes ||
    message.email.length === 0 ||
    utf8ByteLength(message.email) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    message.nickname.length === 0 ||
    utf8ByteLength(message.nickname) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    !CLASSES.includes(message.characterClass) ||
    !GENDERS.includes(message.gender)
  ) {
    sendRegisterResult(outbox, REGISTER_RESULT.failure, logger)
    return
  }
  if (validateForRegistration(message.nickname) !== undefined) {
    sendRegisterResult(outbox, REGISTER_RESULT.nameNotAllowed, logger)
    return
  }
  const characterClass = message.characterClass as CharacterClass
  const gender = message.gender as Gender
  let passwordHash: string
  try {
    passwordHash = await hashPassword(message.password)
  } catch (error) {
    logger.error({ error: String(error) }, 'failed to hash registration password')
    sendRegisterResult(outbox, REGISTER_RESULT.failure, logger)
    return
  }
  try {
    await dependencies.registrations.register({
      name: message.nickname,
      passwordHash,
      email: message.email,
      gender,
      figure: figureIndex(characterClass, gender),
      starterInventory: STARTER_INVENTORY,
    })
    sendRegisterResult(outbox, REGISTER_RESULT.ok, logger)
  } catch (error) {
    if (error instanceof RegistrationError) {
      sendRegisterResult(outbox, REGISTER_RESULT.nicknameExists, logger)
      return
    }
    logger.error({ error: String(error) }, 'registration failed')
    sendRegisterResult(outbox, REGISTER_RESULT.failure, logger)
  }
}

function sendRegisterResult(
  outbox: ConnectionOutbox,
  result: (typeof REGISTER_RESULT)[keyof typeof REGISTER_RESULT],
  logger: Logger
): void {
  outbox.sendEncoded({ tag: 'registerResult', payload: { result } }, logger)
}
