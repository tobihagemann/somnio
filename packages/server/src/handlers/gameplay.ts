import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { BumpMessage, ClientSayMessage, Door, EquipToggleMessage, MoveMessage, UseDoorMessage } from '@somnio/protocol';
import { SOMNIO_CONSTANTS, doorContains, resolveDoor } from '@somnio/core';
import type { ResolvedDoor } from '@somnio/core';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { inventoryMessage } from '../world/spaceActor.ts';

/** Where the player stands after a door transfer; it must replace the source space on the connection. */
export interface DoorOutcome {
  spaceId: string;
}

/**
 * The player left the source space and could be attached nowhere: the connection must not keep
 * pointing at a space that no longer holds them.
 */
export const DOOR_LOST = 'lost';

export function handleMove(message: MoveMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleMove(message, entityId);
}

/** An over-cap chat line is dropped silently; the socket stays open. */
export function handleSay(message: ClientSayMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  if (utf8ByteLength(message.text) > SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes) return;
  dependencies.worldRouter.space(spaceId)?.handleSay(message, entityId);
}

export function handleEquipToggle(
  message: EquipToggleMessage,
  entityId: string,
  spaceId: string,
  outbox: ConnectionOutbox,
  dependencies: ConnectionDependencies,
): void {
  const rows = dependencies.worldRouter.space(spaceId)?.handleEquipToggle(message.slot, message.hand, entityId);
  if (rows === undefined) return;
  outbox.sendEncoded({ tag: 'inventory', payload: inventoryMessage(rows) }, dependencies.logger);
}

export function handleBump(message: BumpMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleBump(message.targetId, entityId);
}

/** A live door of one of the space's sectors, resolved to its trigger and arrival point. */
function doorIn(world: LoadedWorld, spaceId: string, sectorName: string, doorId: string): { door: Door; resolved: ResolvedDoor } | undefined {
  const sector = world.spaces.get(spaceId)?.sectors.find((candidate) => candidate.name === sectorName);
  const door = sector?.doors.find((candidate) => candidate.id === doorId);
  if (sector === undefined || door === undefined) return undefined;
  const resolved = resolveDoor(sector, door, world.registry);
  return resolved === undefined ? undefined : { door, resolved };
}

/**
 * The door transfer. `undefined` leaves the player where they are. It comes with a `doorRefused`
 * when the player's space has no such door or the player stands outside its trigger, and silently
 * when the source space or the player's slot is gone. `DOOR_LOST` means the player is attached
 * nowhere.
 * The player arrives in front of the counterpart door, facing away from it, whoever already
 * stands there: an overlapping pair can always separate.
 */
export function handleUseDoor(
  message: UseDoorMessage,
  entityId: string,
  spaceId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): DoorOutcome | typeof DOOR_LOST | undefined {
  const logger = dependencies.logger;
  const world = dependencies.worldRouter.world;
  const oldSpace = dependencies.worldRouter.space(spaceId);
  const checkpoint = oldSpace?.snapshotForPlayer(entityId);
  if (oldSpace === undefined || checkpoint === undefined) return undefined;
  const source = doorIn(world, spaceId, message.sector, message.doorId);
  if (source === undefined || !doorContains(source.resolved, checkpoint.character.position, SOMNIO_CONSTANTS.doorUseSlack)) {
    connection.outbox.sendEncoded({ tag: 'doorRefused', payload: { sector: message.sector, doorId: message.doorId } }, logger);
    return undefined;
  }
  // The world keeps a door only as half of a sound pair, so the counterpart and its space resolve.
  const target = source.door.target;
  const newSpaceId = world.sectorSpace.get(target.sector)!;
  const newSpace = dependencies.worldRouter.space(newSpaceId)!;
  const arrival = doorIn(world, newSpaceId, target.sector, target.door)!.resolved;
  oldSpace.detach(entityId, false);
  const moved = { ...checkpoint.character, space: newSpaceId, position: arrival.arrival, facing: arrival.facing };
  const worldSeconds = dependencies.worldClock.currentWorldSeconds();
  try {
    newSpace.attach(moved, checkpoint.inventory, connection.outbox, worldSeconds);
    return { spaceId: newSpaceId };
  } catch (error) {
    // The source slot is already released, so put the player back where they came from (the
    // restoring `enterSpace` is what releases the client's wait), and if even that fails,
    // report the loss so the actor closes.
    logger.error({ error: String(error), target: target.sector }, 'failed to attach through door');
    try {
      oldSpace.attach(checkpoint.character, checkpoint.inventory, connection.outbox, worldSeconds);
      return { spaceId };
    } catch (restoreError) {
      logger.error({ error: String(restoreError), space: spaceId }, 'failed to restore after door');
      return DOOR_LOST;
    }
  }
}
