import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, sectorView } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { SpaceActor } from '../src/world/spaceActor.ts';
import { wearing } from './support/combat.ts';
import { collectMessages, entities } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { attachPlayer, makeCharacter, makeDoor, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

function actor(overrides: Partial<Sector> = {}) {
  const sector = makeSector('TestSector', overrides);
  return { sector, space: new SpaceActor(makeWorld([sector]), OUTDOOR_SPACE_ID, { logger: testLogger(), requestDropSave: () => {} }) };
}

describe('SpaceActor.attach', () => {
  it("streams enterSpace first and once, carrying the character's people, then the sector, the self entity, inventory, energy, lucidity, and cooldowns", async () => {
    const { space } = actor();
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice', { worldSeconds: 1234.5, character: { people: 'lumina' } });
    const messages = await collectMessages(alice.outbox);
    expect(messages.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'cooldowns']);
    expect(messages[0]).toEqual({
      tag: 'enterSpace',
      payload: { spaceId: OUTDOOR_SPACE_ID, selfId: alice.character.id, people: 'lumina', worldSeconds: 1234.5 },
    });
    expect(messages[2]).toEqual({
      tag: 'entity',
      payload: {
        id: alice.character.id,
        kind: 'player',
        characterModelId: 'hero',
        name: 'alice',
        radius: SOMNIO_CONSTANTS.playerRadius,
        x: 2,
        z: 2,
        facing: 0,
        gait: 'jog',
        condition: 'hale',
        held: {},
      },
    });
    expect(messages[5]).toEqual({ tag: 'lucidity', payload: { ranks: [] } });
  });

  it('sends the sector as its client view, without the NPCs and spawns the server acts on', async () => {
    const { sector, space } = actor({ npcs: [makeNPC('guard', { x: 10, z: 10 }, 'Halt.')], monsterSpawns: [makeMonsterSpawn({ x: 15, z: 15 })] });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    const messages = await collectMessages(alice.outbox);
    expect(messages[1]).toEqual({ tag: 'sector', payload: { sector: sectorView(sector) } });
    expect(entities(messages)[1]).toMatchObject({ id: 'npc:TestSector/guard', kind: 'npc', radius: SOMNIO_CONSTANTS.npcRadius, x: 10, z: 10 });
  });

  it("names a room's doors that open to the outdoors on its sector frame, and none of a room behind it", async () => {
    const toCellar = makeDoor('to-cellar', { x: 3, z: 9 }, { sector: 'Cellar', door: 'exit' });
    const toTown = makeDoor('exit', { x: 7, z: 9 }, { sector: 'Town', door: 'inside' });
    const world = makeWorld([
      makeSector('Town', makeDoor('inside', { x: 10, z: 10 }, { sector: 'Hall', door: 'exit' })),
      interiorSector('Hall', { placements: [...toCellar.placements, ...toTown.placements], doors: [...toCellar.doors, ...toTown.doors] }),
      interiorSector('Cellar', makeDoor('exit', { x: 5, z: 9 }, { sector: 'Hall', door: 'to-cellar' })),
    ]);
    const sectorFrame = async (spaceId: string) => {
      const space = new SpaceActor(world, spaceId, { logger: testLogger(), requestDropSave: () => {} });
      return (await collectMessages(attachPlayer(space, { x: 5, z: 5 }, 'alice', { spaceId }).outbox))[1];
    };

    expect(await sectorFrame('Hall')).toMatchObject({ tag: 'sector', payload: { outdoorDoorIds: ['exit'] } });
    expect((await sectorFrame('Cellar'))?.payload).not.toHaveProperty('outdoorDoorIds');
    expect((await sectorFrame(OUTDOOR_SPACE_ID))?.payload).not.toHaveProperty('outdoorDoorIds');
  });

  it('with an existing peer emits one self entity to the newcomer and one newcomer entity to the peer', async () => {
    const { space } = actor();
    const first = attachPlayer(space, { x: 1, z: 1 }, 'first');
    const second = attachPlayer(space, { x: 5, z: 5 }, 'second');
    expect(entities(await collectMessages(first.outbox)).map((entity) => entity.id)).toEqual([first.entityId, second.entityId]);
    expect(entities(await collectMessages(second.outbox)).map((entity) => entity.id)).toEqual([second.entityId, first.entityId]);
  });

  it('leaves no slot and no frame behind when the join cannot be encoded', async () => {
    const { space } = actor({
      placements: [{ id: 'oversized', modelId: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1), x: 1, z: 1, yaw: 0, elevation: 0 }],
    });
    const outbox = new ConnectionOutbox(1024);
    expect(() => space.attach(makeCharacter({ x: 2, z: 2 }), wearing(), outbox, 0, 'en')).toThrow();
    expect(await collectMessages(outbox)).toEqual([]);
    expect(space.snapshotForCheckpoint()).toEqual([]);
  });

  it('refuses a position no sector of the space holds', () => {
    const { space } = actor();
    expect(() => space.attach(makeCharacter({ x: 25, z: 2 }), wearing(), new ConnectionOutbox(1024), 0, 'en')).toThrow(/no sector/);
  });
});

describe('a checkpoint', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries a lastSeen strictly after the player's last one, though taken in the same millisecond", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { space } = actor();
    const { character, entityId } = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    const taken = [space.snapshotForCheckpoint()[0]!, space.snapshotForPlayer(entityId)!, space.handOver(entityId, true)!.checkpoint];
    const joined = character.lastSeen.getTime();
    expect(joined).toBe(Date.now());
    expect(taken.map((checkpoint) => checkpoint.character.lastSeen.getTime())).toEqual([joined + 1, joined + 2, joined + 3]);
  });
});

describe('SpaceActor.handOver', () => {
  it('tells the peers who left and why', async () => {
    const { space } = actor();
    const stayer = attachPlayer(space, { x: 1, z: 1 }, 'stayer');
    const leaver = attachPlayer(space, { x: 5, z: 5 }, 'leaver');
    space.handOver(leaver.entityId, true);
    expect(await collectMessages(stayer.outbox)).toContainEqual({ tag: 'leave', payload: { entityId: leaver.entityId, leftGame: true } });
    expect(space.snapshotForPlayer(leaver.entityId)).toBeUndefined();
  });
});
