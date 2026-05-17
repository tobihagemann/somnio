import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

struct MonsterAggroE2ETests {
    @Test func `monster idles when no player is within aggro radius`() async throws {
        let logger = Logger(label: "test.monster.idle")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let actor = PerSectorActor(staticSector: sector, logger: logger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        let farPosition = farPositionFrom(GridPoint(x: 200, y: 200), distance: 1000)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "outsider", sector: sector, position: farPosition, outbox: outbox)

        let monsterEntityIndex = try await captureMonsterEntityIndex(from: sink)

        for _ in 0 ..< 5 {
            _ = await actor.runAITick()
        }
        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        let monsterBroadcasts = frames
            .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .filter { $0.entityIndex == monsterEntityIndex }
        #expect(monsterBroadcasts.isEmpty, "monster outside any player's aggro radius must not broadcast position, got \(monsterBroadcasts.count) frames")
    }

    @Test func `monster chases player who enters aggro radius`() async throws {
        let logger = Logger(label: "test.monster.chase")
        let monsterOrigin = GridPoint(x: 200, y: 200)
        let sector = makeAggroSector(monsterOrigin: monsterOrigin)
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = VisualCenter.center(position: monster.spawnOrigin, mask: monster.spawnedMonsterSize)

        let actor = PerSectorActor(staticSector: sector, logger: logger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        let halfTile = Int32(SomnioConstants.tileSize) / 2
        let playerPosition = GridPoint(
            x: Int16(clamping: monsterCenter.x + 150 - halfTile),
            y: Int16(clamping: monsterCenter.y - halfTile)
        )
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "chased", sector: sector, position: playerPosition, outbox: outbox)

        let monsterEntityIndex = try await captureMonsterEntityIndex(from: sink)
        let playerCenter = VisualCenter.center(
            position: playerPosition,
            mask: GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
        )

        for _ in 0 ..< 4 {
            _ = await actor.runAITick()
        }
        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        let chaseFrames = frames
            .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .filter { $0.entityIndex == monsterEntityIndex }
        #expect(chaseFrames.count >= 4)
        var previousDistance: Int64?
        for frame in chaseFrames {
            let broadcastCenter = VisualCenter.center(
                position: GridPoint(x: frame.x, y: frame.y),
                mask: monster.spawnedMonsterSize
            )
            let distance = VisualCenter.squaredDistance(broadcastCenter, playerCenter)
            if let previous = previousDistance {
                #expect(distance <= previous, "chase distance regressed: \(distance) > \(previous)")
            }
            previousDistance = distance
        }
        let initialDistance = VisualCenter.squaredDistance(monsterCenter, playerCenter)
        #expect(previousDistance ?? initialDistance < initialDistance, "monster never closed the gap; chase code may have broken")
    }

    // swiftlint:disable:next function_body_length
    @Test func `monster targets nearest of multiple players in aggro radius`() async throws {
        let logger = Logger(label: "test.monster.nearest")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = VisualCenter.center(position: monster.spawnOrigin, mask: monster.spawnedMonsterSize)

        let actor = PerSectorActor(staticSector: sector, logger: logger)
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        let outboxB = ConnectionOutbox(highWatermark: 1024)
        let sinkA = FrameRecorder()
        let sinkB = FrameRecorder()
        let drainA = startOutboxDrain(outbox: outboxA, into: sinkA)
        let drainB = startOutboxDrain(outbox: outboxB, into: sinkB)

        // Place A east of the monster (dx > 0, dy = 0 → expected facing .east) and B north
        // of the monster (dx = 0, dy < 0 → expected facing .north). Choosing different
        // axes makes the facing assertion below distinguish "picks B" from "picks A" —
        // if both were on the same axis the chase would head the same way either way.
        // B is closer (80 px) than A (150 px), so the nearest-target gate must select B.
        let halfTile = Int32(SomnioConstants.tileSize) / 2
        let positionA = GridPoint(
            x: Int16(clamping: monsterCenter.x + 150 - halfTile),
            y: Int16(clamping: monsterCenter.y - halfTile)
        )
        let positionB = GridPoint(
            x: Int16(clamping: monsterCenter.x - halfTile),
            y: Int16(clamping: monsterCenter.y - 80 - halfTile)
        )
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "alice", sector: sector, position: positionA, outbox: outboxA)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "bob", sector: sector, position: positionB, outbox: outboxB)

        let monsterEntityIndex = try await captureMonsterEntityIndex(from: sinkA)
        let playerMask = GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
        let centerA = VisualCenter.center(position: positionA, mask: playerMask)
        let centerB = VisualCenter.center(position: positionB, mask: playerMask)

        _ = await actor.runAITick()
        outboxA.finish()
        outboxB.finish()
        await drainA.value
        await drainB.value

        let framesA = await sinkA.snapshot()
        let monsterFrame = try #require(
            framesA
                .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
                .first { $0.entityIndex == monsterEntityIndex }
        )
        let postTickCenter = VisualCenter.center(
            position: GridPoint(x: monsterFrame.x, y: monsterFrame.y),
            mask: monster.spawnedMonsterSize
        )
        let distanceToA = VisualCenter.squaredDistance(postTickCenter, centerA)
        let distanceToB = VisualCenter.squaredDistance(postTickCenter, centerB)
        #expect(distanceToB < distanceToA, "monster must move toward B (the nearest player), got d(A)=\(distanceToA) d(B)=\(distanceToB)")

        // Facing must point at B (north of the monster), not at A (east). If the
        // nearest-target gate were broken and the monster picked A, the dominant-axis
        // facing computation would yield `.east` and this assertion would catch it.
        let dx = centerB.x - monsterCenter.x
        let dy = centerB.y - monsterCenter.y
        let expectedFacing: Direction = if abs(dx) >= abs(dy) {
            dx > 0 ? .east : .west
        } else {
            dy > 0 ? .south : .north
        }
        #expect(expectedFacing == .north, "test setup must place B north of the monster so facing distinguishes B from A")
        #expect(monsterFrame.facing == expectedFacing.rawValue, "expected facing \(expectedFacing), got raw \(monsterFrame.facing)")
    }

    // swiftlint:disable:next function_body_length
    @Test func `monster stops chasing after player leaves the aggro radius`() async throws {
        let logger = Logger(label: "test.monster.aggro-release")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = VisualCenter.center(position: monster.spawnOrigin, mask: monster.spawnedMonsterSize)

        // Phase 1 actor: chase a player who's inside the aggro radius. We tear it down
        // and capture its broadcast count BEFORE moving on — reading mid-test snapshots
        // from a still-draining outbox races against the background drain task.
        let phase1Outbox = ConnectionOutbox(highWatermark: 1024)
        let phase1Sink = FrameRecorder()
        let phase1Drain = startOutboxDrain(outbox: phase1Outbox, into: phase1Sink)
        let phase1Actor = PerSectorActor(staticSector: sector, logger: logger)

        let halfTile = Int32(SomnioConstants.tileSize) / 2
        let nearPosition = GridPoint(
            x: Int16(clamping: monsterCenter.x + 100 - halfTile),
            y: Int16(clamping: monsterCenter.y - halfTile)
        )
        _ = try await PerSectorActorClient.attachPlayer(
            actor: phase1Actor,
            nickname: "kiter",
            sector: sector,
            position: nearPosition,
            outbox: phase1Outbox
        )
        let phase1MonsterIndex = try await captureMonsterEntityIndex(from: phase1Sink)
        for _ in 0 ..< 3 {
            _ = await phase1Actor.runAITick()
        }
        phase1Outbox.finish()
        await phase1Drain.value
        let chasingCount = await countMonsterBroadcasts(in: phase1Sink.snapshot(), entityIndex: phase1MonsterIndex)
        #expect(chasingCount >= 3, "phase 1 must produce chase broadcasts, got \(chasingCount)")

        // Phase 2 actor: same sector, but the player attaches OUTSIDE the aggro radius
        // (visual-centre distance ~565 px vs the 192 px gate). `runMonsterTick`'s
        // closest-target gate must reject the candidate, so the outbox accumulates zero
        // monster `.serverPosition` frames across the 5-tick window.
        let phase2Outbox = ConnectionOutbox(highWatermark: 1024)
        let phase2Sink = FrameRecorder()
        let phase2Drain = startOutboxDrain(outbox: phase2Outbox, into: phase2Sink)
        let phase2Actor = PerSectorActor(staticSector: sector, logger: logger)

        let farPosition = GridPoint(
            x: Int16(clamping: monsterCenter.x + 400 - halfTile),
            y: Int16(clamping: monsterCenter.y + 400 - halfTile)
        )
        _ = try await PerSectorActorClient.attachPlayer(
            actor: phase2Actor,
            nickname: "kiter2",
            sector: sector,
            position: farPosition,
            outbox: phase2Outbox
        )
        let phase2MonsterIndex = try await captureMonsterEntityIndex(from: phase2Sink)
        for _ in 0 ..< 5 {
            _ = await phase2Actor.runAITick()
        }
        phase2Outbox.finish()
        await phase2Drain.value
        let idleCount = await countMonsterBroadcasts(in: phase2Sink.snapshot(), entityIndex: phase2MonsterIndex)
        #expect(idleCount == 0, "monster must not broadcast when the only player is out of aggro range, got \(idleCount) frames")
    }

    // MARK: - Helpers

    private func makeAggroSector(monsterOrigin: GridPoint) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 512, height: 512),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: [],
            monsterSpawns: [
                MonsterSpawn(
                    spawnOrigin: monsterOrigin,
                    spawnBoxSize: GridSize(width: 128, height: 128),
                    spawnedMonsterSize: GridSize(width: 128, height: 128),
                    name: "Gespenst",
                    figure: 0,
                    bounded: false,
                    spawnHP: 100,
                    spawnBalance: 100,
                    spawnMana: 100,
                    aiScriptIndex: 0
                )
            ]
        )
        return Sector(body: body, name: "TestArena")
    }

    private func farPositionFrom(_ origin: GridPoint, distance: Int32) -> GridPoint {
        GridPoint(
            x: Int16(clamping: Int32(origin.x) + distance),
            y: Int16(clamping: Int32(origin.y) + distance)
        )
    }

    /// Poll `sink` until at least one monster `.entity` frame surfaces from the join
    /// sequence, then return its index. A blind `Task.yield()` would not guarantee the
    /// background drain has consumed the frame; an outright `nil`-fallback would mask a
    /// regression in `PerSectorActor.attach` that stopped emitting monster entities.
    /// 1 s budget × 20 ms steps gives ample time on local CI without prolonging the
    /// happy path past a single tick.
    private func captureMonsterEntityIndex(
        from sink: FrameRecorder,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws -> Int16 {
        for _ in 0 ..< 50 {
            await Task.yield()
            let frames = await sink.snapshot()
            if let monster = frames.compactMap(IntegrationTestFixtures.entityPayload(of:))
                .first(where: { $0.type == .monster }) {
                return monster.entityIndex
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("attach never broadcast a monster Entity frame within the budget", sourceLocation: sourceLocation)
        return 0
    }

    private func countMonsterBroadcasts(in frames: [Data], entityIndex: Int16) -> Int {
        frames.compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .count(where: { $0.entityIndex == entityIndex })
    }
}
