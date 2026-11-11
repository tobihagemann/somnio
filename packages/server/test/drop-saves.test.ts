import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Character, Inventory } from '@somnio/core';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleUseDoor } from '../src/handlers/gameplay.ts';
import { DropSaves } from '../src/world/checkpointWriter.ts';
import type { PlayerCheckpoint } from '../src/world/spaceActor.ts';
import { CUDGEL, WAND, carrying } from './support/combat.ts';
import { recordingLogger, testLogger } from './support/logger.ts';
import { attachPlayer, makeCharacter, makeDoor, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure, StubCharacterRepository } from './support/stubRepositories.ts';

interface HeldWrite {
  character: Character;
  inventory: Inventory;
  resolve: () => void;
  reject: () => void;
}

/** A character repository whose every checkpoint write waits until the test resolves or fails it by hand. */
class DeferredCharacterRepository extends StubCharacterRepository {
  readonly writes: HeldWrite[] = [];

  override persistCheckpoint(character: Character, inventory: Inventory): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.writes.push({ character, inventory, resolve: () => resolve(true), reject: () => reject(new RepositoryFailure()) });
    });
  }
}

/** Lets every settled write's continuation run, however many awaits deep. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function snapshots(count: number): PlayerCheckpoint[] {
  const character = makeCharacter({ x: 1, z: 1 });
  return Array.from({ length: count }, (_, index) => ({
    character: { ...character, lastSeen: new Date(character.lastSeen.getTime() + index + 1) },
    inventory: carrying({ coins: index }),
  }));
}

describe('DropSaves', () => {
  it('writes one save at a time per dreamer, then only the latest asked for meanwhile', async () => {
    const characters = new DeferredCharacterRepository();
    const saves = new DropSaves(characters, testLogger());
    const asked = snapshots(5);
    for (const snapshot of asked) saves.request(snapshot, OUTDOOR_SPACE_ID);
    expect(characters.writes.map(({ inventory }) => inventory)).toEqual([asked[0]!.inventory]);

    characters.writes[0]!.resolve();
    await settle();
    expect(characters.writes.map(({ character, inventory }) => [character, inventory])).toEqual(
      [asked[0]!, asked[4]!].map(({ character, inventory }) => [character, inventory]),
    );

    characters.writes[1]!.resolve();
    await settle();
    expect(characters.writes).toHaveLength(2);
    // With nothing in flight, the dreamer's next save is written at once.
    saves.request(asked[4]!, OUTDOOR_SPACE_ID);
    expect(characters.writes).toHaveLength(3);
  });

  it('writes the pending save after the one in flight fails, logging the failure as a drop save', async () => {
    const characters = new DeferredCharacterRepository();
    const { logger, records } = recordingLogger();
    const saves = new DropSaves(characters, logger);
    const [first, second] = snapshots(2);
    saves.request(first!, 'Hall');
    saves.request(second!, 'Hall');

    characters.writes[0]!.reject();
    await settle();
    expect(characters.writes.map(({ inventory }) => inventory)).toEqual([first!.inventory, second!.inventory]);
    expect(records).toMatchObject([{ msg: 'failed to persist player snapshot', origin: 'drop', space: 'Hall', character_id: first!.character.id }]);
  });

  it('keeps the dreamers apart: one in flight for each', () => {
    const characters = new DeferredCharacterRepository();
    const saves = new DropSaves(characters, testLogger());
    const [one] = snapshots(1);
    const [other] = snapshots(1);
    saves.request(one!, OUTDOOR_SPACE_ID);
    saves.request(other!, OUTDOOR_SPACE_ID);
    expect(characters.writes.map(({ character }) => character.id)).toEqual([one!.character.id, other!.character.id]);
  });
});

/** `Town` with a door at (10, 10) into the interior `Hall`, whose door at (5, 9) leads back. */
const TOWN = [
  makeSector('Town', makeDoor('inside', { x: 10, z: 10 }, { sector: 'Hall', door: 'exit' })),
  interiorSector('Hall', makeDoor('exit', { x: 5, z: 9 }, { sector: 'Town', door: 'inside' })),
];

/** The bag after the cudgel is thrown from its first place, the wand still in its second. */
const WAND_LEFT: Inventory = { coins: 0, equipped: {}, bag: [{ place: 1, item: WAND }] };

/** A dreamer at Town's door, carrying a cudgel and a wand, over a repository whose writes the test settles. */
async function dreamerAtTheDoor() {
  const characters = new DeferredCharacterRepository();
  const dependencies = await makeStubConnectionDependencies({ sectors: TOWN, characters });
  const connection = new ConnectionActor(dependencies);
  const accountId = crypto.randomUUID();
  const town = dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
  const { entityId } = attachPlayer(town, { x: 10, z: 9.7 }, 'dropper', { outbox: connection.outbox, inventory: carrying({ bag: [CUDGEL, WAND] }) });
  expect(dependencies.worldRouter.register(connection, accountId)).toBe(true);
  connection.markAttached(entityId, OUTDOOR_SPACE_ID, accountId);
  return { characters, dependencies, connection, accountId, entityId, town };
}

describe('the saves of throws to the ground', () => {
  it('share one lane per dreamer across the spaces a door takes them through', async () => {
    const d = await dreamerAtTheDoor();
    d.town.handleDropItem(CUDGEL.id, 0, d.entityId);
    expect(handleUseDoor({ sector: 'Town', doorId: 'inside' }, d.entityId, OUTDOOR_SPACE_ID, d.connection, d.dependencies)).toEqual({ spaceId: 'Hall' });
    d.dependencies.worldRouter.space('Hall')!.handleDropItem(WAND.id, 0, d.entityId);
    expect(d.characters.writes.map(({ inventory }) => inventory)).toEqual([WAND_LEFT]);

    d.characters.writes[0]!.resolve();
    await settle();
    expect(d.characters.writes.map(({ character, inventory }) => [character.space, inventory])).toEqual([
      [OUTDOOR_SPACE_ID, WAND_LEFT],
      ['Hall', carrying()],
    ]);
  });

  it('on a disconnect, drop the pending save and wait for the one in flight before writing the newer snapshot and letting the account go', async () => {
    const d = await dreamerAtTheDoor();
    await d.connection.dispatch({ tag: 'dropItem', payload: { itemId: CUDGEL.id, heading: 0 } });
    await d.connection.dispatch({ tag: 'dropItem', payload: { itemId: WAND.id, heading: 0 } });
    // A step after the second throw, so the disconnect's snapshot differs from the one pending.
    await d.connection.dispatch({ tag: 'move', payload: { x: 10, z: 9.5, facing: 180, gait: 'walk' } });
    expect(d.characters.writes).toHaveLength(1);

    const drained = d.connection.drainForShutdown();
    await settle();
    expect(d.characters.writes).toHaveLength(1);
    expect(d.dependencies.worldRouter.register(new ConnectionActor(d.dependencies), d.accountId)).toBe(false);

    d.characters.writes[0]!.resolve();
    await settle();
    expect(d.characters.writes.map(({ character, inventory }) => [character.position, inventory])).toEqual([
      [{ x: 10, z: 9.7 }, WAND_LEFT],
      [{ x: 10, z: 9.5 }, carrying()],
    ]);
    expect(d.dependencies.worldRouter.register(new ConnectionActor(d.dependencies), d.accountId)).toBe(false);

    d.characters.writes[1]!.resolve();
    await drained;
    expect(d.characters.writes).toHaveLength(2);
    expect(d.dependencies.worldRouter.register(new ConnectionActor(d.dependencies), d.accountId)).toBe(true);
  });
});
