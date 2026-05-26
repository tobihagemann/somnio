import Foundation
import Logging
import SomnioCore
import Testing
@testable import SomnioServerCore

/// Coverage for `PerSectorActor.arrivalPlacement` — the source-keyed random portal placement a
/// player lands on after a portal hop. Uses a seeded generator so the sampled cell is
/// deterministic across runs.
struct ArrivalPlacementTests {
    @Test func `arrival lands inside the inbound portal keyed to the source sector`() async throws {
        // EdariaMitte's inbound portal back to EdariaBibliothek (the plan's verified rect).
        let portal = inboundPortal(from: "EdariaBibliothek", x: 1344, y: 208, width: 160, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaMitte", portal: portal),
            logger: testLogger,
            rng: SeededGenerator(seed: 1)
        )
        let point = try #require(await actor.arrivalPlacement(fromSector: portal.targetSectorName, spriteSize: SomnioConstants.playerSpriteSize))
        #expect(point.x >= portal.x && point.x < portal.x + portal.width)
        #expect(point.y >= portal.y && point.y < portal.y + portal.height)
    }

    @Test func `reverse arrival lands inside the EdariaBibliothek inbound portal`() async throws {
        let portal = inboundPortal(from: "EdariaMitte", x: 64, y: 384, width: 160, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaBibliothek", portal: portal),
            logger: testLogger,
            rng: SeededGenerator(seed: 2)
        )
        let point = try #require(await actor.arrivalPlacement(fromSector: portal.targetSectorName, spriteSize: SomnioConstants.playerSpriteSize))
        #expect(point.x >= portal.x && point.x < portal.x + portal.width)
        #expect(point.y >= portal.y && point.y < portal.y + portal.height)
    }

    @Test(arguments: [UInt64(1), 2, 3, 4, 5, 6, 7, 8])
    func `arrival keeps the feet box inside the arrival zone`(seed: UInt64) async throws {
        // Reverse arrival rect into EdariaBibliothek, whose door exit sits just below the zone — the
        // case where the feet box must stay fully inside the rect rather than sliding onto the door.
        let portal = inboundPortal(from: "EdariaMitte", x: 64, y: 384, width: 160, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaBibliothek", portal: portal),
            logger: testLogger,
            rng: SeededGenerator(seed: seed)
        )
        let point = try #require(await actor.arrivalPlacement(fromSector: portal.targetSectorName, spriteSize: SomnioConstants.playerSpriteSize))
        let feet = FeetMask.rect(forSpriteAt: point, spriteSize: SomnioConstants.playerSpriteSize)
        #expect(feet.y >= Int32(portal.y))
        #expect(feet.maxY <= Int32(portal.y) + Int32(portal.height))
    }

    @Test func `arrival returns nil when no inbound portal targets the source sector`() async {
        let portal = inboundPortal(from: "EdariaBibliothek", x: 1344, y: 208, width: 160, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaMitte", portal: portal),
            logger: testLogger
        )
        // The caller falls back to its own login spawn when this is nil.
        let point = await actor.arrivalPlacement(fromSector: "Nowhere", spriteSize: SomnioConstants.playerSpriteSize)
        #expect(point == nil)
    }

    @Test func `arrival avoids a static mask inside the portal`() async throws {
        // A mask covering the left third of the portal: the placement retry must land the player
        // on a cell whose feet box clears it.
        let portal = inboundPortal(from: "EdariaBibliothek", x: 1344, y: 208, width: 160, height: 96)
        let mask = CollisionMask(x: 1344, y: 208, width: 64, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaMitte", portal: portal, masks: [mask]),
            logger: testLogger,
            rng: SeededGenerator(seed: 3)
        )
        let point = try #require(await actor.arrivalPlacement(fromSector: portal.targetSectorName, spriteSize: SomnioConstants.playerSpriteSize))
        let feet = FeetMask.rect(forSpriteAt: point, spriteSize: SomnioConstants.playerSpriteSize)
        #expect(!CollisionMaskOverlap.intersects(feet, [mask]))
    }

    @Test func `arrival falls back to the rect center when every cell is blocked`() async throws {
        // A mask covering the full feet-box region of every candidate cell (the feet box sits
        // below the sprite top-left, so the mask must extend past the portal's bottom). With no
        // clear cell, placement returns the rect center.
        let portal = inboundPortal(from: "EdariaBibliothek", x: 1344, y: 208, width: 160, height: 96)
        let mask = CollisionMask(x: 1344, y: 240, width: 160, height: 96)
        let actor = PerSectorActor(
            staticSector: sectorWithInboundPortal(name: "EdariaMitte", portal: portal, masks: [mask]),
            logger: testLogger,
            rng: SeededGenerator(seed: 4)
        )
        let point = try #require(await actor.arrivalPlacement(fromSector: portal.targetSectorName, spriteSize: SomnioConstants.playerSpriteSize))
        #expect(point.x == portal.x + portal.width / 2)
        #expect(point.y == portal.y + portal.height / 2)
    }

    // MARK: - Helpers

    private func inboundPortal(from source: String, x: Int16, y: Int16, width: Int16, height: Int16) -> SectorPortal {
        SectorPortal(x: x, y: y, width: width, height: height, targetSectorName: source, direction: .arrivalPlacement)
    }

    private func sectorWithInboundPortal(
        name: String,
        portal: SectorPortal,
        masks: [CollisionMask] = []
    ) -> Sector {
        // Sized to contain the portal rect (12 x 8 tiles = 1536 x 1024 px).
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 12, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            collisionMasks: masks,
            portals: [portal]
        )
        return Sector(body: body, name: name)
    }

    private var testLogger: Logger {
        Logger(label: "test.arrival-placement")
    }
}
