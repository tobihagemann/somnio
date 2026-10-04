import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, sectorView } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { SpaceActor } from '../src/world/spaceActor.ts';
import { collectMessages, entities } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { attachPlayer, makeCharacter, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

function actor(overrides: Partial<Sector> = {}) {
  const sector = makeSector('TestSector', overrides);
  return { sector, space: new SpaceActor(makeWorld([sector]), OUTDOOR_SPACE_ID, { logger: testLogger() }) };
}

describe('SpaceActor.attach', () => {
  it('streams enterSpace first and once, then the sector, the self entity, inventory, and energy', async () => {
    const { space } = actor();
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice', { worldSeconds: 1234.5 });
    const messages = await collectMessages(alice.outbox);
    expect(messages.map((message) => message.tag)).toEqual(['enterSpace', 'sector', 'entity', 'inventory', 'energy']);
    expect(messages[0]).toEqual({ tag: 'enterSpace', payload: { spaceId: OUTDOOR_SPACE_ID, selfId: alice.character.id, worldSeconds: 1234.5 } });
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
      },
    });
  });

  it('sends the sector as its client view, without the NPCs and spawns the server acts on', async () => {
    const { sector, space } = actor({ npcs: [makeNPC('guard', { x: 10, z: 10 }, 'Halt.')], monsterSpawns: [makeMonsterSpawn({ x: 15, z: 15 })] });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    const messages = await collectMessages(alice.outbox);
    expect(messages[1]).toEqual({ tag: 'sector', payload: { sector: sectorView(sector) } });
    expect(entities(messages)[1]).toMatchObject({ id: 'npc:TestSector/guard', kind: 'npc', radius: SOMNIO_CONSTANTS.npcRadius, x: 10, z: 10 });
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
    expect(() => space.attach(makeCharacter({ x: 2, z: 2 }), [], outbox, 0)).toThrow();
    expect(await collectMessages(outbox)).toEqual([]);
    expect(space.snapshotForCheckpoint()).toEqual([]);
  });

  it('refuses a position no sector of the space holds', () => {
    const { space } = actor();
    expect(() => space.attach(makeCharacter({ x: 25, z: 2 }), [], new ConnectionOutbox(1024), 0)).toThrow(/no sector/);
  });
});

describe('SpaceActor.detach', () => {
  it('tells the peers who left and why', async () => {
    const { space } = actor();
    const stayer = attachPlayer(space, { x: 1, z: 1 }, 'stayer');
    const leaver = attachPlayer(space, { x: 5, z: 5 }, 'leaver');
    space.detach(leaver.entityId, true);
    expect(await collectMessages(stayer.outbox)).toContainEqual({ tag: 'leave', payload: { entityId: leaver.entityId, leftGame: true } });
    expect(space.snapshotForPlayer(leaver.entityId)).toBeUndefined();
  });
});
