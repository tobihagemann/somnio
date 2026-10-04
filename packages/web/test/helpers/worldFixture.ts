import { sectorView } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import type { Door, EntityMessage, SomnioMessage } from '@somnio/protocol';
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
    ...overrides,
  };
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

/** The first frame of a join: the space, and which entity in it is the local player. */
export function enterSpaceFrame(spaceId = 'outdoors', worldSeconds = 0): SomnioMessage {
  return { tag: 'enterSpace', payload: { spaceId, selfId: 'self', worldSeconds } };
}

export function sectorFrame(sector: Sector): SomnioMessage {
  return { tag: 'sector', payload: { sector: sectorView(sector) } };
}

/** The local player unless overridden, standing where `clientEntity` does. */
export function entityFrame(overrides: Partial<EntityMessage> = {}): SomnioMessage {
  return {
    tag: 'entity',
    payload: { id: 'self', kind: 'player', characterModelId: 'hero', name: 'Tester', radius: 0.3, x: 10, z: 10, facing: 0, gait: 'jog', ...overrides },
  };
}
