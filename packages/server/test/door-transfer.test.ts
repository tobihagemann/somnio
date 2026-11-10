import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, headingFromCardinal } from '@somnio/core';
import type { Character, Point, Sector } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { TRANSFER_LOST, handleUseDoor } from '../src/handlers/gameplay.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { MOONSTONE_IN_HAND, characterOf, lucidity, payloads, wounded } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeDoor, makeNPC, makeSector, makeSectorLine } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubCharacterRepository } from './support/stubRepositories.ts';

const WORLD_SECONDS = 123_456.5;
/** The first join of a player alone in a one-sector view: `enterSpace`, `sector`, `entity`, `inventory`, `energy`, `lucidity`, `cooldowns`. */
const JOIN_FRAMES = 7;
/** Not the fresh character's default, so a join that dropped the character's people would show. */
const PEOPLE = 'umbrae';

/** `Town` with a door at (10, 10) into the interior `Hall`, whose door at (5, 9) leads back. */
function town(hall: Partial<Sector> = {}): Sector[] {
  return [
    makeSector('Town', makeDoor('inside', { x: 10, z: 10 }, { sector: 'Hall', door: 'exit' })),
    interiorSector('Hall', { ...makeDoor('exit', { x: 5, z: 9 }, { sector: 'Town', door: 'inside' }), ...hall }),
  ];
}

async function attachedAt(
  sectors: Sector[],
  at: Point,
  characters = new StubCharacterRepository(),
  character: Partial<Character> = {},
  worldSeconds = WORLD_SECONDS,
) {
  const dependencies = await makeStubConnectionDependencies({ sectors, characters, initialWorldSeconds: worldSeconds });
  const connection = new ConnectionActor(dependencies);
  const { entityId } = attachPlayer(dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!, at, 'walker', {
    outbox: connection.outbox,
    worldSeconds,
    character: { people: PEOPLE, ...character },
  });
  connection.markAttached(entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
  const useDoor = (sector: string, doorId: string) => handleUseDoor({ sector, doorId }, entityId, OUTDOOR_SPACE_ID, connection, dependencies);
  const snapshotIn = (spaceId: string) => dependencies.worldRouter.space(spaceId)!.snapshotForPlayer(entityId)?.character;
  return { connection, dependencies, entityId, useDoor, snapshotIn };
}

describe('handleUseDoor', () => {
  it('moves the player in front of the counterpart door, facing away from it', async () => {
    const w = await attachedAt(town(), { x: 10, z: 9.7 });
    expect(w.useDoor('Town', 'inside')).toEqual({ spaceId: 'Hall' });
    expect(w.snapshotIn(OUTDOOR_SPACE_ID)).toBeUndefined();
    expect(w.snapshotIn('Hall')).toMatchObject({ space: 'Hall', position: { x: 5, z: 8.2 }, facing: headingFromCardinal('north') });
  });

  it("starts the arrival with exactly one enterSpace, carrying the world clock and the character's people", async () => {
    const w = await attachedAt(town(), { x: 10, z: 9.7 });
    w.useDoor('Town', 'inside');
    const arrival = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES);
    expect(arrival.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'cooldowns']);
    expect(arrival[0]).toEqual({ tag: 'enterSpace', payload: { spaceId: 'Hall', selfId: w.entityId, people: PEOPLE, worldSeconds: WORLD_SECONDS } });
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

  /** The world clock stands still in the stub, so the hour of the join is the hour of the request. */
  it.each([
    ['refuses by day', 21.9, undefined],
    ['opens at night', 22, { spaceId: 'Hall' }],
  ])('%s a door that opens only at night', async (_label, hour, outcome) => {
    const [square, hall] = town();
    const nightOnly = { ...square!, doors: square!.doors.map((door) => ({ ...door, nightOnly: true as const })) };
    const w = await attachedAt([nightOnly, hall!], { x: 10, z: 9.7 }, undefined, {}, 400 * 86_400 + hour * 3600);
    expect(w.useDoor('Town', 'inside')).toEqual(outcome);
    if (outcome === undefined) {
      expect((await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES)).toEqual([{ tag: 'doorRefused', payload: { sector: 'Town', doorId: 'inside' } }]);
    }
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
    expect(restore.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'cooldowns']);
    expect(restore[0]).toMatchObject({ payload: { spaceId: OUTDOOR_SPACE_ID, people: PEOPLE } });
  });

  describe('with an ability used half a second before', () => {
    /** Braced for 4 s, Brace's own cooldown 15 s, and the global one 0.75 s, each half a second along. */
    const RUNNING = {
      cooldowns: { globalSeconds: 0.25, cooldowns: [{ abilityId: 'brace', seconds: 14.5 }] },
      effects: { effects: [{ effectId: 'braced', seconds: 3.5 }] },
    };

    async function braced(sectors: Sector[]) {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const w = await attachedAt(sectors, { x: 10, z: 9.7 }, new StubCharacterRepository(), { lucidity: lucidity('fighter', { brace: 1 }) });
      w.dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!.handleUseAbility('brace', w.entityId);
      now.mockReturnValue(1500);
      return w;
    }

    afterEach(() => vi.restoreAllMocks());

    it('carries its effect and its cooldowns through the door, sending both after enterSpace', async () => {
      const w = await braced(town());
      expect(w.useDoor('Town', 'inside')).toEqual({ spaceId: 'Hall' });
      const arrival = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES + 4);
      expect(arrival.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'cooldowns', 'effects']);
      expect(arrival.at(-2)).toEqual({ tag: 'cooldowns', payload: RUNNING.cooldowns });
      expect(arrival.at(-1)).toEqual({ tag: 'effects', payload: { entityId: w.entityId, ...RUNNING.effects } });
      const hall = w.dependencies.worldRouter.space('Hall')!;
      hall.handleUseAbility('brace', w.entityId);
      expect(hall.snapshotForPlayer(w.entityId)!.character.energy.balanceCurrent).toBe(85);
    });

    it('carries them back with the player when the target cannot attach', async () => {
      const oversized = { id: 'oversized', modelId: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1), x: 1, z: 1, yaw: 0, elevation: 0 };
      const hall = town()[1]!;
      const w = await braced(town({ placements: [...hall.placements, oversized] }));
      expect(w.useDoor('Town', 'inside')).toEqual({ spaceId: OUTDOOR_SPACE_ID });
      const restore = (await collectMessages(w.connection.outbox)).slice(JOIN_FRAMES + 4);
      expect(restore.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'cooldowns', 'effects']);
      expect(restore.at(-2)).toEqual({ tag: 'cooldowns', payload: RUNNING.cooldowns });
      expect(restore.at(-1)).toEqual({ tag: 'effects', payload: { entityId: w.entityId, ...RUNNING.effects } });
    });
  });

  describe('with a tick of a heal over time due and not yet given as the player leaves', () => {
    /** Renewal at its first rank gives 2.5 a second for 10 s, 25 in all. Its first tick, 2 with 0.5 owed, is 10 ms due. */
    async function renewed(characters = new StubCharacterRepository()) {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const w = await attachedAt(town(), { x: 10, z: 9.7 }, characters, wounded(40));
      const square = w.dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
      const healer = attachPlayer(square, { x: 8, z: 9.7 }, 'healer', {
        character: { lucidity: lucidity('healer', { touch: 2, renewal: 1 }) },
        inventory: [MOONSTONE_IN_HAND],
      });
      square.handleTarget(w.entityId, healer.entityId);
      square.handleUseAbility('renewal', healer.entityId);
      now.mockReturnValue(2010);
      return { ...w, now };
    }

    afterEach(() => vi.restoreAllMocks());

    it('arrives through the door with the tick given, and is given the whole health', async () => {
      const w = await renewed();
      w.useDoor('Town', 'inside');
      const arrived = w.snapshotIn('Hall')!.energy.healthCurrent;
      expect(arrived).toBe(42);
      // Beside another wounded alike, so what Renewal gives on is the gap between the two.
      const hall = w.dependencies.worldRouter.space('Hall')!;
      const other = attachPlayer(hall, { x: 3, z: 3 }, 'other', { character: wounded(42) });
      for (let ms = 2060; ms <= 14_000; ms += 50) {
        w.now.mockReturnValue(ms);
        hall.step(0.05);
      }
      const gap = w.snapshotIn('Hall')!.energy.healthCurrent - characterOf(hall, other.entityId).energy.healthCurrent;
      expect(arrived - 40 + gap).toBe(25);
    });

    it('saves the health of the tick on a disconnect', async () => {
      const characters = new StubCharacterRepository();
      const persistCheckpoint = vi.spyOn(characters, 'persistCheckpoint');
      const w = await renewed(characters);
      await w.connection.drainForShutdown();
      expect(persistCheckpoint.mock.calls).toEqual([[expect.objectContaining({ id: w.entityId, energy: expect.objectContaining({ healthCurrent: 42 }) }), []]]);
    });
  });

  /** A step the dialog catalog translates, greeted to whoever arrives within speaking distance. */
  const GREETING = 'Welcome, $name!';

  it('takes the language NPCs speak to the player in through the door', async () => {
    const w = await attachedAt(town({ npcs: [makeNPC('greeter', { x: 5, z: 7 }, GREETING)] }), { x: 10, z: 9.7 });
    w.connection.locale = 'de';
    w.useDoor('Town', 'inside');
    w.dependencies.worldRouter.space('Hall')!.step(0.05);
    expect(payloads(await collectMessages(w.connection.outbox), 'serverSay').map((line) => line.text)).toEqual(['Willkommen, walker!']);
  });

  it('keeps the language NPCs speak to the player in when the target cannot attach', async () => {
    const oversized = { id: 'oversized', modelId: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1), x: 1, z: 1, yaw: 0, elevation: 0 };
    const [outside, hall] = town();
    const sectors = [
      { ...outside!, npcs: [makeNPC('greeter', { x: 11, z: 8.5 }, GREETING)] },
      { ...hall!, placements: [...hall!.placements, oversized] },
    ];
    const w = await attachedAt(sectors, { x: 10, z: 9.7 });
    w.connection.locale = 'de';
    expect(w.useDoor('Town', 'inside')).toEqual({ spaceId: OUTDOOR_SPACE_ID });
    w.dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!.step(0.05);
    expect(payloads(await collectMessages(w.connection.outbox), 'serverSay').map((line) => line.text)).toEqual(['Willkommen, walker!']);
  });
});
