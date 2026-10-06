import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, headingFromCardinal } from '@somnio/core';
import type { Character, Point, Sector } from '@somnio/core';
import { STARTER_SECTOR } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleUseDoor, handleWake } from '../src/handlers/gameplay.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { energy } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeDoor, makeNPC, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const WORLD_SECONDS = 123_456.5;
const JOIN_FRAMES = 6;
const FELL_AT: Point = { x: 10, z: 9.7 };
const FALLEN: Partial<Character> = { energy: energy({ healthCurrent: 0, balanceCurrent: 3, spiritCurrent: 60 }) };
const INN_SPAWN = { x: 3, z: 4, facing: headingFromCardinal('east') };

const INN = 'EdariaInn';

/** `Town` with a door at (10, 10) into the inn, where Quieta stands and a dreamer who gave up wakes at (3, 4). */
function world(inn: Partial<Sector> = { spawn: INN_SPAWN }): Sector[] {
  return [
    makeSector('Town', makeDoor('inside', { x: 10, z: 10 }, { sector: INN, door: 'exit' })),
    interiorSector(INN, { ...makeDoor('exit', { x: 5, z: 9 }, { sector: 'Town', door: 'inside' }), npcs: [makeNPC('quieta', { x: 8, z: 2 }, '')], ...inn }),
  ];
}

async function attached(character: Partial<Character>, sectors = world()) {
  const dependencies = await makeStubConnectionDependencies({ sectors, initialWorldSeconds: WORLD_SECONDS });
  const connection = new ConnectionActor(dependencies);
  const { entityId } = attachPlayer(dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!, FELL_AT, 'dreamer', {
    outbox: connection.outbox,
    worldSeconds: WORLD_SECONDS,
    character,
  });
  connection.markAttached(entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
  const snapshotIn = (spaceId: string) => dependencies.worldRouter.space(spaceId)!.snapshotForPlayer(entityId)?.character;
  return { connection, dependencies, entityId, snapshotIn };
}

describe('handleWake', () => {
  it('wakes a fallen dreamer at the inn, weakened, with enterSpace first', async () => {
    const w = await attached(FALLEN);
    expect(handleWake(w.entityId, OUTDOOR_SPACE_ID, w.connection, w.dependencies)).toEqual({ spaceId: INN });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toBeUndefined();
    expect(w.snapshotIn(INN)).toMatchObject({
      space: INN,
      position: { x: 3, z: 4 },
      facing: INN_SPAWN.facing,
      energy: { healthCurrent: 25, balanceCurrent: 25, spiritCurrent: 25 },
    });
    const arrival = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES);
    expect(arrival.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'entity']);
    expect(arrival[0]).toEqual({ tag: 'enterSpace', payload: { spaceId: INN, selfId: w.entityId, worldSeconds: WORLD_SECONDS } });
    expect(arrival[2]).toMatchObject({ payload: { id: w.entityId, condition: 'failing' } });
  });

  it.each<[string, Sector[]]>([
    ['a world without the inn', [makeSector('Town')]],
    ['a world whose inn has no spawn', world({})],
  ])('wakes a fallen dreamer in %s at the starter spawn', async (_label, sectors) => {
    const w = await attached(FALLEN, sectors);
    expect(handleWake(w.entityId, OUTDOOR_SPACE_ID, w.connection, w.dependencies)).toEqual({ spaceId: STARTER_SECTOR });
    expect(w.snapshotIn(STARTER_SECTOR)).toMatchObject({ space: STARTER_SECTOR, position: { x: 5, z: 5 }, energy: { healthCurrent: 25 } });
  });

  it('wakes a dreamer who fell in the space they wake in', async () => {
    const w = await attached(FALLEN, [makeSector(INN, { spawn: { x: 4, z: 4, facing: 0 } })]);
    expect(handleWake(w.entityId, OUTDOOR_SPACE_ID, w.connection, w.dependencies)).toEqual({ spaceId: OUTDOOR_SPACE_ID });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toMatchObject({ position: { x: 4, z: 4 }, energy: { healthCurrent: 25 } });
  });

  it('does nothing for a standing dreamer', async () => {
    const w = await attached({});
    expect(await w.connection.dispatch({ tag: 'wake', payload: {} })).toEqual({ kind: 'keepOpen' });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toMatchObject({ position: FELL_AT, energy: { healthCurrent: 100 } });
    expect((await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES)).toEqual([]);
  });

  it('leaves the connection in the space the dreamer woke in', async () => {
    const w = await attached(FALLEN);
    expect(await w.connection.dispatch({ tag: 'wake', payload: {} })).toEqual({ kind: 'keepOpen' });
    expect(w.connection.state).toMatchObject({ kind: 'attached', spaceId: INN });
    await w.connection.dispatch({ tag: 'move', payload: { x: 3, z: 4.5, facing: 0, gait: 'walk' } });
    expect(w.snapshotIn(INN)).toMatchObject({ position: { x: 3, z: 4.5 } });
  });
});

describe('a fallen dreamer at a door', () => {
  it('is answered doorRefused from inside its trigger, and stays where they fell', async () => {
    const w = await attached(FALLEN);
    expect(handleUseDoor({ sector: 'Town', doorId: 'inside' }, w.entityId, OUTDOOR_SPACE_ID, w.connection, w.dependencies)).toBeUndefined();
    expect((await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES)).toEqual([{ tag: 'doorRefused', payload: { sector: 'Town', doorId: 'inside' } }]);
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toMatchObject({ position: FELL_AT });
  });
});
