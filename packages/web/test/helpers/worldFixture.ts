import { baseItem, isBaseItemId, sectorView } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import { EQUIP_SLOTS } from '@somnio/protocol';
import type { Door, EntityMessage, EquipSlot, Outfit, SomnioMessage } from '@somnio/protocol';
import type { ClientEntity } from '@/client';

export function clientEntity(overrides: Partial<ClientEntity> = {}): ClientEntity {
  return {
    id: 'self',
    kind: 'player',
    characterModelId: 'hero',
    name: 'Tester',
    radius: 0.3,
    position: { x: 10, z: 10 },
    facing: 0,
    gait: 'jog',
    condition: 'hale',
    service: undefined,
    people: undefined,
    outfit: undefined,
    rank: undefined,
    trait: undefined,
    ...overrides,
  };
}

/** An outfit of `pieces`, each at its base's own tier, in `EQUIP_SLOTS` order. */
export function outfit(pieces: Partial<Record<EquipSlot, string>>): Outfit {
  return EQUIP_SLOTS.flatMap((slot) => {
    const baseId = pieces[slot];
    return baseId === undefined ? [] : [{ slot, baseId, tier: isBaseItemId(baseId) ? baseItem(baseId).tier : 1 }];
  });
}

/**
 * A door on a `door` placement of its own at `at`, opening north: its trigger is the 0.58 m of
 * ground north of `at`. Spread into a sector's overrides.
 */
export function makeDoor(id: string, at: Point, target: Door['target']): Pick<Sector, 'placements' | 'doors'> {
  return {
    placements: [{ id: `${id}-frame`, modelId: 'door', ...at, yaw: 0, elevation: 0 }],
    doors: [{ id, placement: `${id}-frame`, anchor: 'main', target }],
  };
}

/** The first frame of a join: the space, which entity in it is the local player, and their people. */
export function enterSpaceFrame(spaceId = 'outdoors', worldSeconds = 0, people = 'vigils'): SomnioMessage {
  return { tag: 'enterSpace', payload: { spaceId, selfId: 'self', people, worldSeconds } };
}

export function sectorFrame(sector: Sector, outdoorDoorIds?: string[]): SomnioMessage {
  return { tag: 'sector', payload: { sector: sectorView(sector), ...(outdoorDoorIds === undefined ? {} : { outdoorDoorIds }) } };
}

/** The local player unless overridden, standing where `clientEntity` does. */
export function entityFrame(overrides: Partial<EntityMessage> = {}): SomnioMessage {
  return {
    tag: 'entity',
    payload: {
      id: 'self',
      kind: 'player',
      characterModelId: 'hero',
      people: 'vigils',
      name: 'Tester',
      radius: 0.3,
      x: 10,
      z: 10,
      facing: 0,
      gait: 'jog',
      condition: 'hale',
      ...overrides,
    },
  };
}
