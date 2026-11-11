import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { CharacterResult, CreateCharacterMessage, DeleteCharacterMessage, SelectCharacterMessage } from '@somnio/protocol';
import { isPeople, nextLastSeen } from '@somnio/core';
import type { Character } from '@somnio/core';
import { CharacterNameTakenError, compareCharacters, validateCharacterName } from '@somnio/data';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import type { WorldRouter } from '../world/worldRouter.ts';
import { starterInventory } from './starterInventory.ts';

/**
 * The unique-constraint race maps to `nameExists`; there is no pre-check. A character created is
 * answered with the account's characters, then `ok`.
 */
export async function handleCreateCharacter(
  message: CreateCharacterMessage,
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  if (message.name.length === 0 || utf8ByteLength(message.name) > SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes || !isPeople(message.people)) {
    sendCharacterResult(outbox, 'failure', logger);
    return;
  }
  if (validateCharacterName(message.name) !== undefined) {
    sendCharacterResult(outbox, 'nameNotAllowed', logger);
    return;
  }
  try {
    const characters = await dependencies.characters.findByAccount(accountId);
    if (characters.length >= SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount) {
      sendCharacterResult(outbox, 'full', logger);
      return;
    }
    const created = await dependencies.characters.create(accountId, message.name, message.people, starterInventory());
    sendCharacters(outbox, [...characters, created].sort(compareCharacters), logger);
    sendCharacterResult(outbox, 'ok', logger);
  } catch (error) {
    if (error instanceof CharacterNameTakenError) {
      sendCharacterResult(outbox, 'nameExists', logger);
      return;
    }
    logger.error({ error: String(error) }, 'character creation failed');
    sendCharacterResult(outbox, 'failure', logger);
  }
}

export async function handleSelectCharacter(
  message: SelectCharacterMessage,
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): Promise<void> {
  let character: Character | undefined;
  try {
    character = (await dependencies.characters.findByAccount(accountId)).find((candidate) => candidate.id === message.characterId);
  } catch (error) {
    dependencies.logger.error({ error: String(error) }, 'character list failed');
  }
  if (character === undefined) {
    sendCharacterResult(connection.outbox, 'failure', dependencies.logger);
    return;
  }
  await joinCharacter(character, accountId, connection, dependencies);
}

/** A character deleted is answered with the account's characters left, then `ok`. */
export async function handleDeleteCharacter(
  message: DeleteCharacterMessage,
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): Promise<void> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  try {
    const characters = await dependencies.characters.findByAccount(accountId);
    // Checked against the list first, because an id that is not a UUID makes Postgres throw on the `uuid` column.
    if (!characters.some((character) => character.id === message.characterId) || !(await dependencies.characters.delete(accountId, message.characterId))) {
      sendCharacterResult(outbox, 'failure', logger);
      return;
    }
    sendCharacters(
      outbox,
      characters.filter((character) => character.id !== message.characterId),
      logger,
    );
    sendCharacterResult(outbox, 'ok', logger);
  } catch (error) {
    logger.error({ error: String(error) }, 'character deletion failed');
    sendCharacterResult(outbox, 'failure', logger);
  }
}

/**
 * Joins the world as `character`: its inventory, then its `last_seen` written, then the attach. The
 * write makes a resume find it played last, and lets the snapshot's stale-write guard accept a
 * corrected spawn. Its `last_seen` follows the stored one by `nextLastSeen`, so a host clock
 * stepped back since the last save cannot leave the join and every checkpoint after it skipped as
 * stale. `false`, answered `characterResult(failure)`, leaves the player choosing.
 */
export async function joinCharacter(
  character: Character,
  accountId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): Promise<boolean> {
  const outbox = connection.outbox;
  const logger = dependencies.logger;
  try {
    const inventory = await dependencies.items.load(character.id);
    const spawn = resolvedSpawn(character, dependencies.worldRouter);
    const joined: Character = { ...character, ...spawn, lastSeen: nextLastSeen(character.lastSeen, new Date()) };
    try {
      await dependencies.characters.snapshot(joined);
    } catch (error) {
      logger.warn({ error: String(error), name: character.name, spawn: `${spawn.position.x},${spawn.position.z}` }, 'failed to persist the join');
    }
    dependencies.worldRouter.space(spawn.space)!.attach(joined, inventory, outbox, dependencies.worldClock.currentWorldSeconds(), connection.locale);
    connection.markAttached(character.id, spawn.space, accountId);
    dependencies.worldRouter.characterJoined(accountId, character);
    logger.info({ name: character.name, space: spawn.space }, 'player joined');
    return true;
  } catch (error) {
    logger.error({ error: String(error) }, 'join failed');
    sendCharacterResult(outbox, 'failure', logger);
    return false;
  }
}

/**
 * Where the character joins: the saved place when a player can stand there, else the starter
 * sector's spawn. That heals the `(0, 0)` sentinel of a character never played, a space the world
 * no longer has, and a row left inside geometry by a content change.
 */
export function resolvedSpawn(character: Character, worldRouter: WorldRouter): LoadedWorld['starterSpawn'] {
  if (worldRouter.space(character.space)?.canStand(character.position) === true) return character;
  return worldRouter.world.starterSpawn;
}

export function sendCharacters(outbox: ConnectionOutbox, characters: readonly Character[], logger: Logger): void {
  outbox.sendEncoded(
    {
      tag: 'characters',
      payload: {
        characters: characters.map((character) => ({
          id: character.id,
          name: character.name,
          people: character.people,
          ...(character.lucidity.role === undefined ? {} : { role: character.lucidity.role }),
        })),
      },
    },
    logger,
  );
}

function sendCharacterResult(outbox: ConnectionOutbox, result: CharacterResult, logger: Logger): void {
  outbox.sendEncoded({ tag: 'characterResult', payload: { result } }, logger);
}
