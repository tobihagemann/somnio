import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type {
  AskTaskMessage,
  BuyMessage,
  ClientSayMessage,
  CompleteTaskMessage,
  EngageMessage,
  EquipToggleMessage,
  MoveMessage,
  SellMessage,
  StudyMessage,
  TalkMessage,
  TargetMessage,
  UseAbilityMessage,
  UseDoorMessage,
  UseItemMessage,
} from '@somnio/protocol';
import { COMBAT, SOMNIO_CONSTANTS, doorContains, doorOpenAt } from '@somnio/core';
import type { Character } from '@somnio/core';
import type { ConnectionActor } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import { counterpartOf, doorIn } from '../sectors/sectorCache.ts';

/** Where the player stands after a transfer; it must replace the source space on the connection. */
export interface TransferOutcome {
  spaceId: string;
}

/**
 * The player left the source space and could be attached nowhere: the connection must not keep
 * pointing at a space that no longer holds them.
 */
export const TRANSFER_LOST = 'lost';

export function handleMove(message: MoveMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleMove(message, entityId);
}

/** An over-cap chat line is dropped silently; the socket stays open. */
export function handleSay(message: ClientSayMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  if (utf8ByteLength(message.text) > SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes) return;
  dependencies.worldRouter.say(spaceId, entityId, message);
}

export function handleEquipToggle(message: EquipToggleMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleEquipToggle(message.slot, message.hand, entityId);
}

export function handleTalk(message: TalkMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleTalk(message.npcId, entityId);
}

export function handleTarget(message: TargetMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleTarget(message.targetId, entityId);
}

export function handleEngage(message: EngageMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleEngage(message.on, entityId);
}

export function handleUseAbility(message: UseAbilityMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleUseAbility(message.abilityId, entityId);
}

export function handleUseItem(message: UseItemMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleUseItem(message.slot, entityId);
}

export function handleAskTask(message: AskTaskMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleAskTask(message.npcId, message.teachingId, entityId);
}

export function handleCompleteTask(message: CompleteTaskMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleCompleteTask(message.npcId, entityId);
}

export function handleAbandonTask(entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleAbandonTask(entityId);
}

export function handleStudy(message: StudyMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleStudy(message.npcId, message.teachingId, entityId);
}

export function handleBuy(message: BuyMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleBuy(message.npcId, message.itemId, entityId);
}

export function handleSell(message: SellMessage, entityId: string, spaceId: string, dependencies: ConnectionDependencies): void {
  dependencies.worldRouter.space(spaceId)?.handleSell(message.npcId, message.itemId, entityId);
}

/**
 * Moves a player from one space to where `arrive` places them, with `enterSpace` first in what they
 * are sent. The source hands the player over before the attach, so any heal tick due as they leave
 * arrives with them, and a failed attach puts them back where they came from. The effects and
 * cooldowns the source hands back go with the player either way. The restoring `enterSpace` is
 * what releases a client waiting on the transfer. If even the restore fails, the loss is reported
 * so the actor closes.
 */
function transferPlayer(
  entityId: string,
  spaceId: string,
  arrive: (character: Character) => Character,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): TransferOutcome | typeof TRANSFER_LOST {
  const logger = dependencies.logger;
  const oldSpace = dependencies.worldRouter.space(spaceId)!;
  const worldSeconds = dependencies.worldClock.currentWorldSeconds();
  const { checkpoint, transient } = oldSpace.handOver(entityId, false)!;
  const moved = arrive(checkpoint.character);
  try {
    dependencies.worldRouter.space(moved.space)!.attach(moved, checkpoint.inventory, connection.outbox, worldSeconds, connection.locale, transient);
    return { spaceId: moved.space };
  } catch (error) {
    logger.error({ error: String(error), space: moved.space }, 'failed to attach after transfer');
    try {
      oldSpace.attach(checkpoint.character, checkpoint.inventory, connection.outbox, worldSeconds, connection.locale, transient);
      return { spaceId };
    } catch (restoreError) {
      logger.error({ error: String(restoreError), space: spaceId }, 'failed to restore after transfer');
      return TRANSFER_LOST;
    }
  }
}

/**
 * The door transfer. `undefined` leaves the player where they are. It comes with a `doorRefused`
 * when the player's space has no such door, the player stands outside its trigger or lies fallen,
 * or the door opens only at night and the sun is up. It comes silently when the source space or the
 * player's slot is gone. `TRANSFER_LOST` means the player is attached nowhere.
 * The player arrives in front of the counterpart door, facing away from it, whoever already
 * stands there: an overlapping pair can always separate.
 */
export function handleUseDoor(
  message: UseDoorMessage,
  entityId: string,
  spaceId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): TransferOutcome | typeof TRANSFER_LOST | undefined {
  const world = dependencies.worldRouter.world;
  const oldSpace = dependencies.worldRouter.space(spaceId);
  const position = oldSpace?.snapshotForPlayer(entityId)?.character.position;
  if (oldSpace === undefined || position === undefined) return undefined;
  const source = doorIn(world, spaceId, message.sector, message.doorId);
  if (
    source === undefined ||
    oldSpace.isFallen(entityId) ||
    !doorContains(source.resolved, position, SOMNIO_CONSTANTS.doorUseSlack) ||
    !doorOpenAt(source.door, dependencies.worldClock.currentWorldSeconds())
  ) {
    connection.outbox.sendEncoded({ tag: 'doorRefused', payload: { sector: message.sector, doorId: message.doorId } }, dependencies.logger);
    return undefined;
  }
  const { spaceId: newSpaceId, resolved: arrival } = counterpartOf(world, source.door);
  const arrive = (character: Character): Character => ({ ...character, space: newSpaceId, position: arrival.arrival, facing: arrival.facing });
  return transferPlayer(entityId, spaceId, arrive, connection, dependencies);
}

/**
 * Giving up: a fallen dreamer wakes at the world's wake-point with every pool at the weakened
 * fraction of its maximum.
 * `undefined` leaves the player where they are, which is all a standing dreamer's `wake` does.
 */
export function handleWake(
  entityId: string,
  spaceId: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies,
): TransferOutcome | typeof TRANSFER_LOST | undefined {
  const world = dependencies.worldRouter.world;
  const oldSpace = dependencies.worldRouter.space(spaceId);
  if (oldSpace === undefined || !oldSpace.isFallen(entityId)) return undefined;
  const weakened = (max: number): number => Math.ceil(max * COMBAT.weakenedFraction);
  const wake = (character: Character): Character => {
    const energy = character.energy;
    return {
      ...character,
      ...world.wakeSpawn,
      energy: { ...energy, healthCurrent: weakened(energy.healthMax), balanceCurrent: weakened(energy.balanceMax), spiritCurrent: weakened(energy.spiritMax) },
    };
  };
  return transferPlayer(entityId, spaceId, wake, connection, dependencies);
}
