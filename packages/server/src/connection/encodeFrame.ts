import { encodeSomnioMessage } from '@somnio/protocol'
import type { SomnioMessage } from '@somnio/protocol'
import type { Logger } from '../logging.ts'

/** Encodes a frame, or logs and returns `undefined` when encoding fails (an oversized frame): one frame is never worth the connection or the sector. */
export function encodeOrWarn(message: SomnioMessage, logger: Logger): string | undefined {
  try {
    return encodeSomnioMessage(message)
  } catch (error) {
    logger.warn({ error: String(error), tag: message.tag }, 'failed to encode frame')
    return undefined
  }
}
