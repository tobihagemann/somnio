import Foundation
import Logging
import SomnioCore
import SomnioProtocol

/// Thin glue between a `ConnectionActor`-decoded gameplay message and the per-sector actor
/// that owns the affected runtime state. All `await`s are short calls into the per-sector
/// actor; no I/O happens on the read loop's task.
public enum GameplayHandlers {
    /// Outcome of a successful portal hop. The new `entityIndex` is sector-local and must
    /// replace the source sector's value on the connection — otherwise position/equip/say
    /// frames address the wrong slot in the new sector.
    public struct PortalOutcome: Sendable, Equatable {
        public let sectorName: String
        public let entityIndex: Int16

        public init(sectorName: String, entityIndex: Int16) {
            self.sectorName = sectorName
            self.entityIndex = entityIndex
        }
    }

    public static func handlePosition(
        _ message: PositionMessage,
        entityIndex: Int16,
        sectorName: String,
        dependencies: ConnectionDependencies
    ) async {
        guard let sectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) else { return }
        await sectorActor.handlePosition(message, from: entityIndex)
    }

    public static func handleSay(
        _ message: SayMessage,
        entityIndex: Int16,
        sectorName: String,
        dependencies: ConnectionDependencies
    ) async {
        guard let sectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) else { return }
        await sectorActor.handleSay(message, from: entityIndex)
    }

    public static func handleEquipToggle(
        _ message: EquipToggleMessage,
        entityIndex: Int16,
        sectorName: String,
        outbox: ConnectionOutbox,
        dependencies: ConnectionDependencies
    ) async {
        guard let sectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) else { return }
        let result = await sectorActor.handleEquipToggle(slot: message.slot, hand: message.hand, from: entityIndex)
        guard let result else { return }
        outbox.sendEncoded(
            .inventory(InventoryMessage(rows: result.inventory.map(\.asWire))),
            logger: dependencies.logger
        )
    }

    public static func handleBumpNPC(
        _ message: BumpNPCMessage,
        entityIndex: Int16,
        sectorName: String,
        dependencies: ConnectionDependencies
    ) async {
        guard let sectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) else { return }
        await sectorActor.handleBumpNPC(npcIndex: message.npcIndex, from: entityIndex)
    }

    /// Returns the new sector + entity index when the portal resolves; otherwise `nil` and
    /// the connection stays in the original sector. An unknown destination logs a warning,
    /// snaps the player back via `serverPosition`, and keeps the socket open — application-
    /// layer mismatches do not trigger the wire-protocol terminal close path.
    public static func handleEnterPortal(
        _ message: EnterPortalMessage,
        entityIndex: Int16,
        sectorName: String,
        connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies
    ) async -> PortalOutcome? {
        let portalLogger = Logger(label: "de.tobiha.somnio.server.gameplay.portal")
        guard let oldSectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) else {
            return nil
        }
        let portalIndex = Int(message.portalIndex)
        guard portalIndex >= 0, portalIndex < oldSectorActor.staticSector.portals.count else {
            portalLogger.warning(
                "enter_portal index out of range",
                metadata: ["portal_index": "\(portalIndex)", "sector": "\(sectorName)"]
            )
            await oldSectorActor.snapBack(entityIndex: entityIndex)
            return nil
        }
        let portal = oldSectorActor.staticSector.portals[portalIndex]
        guard let newSectorActor = await dependencies.worldRouter.sectorActor(named: portal.targetSectorName) else {
            portalLogger.warning(
                "enter_portal unknown target",
                metadata: ["error": "unknown_target", "target": "\(portal.targetSectorName)"]
            )
            await oldSectorActor.snapBack(entityIndex: entityIndex)
            return nil
        }
        guard let checkpoint = await oldSectorActor.snapshotForPlayer(entityIndex: entityIndex) else { return nil }
        await oldSectorActor.detach(entityIndex: entityIndex, leftGame: false)
        var movedCharacter = checkpoint.character
        movedCharacter.currentSector = portal.targetSectorName
        do {
            let outbox = await connectionActor.connectionOutbox
            let newEntityIndex = try await newSectorActor.attach(
                character: movedCharacter,
                inventory: checkpoint.inventory,
                outbox: outbox
            )
            // Re-emit the day/night state so the destination sector renders with the right
            // tint as soon as the client renders the new sector.
            let dateTick = await dependencies.worldClock.currentDateTickMessage()
            outbox.sendEncoded(.dateTick(dateTick), logger: dependencies.logger)
            return PortalOutcome(sectorName: portal.targetSectorName, entityIndex: newEntityIndex)
        } catch {
            portalLogger.error("failed to attach on portal", metadata: ["error": "\(error)"])
            return nil
        }
    }
}
