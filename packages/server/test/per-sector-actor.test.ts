import { describe, expect, it } from 'vitest';
import { WIRE_ENTITY_TYPE } from '@somnio/protocol';
import { TEMPO, headingFromCardinal, sectorToWire } from '@somnio/core';
import type { CollisionMask } from '@somnio/core';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { PerSectorActor } from '../src/world/perSectorActor.ts';
import { collectMessages, entities, serverPositions } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { makeCharacter, makeSector } from './support/sectorFactory.ts';

const south = headingFromCardinal('south');

function actor(masks: CollisionMask[] = [{ x: 3, y: 3, width: 1, height: 1 }]) {
  return new PerSectorActor(makeSector('TestSector', { collisionMasks: masks }), { logger: testLogger() });
}

function position(x: number, y: number, facing = south) {
  return { entityIndex: 0, x, y, facing, tempo: TEMPO.default };
}

describe('PerSectorActor', () => {
  it('handlePosition rejects coordinates outside sector bounds', () => {
    const sector = actor();
    const index = sector.attach(makeCharacter({ x: 1, y: 1 }), [], new ConnectionOutbox(1024));
    sector.handlePosition(position(-1, 0), index);
    expect(sector.snapshotForPlayer(index)?.character.position).toEqual({ x: 1, y: 1 });
    // An 8 x 8 tile sector spans 1024 px; the pixel extent itself is out of bounds.
    sector.handlePosition(position(1024, 0), index);
    expect(sector.snapshotForPlayer(index)?.character.position).toEqual({ x: 1, y: 1 });
  });

  it('handlePosition rejects a move whose feet box overlaps a collision mask', () => {
    // At (5, 5) the 32 x 48 sprite's feet box is (5, 37, 32, 16).
    const sector = actor([{ x: 5, y: 37, width: 32, height: 16 }]);
    const index = sector.attach(makeCharacter({ x: 1, y: 1 }), [], new ConnectionOutbox(1024));
    sector.handlePosition(position(5, 5), index);
    expect(sector.snapshotForPlayer(index)?.character.position).toEqual({ x: 1, y: 1 });
  });

  it('handlePosition accepts a move whose head, but not feet, would overlap a mask', () => {
    const sector = actor([{ x: 5, y: 5, width: 32, height: 16 }]);
    const index = sector.attach(makeCharacter({ x: 1, y: 1 }), [], new ConnectionOutbox(1024));
    sector.handlePosition(position(5, 5), index);
    expect(sector.snapshotForPlayer(index)?.character.position).toEqual({ x: 5, y: 5 });
  });

  it('handlePosition rejects a move whose feet box overlaps another player', () => {
    const sector = actor([]);
    sector.attach(makeCharacter({ x: 5, y: 5 }), [], new ConnectionOutbox(1024));
    const mover = sector.attach(makeCharacter({ x: 1, y: 1 }), [], new ConnectionOutbox(1024));
    sector.handlePosition(position(5, 5), mover);
    expect(sector.snapshotForPlayer(mover)?.character.position).toEqual({ x: 1, y: 1 });
  });

  it('handlePosition snaps the originating client back on a rejected move', async () => {
    const sector = actor([]);
    sector.attach(makeCharacter({ x: 5, y: 5 }), [], new ConnectionOutbox(1024));
    const moverOutbox = new ConnectionOutbox(1024);
    const mover = sector.attach(makeCharacter({ x: 1, y: 1 }), [], moverOutbox);
    sector.handlePosition(position(5, 5), mover);
    const snapBack = serverPositions(await collectMessages(moverOutbox)).find((frame) => frame.entityIndex === mover);
    expect(snapBack).toMatchObject({ x: 1, y: 1 });
  });

  it('handlePosition accepts bounded, non-colliding coordinates', async () => {
    const sector = actor();
    const outbox = new ConnectionOutbox(1024);
    const index = sector.attach(makeCharacter({ x: 1, y: 1 }), [], outbox);
    sector.handlePosition(position(5, 5, headingFromCardinal('east')), index);
    const snapshot = sector.snapshotForPlayer(index);
    expect(snapshot?.character.position).toEqual({ x: 5, y: 5 });
    expect(snapshot?.character.facing).toBe(headingFromCardinal('east'));
    const snapped = serverPositions(await collectMessages(outbox)).some((frame) => frame.entityIndex === index);
    expect(snapped).toBe(false);
  });

  /** A client may send any degree value; the stored and broadcast facing is the wrapped one. */
  it('handlePosition normalizes the facing before storing and broadcasting it', async () => {
    const sector = actor();
    const outbox = new ConnectionOutbox(1024);
    const peerOutbox = new ConnectionOutbox(1024);
    const index = sector.attach(makeCharacter({ x: 1, y: 1 }), [], outbox);
    sector.attach(makeCharacter({ x: 400, y: 400 }, 'peer'), [], peerOutbox);
    sector.handlePosition(position(5, 5, 450), index);
    expect(sector.snapshotForPlayer(index)?.character.facing).toBe(90);
    const relayed = serverPositions(await collectMessages(peerOutbox)).find((frame) => frame.entityIndex === index);
    expect(relayed?.facing).toBe(90);
    sector.handlePosition(position(6, 6, -90), index);
    expect(sector.snapshotForPlayer(index)?.character.facing).toBe(270);
  });

  it('attach streams the self-Entity between MainCharacter and Inventory on a no-peer sector', async () => {
    const sector = actor();
    const outbox = new ConnectionOutbox(1024);
    const character = makeCharacter({ x: 2, y: 2 });
    const index = sector.attach(character, [], outbox);
    const messages = await collectMessages(outbox);
    expect(messages.map((message) => message.tag)).toEqual(['enterSector', 'mainCharacter', 'entity', 'inventory', 'energy']);
    expect(messages[1]).toEqual({ tag: 'mainCharacter', payload: { entityIndex: index } });
    expect(messages[2]).toMatchObject({
      tag: 'entity',
      payload: { entityIndex: index, type: WIRE_ENTITY_TYPE.player, name: character.name, x: 2, y: 2 },
    });
  });

  it('attach emits enterSector equal to sectorToWire(sector)', async () => {
    const staticSector = makeSector('TestSector', { collisionMasks: [{ x: 3, y: 3, width: 1, height: 1 }] });
    const sector = new PerSectorActor(staticSector, { logger: testLogger() });
    const outbox = new ConnectionOutbox(1024);
    sector.attach(makeCharacter({ x: 2, y: 2 }), [], outbox);
    const [enterSector] = await collectMessages(outbox);
    expect(enterSector).toEqual({ tag: 'enterSector', payload: { sector: sectorToWire(staticSector) } });
  });

  it('attach with an existing peer emits one self-Entity to the newcomer and one newcomer-Entity to the peer', async () => {
    const sector = actor();
    const firstOutbox = new ConnectionOutbox(1024);
    const first = sector.attach(makeCharacter({ x: 1, y: 1 }), [], firstOutbox);
    const secondOutbox = new ConnectionOutbox(1024);
    const second = sector.attach(makeCharacter({ x: 5, y: 5 }), [], secondOutbox);
    const firstEntities = entities(await collectMessages(firstOutbox)).map((entity) => entity.entityIndex);
    const secondEntities = entities(await collectMessages(secondOutbox)).map((entity) => entity.entityIndex);
    expect(firstEntities).toEqual([first, second]);
    expect(secondEntities).toEqual([second, first]);
    expect(secondEntities).not.toContain(0);
  });

  it('entity indices are sector-local so a portal hop must propagate the new index', () => {
    const sectorA = actor();
    const sectorB = actor();
    sectorB.attach(makeCharacter({ x: 0, y: 0 }), [], new ConnectionOutbox(1024));
    const indexA = sectorA.attach(makeCharacter({ x: 0, y: 0 }), [], new ConnectionOutbox(1024));
    const indexB = sectorB.attach(makeCharacter({ x: 0, y: 0 }), [], new ConnectionOutbox(1024));
    expect(indexA).not.toBe(indexB);
  });
});
