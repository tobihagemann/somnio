import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol'
import type {
  BumpNPCMessage,
  EnterPortalMessage,
  EquipToggleMessage,
  PositionMessage,
  SayMessage,
} from '@somnio/protocol'
import { SOMNIO_CONSTANTS, arrivalSpawn, inventoryRowToWire, sectorPixelCenter } from '@somnio/core'
import type { ConnectionActor } from '../connection/connectionActor.ts'
import type { ConnectionDependencies } from '../connection/dependencies.ts'
import type { ConnectionOutbox } from '../connection/outbox.ts'

/** The new sector-local entity index after a portal hop; it must replace the source sector's on the connection. */
export interface PortalOutcome {
  sectorName: string
  entityIndex: number
}

/**
 * The player left the source sector and could be attached nowhere: the connection must not keep
 * an entity index that the sector may hand to a later joiner.
 */
export const PORTAL_LOST = 'lost'

export function handlePosition(
  message: PositionMessage,
  entityIndex: number,
  sectorName: string,
  dependencies: ConnectionDependencies
): void {
  dependencies.worldRouter.sector(sectorName)?.handlePosition(message, entityIndex)
}

/** An over-cap chat line is dropped silently; the socket stays open. */
export function handleSay(
  message: SayMessage,
  entityIndex: number,
  sectorName: string,
  dependencies: ConnectionDependencies
): void {
  if (utf8ByteLength(message.text) > SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes) return
  dependencies.worldRouter.sector(sectorName)?.handleSay(message, entityIndex)
}

export function handleEquipToggle(
  message: EquipToggleMessage,
  entityIndex: number,
  sectorName: string,
  outbox: ConnectionOutbox,
  dependencies: ConnectionDependencies
): void {
  const rows = dependencies.worldRouter
    .sector(sectorName)
    ?.handleEquipToggle(message.slot, message.hand, entityIndex)
  if (rows === undefined) return
  outbox.sendEncoded(
    { tag: 'inventory', payload: { rows: rows.map(inventoryRowToWire) } },
    dependencies.logger
  )
}

export function handleBumpNPC(
  message: BumpNPCMessage,
  entityIndex: number,
  sectorName: string,
  dependencies: ConnectionDependencies
): void {
  dependencies.worldRouter.sector(sectorName)?.handleBumpNPC(message.npcIndex, entityIndex)
}

/**
 * The portal hop. `undefined` leaves the player where they are: with a snap-back when the index
 * is out of range, names an arrival marker rather than a trigger, or points at an unknown sector;
 * silently when the source sector or the player's slot is gone. `PORTAL_LOST` means the player
 * is attached nowhere. Placement is the inbound arrival portal keyed to the source, then the
 * destination's arrival spawn, then its center.
 */
export function handleEnterPortal(
  message: EnterPortalMessage,
  entityIndex: number,
  sectorName: string,
  connection: ConnectionActor,
  dependencies: ConnectionDependencies
): PortalOutcome | typeof PORTAL_LOST | undefined {
  const logger = dependencies.logger
  const oldSector = dependencies.worldRouter.sector(sectorName)
  if (oldSector === undefined) return undefined
  const portal = oldSector.staticSector.portals[message.portalIndex]
  if (message.portalIndex < 0 || portal === undefined) {
    logger.warn({ portal_index: message.portalIndex, sector: sectorName }, 'enter_portal index out of range')
    oldSector.snapBack(entityIndex)
    return undefined
  }
  // Only outbound triggers are walk-into portals; a crafted frame naming an arrival marker would
  // teleport without reaching a trigger zone.
  if (portal.direction !== 'outboundTrigger') {
    logger.warn(
      { direction: portal.direction, portal_index: message.portalIndex, sector: sectorName },
      'enter_portal non-trigger direction'
    )
    oldSector.snapBack(entityIndex)
    return undefined
  }
  const newSector = dependencies.worldRouter.sector(portal.targetSectorName)
  if (newSector === undefined) {
    logger.warn({ error: 'unknown_target', target: portal.targetSectorName }, 'enter_portal unknown target')
    oldSector.snapBack(entityIndex)
    return undefined
  }
  const checkpoint = oldSector.snapshotForPlayer(entityIndex)
  if (checkpoint === undefined) return undefined
  oldSector.detach(entityIndex, false)
  const destination = newSector.staticSector
  const position =
    newSector.arrivalPlacement(sectorName, SOMNIO_CONSTANTS.playerSpriteSize) ??
    arrivalSpawn(destination) ??
    sectorPixelCenter(destination)
  const moved = { ...checkpoint.character, currentSector: portal.targetSectorName, position }
  try {
    const newEntityIndex = newSector.attach(moved, checkpoint.inventory, connection.outbox)
    connection.outbox.sendEncoded(
      { tag: 'dateTick', payload: dependencies.worldClock.currentDateTickMessage() },
      logger
    )
    return { sectorName: portal.targetSectorName, entityIndex: newEntityIndex }
  } catch (error) {
    // The source slot is already released, so the connection cannot keep its old index: put the
    // player back where they came from (the client reloads the sector on the second
    // `enterSector`), and if even that fails, report the loss so the actor closes.
    logger.error({ error: String(error), target: portal.targetSectorName }, 'failed to attach on portal')
    try {
      const restoredIndex = oldSector.attach(checkpoint.character, checkpoint.inventory, connection.outbox)
      return { sectorName, entityIndex: restoredIndex }
    } catch (restoreError) {
      logger.error({ error: String(restoreError), sector: sectorName }, 'failed to restore after portal')
      return PORTAL_LOST
    }
  }
}
