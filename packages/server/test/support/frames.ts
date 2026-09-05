import { decodeSomnioMessage } from '@somnio/protocol'
import type {
  DateTickMessage,
  EntityMessage,
  LoginResultCode,
  PositionMessage,
  SomnioMessage,
  SomnioMessageTag,
} from '@somnio/protocol'
import { collectOutbox } from '../../src/connection/outbox.ts'
import type { ConnectionOutbox } from '../../src/connection/outbox.ts'

/** Finishes and drains an outbox, decoding every frame. */
export async function collectMessages(outbox: ConnectionOutbox): Promise<SomnioMessage[]> {
  outbox.finish()
  return (await collectOutbox(outbox)).map(decodeSomnioMessage)
}

export async function collectTags(outbox: ConnectionOutbox): Promise<SomnioMessageTag[]> {
  return (await collectMessages(outbox)).map((message) => message.tag)
}

export function serverSays(messages: readonly SomnioMessage[]): string[] {
  return messages.flatMap((message) => (message.tag === 'serverSay' ? [message.payload.text] : []))
}

export function serverPositions(messages: readonly SomnioMessage[]): PositionMessage[] {
  return messages.flatMap((message) => (message.tag === 'serverPosition' ? [message.payload] : []))
}

export function entities(messages: readonly SomnioMessage[]): EntityMessage[] {
  return messages.flatMap((message) => (message.tag === 'entity' ? [message.payload] : []))
}

export function dateTicks(messages: readonly SomnioMessage[]): DateTickMessage[] {
  return messages.flatMap((message) => (message.tag === 'dateTick' ? [message.payload] : []))
}

export function loginResults(messages: readonly SomnioMessage[]): LoginResultCode[] {
  return messages.flatMap((message) => (message.tag === 'loginResult' ? [message.payload.result] : []))
}
