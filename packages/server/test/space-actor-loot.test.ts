import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PERSONAL_DROPS, MAX_SHARED_DROPS, OUTDOOR_SPACE_ID, SCATTER_DISTANCE, SHARED_LOOT_SECONDS, THROW_DISTANCE, withinPickupReach } from '@somnio/core';
import type { Inventory, ItemInstance, Point } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { plain } from '../../core/test/support/items.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { PersonalDrops } from '../src/world/personalDrops.ts';
import type { PlayerCheckpoint, SpaceActor } from '../src/world/spaceActor.ts';
import {
  BESIDE_GHOST,
  CUDGEL,
  GHOST_AT,
  MOONSTONE,
  RESPAWN_MS,
  STRIKER,
  arena,
  attackGhost,
  carrying,
  engage,
  face,
  payloads,
  wounded,
} from './support/combat.ts';
import { recordingOutbox } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeSector, makeSectorLine, makeWorld } from './support/sectorFactory.ts';
import type { AttachPlayerOptions } from './support/sectorFactory.ts';

/** What every dreamer sharing the Ghost finds where it was driven off, in an arena with drops. */
const DAGGER_DROP = { kind: 'item', baseId: 'dagger', rarity: 'plain' } as const;

/** Caps enough to fill a bag, their ids in the order a dreamer came by them. */
const FULL_BAG: ItemInstance[] = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({
  id: `00000000-0000-7000-8000-${String(index + 10).padStart(12, '0')}`,
  ...plain('cap'),
}));

/** A dreamer on a recording outbox. */
function join(space: SpaceActor, at: Point, name: string, inventory: Inventory = carrying(), character: AttachPlayerOptions['character'] = {}) {
  const { outbox, sent } = recordingOutbox();
  const { entityId } = attachPlayer(space, at, name, { outbox, inventory, character });
  return { entityId, sent };
}

/**
 * An arena with drops where a Fighter beside the Ghost drives it off with three swings. Bystanders
 * join first, `near` within the share radius and `far` beyond it.
 */
function driveOff(strikerInventory: Inventory = carrying({ worn: [CUDGEL] })) {
  const fight = arena({}, { drops: true });
  const { clock, space } = fight;
  const near = join(space, { x: 10, z: 15.9 }, 'near');
  const far = join(space, { x: 10, z: 16.1 }, 'far');
  const { outbox, sent } = recordingOutbox();
  const { entityId } = attachPlayer(space, BESIDE_GHOST, 'striker', { outbox, character: STRIKER, inventory: strikerInventory });
  const striker = { entityId, sent };
  attackGhost(space, entityId);
  for (let swing = 0; swing < 3; swing += 1) {
    space.step(0);
    clock.ms += 1000;
  }
  const lootOf = (dreamer: { sent: SomnioMessage[] }) => payloads(dreamer.sent, 'loot')[0]!.lootId;
  return { ...fight, striker, near, far, lootOf };
}

const gone = (dreamer: { sent: SomnioMessage[] }) => payloads(dreamer.sent, 'lootGone');
const pickedUp = (dreamer: { sent: SomnioMessage[] }) => payloads(dreamer.sent, 'inventory').flatMap((inventory) => inventory.pickedUp ?? []);
const dropped = (dreamer: { sent: SomnioMessage[] }) => payloads(dreamer.sent, 'inventory').flatMap((inventory) => inventory.dropped ?? []);

/** Walks the dreamer along their line of z to `toX` in accepted moves, a second of clock apart. */
function walkTo(space: SpaceActor, clock: { ms: number }, entityId: string, toX: number): void {
  const { z, ...at } = space.snapshotForPlayer(entityId)!.character.position;
  let x = at.x;
  while (x !== toX) {
    x = toX > x ? Math.min(x + 1.5, toX) : Math.max(x - 1.5, toX);
    clock.ms += 1000;
    space.handleMove({ x, z, facing: 0, gait: 'jog' }, entityId);
  }
}

/**
 * Where the drops scatter to from where the Ghost stood, as near as a scatter goes: rolls of 0 fan
 * the two out from south, the first to join's south and the striker's north.
 */
const SCATTERED = {
  near: { x: GHOST_AT.x, z: GHOST_AT.z + SCATTER_DISTANCE.min },
  striker: { x: GHOST_AT.x, z: GHOST_AT.z - SCATTER_DISTANCE.min },
};
/** North of the Ghost, within reach of the striker's drop. */
const BY_STRIKERS_DROP = { x: 10, z: 9.4, facing: 180, gait: 'jog' } as const;

describe('a drop', () => {
  it('scatters from where the nightmare was driven off for each dreamer sharing it, fanned out on headings of their own, sent to that dreamer alone', () => {
    const { striker, near, far, lootOf } = driveOff();
    for (const [dreamer, landing] of [
      [striker, SCATTERED.striker],
      [near, SCATTERED.near],
    ] as const) {
      expect(payloads(dreamer.sent, 'loot')).toEqual([{ lootId: lootOf(dreamer), ...landing, contents: DAGGER_DROP, from: GHOST_AT }]);
    }
    expect(lootOf(near)).not.toBe(lootOf(striker));
    expect(payloads(far.sent, 'loot')).toEqual([]);
  });

  it('is picked up into the bag from within reach, gone for its owner, and answered with what was picked up', () => {
    const { space, striker, near, lootOf } = driveOff();
    space.handlePickUp(lootOf(near), striker.entityId);
    expect([gone(striker), gone(near), pickedUp(striker)]).toEqual([[], [], []]);

    space.handleMove(BY_STRIKERS_DROP, striker.entityId);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect(gone(striker)).toEqual([{ lootId: lootOf(striker) }]);
    expect(pickedUp(striker)).toEqual([DAGGER_DROP]);
    expect(space.snapshotForPlayer(striker.entityId)!.inventory.bag).toEqual([
      { place: 0, item: expect.objectContaining({ baseId: 'dagger', tier: 1, rarity: 'plain', affixes: [] }) },
    ]);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect(pickedUp(striker)).toHaveLength(1);
  });

  it('is refused out of reach and into a full bag, and stays where it lies', () => {
    const { space, striker, near, lootOf } = driveOff(carrying({ worn: [CUDGEL], bag: FULL_BAG }));
    space.handleMove(BY_STRIKERS_DROP, striker.entityId);
    space.handlePickUp(lootOf(near), near.entityId);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect([gone(near), pickedUp(near), gone(striker), pickedUp(striker)]).toEqual([[], [], [], []]);

    // Within reach, and with a cap worn out of the bag.
    space.handleMove({ x: 10, z: 10.9, facing: 0, gait: 'jog' }, near.entityId);
    space.handlePickUp(lootOf(near), near.entityId);
    space.handleEquip(FULL_BAG[0]!.id, undefined, striker.entityId);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect([pickedUp(near), pickedUp(striker)]).toEqual([[DAGGER_DROP], [DAGGER_DROP]]);
  });

  it('lies for its owner alone wherever they stand: shown to no one else who comes into view of its sector, and not gone as its owner goes out of view', () => {
    const hits = { nextUInt32: () => 0 };
    const world = makeWorld(makeSectorLine({ west: { monsterSpawns: [makeMonsterSpawn(GHOST_AT)] } }));
    const { clock, space } = makeClockedSpace(world, OUTDOOR_SPACE_ID, { random: hits, lootRandom: hits });
    clock.ms = RESPAWN_MS;
    space.step(0);
    const striker = join(space, BESIDE_GHOST, 'striker', carrying({ worn: [CUDGEL] }), STRIKER);
    const east = join(space, { x: 45, z: 10 }, 'east');
    attackGhost(space, striker.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    const [drop] = payloads(striker.sent, 'loot');
    expect(drop?.contents).toEqual(DAGGER_DROP);

    walkTo(space, clock, east.entityId, 25);
    walkTo(space, clock, striker.entityId, 45);
    expect([payloads(east.sent, 'loot'), gone(striker)]).toEqual([[], []]);
    walkTo(space, clock, striker.entityId, BESIDE_GHOST.x);
    space.handlePickUp(drop!.lootId, striker.entityId);
    expect(pickedUp(striker)).toEqual([DAGGER_DROP]);
  });

  it('lies on the ground for hours on the clock of the space', () => {
    const { clock, space, striker, lootOf } = driveOff();
    clock.ms += 24 * 3600 * 1000;
    space.step(0);
    expect(gone(striker)).toEqual([]);
    space.handleMove(BY_STRIKERS_DROP, striker.entityId);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect(pickedUp(striker)).toEqual([DAGGER_DROP]);
  });
});

/**
 * The outdoor arena and the room `Hall`, each with a Ghost at `GHOST_AT`, on one clock and one
 * ledger of drops, as the world's spaces are, and a Fighter beside the outdoor Ghost whose drive-offs
 * each leave them a dagger. `moveTo` hands them over to a space beside its Ghost on the same
 * outbox, as a door or a wake does.
 */
function twoArenas() {
  const ghost = { monsterSpawns: [makeMonsterSpawn(GHOST_AT)] };
  const world = makeWorld([makeSector('TestSector', ghost), interiorSector('Hall', { size: { width: 20, depth: 20 }, ...ghost })]);
  const personalDrops = new PersonalDrops();
  const hits = { nextUInt32: () => 0 };
  const { clock, space: outdoors } = makeClockedSpace(world, OUTDOOR_SPACE_ID, { random: hits, lootRandom: hits, personalDrops });
  const { space: hall } = makeClockedSpace(world, 'Hall', { random: hits, lootRandom: hits, personalDrops, now: () => clock.ms });
  const spaceIds = new Map([
    [outdoors, OUTDOOR_SPACE_ID],
    [hall, 'Hall'],
  ]);
  const ghostsDriven = new Map([
    [outdoors, 0],
    [hall, 0],
  ]);
  const { outbox, sent } = recordingOutbox();
  const { entityId } = attachPlayer(outdoors, BESIDE_GHOST, 'striker', { outbox, character: STRIKER, inventory: carrying({ worn: [CUDGEL] }) });
  const striker = { entityId, sent };
  let current = outdoors;
  /** Waits out the Ghost's respawn, resting, and drives the new one off with three swings. */
  const driveOffIn = (space: SpaceActor) => {
    clock.ms += RESPAWN_MS;
    space.step(RESPAWN_MS / 1000);
    const number = ghostsDriven.get(space)! + 1;
    ghostsDriven.set(space, number);
    face(space, entityId, GHOST_AT);
    engage(space, `monster:${number}`, entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
  };
  const moveTo = (space: SpaceActor) => {
    const { checkpoint, transient } = current.handOver(entityId, false)!;
    space.attach({ ...checkpoint.character, space: spaceIds.get(space)!, position: BESIDE_GHOST }, checkpoint.inventory, outbox, 0, 'en', transient);
    current = space;
  };
  return { outdoors, hall, personalDrops, striker, driveOffIn, moveTo };
}

/** The frames the dreamer was sent since `mark` frames in. */
const since = (dreamer: { sent: SomnioMessage[] }, mark: number) => ({ sent: dreamer.sent.slice(mark) });

describe("a drop from a nightmare across the world's spaces", () => {
  it('waits for its owner through a door and a wake, and is sent again without its throw as they come back into its space', () => {
    const { outdoors, hall, striker, driveOffIn, moveTo } = twoArenas();
    driveOffIn(outdoors);
    const { lootId, x, z, contents } = payloads(striker.sent, 'loot')[0]!;
    const lying = { lootId, x, z, contents };

    let mark = striker.sent.length;
    moveTo(hall);
    expect(payloads(since(striker, mark).sent, 'loot')).toEqual([]);
    mark = striker.sent.length;
    moveTo(outdoors);
    const back = since(striker, mark).sent;
    expect(payloads(back, 'loot')).toEqual([lying]);
    expect(back.at(-1)).toEqual({ tag: 'loot', payload: lying });
    mark = striker.sent.length;
    // A wake hands the dreamer over as a door does, here into the space the drop lies in.
    moveTo(outdoors);
    expect(payloads(since(striker, mark).sent, 'loot')).toEqual([lying]);
    expect(gone(striker)).toEqual([]);

    mark = striker.sent.length;
    outdoors.handlePickUp(lootId, striker.entityId);
    expect(pickedUp(since(striker, mark))).toEqual([DAGGER_DROP]);
  });

  it('is gone once its owner leaves the world, so a new login of theirs finds none', () => {
    const { outdoors, hall, personalDrops, striker, driveOffIn, moveTo } = twoArenas();
    driveOffIn(outdoors);
    moveTo(hall);
    driveOffIn(hall);
    const left = hall.handOver(striker.entityId, true)!;
    // As the router does once the departing account's checkpoint is written.
    personalDrops.forget(striker.entityId);

    for (const [space, spaceId] of [
      [outdoors, OUTDOOR_SPACE_ID],
      [hall, 'Hall'],
    ] as const) {
      const login = recordingOutbox();
      space.attach({ ...left.checkpoint.character, space: spaceId, position: BESIDE_GHOST }, left.checkpoint.inventory, login.outbox, 0, 'en');
      space.handlePickUp('loot-1', striker.entityId);
      expect([payloads(login.sent, 'loot'), pickedUp(login)]).toEqual([[], []]);
      space.handOver(striker.entityId, true);
    }
  });

  it("past the cap takes its owner's oldest away wherever it lies, telling them only where they stand", () => {
    const { outdoors, hall, striker, driveOffIn, moveTo } = twoArenas();
    driveOffIn(outdoors);
    moveTo(hall);
    for (let count = 1; count < MAX_PERSONAL_DROPS; count += 1) driveOffIn(hall);
    expect(gone(striker)).toEqual([]);

    moveTo(outdoors);
    driveOffIn(outdoors);
    expect(gone(striker)).toEqual([{ lootId: 'loot-1' }]);
    driveOffIn(outdoors);
    expect(gone(striker)).toEqual([{ lootId: 'loot-1' }]);

    const mark = striker.sent.length;
    moveTo(hall);
    const inHall = payloads(since(striker, mark).sent, 'loot').map(({ lootId }) => lootId);
    expect(inHall).toEqual(Array.from({ length: MAX_PERSONAL_DROPS - 2 }, (_, index) => `loot-${index + 2}`));
  });

  it('frees its place under the cap once its owner picks it up', () => {
    const { outdoors, striker, driveOffIn } = twoArenas();
    for (let count = 0; count < MAX_PERSONAL_DROPS; count += 1) driveOffIn(outdoors);
    outdoors.handlePickUp('loot-2', striker.entityId);
    expect(pickedUp(striker)).toEqual([DAGGER_DROP]);

    driveOffIn(outdoors);
    expect(gone(striker)).toEqual([{ lootId: 'loot-2' }]);
    driveOffIn(outdoors);
    expect(gone(striker)).toEqual([{ lootId: 'loot-2' }, { lootId: 'loot-1' }]);
  });
});

/** A magic cap whose stat line has to survive the ground. */
const MAGIC_CAP: ItemInstance = {
  id: '00000000-0000-7000-8000-000000000009',
  baseId: 'cap',
  tier: 1,
  rarity: 'magic',
  affixes: [{ affixId: 'guard', value: 2 }],
};
const CAP_DROP = { kind: 'item', baseId: 'cap', rarity: 'magic' } as const;

/** Where the dreamer in West throws the magic cap from, and where it lands thrown east in the open. */
const DROPPER_AT = { x: 5, z: 10 };
const LANDED = { x: expect.closeTo(DROPPER_AT.x + THROW_DISTANCE, 9), z: DROPPER_AT.z };

/**
 * West (x 0 to 20), Middle (20 to 40), East (40 to 60), where a dreamer in West throws the magic
 * cap east: `beside` stands within pickup reach of where it lands, `middle` sees West from Middle,
 * and `east` does not.
 */
function dropInWest() {
  const { clock, space } = makeClockedSpace(makeWorld(makeSectorLine()));
  const dropper = join(space, DROPPER_AT, 'dropper', carrying({ worn: [CUDGEL], bag: [MAGIC_CAP] }));
  const beside = join(space, { x: 5.8, z: 10 }, 'beside');
  const middle = join(space, { x: 25, z: 10 }, 'middle');
  const east = join(space, { x: 45, z: 10 }, 'east');
  space.handleDropItem(MAGIC_CAP.id, 90, dropper.entityId);
  const walk = (entityId: string, toX: number) => walkTo(space, clock, entityId, toX);
  const lootId = payloads(dropper.sent, 'loot')[0]!.lootId;
  return { clock, space, dropper, beside, middle, east, walk, lootId };
}

describe('an item dropped to the ground', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is refused for the Moonstone, worn or carried, for an item the dreamer does not have, and from a fallen dreamer', () => {
    const persisted: PlayerCheckpoint[] = [];
    const { space } = makeClockedSpace(makeWorld(makeSectorLine()), OUTDOOR_SPACE_ID, {
      requestDropSave: (checkpoint) => {
        persisted.push(checkpoint);
      },
    });
    const wearing = join(space, { x: 5, z: 10 }, 'wearing', carrying({ worn: [MOONSTONE] }));
    const carrier = join(space, { x: 6, z: 10 }, 'carrier', carrying({ bag: [MOONSTONE] }));
    const fallen = join(space, { x: 8, z: 10 }, 'fallen', carrying({ worn: [CUDGEL], bag: [MAGIC_CAP] }), wounded(0));
    for (const itemId of [MOONSTONE.id, MAGIC_CAP.id]) space.handleDropItem(itemId, 90, wearing.entityId);
    space.handleDropItem(MOONSTONE.id, 90, carrier.entityId);
    for (const itemId of [CUDGEL.id, MAGIC_CAP.id]) space.handleDropItem(itemId, 90, fallen.entityId);
    for (const dreamer of [wearing, carrier, fallen]) expect([payloads(dreamer.sent, 'loot'), dropped(dreamer)]).toEqual([[], []]);
    expect(space.snapshotForPlayer(wearing.entityId)!.inventory).toEqual(carrying({ worn: [MOONSTONE] }));
    expect(space.snapshotForPlayer(carrier.entityId)!.inventory).toEqual(carrying({ bag: [MOONSTONE] }));
    expect(space.snapshotForPlayer(fallen.entityId)!.inventory).toEqual(carrying({ worn: [CUDGEL], bag: [MAGIC_CAP] }));
    expect(persisted).toEqual([]);
  });

  it("saves the dropper's checkpoint without it the moment it is thrown, ordered after one taken before in the same millisecond", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const persisted: PlayerCheckpoint[] = [];
    const { space } = makeClockedSpace(makeWorld(makeSectorLine()), OUTDOOR_SPACE_ID, {
      requestDropSave: (checkpoint) => {
        persisted.push(checkpoint);
      },
    });
    const dropper = join(space, DROPPER_AT, 'dropper', carrying({ worn: [CUDGEL], bag: [MAGIC_CAP] }));
    const beside = join(space, { x: 5.8, z: 10 }, 'beside');
    const before = space.snapshotForCheckpoint().find(({ character }) => character.id === dropper.entityId)!;

    space.handleDropItem(MAGIC_CAP.id, 90, dropper.entityId);
    expect(persisted.map(({ character, inventory }) => [character.id, inventory])).toEqual([[dropper.entityId, carrying({ worn: [CUDGEL] })]]);
    expect(persisted[0]!.character.lastSeen.getTime()).toBeGreaterThan(before.character.lastSeen.getTime());

    space.handlePickUp(payloads(dropper.sent, 'loot')[0]!.lootId, beside.entityId);
    expect(pickedUp(beside)).toEqual([CAP_DROP]);
    expect(persisted).toHaveLength(1);
  });

  it('past the cap of the space takes its oldest one away for everyone who sees it, and no drop from a nightmare', () => {
    const { space, striker, near, lootOf } = driveOff();
    const droppers = Array.from({ length: Math.ceil((MAX_SHARED_DROPS + 1) / FULL_BAG.length) }, (_, index) =>
      join(space, { x: 2 + index * 2, z: 3 }, `dropper-${index}`, carrying({ bag: FULL_BAG })),
    );
    const throws = droppers.flatMap((dropper) => FULL_BAG.map((item) => () => space.handleDropItem(item.id, 90, dropper.entityId)));
    for (const toss of throws.slice(0, MAX_SHARED_DROPS)) toss();
    expect(gone(striker)).toEqual([]);

    const oldest = payloads(striker.sent, 'loot').find(({ shared }) => shared === true)!.lootId;
    throws[MAX_SHARED_DROPS]!();
    for (const dreamer of [striker, near, ...droppers]) expect(gone(dreamer)).toEqual([{ lootId: oldest }]);
    space.handleMove(BY_STRIKERS_DROP, striker.entityId);
    space.handlePickUp(lootOf(striker), striker.entityId);
    expect(pickedUp(striker)).toEqual([DAGGER_DROP]);
  });

  it('is picked up by no fallen dreamer, neither their own drop nor one dropped for anyone, though both lie within reach', () => {
    const { space, striker, lootOf } = driveOff();
    const thrower = join(space, { x: 10, z: 7.6 }, 'thrower', carrying({ bag: [MAGIC_CAP] }));
    space.handleDropItem(MAGIC_CAP.id, 0, thrower.entityId);
    const shared = payloads(thrower.sent, 'loot')[0]!;
    const { checkpoint } = space.handOver(striker.entityId, false)!;
    const fallen = recordingOutbox();
    const lying = { x: 10, z: 9.2 };
    const character = { ...checkpoint.character, position: lying, energy: { ...checkpoint.character.energy, healthCurrent: 0 } };
    space.attach(character, checkpoint.inventory, fallen.outbox, 0, 'en');
    expect([withinPickupReach(lying, SCATTERED.striker), withinPickupReach(lying, shared)]).toEqual([true, true]);

    for (const lootId of [lootOf(striker), shared.lootId]) space.handlePickUp(lootId, striker.entityId);
    expect([gone(fallen), pickedUp(fallen)]).toEqual([[], []]);
  });

  it('takes a worn item off and throws it in one step with the bag full, shown thrown from the hand it left before that hand is shown empty, the inventory after', () => {
    const { space } = makeClockedSpace(makeWorld(makeSectorLine()));
    const dropper = join(space, DROPPER_AT, 'dropper', carrying({ worn: [CUDGEL, MAGIC_CAP], bag: FULL_BAG }));
    const beside = join(space, { x: 5.8, z: 10 }, 'beside');
    const order = (dreamer: { sent: SomnioMessage[] }, from: number) =>
      dreamer.sent.slice(from).flatMap(({ tag }) => (tag === 'loot' || tag === 'held' || tag === 'inventory' ? [tag] : []));
    const marks = [dropper.sent.length, beside.sent.length] as const;

    space.handleDropItem(CUDGEL.id, 90, dropper.entityId);
    expect([order(dropper, marks[0]), order(beside, marks[1])]).toEqual([
      ['loot', 'inventory', 'held'],
      ['loot', 'held'],
    ]);
    const cudgel = { kind: 'item', baseId: 'cudgel', rarity: 'plain' } as const;
    expect(payloads(beside.sent, 'loot').map(({ contents, from }) => [contents, from])).toEqual([
      [cudgel, { ...DROPPER_AT, entityId: dropper.entityId, hand: 'mainHand' }],
    ]);
    expect(payloads(beside.sent, 'held').at(-1)).toEqual({ entityId: dropper.entityId, held: {} });
    expect(dropped(dropper)).toEqual([cudgel]);

    const thrown = [dropper.sent.length, beside.sent.length] as const;
    space.handleDropItem(MAGIC_CAP.id, 90, dropper.entityId);
    expect([order(dropper, thrown[0]), order(beside, thrown[1])]).toEqual([['loot', 'inventory'], ['loot']]);
    expect(payloads(beside.sent, 'loot').at(-1)!.from).toEqual({ ...DROPPER_AT, entityId: dropper.entityId });
    expect(space.snapshotForPlayer(dropper.entityId)!.inventory).toEqual(carrying({ bag: FULL_BAG }));
  });

  it('leaves the bag at once and lands a throw away along the heading, thrown from the dreamer for everyone who sees its sector, and no one else', () => {
    const { space, dropper, beside, middle, east, lootId } = dropInWest();
    expect(dropped(dropper)).toEqual([CAP_DROP]);
    expect(space.snapshotForPlayer(dropper.entityId)!.inventory.bag).toEqual([]);
    for (const dreamer of [dropper, beside, middle]) {
      expect(payloads(dreamer.sent, 'loot')).toEqual([
        { lootId, ...LANDED, contents: CAP_DROP, shared: true, from: { ...DROPPER_AT, entityId: dropper.entityId } },
      ]);
    }
    expect(payloads(east.sent, 'loot')).toEqual([]);
    const late = join(space, { x: 30, z: 10 }, 'late');
    expect(payloads(late.sent, 'loot')).toEqual([{ lootId, ...LANDED, contents: CAP_DROP, shared: true }]);
  });

  it('lands short of a wall in the way, on the side it was thrown from', () => {
    const wall = { id: 'wall', x: 5.6, z: 0, width: 0.2, depth: 20 };
    const { space } = makeClockedSpace(makeWorld(makeSectorLine({ west: { blockers: [wall] } })));
    const dropper = join(space, DROPPER_AT, 'dropper', carrying({ bag: [MAGIC_CAP] }));
    space.handleDropItem(MAGIC_CAP.id, 90, dropper.entityId);
    const [landed] = payloads(dropper.sent, 'loot');
    expect(landed!.z).toBe(DROPPER_AT.z);
    expect(landed!.x).toBeGreaterThan(DROPPER_AT.x);
    expect(landed!.x).toBeLessThan(wall.x);
  });

  it('comes into view and goes out of it with its sector, lying where it landed', () => {
    const { east, walk, lootId } = dropInWest();
    walk(east.entityId, 39);
    expect(payloads(east.sent, 'loot')).toEqual([{ lootId, ...LANDED, contents: CAP_DROP, shared: true }]);
    walk(east.entityId, 42);
    expect(gone(east)).toEqual([{ lootId }]);
  });

  it('is picked up whole by whoever asks first from within reach, and is gone for everyone who saw it', () => {
    const { space, dropper, beside, middle, east, lootId } = dropInWest();
    space.handlePickUp(lootId, middle.entityId);
    expect(pickedUp(middle)).toEqual([]);

    space.handlePickUp(lootId, beside.entityId);
    space.handlePickUp(lootId, dropper.entityId);
    expect([pickedUp(beside), pickedUp(dropper)]).toEqual([[CAP_DROP], []]);
    const taken = space.snapshotForPlayer(beside.entityId)!.inventory.bag[0]?.item;
    expect(taken).toEqual({ ...MAGIC_CAP, id: expect.any(String) });
    expect(taken!.id).not.toBe(MAGIC_CAP.id);
    for (const dreamer of [dropper, beside, middle]) expect(gone(dreamer)).toEqual([{ lootId }]);
    expect(gone(east)).toEqual([]);
  });

  it('is gone for everyone who sees it once it has lain on the ground for its time', () => {
    const { clock, space, dropper, middle, east, lootId } = dropInWest();
    clock.ms += SHARED_LOOT_SECONDS * 1000 - 1;
    space.step(0);
    expect(gone(dropper)).toEqual([]);
    clock.ms += 1;
    space.step(0);
    expect([gone(dropper), gone(middle), gone(east)]).toEqual([[{ lootId }], [{ lootId }], []]);
  });

  it('is held by one dreamer alone in every checkpoint, and stays on the ground when its dropper leaves', () => {
    const { space, dropper, beside, lootId } = dropInWest();
    const holders = () =>
      space.snapshotForCheckpoint().filter(({ inventory }) => inventory.bag.some(({ item }) => item.baseId === 'cap' && item.rarity === 'magic'));
    expect(holders()).toEqual([]);

    const left = space.handOver(dropper.entityId, true)!;
    expect(left.checkpoint.inventory).toEqual(carrying({ worn: [CUDGEL] }));
    space.handlePickUp(lootId, beside.entityId);
    expect(holders().map(({ character }) => character.id)).toEqual([beside.entityId]);
  });
});
