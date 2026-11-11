import { decodeSomnioMessage } from '@somnio/protocol';
import type {
  CharacterResult,
  EntityMessage,
  EntityMove,
  LoginResult,
  RegisterMessage,
  RegisterResult,
  SomnioMessage,
  SomnioMessageTag,
} from '@somnio/protocol';
import { ConnectionOutbox, collectOutbox } from '../../src/connection/outbox.ts';

/** Finishes and drains an outbox, decoding every frame. */
export async function collectMessages(outbox: ConnectionOutbox): Promise<SomnioMessage[]> {
  outbox.finish();
  return (await collectOutbox(outbox)).map(decodeSomnioMessage);
}

export async function collectTags(outbox: ConnectionOutbox): Promise<SomnioMessageTag[]> {
  return (await collectMessages(outbox)).map((message) => message.tag);
}

export function serverSays(messages: readonly SomnioMessage[]): string[] {
  return messages.flatMap((message) => (message.tag === 'serverSay' ? [message.payload.text] : []));
}

/** Every entity move received, across `moves` frames, in order. */
export function entityMoves(messages: readonly SomnioMessage[]): EntityMove[] {
  return messages.flatMap((message) => (message.tag === 'moves' ? message.payload.moves : []));
}

export function entities(messages: readonly SomnioMessage[]): EntityMessage[] {
  return messages.flatMap((message) => (message.tag === 'entity' ? [message.payload] : []));
}

/** An outbox whose frames are read as they are sent, so one test can look at them more than once. */
export function recordingOutbox(): { outbox: ConnectionOutbox; sent: SomnioMessage[] } {
  const outbox = new ConnectionOutbox(4096);
  const sent: SomnioMessage[] = [];
  const send = outbox.send.bind(outbox);
  outbox.send = (frame) => {
    sent.push(decodeSomnioMessage(frame));
    send(frame);
  };
  return { outbox, sent };
}

/** An outbox that notes the clock at each `vitals` frame it is sent, for a test that needs to know when each went out. */
export function vitalsOutbox(clock: { ms: number }) {
  const outbox = new ConnectionOutbox(4096);
  const sent: { ms: number; entityId: string; health: number }[] = [];
  const send = outbox.send.bind(outbox);
  outbox.send = (frame) => {
    const message = decodeSomnioMessage(frame);
    if (message.tag === 'vitals') sent.push({ ms: clock.ms, ...message.payload });
    send(frame);
  };
  return { outbox, sent };
}

export function loginResults(messages: readonly SomnioMessage[]): LoginResult[] {
  return messages.flatMap((message) => (message.tag === 'loginResult' ? [message.payload.result] : []));
}

export function registerResults(messages: readonly SomnioMessage[]): RegisterResult[] {
  return messages.flatMap((message) => (message.tag === 'registerResult' ? [message.payload.result] : []));
}

export function characterResults(messages: readonly SomnioMessage[]): CharacterResult[] {
  return messages.flatMap((message) => (message.tag === 'characterResult' ? [message.payload.result] : []));
}

/** A `register` payload that passes the handler's field validation. */
export const VALID_REGISTER_MESSAGE: RegisterMessage = {
  email: 'info@example.com',
  password: 'hunter2-long',
  passwordRepeat: 'hunter2-long',
};
