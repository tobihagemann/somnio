import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { RegisterMessage, RegisterResult } from '@somnio/protocol';
import { PEOPLES } from '@somnio/core';
import type { People } from '@somnio/core';
import { RegistrationError, hashPassword, validateForRegistration } from '@somnio/data';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import { STARTER_INVENTORY } from './starterInventory.ts';

/**
 * Registration: validate the fields, hash the password, then the transactional
 * registration. The unique-constraint race maps to `nicknameExists`; there is no pre-check.
 */
export async function handleRegister(message: RegisterMessage, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  const passwordLength = utf8ByteLength(message.password);
  if (
    message.password !== message.passwordRepeat ||
    passwordLength < SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes ||
    passwordLength > SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes ||
    message.email.length === 0 ||
    utf8ByteLength(message.email) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    message.nickname.length === 0 ||
    utf8ByteLength(message.nickname) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    !isPeople(message.people)
  ) {
    sendRegisterResult(outbox, 'failure', logger);
    return;
  }
  if (validateForRegistration(message.nickname) !== undefined) {
    sendRegisterResult(outbox, 'nameNotAllowed', logger);
    return;
  }
  // Never refunded: every attempt that reaches the hash costs one, whatever it is answered.
  if (!dependencies.attemptLimiter.admit('registration', connection.clientAddress)) {
    sendRegisterResult(outbox, 'throttled', logger);
    return;
  }
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(message.password);
  } catch (error) {
    logger.error({ error: String(error) }, 'failed to hash registration password');
    sendRegisterResult(outbox, 'failure', logger);
    return;
  }
  try {
    await dependencies.registrations.register({
      name: message.nickname,
      passwordHash,
      email: message.email,
      people: message.people,
      starterInventory: STARTER_INVENTORY,
    });
    sendRegisterResult(outbox, 'ok', logger);
  } catch (error) {
    if (error instanceof RegistrationError) {
      sendRegisterResult(outbox, 'nicknameExists', logger);
      return;
    }
    logger.error({ error: String(error) }, 'registration failed');
    sendRegisterResult(outbox, 'failure', logger);
  }
}

function isPeople(value: string): value is People {
  return (PEOPLES as readonly string[]).includes(value);
}

function sendRegisterResult(outbox: ConnectionOutbox, result: RegisterResult, logger: Logger): void {
  outbox.sendEncoded({ tag: 'registerResult', payload: { result } }, logger);
}
