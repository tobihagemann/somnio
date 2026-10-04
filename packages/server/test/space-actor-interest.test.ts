import { describe, expect, it } from 'vitest';
import type { SomnioMessage } from '@somnio/protocol';
import type { Sector } from '@somnio/core';
import { collectMessages, entities, entityMoves } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeSectorLine, makeWorld } from './support/sectorFactory.ts';

/** West (x 0 to 20), Middle (20 to 40), East (40 to 60): West and East are not neighbours. */
function line(overrides: { east?: Partial<Sector> } = {}) {
  const { clock, space } = makeClockedSpace(makeWorld(makeSectorLine(overrides)));
  const join = (name: string, x: number) => attachPlayer(space, { x, z: 10 }, name);
  /** Walks along z = 10 in accepted moves, a second of clock apart. */
  const walk = (entityId: string, toX: number) => {
    let x = space.snapshotForPlayer(entityId)!.character.position.x;
    while (x !== toX) {
      x = toX > x ? Math.min(x + 1.5, toX) : Math.max(x - 1.5, toX);
      clock.ms += 1000;
      space.handleMove({ x, z: 10, facing: 0, gait: 'jog' }, entityId);
    }
  };
  return { clock, space, join, walk };
}

function sectorNames(messages: readonly SomnioMessage[]): string[] {
  return messages.flatMap((message) => (message.tag === 'sector' ? [message.payload.sector.name] : []));
}

/** The `entity` and `leave` frames about one entity, in order. */
function sightings(messages: readonly SomnioMessage[], entityId: string): string[] {
  return messages.flatMap((message) => {
    if (message.tag === 'entity' && message.payload.id === entityId) return ['entity'];
    if (message.tag === 'leave' && message.payload.entityId === entityId) return [`leave:${message.payload.leftGame}`];
    return [];
  });
}

describe('interest on a line of three sectors', () => {
  it('a join is sent its own sector and the neighbours, and the entities standing in them', async () => {
    const { join } = line();
    const far = join('far', 45);
    const near = join('near', 25);
    const watcher = join('watcher', 5);
    const messages = await collectMessages(watcher.outbox);
    expect(sectorNames(messages)).toEqual(['West', 'Middle']);
    expect(entities(messages).map((entity) => entity.id)).toEqual([watcher.entityId, near.entityId]);
    // The far player never hears of the watcher either.
    expect(sightings(await collectMessages(far.outbox), watcher.entityId)).toEqual([]);
  });

  it('a stationary observer gets entity when a player crosses from the third sector into the second, and leave when it crosses back', async () => {
    const { space, join, walk } = line();
    const observer = join('observer', 5);
    const walker = join('walker', 42);
    walk(walker.entityId, 39);
    space.flushMoves();
    walk(walker.entityId, 42);
    space.flushMoves();
    const messages = await collectMessages(observer.outbox);
    expect(sightings(messages, walker.entityId)).toEqual(['entity', 'leave:false']);
    expect(entities(messages).find((entity) => entity.id === walker.entityId)).toMatchObject({ x: 39, z: 10 });
    // Its moves reach the observer only while it is in view.
    expect(entityMoves(messages)).toEqual([{ id: walker.entityId, x: 39, z: 10, facing: 0, gait: 'jog' }]);
  });

  it('a stationary observer gets entity when a monster crosses from the third sector into the second, and leave when it crosses back', async () => {
    const { clock, space, join, walk } = line({ east: { monsterSpawns: [makeMonsterSpawn({ x: 1, z: 10 })] } });
    const observer = join('observer', 5);
    const bait = join('bait', 38.5);
    clock.ms = 60_000;
    space.step(0);
    // The monster stands at x 41 in East and chases the bait west across the border.
    for (let pass = 0; pass < 20; pass += 1) space.step(0.05);
    // The bait walks east through it, and the monster follows back.
    walk(bait.entityId, 42.5);
    for (let pass = 0; pass < 30; pass += 1) space.step(0.05);
    expect(sightings(await collectMessages(observer.outbox), 'monster:1')).toEqual(['entity', 'leave:false']);
    expect(sightings(await collectMessages(bait.outbox), 'monster:1')).toEqual(['entity']);
  });

  it('a player who walks to the third sector and back is sent the first sector again', async () => {
    const { join, walk } = line();
    const stayer = join('stayer', 5);
    const walker = join('walker', 18.5);
    walk(walker.entityId, 41);
    walk(walker.entityId, 38);
    const messages = await collectMessages(walker.outbox);
    expect(sectorNames(messages)).toEqual(['West', 'Middle', 'East', 'West']);
    // The player left behind in the first sector goes out of view and comes back with it.
    expect(sightings(messages, stayer.entityId)).toEqual(['entity', 'leave:false', 'entity']);
    expect(sightings(await collectMessages(stayer.outbox), walker.entityId)).toEqual(['entity', 'leave:false', 'entity']);
  });
});
