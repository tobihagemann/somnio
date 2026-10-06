import { describe, expect, it, vi } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, headingFromCardinal } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { TRANSFER_LOST, handleUseDoor } from '../src/handlers/gameplay.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeDoor, makeSector, makeSectorLine } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubCharacterRepository } from './support/stubRepositories.ts';

const WORLD_SECONDS = 123_456.5;
/** The first join of a player alone in a one-sector view: `enterSpace`, `sector`, `entity`, `inventory`, `energy`, `lucidity`. */
const JOIN_FRAMES = 6;

/** `Town` with a door at (10, 10) into the interior `Hall`, whose door at (5, 9) leads back. */
function town(hall: Partial<Sector> = {}): Sector[] {
  return [
    makeSector('Town', makeDoor('inside', { x: 10, z: 10 }, { sector: 'Hall', door: 'exit' })),
    interiorSector('Hall', { ...makeDoor('exit', { x: 5, z: 9 }, { sector: 'Town', door: 'inside' }), ...hall }),
  ];
}

async function attachedAt(sectors: Sector[], at: Point, characters = new StubCharacterRepository()) {
  const dependencies = await makeStubConnectionDependencies({ sectors, characters, initialWorldSeconds: WORLD_SECONDS });
  const connection = new ConnectionActor(dependencies);
  const { entityId } = attachPlayer(dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!, at, 'walker', {
    outbox: connection.outbox,
    worldSeconds: WORLD_SECONDS,
  });
  connection.markAttached(entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
  const useDoor = (sector: string, doorId: string) => handleUseDoor({ sector, doorId }, entityId, OUTDOOR_SPACE_ID, connection, dependencies);
  const snapshotIn = (spaceId: string) => dependencies.worldRouter.space(spaceId)!.snapshotForPlayer(entityId)?.character;
  return { connection, entityId, useDoor, snapshotIn };
}

describe('handleUseDoor', () => {
  it('moves the player in front of the counterpart door, facing away from it', async () => {
    const w = await attachedAt(town(), { x: 10, z: 9.7 });
    expect(w.useDoor('Town', 'inside')).toEqual({ spaceId: 'Hall' });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toBeUndefined();
    expect(w.snapshotIn('Hall')).toMatchObject({ space: 'Hall', position: { x: 5, z: 8.2 }, facing: headingFromCardinal('north') });
  });

  it('starts the arrival with exactly one enterSpace, carrying the world clock', async () => {
    const w = await attachedAt(town(), { x: 10, z: 9.7 });
    w.useDoor('Town', 'inside');
    const arrival = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES);
    expect(arrival.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity']);
    expect(arrival[0]).toEqual({ tag: 'enterSpace', payload: { spaceId: 'Hall', selfId: w.entityId, worldSeconds: WORLD_SECONDS } });
  });

  it('accepts a player within the slack around the trigger and refuses one beyond it', async () => {
    // The trigger reaches from z 10 north to z 9.42; the slack adds a metre.
    const within = await attachedAt(town(), { x: 10, z: 8.6 });
    expect(within.useDoor('Town', 'inside')).toMatchObject({ spaceId: 'Hall' });
    const beyond = await attachedAt(town(), { x: 10, z: 8 });
    expect(beyond.useDoor('Town', 'inside')).toBeUndefined();
  });

  it.each([
    ['from outside its trigger', 'Town', 'inside', { x: 3, z: 3 }],
    ['for a door the sector does not have', 'Town', 'cellar', { x: 10, z: 9.7 }],
    ['for a door of another space', 'Hall', 'exit', { x: 10, z: 9.7 }],
  ])('answers a useDoor %s with doorRefused and leaves the player in place', async (_label, sector, doorId, at) => {
    const w = await attachedAt(town(), at);
    expect(w.useDoor(sector, doorId)).toBeUndefined();
    expect((await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES)).toEqual([{ tag: 'doorRefused', payload: { sector, doorId } }]);
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toMatchObject({ space: OUTDOOR_SPACE_ID, position: at });
  });

  it('resolves the door by its sector when two sectors of the space share a door id', async () => {
    const sectors = [
      ...makeSectorLine({
        west: makeDoor('in', { x: 10, z: 10 }, { sector: 'WestHall', door: 'exit' }),
        middle: makeDoor('in', { x: 10, z: 10 }, { sector: 'MiddleHall', door: 'exit' }),
      }),
      interiorSector('WestHall', makeDoor('exit', { x: 5, z: 9 }, { sector: 'West', door: 'in' })),
      interiorSector('MiddleHall', makeDoor('exit', { x: 5, z: 9 }, { sector: 'Middle', door: 'in' })),
    ];
    // In the trigger of Middle's door, which stands at x 30 in the space.
    const w = await attachedAt(sectors, { x: 30, z: 9.7 });
    expect(w.useDoor('West', 'in')).toBeUndefined();
    expect(w.useDoor('Middle', 'in')).toEqual({ spaceId: 'MiddleHall' });
  });

  it('leaves the connection in the space the player arrived in, for the next move and for the disconnect checkpoint', async () => {
    const characters = new StubCharacterRepository();
    const persistCheckpoint = vi.spyOn(characters, 'persistCheckpoint');
    const w = await attachedAt(town(), { x: 10, z: 9.7 }, characters);
    expect(await w.connection.dispatch({ tag: 'useDoor', payload: { sector: 'Town', doorId: 'inside' } })).toEqual({ kind: 'keepOpen' });
    await w.connection.dispatch({ tag: 'move', payload: { x: 5, z: 8, facing: 180, gait: 'walk' } });
    expect(w.snapshotIn('Hall')).toMatchObject({ position: { x: 5, z: 8 } });
    await w.connection.drainForShutdown();
    expect(persistCheckpoint.mock.calls).toEqual([[expect.objectContaining({ id: w.entityId, space: 'Hall', position: { x: 5, z: 8 } }), []]]);
    expect(w.snapshotIn('Hall')).toBeUndefined();
  });

  /** One placement carrying more than `maxFrameLength` of `modelId` makes the target's `sector` frame fail to encode. */
  it('puts the player back in the source space when the target cannot attach, with exactly one enterSpace', async () => {
    const oversized = { id: 'oversized', modelId: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1), x: 1, z: 1, yaw: 0, elevation: 0 };
    const hall = town()[1]!;
    const w = await attachedAt(town({ placements: [...hall.placements, oversized] }), { x: 10, z: 9.7 });
    const outcome = w.useDoor('Town', 'inside');
    expect(outcome).not.toBe(TRANSFER_LOST);
    expect(outcome).toEqual({ spaceId: OUTDOOR_SPACE_ID });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toMatchObject({ space: OUTDOOR_SPACE_ID, position: { x: 10, z: 9.7 } });
    expect(w.snapshotIn('Hall')).toBeUndefined();
    // The restoring `enterSpace` is what releases the client's wait for the transfer.
    const restore = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES);
    expect(restore.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity']);
    expect(restore[0]).toMatchObject({ payload: { spaceId: OUTDOOR_SPACE_ID } });
  });
});
