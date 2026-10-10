import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import type { SayMessage, SpeechKind } from '@somnio/protocol';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import { seededRandom } from '../src/world/random.ts';
import { energy, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeNPC, makeSector, makeSectorLine, makeWorld } from './support/sectorFactory.ts';

const LINE = 'one two three four five six seven eight nine ten';
/** `LINE` crumbled by `speechSpace`'s seed, at a clarity of a half and of seven eighths. */
const CRUMBLED_AT_HALF = 'one two three ... five ... nine ...';
const CRUMBLED_THROUGH_DOOR = 'one two three ... five six seven eight nine ten';

/** The outdoor space over `sectors`, with the words a listener misses picked from a fixed seed. */
function speechSpace(sectors: Sector[] = makeSectorLine()) {
  return makeClockedSpace(makeWorld(sectors), OUTDOOR_SPACE_ID, { speechRandom: seededRandom(7) });
}

async function heard(outbox: ConnectionOutbox): Promise<SayMessage[]> {
  return payloads(await collectMessages(outbox), 'serverSay');
}

function say(text: string, kind: SpeechKind = 'say') {
  return { text, kind };
}

describe('speech carries by distance', () => {
  it('is heard whole within its clear radius, crumbled in the band, and not at all past it, by everyone but the speaker', async () => {
    const { space } = speechSpace();
    const speaker = attachPlayer(space, { x: 5, z: 10 }, 'alice');
    const near = attachPlayer(space, { x: 10, z: 10 }, 'near');
    const band = attachPlayer(space, { x: 14, z: 10 }, 'band');
    const far = attachPlayer(space, { x: 18, z: 10 }, 'far');

    space.handleSay(say(LINE), speaker.entityId);

    expect(await heard(near.outbox)).toEqual([{ entityId: speaker.entityId, name: 'alice', kind: 'say', text: LINE, clarity: 1, x: 5, z: 10 }]);
    expect(await heard(band.outbox)).toEqual([{ entityId: speaker.entityId, name: 'alice', kind: 'say', text: CRUMBLED_AT_HALF, clarity: 0.5, x: 5, z: 10 }]);
    expect(await heard(far.outbox)).toEqual([]);
    expect(await heard(speaker.outbox)).toEqual([]);
  });

  /** Pooling what several listeners heard of one line gives back no more than the clearest of them heard. */
  it('crumbles one line the same way for everyone: further off misses every word missed nearer', async () => {
    const { space } = speechSpace();
    const speaker = attachPlayer(space, { x: 5, z: 10 });
    const listeners = [12, 14, 14, 16].map((x) => attachPlayer(space, { x, z: 10 }));

    space.handleSay(say(LINE), speaker.entityId);

    const [nearer, beside, besideToo, further] = await Promise.all(
      listeners.map(async ({ outbox }) => new Set((await heard(outbox))[0]!.text.split(' ').filter((word) => word !== '...'))),
    );
    expect(besideToo).toEqual(beside);
    expect([...further!].every((word) => beside!.has(word))).toBe(true);
    expect([...beside!].every((word) => nearer!.has(word))).toBe(true);
    expect([nearer!.size, beside!.size, further!.size]).toEqual([8, 5, 2]);
  });

  it('carries a whisper to 3 m, whole within 1.5 m', async () => {
    const { space } = speechSpace();
    const speaker = attachPlayer(space, { x: 5, z: 10 });
    const listeners = [1, 2, 4].map((metres) => attachPlayer(space, { x: 5 + metres, z: 10 }));

    space.handleSay(say('psst', 'whisper'), speaker.entityId);

    const clarities = await Promise.all(listeners.map(async ({ outbox }) => (await heard(outbox)).map((line) => line.clarity)));
    expect(clarities[0]).toEqual([1]);
    expect(clarities[1]![0]).toBeCloseTo(2 / 3, 12);
    expect(clarities[2]).toEqual([]);
  });

  /** West and East are no neighbours, so neither is sent the other's sector. */
  it('carries a yell whole between sectors that do not touch', async () => {
    const { space } = speechSpace();
    const speaker = attachPlayer(space, { x: 15, z: 10 });
    const listener = attachPlayer(space, { x: 45, z: 10 });

    space.handleSay(say('Hilfe!', 'yell'), speaker.entityId);

    expect(await heard(listener.outbox)).toMatchObject([{ kind: 'yell', text: 'Hilfe!', clarity: 1 }]);
  });

  it('carries a yell to 80 m, crumbling past 40 m', async () => {
    const { space } = speechSpace([makeSector('Long', { size: { width: 100, depth: 20 } })]);
    const speaker = attachPlayer(space, { x: 5, z: 10 });
    const band = attachPlayer(space, { x: 65, z: 10 });
    const far = attachPlayer(space, { x: 90, z: 10 });

    space.handleSay(say(LINE, 'yell'), speaker.entityId);

    expect(await heard(band.outbox)).toMatchObject([{ kind: 'yell', clarity: 0.5 }]);
    expect(await heard(far.outbox)).toEqual([]);
  });

  it('lets a fallen dreamer call for help', async () => {
    const { space } = speechSpace();
    const fallen = attachPlayer(space, { x: 5, z: 10 }, 'fallen', { character: { energy: energy({ healthCurrent: 0 }) } });
    const listener = attachPlayer(space, { x: 30, z: 10 });

    space.handleSay(say('Hilfe!', 'yell'), fallen.entityId);

    expect(await heard(listener.outbox)).toMatchObject([{ entityId: fallen.entityId, text: 'Hilfe!' }]);
  });

  it('lets an NPC talk like a dreamer: whole to the one it greets, crumbled to a bystander, and unheard further off', async () => {
    const guard: Point = { x: 10, z: 10 };
    const { space } = speechSpace(makeSectorLine({ west: { npcs: [makeNPC('guard', guard, 'Hello, $name, and welcome to the town.')] } }));
    const greeted = attachPlayer(space, { x: 10, z: 11.5 }, 'alice');
    const bystander = attachPlayer(space, { x: 19, z: 10 });
    const far = attachPlayer(space, { x: 23, z: 10 });

    space.step(0.05);

    expect(await heard(greeted.outbox)).toEqual([
      { entityId: 'npc:West/guard', name: 'test-npc', kind: 'say', text: 'Hello, alice, and welcome to the town.', clarity: 1, ...guard },
    ]);
    const crumbled = await heard(bystander.outbox);
    expect(crumbled).toHaveLength(1);
    expect(crumbled[0]!.clarity).toBe(0.5);
    expect(crumbled[0]!.text).toContain('...');
    expect(await heard(far.outbox)).toEqual([]);
  });
});

describe('a yell heard through a door', () => {
  it('comes out of the doorway by the shortest way, crumbled by the way plus the distance, naming the yeller', async () => {
    const { space } = speechSpace();
    const nearer = attachPlayer(space, { x: 14, z: 10 });
    const other = attachPlayer(space, { x: 5, z: 10 });

    space.hearThroughDoors({ voice: { entityId: 'saibot', name: 'Saibot', kind: 'yell', text: LINE }, rolls: [] }, [
      { spaceId: OUTDOOR_SPACE_ID, source: { x: 5, z: 10 }, baseMetres: 50 },
      { spaceId: OUTDOOR_SPACE_ID, source: { x: 15, z: 10 }, baseMetres: 44 },
    ]);

    expect(await heard(nearer.outbox)).toEqual([
      { entityId: 'saibot', name: 'Saibot', kind: 'yell', text: CRUMBLED_THROUGH_DOOR, clarity: 0.875, x: 15, z: 10 },
    ]);
    expect(await heard(other.outbox)).toMatchObject([{ clarity: 0.75, x: 5, z: 10 }]);
  });
});
