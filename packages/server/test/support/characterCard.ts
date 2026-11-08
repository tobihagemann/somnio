import { encodeSomnioMessage } from '@somnio/protocol';
import type { CharacterResult, CharacterSummaryMessage, LoginMessage, SomnioMessage } from '@somnio/protocol';
import type { TestClient } from './liveServer.ts';

/** The email of the account a test player named `name` logs in with. */
export function emailFor(name: string): string {
  return `${name}@example.invalid`;
}

export interface OnCard {
  characters: CharacterSummaryMessage[];
  /** Every frame from the authentication's answer through the account's `characters`. */
  frames: SomnioMessage[];
}

/** Logs in on a socket past its `hello` and reads through to the character card. */
export function loginToCard(client: TestClient, login: LoginMessage): Promise<OnCard> {
  client.send(encodeSomnioMessage({ tag: 'login', payload: login }));
  return untilCard(client);
}

/** Sends a session redeem on a socket, leaving its answer for the caller to read. */
export function sendRedeem(client: TestClient, token: string): void {
  client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token } }));
}

/** Redeems a session on a socket past its `hello` and reads through to the character card. */
export function redeemToCard(client: TestClient, token: string): Promise<OnCard> {
  sendRedeem(client, token);
  return untilCard(client);
}

/** Reads an authentication's answer, failing on any but `ok`, and up to the account's `characters`, which put the player on the card. */
async function untilCard(client: TestClient): Promise<OnCard> {
  const answer = await client.until('loginResult');
  if (answer.target.tag !== 'loginResult' || answer.target.payload.result !== 'ok') throw new Error(`authentication failed: ${JSON.stringify(answer.target)}`);
  const listed = await client.until('characters');
  if (listed.target.tag !== 'characters') throw new Error('expected characters');
  return { characters: listed.target.payload.characters, frames: [answer.target, ...listed.before, listed.target] };
}

/** A request on the card and its answer: the account's characters, listed ahead of an `ok`, then the result. */
export async function askOnCard(
  client: TestClient,
  message: SomnioMessage,
): Promise<{ result: CharacterResult; characters: CharacterSummaryMessage[] | undefined; frames: SomnioMessage[] }> {
  client.send(encodeSomnioMessage(message));
  const answered = await client.until('characterResult');
  if (answered.target.tag !== 'characterResult') throw new Error('expected characterResult');
  const listed = answered.before.find((received) => received.tag === 'characters');
  return {
    result: answered.target.payload.result,
    characters: listed?.tag === 'characters' ? listed.payload.characters : undefined,
    frames: [...answered.before, answered.target],
  };
}

/**
 * From the card into the world as the account's first listed character, created as `name` when it
 * has none. Answers the frames the creation read; the join is left for the caller to read.
 */
export async function chooseOnCard(client: TestClient, card: OnCard, name: string): Promise<SomnioMessage[]> {
  let characters = card.characters;
  const frames: SomnioMessage[] = [];
  if (characters.length === 0) {
    const created = await askOnCard(client, { tag: 'createCharacter', payload: { name, people: 'vigils' } });
    if (created.characters === undefined) throw new Error(`creating ${name} failed: ${created.result}`);
    frames.push(...created.frames);
    characters = created.characters;
  }
  client.send(encodeSomnioMessage({ tag: 'selectCharacter', payload: { characterId: characters[0]!.id } }));
  return frames;
}
