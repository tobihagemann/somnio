import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { RegisterMessage, RegisterResult } from '@somnio/protocol';
import { isEmailAddress } from '@somnio/core';
import { EmailTakenError, hashPassword } from '@somnio/data';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';

/** The unique-constraint race maps to `emailExists`; there is no pre-check. */
export async function handleRegister(message: RegisterMessage, connection: ConnectionActor, dependencies: ConnectionDependencies): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  const passwordLength = utf8ByteLength(message.password);
  if (
    message.password !== message.passwordRepeat ||
    passwordLength < SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes ||
    passwordLength > SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes ||
    utf8ByteLength(message.email) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes ||
    !isEmailAddress(message.email)
  ) {
    sendRegisterResult(outbox, 'failure', logger);
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
    await dependencies.accounts.create(message.email, passwordHash);
    sendRegisterResult(outbox, 'ok', logger);
  } catch (error) {
    if (error instanceof EmailTakenError) {
      sendRegisterResult(outbox, 'emailExists', logger);
      return;
    }
    logger.error({ error: String(error) }, 'registration failed');
    sendRegisterResult(outbox, 'failure', logger);
  }
}

function sendRegisterResult(outbox: ConnectionOutbox, result: RegisterResult, logger: Logger): void {
  outbox.sendEncoded({ tag: 'registerResult', payload: { result } }, logger);
}
