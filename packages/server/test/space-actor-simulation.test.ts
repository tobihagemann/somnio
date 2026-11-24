import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE,
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  distance,
  headingFromCardinal,
  headingFromVector,
  headingRadians,
  monsterKind,
  reachDistance,
  rectContains,
  sectorPointInSpace,
  sectorRect,
  spawnArea,
} from '@somnio/core';
import type { DialogStep, Point, QuestLog, Sector } from '@somnio/core';
import type { Service, SomnioMessage } from '@somnio/protocol';
import registryJSON from '@somnio/core/data/ModelRegistry.json' with { type: 'json' };
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import { DEV_SECTORS_DIRECTORY } from '../src/config.ts';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import { loadSectorCache, loadWorld } from '../src/sectors/sectorCache.ts';
import { seededRandom } from '../src/world/random.ts';
import type { RandomSource } from '../src/world/random.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import type { SpaceActorOptions } from '../src/world/spaceActor.ts';
import { CUDGEL, GHOST, RESPAWN_MS, characterOf, energy, engage, face, lucidity, payloads, wearing } from './support/combat.ts';
import { collectMessages, entities, entityMoves, recordingOutbox, serverSays } from './support/frames.ts';
import {
  attachPlayer,
  landsAtCentre,
  makeClockedSpace,
  makeMonsterGround,
  makeMonsterSpawn,
  makeNPC,
  makeSector,
  makeSectorLine,
  makeWorld,
  unconditionalSteps,
} from './support/sectorFactory.ts';
import type { AttachPlayerOptions } from './support/sectorFactory.ts';

/** One 20 x 20 m sector on a clock the test advances. */
function actor(overrides: Partial<Sector> = {}, options: Partial<SpaceActorOptions> = {}) {
  return makeClockedSpace(makeWorld([makeSector('TestSector', overrides)]), OUTDOOR_SPACE_ID, options);
}

async function monstersSeen(outbox: ConnectionOutbox) {
  return entities(await collectMessages(outbox)).filter((entity) => entity.kind === 'monster');
}

describe('NPC dialog', () => {
  /** Pugnax's carrier id, which Libus's errand counts a visit to. */
  const PUGNAX = 'npc:EdariaFighterHall/pugnax';
  const NEAR: Point = { x: 10, z: 11.2 };
  const AWAY: Point = { x: 10, z: 12.7 };
  /** Within speaking distance of the NPC too, beside `NEAR`. */
  const BESIDE: Point = { x: 10.8, z: 10.9 };
  /** In the dialog catalog, 56 graphemes in English and 75 in German, so it is held for the German's 6 s where the English reads in 4.73 s. */
  const HEALER_LORE = 'Only a Healer draws back the fallen. Leave no one lying.';
  const LORE_READ_MS = 6000;
  /** Read in 3.67 s, in either language, since the catalog does not hold it. */
  const FORTY = 'Forty graphemes, held under four seconds';
  const OFFER: DialogStep = { text: 'Drive off a nightmare first.', when: { quest: 'fighter-trial', state: 'offered' } };
  const OFFER_AGAIN: DialogStep = { text: 'Well? Drive one off.', when: { quest: 'fighter-trial', state: 'offered' } };
  const HELD: DialogStep = { text: 'Has a nightmare fled from you yet?', when: { quest: 'fighter-trial', state: 'held' } };
  const OWN: DialogStep = { text: 'Guard up, $name.', when: { role: 'own' } };
  const GRAVES: DialogStep = { text: 'The graves are restless.', when: { quest: 'restless-graves', state: 'held' } };
  const NEWCOMER: AttachPlayerOptions['character'] = {};
  const FIGHTER: AttachPlayerOptions['character'] = { lucidity: lucidity('fighter'), quests: { active: [], done: ['fighter-trial'] } };
  const ON_THE_ERRAND: QuestLog = { active: [{ questId: 'newcomer-errand', progress: [0, 0, 0, 0, 0] }], done: [] };

  /** Pugnax's hall: one 20 x 20 m sector with an NPC at (10, 10) as Pugnax, a master of Fighters unless `service` says otherwise. `at` sets the clock and steps the space. */
  function hall(script: Parameters<typeof makeNPC>[2], service: Service | undefined = 'fighterMaster') {
    const world = makeWorld([makeSector('EdariaFighterHall', { npcs: [makeNPC('pugnax', { x: 10, z: 10 }, script, service)] })]);
    const { clock, space } = makeClockedSpace(world);
    const at = (ms: number): void => {
      clock.ms = ms;
      space.step(0.05);
    };
    return { world, space, at };
  }

  /** Attaches a dreamer at `point`, and reads every NPC line they have heard so far, as often as asked. */
  function listener(space: SpaceActor, point: Point, name: string, options: AttachPlayerOptions = {}) {
    const recording = recordingOutbox();
    const player = attachPlayer(space, point, name, { ...options, outbox: recording.outbox });
    return { ...player, heard: () => serverSays(recording.sent) };
  }

  function moveTo(space: SpaceActor, point: Point, entityId: string): void {
    space.handleMove({ ...point, facing: 0, gait: 'jog' }, entityId);
  }

  it('greets a dreamer who comes within speaking distance with its greeting, once', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('Follow up.') });
    const alice = listener(space, AWAY, 'alice');
    at(0);
    moveTo(space, NEAR, alice.entityId);
    at(0);
    at(10_000);
    expect(alice.heard()).toEqual(['Hello, alice.']);
  });

  it('greets a dreamer again who walked away and came back, but not within the greeting pause', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.' });
    const alice = listener(space, NEAR, 'alice');
    let ms = 0;
    const walk = (to: Point): void => {
      ms += 2000;
      moveTo(space, to, alice.entityId);
      at(ms);
    };
    at(0);
    walk(AWAY);
    walk(NEAR);
    walk(AWAY);
    ms += SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000;
    walk(NEAR);
    expect(alice.heard()).toEqual(['Hello, alice.', 'Hello, alice.']);
  });

  it('greets a dreamer who stays beside it once, however long they stay', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.' });
    const alice = listener(space, NEAR, 'alice');
    at(0);
    at(2 * SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000);
    expect(alice.heard()).toEqual(['Hello, alice.']);
  });

  it('greets a dreamer back in the space under the same id before its next step as one who just came', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.' });
    const alice = listener(space, NEAR, 'alice');
    at(0);
    const { checkpoint, transient } = space.handOver(alice.entityId, false)!;
    space.attach(checkpoint.character, checkpoint.inventory, alice.outbox, 0, 'en', transient);
    // "Hello, alice." is read in the least time, 3 s.
    at(3000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'Hello, alice.']);
  });

  it('greets arrivals one at a time, a greeting held for its reading time', () => {
    const { space, at } = hall({ greeting: 'Hello, $name. Mind the step, and the guard who keeps it.' });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    at(0);
    // 56 graphemes, read in 4.73 s.
    at(4733);
    expect(bob.heard()).toEqual(['Hello, alice. Mind the step, and the guard who keeps it.']);
    at(4734);
    expect(alice.heard()).toEqual(['Hello, alice. Mind the step, and the guard who keeps it.', 'Hello, bob. Mind the step, and the guard who keeps it.']);
  });

  it.each([
    ['a newcomer the trial is offered to', NEWCOMER, OFFER.text],
    ['a Fighter who passed the trial', FIGHTER, 'Guard up, alice.'],
  ])('says to %s only the steps that fit them, and then ends the conversation', (_, character, step) => {
    const { space, at } = hall({ dialog: [OFFER, OWN] });
    const alice = listener(space, NEAR, 'alice', { character });
    space.handleInteract(PUGNAX, alice.entityId);
    for (let ms = 0; ms <= 20_000; ms += 1000) at(ms);
    expect(alice.heard()).toEqual([step]);
  });

  it('says the step that fits a dreamer who took a quest on since the step before', () => {
    const { space, at } = hall({ dialog: [OFFER, OFFER_AGAIN, HELD] });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    space.handleAcceptQuest(PUGNAX, 'fighter-trial', alice.entityId);
    for (let ms = 1000; ms <= 20_000; ms += 1000) at(ms);
    expect(alice.heard()).toEqual([OFFER.text, HELD.text]);
  });

  it('ends the conversation, saying nothing, once no step left fits a dreamer who took a quest on, and answers the next who asks', () => {
    const { space, at } = hall({ dialog: [OFFER, OFFER_AGAIN] });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    space.handleAcceptQuest(PUGNAX, 'fighter-trial', alice.entityId);
    for (let ms = 1000; ms <= 20_000; ms += 1000) at(ms);
    expect(alice.heard()).toEqual([OFFER.text]);
    space.handleInteract(PUGNAX, bob.entityId);
    at(21_000);
    expect(bob.heard()).toEqual([OFFER.text, OFFER.text]);
  });

  it("holds its next step for the reading time of the step's longest translation", () => {
    const { space, at } = hall({ dialog: unconditionalSteps(HEALER_LORE, FORTY, 'Third.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(LORE_READ_MS - 1);
    expect(alice.heard()).toEqual([HEALER_LORE]);
    at(LORE_READ_MS);
    expect(alice.heard()).toEqual([HEALER_LORE, FORTY]);
    at(LORE_READ_MS + 3666);
    expect(alice.heard()).toEqual([HEALER_LORE, FORTY]);
    at(LORE_READ_MS + 3667);
    expect(alice.heard()).toEqual([HEALER_LORE, FORTY, 'Third.']);
  });

  it('says the next step 1 s after the last when the dreamer it said it to asks again', () => {
    const { space, at } = hall({ dialog: unconditionalSteps(HEALER_LORE, 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(500);
    space.handleInteract(PUGNAX, alice.entityId);
    at(999);
    expect(alice.heard()).toEqual([HEALER_LORE]);
    at(1000);
    expect(alice.heard()).toEqual([HEALER_LORE, 'Second.']);
  });

  it('leaves the conversation as it was when another dreamer asks, and counts their ask as a visit', () => {
    const { space, at } = hall({ dialog: unconditionalSteps(HEALER_LORE, 'Then you, $name.') });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob', { character: { quests: ON_THE_ERRAND } });
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(500);
    space.handleInteract(PUGNAX, bob.entityId);
    expect(characterOf(space, bob.entityId).quests.active[0]!.progress).toEqual([0, 0, 1, 0, 0]);
    at(1000);
    at(LORE_READ_MS - 1);
    expect(bob.heard()).toEqual([HEALER_LORE]);
    at(LORE_READ_MS);
    expect(bob.heard()).toEqual([HEALER_LORE, 'Then you, alice.']);
  });

  it('says the next step 1 s after the last to the dreamer who asked for it when another dreamer asks in between', () => {
    const { space, at } = hall({ dialog: unconditionalSteps(HEALER_LORE, 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(500);
    space.handleInteract(PUGNAX, alice.entityId);
    at(750);
    space.handleInteract(PUGNAX, bob.entityId);
    at(1000);
    expect(alice.heard()).toEqual([HEALER_LORE, 'Second.']);
  });

  it('greets a dreamer who asks before it has greeted them, says their first step 1 s later, and greets them no more', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('First.') });
    const alice = listener(space, AWAY, 'alice');
    moveTo(space, NEAR, alice.entityId);
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    expect(alice.heard()).toEqual(['Hello, alice.']);
    at(999);
    expect(alice.heard()).toEqual(['Hello, alice.']);
    at(1000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'First.']);
    for (let ms = 2000; ms <= 20_000; ms += 1000) at(ms);
    expect(alice.heard()).toEqual(['Hello, alice.', 'First.']);
  });

  it('greets a dreamer it greeted because they asked no more when they walk away and come back within the greeting pause, and answers their next ask with a step', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('First.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(1000);
    moveTo(space, AWAY, alice.entityId);
    at(3000);
    moveTo(space, NEAR, alice.entityId);
    at(5000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'First.']);
    space.handleInteract(PUGNAX, alice.entityId);
    at(6000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'First.', 'First.']);
  });

  it('stays free when no step fits the dreamer who asks, counting the ask as their visit', () => {
    const { space, at } = hall({ dialog: [OWN] });
    const healer = listener(space, NEAR, 'hilde', { character: { lucidity: lucidity('healer'), quests: { ...ON_THE_ERRAND, done: ['healer-trial'] } } });
    const fighter = listener(space, BESIDE, 'bruno', { character: FIGHTER });
    space.handleInteract(PUGNAX, healer.entityId);
    expect(characterOf(space, healer.entityId).quests.active[0]!.progress).toEqual([0, 0, 1, 0, 0]);
    space.handleInteract(PUGNAX, fighter.entityId);
    at(0);
    expect(fighter.heard()).toEqual(['Guard up, bruno.']);
  });

  it.each([
    ['its last step', unconditionalSteps(HEALER_LORE)],
    ['its last step that fits her', [{ text: HEALER_LORE }, GRAVES]],
  ])('answers the next dreamer who asks after it said %s to another only once that step has been read', (_, dialog) => {
    const { space, at } = hall({ dialog });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(100);
    space.handleInteract(PUGNAX, bob.entityId);
    at(200);
    space.handleInteract(PUGNAX, bob.entityId);
    at(1000);
    at(LORE_READ_MS - 1);
    expect(bob.heard()).toEqual([HEALER_LORE]);
    at(LORE_READ_MS);
    expect(bob.heard()).toEqual([HEALER_LORE, HEALER_LORE]);
  });

  it('holds a greeting for the reading time of a step its target asked to skip and then walked away from', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps(HEALER_LORE, 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(1000);
    expect(alice.heard()).toEqual(['Hello, alice.', HEALER_LORE]);
    const bob = listener(space, BESIDE, 'bob');
    at(1500);
    space.handleInteract(PUGNAX, alice.entityId);
    at(1800);
    moveTo(space, AWAY, alice.entityId);
    at(2000);
    at(1000 + LORE_READ_MS - 1);
    expect(bob.heard()).toEqual([]);
    at(1000 + LORE_READ_MS);
    expect(bob.heard()).toEqual(['Hello, bob.']);
  });

  it('holds the greeting to a dreamer who walked out of speaking distance and back and asks again for the reading time of its step to them', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps(HEALER_LORE, 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(1000);
    moveTo(space, AWAY, alice.entityId);
    at(1500);
    moveTo(space, NEAR, alice.entityId);
    at(2000);
    space.handleInteract(PUGNAX, alice.entityId);
    at(3000);
    at(1000 + LORE_READ_MS - 1);
    expect(alice.heard()).toEqual(['Hello, alice.', HEALER_LORE]);
    at(1000 + LORE_READ_MS);
    expect(alice.heard()).toEqual(['Hello, alice.', HEALER_LORE, 'Hello, alice.']);
  });

  it('says the first step 1 s after the greeting to the dreamer it greeted who asks, and holds it for anyone else for the greeting', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('First, $name.') });
    const alice = listener(space, NEAR, 'alice');
    at(0);
    at(500);
    space.handleInteract(PUGNAX, alice.entityId);
    at(999);
    expect(alice.heard()).toEqual(['Hello, alice.']);
    at(1000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'First, alice.']);
  });

  it("holds the first reply to a dreamer it did not greet for the greeting's reading time", () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('First, $name.') });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    at(0);
    at(500);
    space.handleInteract(PUGNAX, bob.entityId);
    // "Hello, alice." is read in the least time, 3 s.
    at(2999);
    expect(bob.heard()).toEqual(['Hello, alice.']);
    at(3000);
    expect(bob.heard()).toEqual(['Hello, alice.', 'Hello, bob.']);
    at(4000);
    expect(alice.heard()).toEqual(['Hello, alice.', 'Hello, bob.', 'First, bob.']);
  });

  it("says a bystander the line meant for the dreamer who asked, in the bystander's language", () => {
    const { space, at } = hall({ dialog: [{ text: 'Be welcome, $name. The Moonstone takes what it gives.', when: { role: 'own' } }] });
    const fighter = listener(space, NEAR, 'bruno', { character: FIGHTER });
    // 4 m off, inside a said line's clear radius.
    const healer = listener(space, { x: 14, z: 10 }, 'hilde', { character: { lucidity: lucidity('healer') }, locale: 'de' });
    space.handleInteract(PUGNAX, fighter.entityId);
    at(0);
    expect(fighter.heard()).toEqual(['Be welcome, bruno. The Moonstone takes what it gives.']);
    expect(healer.heard()).toEqual(['Sei willkommen, bruno. Der Mondstein nimmt, was er gibt.']);
  });

  it('drops an interact from beyond speaking distance and one at anything but a carrier', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.', dialog: unconditionalSteps('Follow up.') });
    const far = listener(space, { x: 10, z: 12.1 }, 'far');
    const near = listener(space, NEAR, 'near');
    space.handleInteract(PUGNAX, far.entityId);
    space.handleInteract(far.entityId, near.entityId);
    space.handleInteract('npc:EdariaFighterHall/nobody', near.entityId);
    at(0);
    at(10_000);
    expect(near.heard()).toEqual(['Hello, near.']);
  });

  it('has nothing to go on with when its greeting is all it has', () => {
    const { space, at } = hall({ greeting: 'Hello, $name.' });
    const alice = listener(space, NEAR, 'alice');
    at(0);
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(10_000);
    expect(alice.heard()).toEqual(['Hello, alice.']);
  });

  it('ends the conversation when its target walks out of speaking distance, so their next ask starts at the first step', () => {
    const { space, at } = hall({ dialog: unconditionalSteps('First.', 'Second.', 'Third.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    moveTo(space, AWAY, alice.entityId);
    at(1000);
    moveTo(space, NEAR, alice.entityId);
    at(2000);
    space.handleInteract(PUGNAX, alice.entityId);
    at(3000);
    expect(alice.heard()).toEqual(['First.', 'First.']);
  });

  it('ends the conversation when its target leaves the space, and answers a dreamer who asks before the next step', () => {
    const { space, at } = hall({ dialog: unconditionalSteps('First.', 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    const bob = listener(space, BESIDE, 'bob');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    space.handOver(alice.entityId, false);
    space.handleInteract(PUGNAX, bob.entityId);
    at(100);
    expect(bob.heard()).toEqual(['First.']);
    at(3000);
    expect(bob.heard()).toEqual(['First.', 'First.']);
  });

  it('ends the conversation when its target leaves the space, so one back before the next step hears no step they asked for early', () => {
    const { space, at } = hall({ dialog: unconditionalSteps(HEALER_LORE, 'Second.') });
    const alice = listener(space, NEAR, 'alice');
    space.handleInteract(PUGNAX, alice.entityId);
    at(0);
    at(500);
    space.handleInteract(PUGNAX, alice.entityId);
    const { checkpoint, transient } = space.handOver(alice.entityId, false)!;
    space.attach(checkpoint.character, checkpoint.inventory, alice.outbox, 0, 'en', transient);
    for (let ms = 1000; ms <= 20_000; ms += 1000) at(ms);
    expect(alice.heard()).toEqual([HEALER_LORE]);
  });

  it('starts at the first step in a space actor built over the same world after another advanced its conversation', () => {
    const script = { dialog: unconditionalSteps('First.', 'Second.') };
    const first = hall(script);
    const alice = listener(first.space, NEAR, 'alice');
    first.space.handleInteract(PUGNAX, alice.entityId);
    first.at(0);
    expect(alice.heard()).toEqual(['First.']);
    const { space } = makeClockedSpace(first.world);
    const bob = listener(space, NEAR, 'bob');
    space.handleInteract(PUGNAX, bob.entityId);
    space.step(0.05);
    expect(bob.heard()).toEqual(['First.']);
  });
});

describe('monster spawn cadence', () => {
  it('no monster exists at boot, and one spawns once the respawn time has passed on the clock', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })] });
    const early = attachPlayer(space, { x: 2, z: 2 }, 'early');
    clock.ms = RESPAWN_MS - 1;
    space.step(0.05);
    const late = attachPlayer(space, { x: 18, z: 18 }, 'late');
    clock.ms = RESPAWN_MS;
    space.step(0.05);
    const kind = monsterKind('ghost');
    const spawned = { id: 'monster:1', kind: 'monster', characterModelId: kind.characterModelId, name: kind.name, radius: kind.radius, x: 10, z: 10 };
    expect(await monstersSeen(early.outbox)).toMatchObject([spawned]);
    expect(await monstersSeen(late.outbox)).toMatchObject([spawned]);
  });

  it('a spawn never keeps more than maxAlive monsters', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 5, z: 5 }, 10, 3)] }, { random: seededRandom(7) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    for (let pass = 1; pass <= 10; pass += 1) {
      clock.ms = pass * RESPAWN_MS;
      space.step(0);
    }
    expect((await monstersSeen(alice.outbox)).map((monster) => monster.id)).toEqual(['monster:1', 'monster:2', 'monster:3']);
  });

  it('a spawned monster is placed clear of blockers', async () => {
    // The west half of the area is under a blocker.
    const blocker = { id: 'slab', x: 8, z: 8, width: 2, depth: 4 };
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 8, z: 8 }, 4)], blockers: [blocker] }, { random: seededRandom(3) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    clock.ms = RESPAWN_MS;
    space.step(0);
    const [monster] = await monstersSeen(alice.outbox);
    expect(monster!.x).toBeGreaterThanOrEqual(blocker.x + blocker.width + monster!.radius);
  });

  it('places a monster inside an area whose size has a fraction of a centimetre', async () => {
    const area = { ...makeMonsterSpawn({ x: 2, z: 2 }), width: 5.765, depth: 5.765 };
    // 5.765 m rounds to 577 cm, and this is the last draw of that range.
    const { clock, space } = actor({ monsterSpawns: [area] }, { random: { nextUInt32: () => 577 } });
    const alice = attachPlayer(space, { x: 18, z: 18 }, 'alice');
    clock.ms = RESPAWN_MS;
    space.step(0);
    const [monster] = await monstersSeen(alice.outbox);
    expect(monster!.x).toBeLessThanOrEqual(area.x + area.width);
    expect(monster!.z).toBeLessThanOrEqual(area.z + area.depth);
  });

  /**
   * The Graveyard's skeletons are what a dreamer drives off outdoors there, so its spawns must place
   * them, among its graves: every point of either area lies within 2.8 m of a grave (2.79 m at the
   * farthest).
   */
  it("spawns Skeletons and Skeleton Warriors among the committed Graveyard's graves", async () => {
    const world = loadWorld(loadSectorCache(DEV_SECTORS_DIRECTORY), registryJSON);
    const graveyard = world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.find((sector) => sector.name === 'Graveyard')!;
    const { clock, space } = makeClockedSpace(world, OUTDOOR_SPACE_ID, { random: seededRandom(5) });
    for (let pass = 1; pass <= 4; pass += 1) {
      clock.ms = pass * monsterKind('skeleton-warrior').respawnSeconds * 1000;
      space.step(0);
    }
    const seen = (await monstersSeen(attachPlayer(space, sectorPointInSpace(graveyard, { x: 36, z: 20.4 }), 'watcher').outbox)).filter((monster) =>
      rectContains(sectorRect(graveyard), monster),
    );
    const names = Object.fromEntries(graveyard.monsterSpawns.map((spawn) => [monsterKind(spawn.kind).name, spawn]));
    expect(seen.map((monster) => monster.name).toSorted()).toEqual(['Skeleton', 'Skeleton', 'Skeleton', 'Skeleton', 'Skeleton Warrior', 'Skeleton Warrior']);
    const graves = graveyard.placements.filter((placement) => placement.modelId.startsWith('grave')).map((grave) => sectorPointInSpace(graveyard, grave));
    for (const monster of seen) {
      expect(rectContains(spawnArea(graveyard, names[monster.name]!), monster), monster.id).toBe(true);
      expect(Math.min(...graves.map((grave) => distance(grave, monster))), monster.id).toBeLessThan(2.8);
    }
  });

  it('a blocked spawn point keeps the timer due and spawns once it frees', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })] });
    const observer = attachPlayer(space, { x: 2, z: 2 }, 'observer');
    const blocker = attachPlayer(space, { x: 10, z: 10 }, 'blocker');
    clock.ms = RESPAWN_MS;
    space.step(0);
    space.handOver(blocker.entityId, false);
    space.step(0);
    expect(await monstersSeen(observer.outbox)).toHaveLength(1);
  });
});

describe('monster aggro and chase', () => {
  const HOME: Point = { x: 10, z: 10 };
  /** Outside every area and aggro radius here, where a watcher joins. */
  const AFAR: Point = { x: 1, z: 19 };
  const FALLEN = { character: { energy: energy({ healthCurrent: 0 }) } };
  const REACH = reachDistance(monsterKind('ghost').radius);
  const STRIDE = monsterKind('ghost').chaseMetresPerSecond * 0.05;
  const STROLL_STRIDE = monsterKind('ghost').strollMetresPerSecond * 0.05;
  const WEST = headingFromVector(-1, 0);
  /** A Fighter whose Cleave lands a share of a cudgel swing, little enough to leave a Ghost standing. */
  const CLEAVER = { character: { lucidity: lucidity('fighter', { strike: 1, cleave: 1 }) }, inventory: wearing(CUDGEL) };

  type Steps = (count: number, each?: () => void) => void;

  /** Runs `count` steps of 50 ms on the clock, calling `each` before every one. */
  function stepper(clock: { ms: number }, space: SpaceActor): Steps {
    return (count, each = () => {}) => {
      for (let index = 0; index < count; index += 1) {
        clock.ms += 50;
        each();
        space.step(0.05);
      }
    };
  }

  /**
   * A space whose one monster already stands at (10, 10), in the middle of a spawn area reaching
   * `half` metres each way, where every wander lands on that middle unless `wanderRandom` says otherwise.
   */
  function withMonster(overrides: Partial<Sector> = {}, half = 4, wanderRandom: RandomSource = landsAtCentre(half)) {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterGround(HOME, half)], ...overrides }, { random: landsAtCentre(half), wanderRandom });
    clock.ms = RESPAWN_MS;
    space.step(0);
    return { clock, space, steps: stepper(clock, space) };
  }

  /** Whether the point lies in the area `withMonster` gives its monster. */
  const inArea = (point: Point, half = 4): boolean => rectContains(makeMonsterGround(HOME, half), point, EDGE_TOLERANCE);

  const movesIn = (messages: readonly SomnioMessage[], id = GHOST) => entityMoves(messages).filter((move) => move.id === id);

  /** The monster's moves, as the outbox's dreamer is told them. Reading an outbox finishes it. */
  async function monsterMoves(space: SpaceActor, outbox: ConnectionOutbox) {
    space.flushMoves();
    return movesIn(await collectMessages(outbox));
  }

  /** Turns the dreamer to the Ghost at `at` and attacks it for two swings, a swing interval apart. */
  function attackFor(space: SpaceActor, entityId: string, at: Point, steps: Steps): void {
    face(space, entityId, at);
    engage(space, GHOST, entityId);
    steps(21);
    space.handleEngage(false, entityId);
  }

  /** The monster `id` as a dreamer joining at `at` is shown it now. */
  async function monsterNow(space: SpaceActor, at: Point = AFAR, id = GHOST) {
    const watcher = attachPlayer(space, at, 'watcher');
    space.handOver(watcher.entityId, false);
    return (await monstersSeen(watcher.outbox)).find((monster) => monster.id === id)!;
  }

  /** Everything a dreamer who joins at `at` is sent over `count` more steps, every move as it is made. */
  async function sentOver(space: SpaceActor, steps: Steps, count: number, at: Point = AFAR) {
    space.flushMoves();
    const watcher = attachPlayer(space, at, 'watcher');
    steps(count, () => space.flushMoves());
    space.flushMoves();
    space.handOver(watcher.entityId, false);
    return collectMessages(watcher.outbox);
  }

  const conditionsIn = (messages: readonly SomnioMessage[]) =>
    payloads(messages, 'condition').flatMap((sent) => (sent.entityId === GHOST ? [sent.condition] : []));

  /** Jogs the dreamer to `to` at 0.1 m a step, a step of the simulation after each report, every move sent as it is made. */
  function jogTo(space: SpaceActor, steps: Steps, entityId: string, to: Point): void {
    for (let at = characterOf(space, entityId).position; distance(at, to) > 0;) {
      const away = distance(at, to);
      const stride = Math.min(0.1, away);
      at = stride === away ? to : { x: at.x + ((to.x - at.x) * stride) / away, z: at.z + ((to.z - at.z) * stride) / away };
      space.handleMove({ ...at, facing: headingFromVector(to.x - at.x, to.z - at.z), gait: 'jog' }, entityId);
      steps(1);
      space.flushMoves();
    }
  }

  /**
   * Has the monster chase a dreamer from its home at (10, 10) out of its area, to just inside its
   * reach of them at `lure`. The returned `giveUp` hands the dreamer over, which empties its table.
   */
  async function chasedOut(lure: Point = { x: 16, z: 10 }, wanderRandom?: RandomSource) {
    const monster = withMonster({}, 4, wanderRandom);
    const alice = attachPlayer(monster.space, { x: 12, z: 10 }, 'alice');
    monster.steps(10);
    monster.space.handleMove({ ...lure, facing: 0, gait: 'jog' }, alice.entityId);
    monster.steps(50);
    const chaseEnd = await monsterNow(monster.space);
    const giveUp = (): void => void monster.space.handOver(alice.entityId, false);
    return { ...monster, alice, chaseEnd, giveUp };
  }

  /** A Fighter who joins beside the monster, cleaves it, and leaves before the next step, so it has no step to notice them: the blows they struck. */
  async function cleaveOnce(space: SpaceActor, name: string) {
    const at = await monsterNow(space);
    const fighter = attachPlayer(space, { x: at.x + 0.7, z: at.z }, name, CLEAVER);
    face(space, fighter.entityId, at);
    space.handleUseAbility('cleave', fighter.entityId);
    space.handOver(fighter.entityId, false);
    return payloads(await collectMessages(fighter.outbox), 'blow');
  }

  it('runs toward an in-radius player at its chase speed, facing them', async () => {
    const { space } = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    const [frame] = await monsterMoves(space, alice.outbox);
    expect(frame).toMatchObject({ id: GHOST, facing: headingFromVector(2, 2), gait: 'run' });
    expect(frame!.x).toBeCloseTo(10 + STRIDE / Math.SQRT2, 9);
    expect(frame!.z).toBeCloseTo(10 + STRIDE / Math.SQRT2, 9);
  });

  it('idles when no player is in radius', async () => {
    const { space } = withMonster();
    const alice = attachPlayer(space, { x: 18, z: 18 }, 'alice');
    space.step(0.05);
    expect(await monsterMoves(space, alice.outbox)).toEqual([]);
  });

  it('chases a dreamer within its aggro radius outside its spawn area', async () => {
    const { space, steps } = withMonster({}, 1);
    const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(5);
    const [frame] = await monsterMoves(space, alice.outbox);
    expect(frame).toMatchObject({ id: GHOST, facing: headingFromCardinal('east') });
    expect(frame!.x).toBeCloseTo(10 + 5 * STRIDE, 9);
  });

  it('keeps chasing a dreamer it noticed who steps out of its aggro radius', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(1);
    // 4.5 m jogged in one report, as a stalled connection sends what it held back.
    const away = { x: 16.5, z: 10 };
    space.handleMove({ ...away, facing: 90, gait: 'jog' }, alice.entityId);
    expect(characterOf(space, alice.entityId).position).toEqual(away);
    steps(10);
    const chasing = await monsterNow(space);
    expect(distance(chasing, away)).toBeGreaterThan(monsterKind('ghost').aggroRadius);
    expect(chasing.x).toBeCloseTo(10 + 11 * STRIDE, 9);
  });

  it('attaching after a chase delivers the post-step monster facing and gait in the entity frame', async () => {
    const { space } = withMonster();
    attachPlayer(space, { x: 8, z: 8 }, 'alice');
    space.step(0.05);
    const bob = attachPlayer(space, { x: 2, z: 2 }, 'bob');
    expect((await monstersSeen(bob.outbox))[0]).toMatchObject({ facing: headingFromVector(-2, -2), gait: 'run' });
  });

  it.each([true, false])('targets the nearest in-radius player regardless of attach order (closer first: %s)', async (closerFirst) => {
    const { space } = withMonster();
    const places: [string, Point][] = [
      ['alice', { x: 11.2, z: 10 }],
      ['bob', { x: 7, z: 10 }],
    ];
    const [alice] = (closerFirst ? places : places.toReversed())
      .map(([name, at]) => attachPlayer(space, at, name))
      .filter((_, index) => (index === 0) === closerFirst);
    space.step(0.05);
    expect((await monsterMoves(space, alice!.outbox))[0]?.facing).toBe(headingFromCardinal('east'));
  });

  it('steers round a post in its way, still facing the player', async () => {
    const { space } = withMonster({ blockers: [{ id: 'post', x: 10.25, z: 10.25, width: 0.1, depth: 0.1 }] });
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    const [frame] = await monsterMoves(space, alice.outbox);
    expect(frame).toMatchObject({ id: GHOST, facing: headingFromVector(2, 2) });
    expect(distance(frame!, HOME)).toBeCloseTo(STRIDE, 9);
    expect(Math.abs(headingFromVector(frame!.x - 10, frame!.z - 10) - headingFromVector(2, 2))).toBeGreaterThan(1);
  });

  it('closes to just inside its reach of a player and stops there, while a player may step onto it', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 11.2, z: 10 }, 'alice');
    steps(20, () => space.flushMoves());
    const moves = await monsterMoves(space, alice.outbox);
    expect(moves).toHaveLength(3);
    const stop = moves.at(-1)!.x;
    expect(stop).toBeCloseTo(11.2 - (REACH - 0.01), 9);
    const bob = attachPlayer(space, { x: 9, z: 10 }, 'bob');
    space.handleMove({ x: stop, z: 10, facing: 0, gait: 'jog' }, bob.entityId);
    expect(space.snapshotForPlayer(bob.entityId)?.character.position).toEqual({ x: stop, z: 10 });
  });

  it('closes on a dreamer on the diagonal and strikes them', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    steps(25);
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toContainEqual({ attackerId: GHOST, targetId: alice.entityId, hit: true });
  });

  describe('against a wall along its north side', () => {
    /** Its south face, just more than the monster's radius north of the monster at (10, 10). */
    const WALL_FACE = 10 - monsterKind('ghost').radius - 0.005;

    /**
     * The monster stands at (10, 10), heading east toward a dreamer at (12, 10) with a fallen body
     * straight ahead in contact. A turn to its first side, north, runs into the wall at any angle.
     */
    function atWall() {
      const { space, steps } = withMonster({ blockers: [{ id: 'wall', x: 8, z: 9, width: 6, depth: WALL_FACE - 9 }] }, 0);
      const fallen = attachPlayer(space, { x: 10.6, z: 10 }, 'fallen', FALLEN);
      const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
      return { space, steps, fallen, alice };
    }

    it('turns the other way, and never into the wall', async () => {
      const { space, steps, alice } = atWall();
      steps(40, () => space.flushMoves());
      const moves = await monsterMoves(space, alice.outbox);
      expect(moves[0]!.z).toBeGreaterThan(10);
      for (const move of moves) expect(move.z - monsterKind('ghost').radius).toBeGreaterThanOrEqual(WALL_FACE);
    });

    it('keeps turning to the side it last turned to', async () => {
      const { space, steps, fallen } = atWall();
      steps(1);
      const first = await monsterNow(space);
      expect(first.x).toBeCloseTo(10, 9);
      expect(first.z).toBeCloseTo(10 + STRIDE, 9);
      space.handOver(fallen.entityId, false);
      // 0.65 m ahead and 0.1 m south of the bearing, a body blocks the straight step, both 30-degree
      // turns, and the 60 to the south. The 90 to the south and the 60 to the north are free.
      const bearing = headingRadians(headingFromVector(12 - first.x, 10 - first.z));
      const ahead = { x: Math.sin(bearing), z: Math.cos(bearing) };
      const south = { x: -ahead.z, z: ahead.x };
      attachPlayer(space, { x: first.x + 0.65 * ahead.x + 0.1 * south.x, z: first.z + 0.65 * ahead.z + 0.1 * south.z }, 'wall', FALLEN);
      steps(1);
      const second = await monsterNow(space);
      expect(second.x).toBeCloseTo(first.x + STRIDE * south.x, 9);
      expect(second.z).toBeCloseTo(first.z + STRIDE * south.z, 9);
    });
  });

  it('gives its fight up the step after it stands past its leash from where the fight began, and evades a swing on its way home', async () => {
    const anchor = { x: 3, z: 10 };
    const { clock, space } = actor({ monsterSpawns: [makeMonsterGround(anchor, 1)] }, { random: landsAtCentre(1), wanderRandom: landsAtCentre(1) });
    clock.ms = RESPAWN_MS;
    space.step(0);
    const steps = stepper(clock, space);
    const watcher = recordingOutbox();
    attachPlayer(space, AFAR, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 5.5, z: 10 }, 'alice', CLEAVER);
    // She jogs east slower than it walks, so it closes on her and follows at her pace.
    jogTo(space, steps, alice.entityId, { x: 18, z: 10 });
    const xs = movesIn(watcher.sent).map((move) => move.x);
    const farthest = Math.max(...xs);
    expect(farthest - anchor.x).toBeGreaterThan(monsterKind('ghost').leashMetres);
    expect(farthest - anchor.x).toBeLessThanOrEqual(monsterKind('ghost').leashMetres + STRIDE);
    const homeward = await monsterNow(space);
    expect(homeward).toMatchObject({ z: 10, facing: WEST });
    expect(homeward.x).toBeLessThan(farthest);
    space.handleMove({ x: homeward.x + 0.7, z: 10, facing: WEST, gait: 'jog' }, alice.entityId);
    space.handleUseAbility('cleave', alice.entityId);
    expect(payloads(watcher.sent, 'blow').filter((blow) => blow.attackerId === alice.entityId)).toEqual([
      { attackerId: alice.entityId, targetId: GHOST, hit: false, evaded: true },
    ]);
    expect(conditionsIn(watcher.sent)).toEqual([]);
  });

  it('walks back to where it set off from after giving up, and then sends nothing until it may wander', async () => {
    const { space, steps, giveUp } = await chasedOut(undefined, seededRandom(1));
    giveUp();
    steps(60);
    const back = await monsterNow(space);
    expect(back.x).toBeCloseTo(HOME.x, 9);
    expect(back.z).toBeCloseTo(HOME.z, 9);
    // It was home about 2.2 s after giving up, and may wander 6 to 15 s after that.
    expect(movesIn(await sentOver(space, steps, 100))).toEqual([]);
    expect(movesIn(await sentOver(space, steps, 200))).not.toEqual([]);
  });

  it('runs home after giving up, its last step home included as it rests there', async () => {
    const { space, steps, giveUp } = await chasedOut();
    giveUp();
    const homeward = movesIn(await sentOver(space, steps, 60));
    expect(homeward.length).toBeGreaterThan(1);
    expect(new Set(homeward.map((move) => move.gait))).toEqual(new Set(['run']));
    expect(homeward.at(-1)!.x).toBeCloseTo(HOME.x, 9);
    expect(homeward.at(-1)!.z).toBeCloseTo(HOME.z, 9);
  });

  it('notices no one on its way home after giving up, and chases a dreamer within its notice once it is home and whole', async () => {
    const { space, steps, chaseEnd, giveUp } = await chasedOut();
    giveUp();
    steps(1);
    // Within its notice all the way home, south of its way.
    const bob: Point = { x: 12.5, z: 12 };
    attachPlayer(space, bob, 'bob');
    steps(1);
    const homeward = await monsterNow(space);
    expect(homeward).toMatchObject({ z: 10, facing: WEST });
    expect(homeward.x).toBeLessThan(chaseEnd.x);
    steps(90);
    expect(distance(await monsterNow(space), bob)).toBeLessThanOrEqual(REACH);
  });

  it('waits before a wall of fallen bodies across its way home, stops evading a second on, and walks home once they are gone', async () => {
    const { space, steps, chaseEnd, giveUp } = await chasedOut();
    const fallen = [9.4, 10, 10.6].map((z) => attachPlayer(space, { x: chaseEnd.x - 0.65, z }, `fallen-${z}`, FALLEN));
    giveUp();
    steps(10);
    expect(await cleaveOnce(space, 'early')).toEqual([expect.objectContaining({ hit: false, evaded: true })]);
    steps(20);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
    expect(await cleaveOnce(space, 'late')).toEqual([expect.not.objectContaining({ evaded: true })]);
    for (const body of fallen) space.handOver(body.entityId, false);
    steps(60);
    const back = await monsterNow(space);
    expect(back.x).toBeCloseTo(HOME.x, 9);
    expect(back.z).toBeCloseTo(HOME.z, 9);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
  });

  it('rests short of a body lying on where it set off from, once its way there is blocked inside its area', async () => {
    const { space, steps, giveUp } = await chasedOut();
    attachPlayer(space, HOME, 'fallen', FALLEN);
    giveUp();
    steps(80);
    const short = await monsterNow(space);
    expect(inArea(short)).toBe(true);
    // In touch with the body, about 0.63 m off, and short of the 0.75 m ring a new home would lie on.
    expect(distance(short, HOME)).toBeGreaterThan(0.5);
    expect(distance(short, HOME)).toBeLessThan(0.7);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
    expect(await cleaveOnce(space, 'resting')).toEqual([expect.not.objectContaining({ evaded: true })]);
  });

  /** Hurt, it gives up 3 m from home inside its area, is stalled by the body a second later, and is whole about 4 s after giving up. */
  it('keeps evading short of a body lying on where it set off from inside its area until it is whole', async () => {
    const { space, steps } = withMonster();
    // Inside its area and its notice, east of it, where it closes on her.
    const alice = attachPlayer(space, { x: 13.7, z: 10 }, 'alice', { character: { lucidity: lucidity('fighter', { strike: 2 }) }, inventory: wearing() });
    steps(30);
    const lured = await monsterNow(space);
    expect(inArea(lured)).toBe(true);
    expect(distance(lured, HOME)).toBeGreaterThan(2.5);
    // Three bare-handed swings a second apart take it to half its health.
    face(space, alice.entityId, lured);
    engage(space, GHOST, alice.entityId);
    steps(41);
    attachPlayer(space, HOME, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    steps(50);
    expect((await monsterNow(space)).condition).not.toBe('hale');
    expect(await cleaveOnce(space, 'early')).toEqual([expect.objectContaining({ hit: false, evaded: true })]);
    steps(40);
    expect((await monsterNow(space)).condition).toBe('hale');
    expect(await cleaveOnce(space, 'whole')).toEqual([expect.not.objectContaining({ evaded: true })]);
  });

  /**
   * The free point of `LINE_AREA` nearest a body lying on `HOME`: 0.75 m west of it, on the first of
   * the 0.25 m rings beyond the 0.6 m the Ghost and the body keep between them.
   */
  const REHOMED: Point = { x: HOME.x - 3 * 0.25, z: HOME.z };

  /** The line area a `lineHome` Ghost spawns on, at `HOME`. */
  const LINE_AREA = { ...makeMonsterSpawn(HOME), x: 7.9, width: 2.2 };

  /**
   * Has a Ghost spawned at `HOME` on `LINE_AREA` chase a dreamer east out of it, lays a fallen body on
   * `HOME`, and hands the dreamer over, so it gives up. Coming back, the way round the body keeps it
   * outside its area until the way home is blocked.
   */
  async function lineHome() {
    // Every draw lands 2.1 m into the area, on (10, 10).
    const monster = withMonster({ monsterSpawns: [LINE_AREA] }, 2.1);
    const { space, steps } = monster;
    expect(await monsterNow(space)).toMatchObject(HOME);
    const watcher = recordingOutbox();
    attachPlayer(space, AFAR, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(10);
    space.handleMove({ x: 16, z: 10, facing: 90, gait: 'jog' }, alice.entityId);
    steps(50);
    attachPlayer(space, HOME, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    const left = () => payloads(watcher.sent, 'leave').filter((leave) => leave.entityId === GHOST);
    return { ...monster, left };
  }

  it('takes the free point of its area nearest a body lying on where it set off from as its home, once that body stalls it outside, and rests there', async () => {
    const { space, steps, left } = await lineHome();
    // Past the 10 s that would have walled it off from home.
    steps(15 * 20);
    expect(left()).toEqual([]);
    const settled = await monsterNow(space);
    expect(rectContains(LINE_AREA, settled, EDGE_TOLERANCE)).toBe(true);
    expect(distance(settled, HOME)).toBeGreaterThanOrEqual(monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius - 1e-9);
    // The nearest ring holding a free point, not a farther one.
    expect(distance(settled, REHOMED)).toBeLessThan(1e-6);
    expect(settled.condition).toBe('hale');
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
  });

  /**
   * It meets the body on `HOME` 2 s after giving up and circles it, no nearer, for a second, when it
   * takes `REHOMED` as its home. A second body laid there, as it heads for it still outside its area,
   * stalls it again, and it takes the free point nearest `REHOMED` in turn: on the first ring holding
   * one, 0.75 m west of it, since the point 0.75 m east lies in the body on `HOME`.
   */
  it('takes another home when a body lies on the one it took too, while it is still outside its area, and rests there', async () => {
    const { clock, space, steps, left } = await lineHome();
    const gaveUpAt = clock.ms;
    // It faces the home it steps toward. Coming back along the line, `HOME` lies on its bearing to
    // `REHOMED`, so it has taken `REHOMED` as its home only once it faces `REHOMED` and not `HOME`.
    const facesTo = (at: { x: number; z: number; facing: number }, to: Point) =>
      Math.abs(((headingFromVector(to.x - at.x, to.z - at.z) - at.facing + 540) % 360) - 180) < 1e-6;
    const rehomed = (at: { x: number; z: number; facing: number }) => facesTo(at, REHOMED) && !facesTo(at, HOME);
    let heading = await monsterNow(space);
    while (!rehomed(heading) && clock.ms < gaveUpAt + 6000) {
      steps(1);
      heading = await monsterNow(space);
    }
    expect(rehomed(heading)).toBe(true);
    expect(rectContains(LINE_AREA, heading, EDGE_TOLERANCE)).toBe(false);
    attachPlayer(space, REHOMED, 'fallen-again', FALLEN);
    // Past the 10 s that would have walled it off from the home it took.
    steps(15 * 20);
    expect(left()).toEqual([]);
    const settled = await monsterNow(space);
    expect(settled.condition).toBe('hale');
    expect(rectContains(LINE_AREA, settled, EDGE_TOLERANCE)).toBe(true);
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius - 1e-9;
    expect(distance(settled, HOME)).toBeGreaterThanOrEqual(contact);
    expect(distance(settled, REHOMED)).toBeGreaterThanOrEqual(contact);
    expect(distance(settled, { x: REHOMED.x - 3 * 0.25, z: HOME.z })).toBeLessThan(1e-6);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
  });

  /**
   * Lured out of a line area running 6 m west of `HOME`, with a body on `HOME`, it gives up boxed in
   * by four fallen bodies, so no step of its own brings it nearer any home. Each second, once stalled,
   * it takes the free point 0.75 m west of the home it holds, and a body is laid on each new home half
   * a second after, until it has taken eight. It turns to each new home it takes.
   */
  it('leaves 10 s after it last came nearer home, however many homes it takes meanwhile', async () => {
    const wideArea = { ...makeMonsterSpawn(HOME), x: 3.9, width: 6.2 };
    // Every draw lands 6.1 m into the area, on (10, 10).
    const { clock, space, steps } = withMonster({ monsterSpawns: [wideArea] }, 6.1);
    expect(await monsterNow(space)).toMatchObject(HOME);
    const watcher = recordingOutbox();
    attachPlayer(space, AFAR, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 12, z: 10.5 }, 'alice');
    steps(10);
    space.handleMove({ x: 16, z: 11.5, facing: 90, gait: 'jog' }, alice.entityId);
    steps(50);
    const boxed = await monsterNow(space);
    expect(rectContains(wideArea, boxed, EDGE_TOLERANCE)).toBe(false);
    // Each 0.61 m off, so any step the Ghost takes, whichever way, nears one of them within contact.
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      attachPlayer(space, { x: boxed.x + 0.61 * dx, z: boxed.z + 0.61 * dz }, `box-${dx}-${dz}`, FALLEN);
    const homes = Array.from({ length: 9 }, (_, index): Point => ({ x: HOME.x - index * 0.75, z: HOME.z }));
    attachPlayer(space, homes[0]!, 'fallen-0', FALLEN);
    space.flushMoves();
    const sentBefore = watcher.sent.length;
    space.handOver(alice.entityId, false);
    const gaveUpAt = clock.ms;
    const left = () => payloads(watcher.sent, 'leave').some((leave) => leave.entityId === GHOST);
    let laid = 1;
    while (!left() && clock.ms < gaveUpAt + 12_000) {
      if (laid < homes.length - 1 && clock.ms >= gaveUpAt + (laid + 0.5) * 1000) {
        attachPlayer(space, homes[laid]!, `fallen-${laid}`, FALLEN);
        laid += 1;
      }
      steps(1);
      space.flushMoves();
    }
    expect(left()).toBe(true);
    // Its first step home counts as nearer, since a return starts with no best distance, and it leaves 10 s after that.
    expect(clock.ms - gaveUpAt).toBeGreaterThanOrEqual(10_000);
    expect(clock.ms - gaveUpAt).toBeLessThanOrEqual(10_000 + 250);
    const moves = movesIn(watcher.sent.slice(sentBefore));
    for (const move of moves) expect(move).toMatchObject({ x: boxed.x, z: boxed.z });
    const facings = moves.map((move) => move.facing).filter((facing, index, all) => index === 0 || facing !== all[index - 1]);
    expect(facings).toHaveLength(homes.length);
    facings.forEach((facing, index) => expect(facing).toBeCloseTo(headingFromVector(homes[index]!.x - boxed.x, homes[index]!.z - boxed.z), 9));
  });

  /**
   * With bodies at 9.1 and 8.2 besides the one on `HOME`, no point of its line area is clear, so it
   * finds no home to take once stalled outside. 5 s on, a body is handed over and a point frees, which
   * it takes as its home in time, rather than being walled off.
   */
  it('takes another home once a point of its area frees, after finding none free', async () => {
    const { space, steps, left } = await lineHome();
    const near = attachPlayer(space, { x: 9.1, z: 10 }, 'fallen-near', FALLEN);
    const far = attachPlayer(space, { x: 8.2, z: 10 }, 'fallen-far', FALLEN);
    steps(5 * 20);
    expect(left()).toEqual([]);
    expect(rectContains(LINE_AREA, await monsterNow(space), EDGE_TOLERANCE)).toBe(false);
    space.handOver(far.entityId, false);
    steps(20 * 20);
    expect(left()).toEqual([]);
    const settled = await monsterNow(space);
    expect(settled.condition).toBe('hale');
    expect(rectContains(LINE_AREA, settled, EDGE_TOLERANCE)).toBe(true);
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius - 1e-9;
    expect(distance(settled, HOME)).toBeGreaterThanOrEqual(contact);
    expect(distance(settled, near.character.position)).toBeGreaterThanOrEqual(contact);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
  });

  it('keeps its home with a body on it and no free point of its area within reach, and leaves once walled off for 10 s', () => {
    // Its area is the one point it spawned on.
    const { clock, space, steps } = withMonster({ monsterSpawns: [makeMonsterSpawn(HOME)] }, 0);
    const watcher = recordingOutbox();
    attachPlayer(space, AFAR, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(10);
    space.handleMove({ x: 16, z: 10, facing: 90, gait: 'jog' }, alice.entityId);
    steps(50);
    attachPlayer(space, HOME, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    const gaveUpAt = clock.ms;
    const left = () => payloads(watcher.sent, 'leave').filter((leave) => leave.entityId === GHOST);
    // It meets the body 2 s after giving up and comes no nearer from then on.
    while (left().length === 0 && clock.ms < gaveUpAt + 20_000) steps(1);
    expect(left()).toHaveLength(1);
    expect(clock.ms - gaveUpAt).toBeGreaterThanOrEqual(10_000);
    expect(clock.ms - gaveUpAt).toBeLessThanOrEqual(2000 + 10_000 + 500);
  });

  /**
   * As 'takes the free point of its area nearest a body lying on where it set off from' on
   * `LINE_AREA`, but along z 0, the sector's middle, where a ring's west point lies a rounding error
   * north of the line, outside it but for the edge's tolerance.
   */
  it('takes the free point nearest its home on an area edge lying at a zero coordinate', async () => {
    const atZero: Point = { x: 10, z: 0 };
    const sector = outdoorSector('TestSector', { x: 0, z: -10 }, { monsterSpawns: [LINE_AREA] });
    const { clock, space } = makeClockedSpace(makeWorld([sector]), OUTDOOR_SPACE_ID, { random: landsAtCentre(2.1), wanderRandom: landsAtCentre(2.1) });
    clock.ms = RESPAWN_MS;
    space.step(0);
    const steps = stepper(clock, space);
    const afar: Point = { x: 1, z: 9 };
    expect(await monsterNow(space, afar)).toMatchObject(atZero);
    const watcher = recordingOutbox();
    attachPlayer(space, afar, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 12, z: 0 }, 'alice');
    steps(10);
    space.handleMove({ x: 16, z: 0, facing: 90, gait: 'jog' }, alice.entityId);
    steps(50);
    attachPlayer(space, atZero, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    steps(15 * 20);
    expect(payloads(watcher.sent, 'leave').filter((leave) => leave.entityId === GHOST)).toEqual([]);
    const settled = await monsterNow(space, afar);
    expect(distance(settled, { x: REHOMED.x, z: 0 })).toBeLessThan(1e-6);
    expect(movesIn(await sentOver(space, steps, 40, afar))).toEqual([]);
  });

  it('steps round a fallen body in its way home, however long the chase before it', async () => {
    // Lured past the far corner of its area, it meets the body a second into its walk home, when its progress is first weighed, and steers round it.
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 12.5, z: 12.5 }, 'alice');
    steps(20);
    space.handleMove({ x: 15.5, z: 15.5, facing: 0, gait: 'jog' }, alice.entityId);
    steps(30);
    space.handleMove({ x: 18, z: 18, facing: 0, gait: 'jog' }, alice.entityId);
    steps(40);
    attachPlayer(space, { x: 15.28, z: 15.28 }, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    const homeward = movesIn(await sentOver(space, steps, 60));
    expect(homeward.some((move) => Math.abs(move.x - move.z) > 0.1)).toBe(true);
    expect(inArea(homeward.at(-1)!)).toBe(true);
  });

  it('steers home round a fallen body that blocks its first step back after a chase', async () => {
    const { space, steps, chaseEnd, giveUp } = await chasedOut();
    attachPlayer(space, { x: chaseEnd.x - 0.65, z: 10 }, 'fallen', FALLEN);
    giveUp();
    const homeward = movesIn(await sentOver(space, steps, 60));
    expect(homeward.some((move) => move.z !== 10)).toBe(true);
    expect(inArea(homeward.at(-1)!)).toBe(true);
  });

  it('steps round another nightmare chasing the same dreamer', async () => {
    const second = { ...makeMonsterGround({ x: 10, z: 9.3 }, 4), id: 'spawn-2' };
    const { space, steps } = withMonster({ monsterSpawns: [makeMonsterGround(HOME, 4), second] });
    const alice = { x: 10, z: 12.8 };
    attachPlayer(space, alice, 'alice');
    steps(40);
    const [one, other] = await monstersSeen(attachPlayer(space, AFAR, 'watcher').outbox);
    // Both reached her, the one behind by coming round the other.
    expect(distance(one!, alice)).toBeLessThanOrEqual(REACH);
    expect(distance(other!, alice)).toBeLessThanOrEqual(REACH);
    expect(distance(one!, other!)).toBeGreaterThanOrEqual(2 * monsterKind('ghost').radius - 1e-6);
  });

  it('turns to face a dreamer it strikes, and sends the turn', async () => {
    const { space, steps } = withMonster({}, 0);
    const alice = attachPlayer(space, { x: 10.7, z: 10 }, 'alice');
    steps(1);
    expect(await monsterMoves(space, alice.outbox)).toEqual([{ id: GHOST, x: 10, z: 10, facing: headingFromCardinal('east'), gait: 'walk' }]);
  });

  it('leaves the space once a wall it chased round has kept it from home for 10 s, and its spawn fills again after the respawn time', () => {
    // East of its spawn point, from 3 m north of it to the sector's south edge.
    const { clock, space, steps } = withMonster({ blockers: [{ id: 'wall', x: 12, z: 7, width: 0.2, depth: 13 }] }, 0);
    const watcher = recordingOutbox();
    attachPlayer(space, AFAR, 'watcher', { outbox: watcher.outbox });
    const alice = attachPlayer(space, { x: 11, z: 7 }, 'alice');
    // She leads it north round the wall's end and south down its far side.
    for (const to of [
      { x: 12.1, z: 6.2 },
      { x: 14, z: 6.2 },
      { x: 14, z: 12 },
    ])
      jogTo(space, steps, alice.entityId, to);
    space.handOver(alice.entityId, false);
    const gaveUpAt = clock.ms;
    const left = () => payloads(watcher.sent, 'leave').some((leave) => leave.entityId === GHOST);
    steps(10 * 20 - 1);
    expect(left()).toBe(false);
    while (!left() && clock.ms < gaveUpAt + 12_000) steps(1);
    expect(left()).toBe(true);
    const leftAt = clock.ms;
    clock.ms = leftAt + RESPAWN_MS - 50;
    space.step(0.05);
    expect(entities(watcher.sent).map((entity) => entity.id)).not.toContain('monster:2');
    clock.ms = leftAt + RESPAWN_MS;
    space.step(0.05);
    expect(entities(watcher.sent).find((entity) => entity.id === 'monster:2')).toMatchObject(HOME);
  });

  it('comes round a fallen dreamer it touches to reach a standing one behind them', async () => {
    const { space, steps } = withMonster();
    attachPlayer(space, { x: 10.6, z: 10 }, 'fallen', FALLEN);
    const standing = attachPlayer(space, { x: 11.8, z: 10 }, 'standing');
    steps(40);
    expect(payloads(await collectMessages(standing.outbox), 'blow').map((blow) => blow.targetId)).toContain(standing.entityId);
  });

  it('steps away from a fallen body lying on it', async () => {
    const { space, steps } = withMonster();
    attachPlayer(space, HOME, 'fallen', FALLEN);
    attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(5);
    expect((await monsterNow(space)).x).toBeGreaterThan(HOME.x);
  });

  /** A Fighter beside the monster at home strikes it to half its health with three bare-handed swings a second apart, and leaves, so it gives up where it stands. */
  function struckToHalf() {
    const monster = withMonster();
    const alice = attachPlayer(monster.space, { x: 10, z: 10.7 }, 'alice', {
      character: { lucidity: lucidity('fighter', { strike: 2 }) },
      inventory: wearing(),
    });
    face(monster.space, alice.entityId, HOME);
    engage(monster.space, GHOST, alice.entityId);
    monster.steps(41);
    monster.space.handOver(alice.entityId, false);
    monster.steps(1);
    return monster;
  }

  it('heals an eighth of its health a second from giving up, whole from half in 4 s', async () => {
    const { space, steps } = struckToHalf();
    steps(78);
    expect((await monsterNow(space)).condition).not.toBe('hale');
    steps(4);
    expect((await monsterNow(space)).condition).toBe('hale');
  });

  it('waits home after giving up, evading and noticing no one, until it is whole', () => {
    const { space, steps } = struckToHalf();
    const { outbox, sent } = recordingOutbox();
    // In its reach, so it strikes him the step it notices him.
    const bob = attachPlayer(space, { x: 10, z: 10.7 }, 'bob', { outbox, ...CLEAVER });
    steps(40);
    face(space, bob.entityId, HOME);
    space.handleUseAbility('cleave', bob.entityId);
    steps(39);
    const ghostBlows = () => payloads(sent, 'blow').filter((blow) => blow.attackerId === GHOST);
    expect(payloads(sent, 'blow').filter((blow) => blow.attackerId === bob.entityId)).toEqual([
      { attackerId: bob.entityId, targetId: GHOST, hit: false, evaded: true },
    ]);
    expect(ghostBlows()).toEqual([]);
    steps(2);
    expect(ghostBlows()).toEqual([{ attackerId: GHOST, targetId: bob.entityId, hit: true }]);
  });

  it('heals nothing while it fights', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 10, z: 10.7 }, 'alice', { inventory: wearing(CUDGEL) });
    // Two cudgel hits take it from 60 to 44, and any healing would take it back past 45.
    const watcher = attachPlayer(space, AFAR, 'watcher');
    attackFor(space, alice.entityId, HOME, steps);
    space.handOver(watcher.entityId, false);
    expect(conditionsIn(await collectMessages(watcher.outbox))).toEqual(['grazed', 'wounded']);
    expect(conditionsIn(await sentOver(space, steps, 200))).toEqual([]);
    expect(space.isFallen(alice.entityId)).toBe(false);
  });

  it('walks back into an area far from the origin', async () => {
    const spawn = { ...makeMonsterSpawn({ x: 0.01, z: 0.01 }), width: 4.8, depth: 4.8 };
    const sector = outdoorSector('Far', { x: -61.44, z: 0 }, { monsterSpawns: [spawn] });
    const area = { x: -61.44 + 0.01, z: 0.01, width: 4.8, depth: 4.8 };
    // The last draw of each axis puts its spawn on the area's south-east corner.
    const { clock, space } = makeClockedSpace(makeWorld([sector]), OUTDOOR_SPACE_ID, { random: { nextUInt32: () => 480 }, wanderRandom: landsAtCentre(2.4) });
    clock.ms = RESPAWN_MS;
    // East of the area, within its notice.
    const alice = attachPlayer(space, { x: -54, z: 3 }, 'alice');
    space.step(0);
    const afar = { x: -45, z: 18 };
    const steps = stepper(clock, space);
    steps(30);
    expect(rectContains(area, await monsterNow(space, afar), EDGE_TOLERANCE)).toBe(false);
    space.handOver(alice.entityId, false);
    steps(40);
    expect(rectContains(area, await monsterNow(space, afar), EDGE_TOLERANCE)).toBe(true);
  });

  it('walks each of two that gave up together back to where it set off from', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterGround(HOME, 1, 2)] }, { random: seededRandom(3), wanderRandom: landsAtCentre(1) });
    for (const pass of [1, 2]) {
      clock.ms = pass * RESPAWN_MS;
      space.step(0);
    }
    const steps = stepper(clock, space);
    const spawned = await monstersSeen(attachPlayer(space, AFAR, 'spawned').outbox);
    const alice = attachPlayer(space, { x: 12.5, z: 10 }, 'alice');
    steps(1);
    space.handleMove({ x: 16, z: 10, facing: 90, gait: 'jog' }, alice.entityId);
    steps(50);
    const lured = await monstersSeen(attachPlayer(space, AFAR, 'lured').outbox);
    expect(lured.map((monster) => inArea(monster, 1))).toEqual([false, false]);
    space.handOver(alice.entityId, false);
    steps(60);
    const home = await monstersSeen(attachPlayer(space, AFAR, 'home').outbox);
    expect(home.map((monster, index) => distance(monster, spawned[index]!))).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    expect(entityMoves(await sentOver(space, steps, 40))).toEqual([]);
  });

  it('steers a follower round a body in its way home the step after its leader gives up, however long after it spawned', async () => {
    const follower = { ...makeMonsterSpawn({ x: 13, z: 10 }), id: 'spawn-2' };
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn(HOME), follower] });
    clock.ms = RESPAWN_MS;
    space.step(0);
    clock.ms += 30_000;
    const steps = stepper(clock, space);
    // Within the leader's notice, and beyond the follower's however far it follows here.
    const alice = attachPlayer(space, { x: 6.5, z: 10 }, 'alice');
    steps(30);
    const following = await monsterNow(space, AFAR, 'monster:2');
    expect(following.x).toBeLessThan(13);
    attachPlayer(space, { x: following.x + 0.65, z: 10 }, 'fallen', FALLEN);
    space.handOver(alice.entityId, false);
    steps(3);
    expect(distance(await monsterNow(space, AFAR, 'monster:2'), { x: 13, z: 10 })).toBeLessThan(distance(following, { x: 13, z: 10 }));
  });

  describe('wandering', () => {
    it('stands still while no dreamer sees its sector, and walks its area at its stroll speed once one does', async () => {
      const sectors = makeSectorLine({ west: { monsterSpawns: [makeMonsterGround(HOME, 4)] } });
      const { clock, space } = makeClockedSpace(makeWorld(sectors), OUTDOOR_SPACE_ID, { random: landsAtCentre(4), wanderRandom: seededRandom(1) });
      clock.ms = RESPAWN_MS;
      space.step(0);
      const steps = stepper(clock, space);
      // In the east sector, which does not see the west one.
      attachPlayer(space, { x: 50, z: 10 }, 'unseeing');
      steps(60 * 20);
      expect(await monsterNow(space)).toMatchObject(HOME);
      // In the middle sector, which sees the west one, far beyond its notice.
      const watcher = recordingOutbox();
      attachPlayer(space, { x: 30, z: 10 }, 'watcher', { outbox: watcher.outbox });
      steps(15 * 20, () => space.flushMoves());
      const path = [HOME, ...movesIn(watcher.sent)];
      expect(path.length).toBeGreaterThan(1);
      for (const point of path) expect(inArea(point)).toBe(true);
      const strides = path.slice(1).map((point, index) => distance(point, path[index]!));
      expect(Math.max(...strides)).toBeCloseTo(STROLL_STRIDE, 9);
      expect(new Set(movesIn(watcher.sent).map((move) => move.gait))).toEqual(new Set(['walk']));
    });

    it('ends a wander the step the last dreamer who sees its sector leaves', async () => {
      // Every draw puts its wanders 6 s apart, and each on the area's north-west corner.
      const { space, steps } = withMonster({}, 4, { nextUInt32: () => 0 });
      const watcher = attachPlayer(space, AFAR, 'watcher');
      steps(130);
      const wandering = await monsterNow(space);
      expect(wandering.x).toBeLessThan(HOME.x);
      space.handOver(watcher.entityId, false);
      steps(40);
      expect(await monsterNow(space)).toMatchObject({ x: wandering.x, z: wandering.z });
    });

    it('never wanders off a spawn area that is a single point', async () => {
      const { space, steps } = withMonster({}, 0, { nextUInt32: () => 0 });
      expect(movesIn(await sentOver(space, steps, 60 * 20))).toEqual([]);
    });

    it('never steps out of its area steering round a body across its way', async () => {
      // Every draw puts its wanders 6 s apart, and each on the area's south-east corner.
      const { space, steps } = withMonster({}, 4, { nextUInt32: () => 800 });
      // On its way to that corner, so near it that every way round leaves the area.
      const body: Point = { x: 13.5, z: 13.5 };
      attachPlayer(space, body, 'fallen', FALLEN);
      const path = movesIn(await sentOver(space, steps, 15 * 20));
      expect(Math.min(...path.map((move) => distance(move, body)))).toBeLessThan(0.7);
      for (const move of path) expect(inArea(move), `${move.x}, ${move.z}`).toBe(true);
    });
  });

  describe('a pack stirring', () => {
    /** On single points along a line running west, each within 4 m of the next, and one more south of the line, 6 m or more from each of them. */
    const PACK = { c: { x: 10, z: 10 }, b: { x: 6.2, z: 10 }, a: { x: 2.4, z: 10 }, d: { x: 6.2, z: 16.5 } };
    const [C, B, A, D] = ['monster:1', 'monster:2', 'monster:3', 'monster:4'];
    /** Within C's notice, east of it, and beyond everyone else's. */
    const PULL_AT: Point = { x: 13.5, z: 10 };
    /** A Fighter whose one landed cudgel swing drives a Ghost off. */
    const SLAYER = { character: { lucidity: lucidity('fighter', { strike: 20 }) }, inventory: wearing(CUDGEL) };

    /**
     * The pack, or `spawns`, in the west of three sectors in a line, on rolls that always land and
     * place each on its area's north-west corner, with a watcher in the middle sector far beyond
     * their notice.
     */
    function pack(spawns = Object.entries(PACK).map(([id, at]) => ({ ...makeMonsterSpawn(at), id })), wanderRandom?: RandomSource) {
      const { clock, space } = makeClockedSpace(makeWorld(makeSectorLine({ west: { monsterSpawns: spawns } })), OUTDOOR_SPACE_ID, {
        random: { nextUInt32: () => 0 },
        ...(wanderRandom === undefined ? {} : { wanderRandom }),
      });
      clock.ms = RESPAWN_MS;
      space.step(0);
      const watcher = recordingOutbox();
      attachPlayer(space, { x: 30, z: 10 }, 'watcher', { outbox: watcher.outbox });
      const run = stepper(clock, space);
      const steps = (count: number): void => run(count, () => space.flushMoves());
      return { space, steps, watcher: watcher.sent };
    }

    it('stirs each resting nightmare within 4 m of one setting off a second after it, a hop at a time, and none farther', () => {
      const { space, steps, watcher } = pack();
      attachPlayer(space, PULL_AT, 'alice');
      const firstMoves = new Map<string, number>();
      for (let step = 1; step <= 60; step += 1) {
        const before = watcher.length;
        steps(1);
        space.flushMoves();
        for (const move of entityMoves(watcher.slice(before))) if (!firstMoves.has(move.id)) firstMoves.set(move.id, step);
      }
      expect(Object.fromEntries(firstMoves)).toEqual({ [C]: 1, [B]: 21, [A]: 41 });
      expect(firstMoves.has(D)).toBe(false);
    });

    it('runs to follow the one it is aware of', () => {
      const { space, steps, watcher } = pack();
      attachPlayer(space, PULL_AT, 'alice');
      // B follows C from 1 s, and would notice her itself at 2.5 s.
      steps(45);
      const following = entityMoves(watcher).filter((move) => move.id === B);
      expect(following.length).toBeGreaterThan(1);
      expect(new Set(following.map((move) => move.gait))).toEqual(new Set(['run']));
    });

    it('sends those it stirred back home without evading once the one they follow is driven off before they notice anyone', async () => {
      const { space, steps, watcher } = pack();
      const alice = attachPlayer(space, PULL_AT, 'alice', SLAYER);
      // A follows B from 2 s, and B would notice her at 2.5 s.
      steps(43);
      face(space, alice.entityId, await monsterNow(space, AFAR, C));
      engage(space, C, alice.entityId);
      steps(1);
      expect(payloads(watcher, 'condition')).toContainEqual({ entityId: C, condition: 'fallen' });
      space.handleEngage(false, alice.entityId);
      steps(2);
      const [a, b] = [await monsterNow(space, AFAR, A), await monsterNow(space, AFAR, B)];
      expect([a.facing, b.facing]).toEqual([WEST, WEST]);
      const prober = attachPlayer(space, { x: b.x + 0.7, z: b.z }, 'prober', CLEAVER);
      face(space, prober.entityId, b);
      space.handleTarget(B, prober.entityId);
      space.handleUseAbility('cleave', prober.entityId);
      space.handOver(prober.entityId, false);
      expect(payloads(await collectMessages(prober.outbox), 'blow')).toEqual([{ attackerId: prober.entityId, targetId: B, hit: true }]);
      steps(80);
      expect(await monsterNow(space, AFAR, A)).toMatchObject(PACK.a);
      expect(await monsterNow(space, AFAR, B)).toMatchObject(PACK.b);
      expect(entityMoves(await sentOver(space, steps, 40)).filter((move) => move.id === A || move.id === B)).toEqual([]);
    });

    it('walks a follower that noticed a dreamer itself back to where it was stirred once it gives up, not to where its own fight began', async () => {
      const { space, steps } = pack();
      const alice = attachPlayer(space, PULL_AT, 'alice');
      // B follows C from 1 s, and notices her itself at 2.5 s.
      steps(60);
      expect(distance(await monsterNow(space, AFAR, B), PULL_AT)).toBeLessThan(monsterKind('ghost').aggroRadius);
      space.handOver(alice.entityId, false);
      steps(400);
      expect(await monsterNow(space, AFAR, B)).toMatchObject(PACK.b);
    });

    it('walks a nightmare stirred where it wandered to back there, not to where it spawned', async () => {
      // B's area reaches 2 m each way round its place in the pack, and it spawns on the north-west corner.
      const spawns = [
        { ...makeMonsterSpawn(PACK.c), id: 'c' },
        { ...makeMonsterGround(PACK.b, 2), id: 'b' },
      ];
      // Every draw puts its wanders 6 s apart, and each in the middle of its area, within C's 4 m.
      const { space, steps, watcher } = pack(spawns, { nextUInt32: () => 200 });
      const spawned = entities(watcher).find((entity) => entity.id === B)!;
      steps(9 * 20);
      const stirred = await monsterNow(space, AFAR, B);
      expect(distance(stirred, spawned)).toBeGreaterThan(2);
      expect(distance(stirred, PACK.c)).toBeLessThanOrEqual(4);
      const alice = attachPlayer(space, PULL_AT, 'alice');
      // Long enough for B to follow C, and short of its own notice of her.
      steps(25);
      space.handOver(alice.entityId, false);
      steps(60);
      expect(await monsterNow(space, AFAR, B)).toMatchObject({ x: stirred.x, z: stirred.z });
    });
  });
});
