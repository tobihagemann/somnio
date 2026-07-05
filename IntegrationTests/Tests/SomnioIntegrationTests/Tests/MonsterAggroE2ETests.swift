import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

struct MonsterAggroE2ETests {
    /// Spawn threshold that materializes exactly one monster within a 7-tick window: the timer
    /// reaches 3 on tick 3 and spawns on tick 4; the next spawn would be tick 8. Distances/facing
    /// use the feet-center, matching `runMonsterTick`.
    private static let singleSpawnThreshold: Int16 = 3
    private static let singleSpawnTicks = 7

    @Test func `monster idles when no player is within aggro radius`() async throws {
        let logger = Logger(label: "test.monster.idle")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let actor = PerSectorActor(staticSector: sector, logger: logger, monsterSpawnThreshold: Self.singleSpawnThreshold)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        let farPosition = farPositionFrom(GridPoint(x: 200, y: 200), distance: 1000)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "outsider", sector: sector, position: farPosition, outbox: outbox)

        for _ in 0 ..< Self.singleSpawnTicks {
            _ = await actor.runAITick()
        }
        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        // A monster spawned (entity frame present) but, out of aggro range, broadcast no position.
        let monsterIndex = try requireMonsterIndex(in: frames)
        let monsterBroadcasts = frames
            .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .filter { $0.entityIndex == monsterIndex }
        #expect(monsterBroadcasts.isEmpty, "monster outside any player's aggro radius must not broadcast position, got \(monsterBroadcasts.count) frames")
    }

    @Test func `monster chases player who enters aggro radius`() async throws {
        let logger = Logger(label: "test.monster.chase")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = FeetMask.center(forSpriteAt: monster.spawnOrigin, spriteSize: monster.spawnedMonsterSize)

        let actor = PerSectorActor(staticSector: sector, logger: logger, monsterSpawnThreshold: Self.singleSpawnThreshold)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        // Player feet-center ~150 px east of the monster's — inside the 192 px aggro radius.
        let playerPosition = playerPositionForFeetCenter(x: monsterCenter.x + 150, y: monsterCenter.y)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "chased", sector: sector, position: playerPosition, outbox: outbox)
        let playerCenter = FeetMask.center(forSpriteAt: playerPosition, spriteSize: SomnioConstants.playerSpriteSize)

        for _ in 0 ..< Self.singleSpawnTicks {
            _ = await actor.runAITick()
        }
        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        let monsterIndex = try requireMonsterIndex(in: frames)
        let chaseFrames = frames
            .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .filter { $0.entityIndex == monsterIndex }
        #expect(chaseFrames.count >= 4)
        var previousDistance: Int64?
        for frame in chaseFrames {
            let broadcastCenter = FeetMask.center(
                forSpriteAt: GridPoint(x: frame.x, y: frame.y),
                spriteSize: monster.spawnedMonsterSize
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

    @Test func `monster targets nearest of multiple players in aggro radius`() async throws {
        let logger = Logger(label: "test.monster.nearest")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = FeetMask.center(forSpriteAt: monster.spawnOrigin, spriteSize: monster.spawnedMonsterSize)

        let actor = PerSectorActor(staticSector: sector, logger: logger, monsterSpawnThreshold: 0)
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        let outboxB = ConnectionOutbox(highWatermark: 1024)
        let sinkA = FrameRecorder()
        let sinkB = FrameRecorder()
        let drainA = startOutboxDrain(outbox: outboxA, into: sinkA)
        let drainB = startOutboxDrain(outbox: outboxB, into: sinkB)

        // A's feet-center is 150 px due east of the monster; B's is 100 px due north. B is
        // closer, so the nearest-target gate must select B and the monster must face the exact
        // northward heading (180°) — distinguishing "picks B" from "picks A".
        let positionA = playerPositionForFeetCenter(x: monsterCenter.x + 150, y: monsterCenter.y)
        let positionB = playerPositionForFeetCenter(x: monsterCenter.x, y: monsterCenter.y - 100)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "alice", sector: sector, position: positionA, outbox: outboxA)
        _ = try await PerSectorActorClient.attachPlayer(actor: actor, nickname: "bob", sector: sector, position: positionB, outbox: outboxB)
        let centerA = FeetMask.center(forSpriteAt: positionA, spriteSize: SomnioConstants.playerSpriteSize)
        let centerB = FeetMask.center(forSpriteAt: positionB, spriteSize: SomnioConstants.playerSpriteSize)

        // A single tick spawns exactly one monster and runs its first chase step.
        _ = await actor.runAITick()
        outboxA.finish()
        outboxB.finish()
        await drainA.value
        await drainB.value

        let framesA = await sinkA.snapshot()
        let monsterIndex = try requireMonsterIndex(in: framesA)
        let monsterFrame = try #require(
            framesA
                .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
                .first { $0.entityIndex == monsterIndex }
        )
        let postTickCenter = FeetMask.center(
            forSpriteAt: GridPoint(x: monsterFrame.x, y: monsterFrame.y),
            spriteSize: monster.spawnedMonsterSize
        )
        let distanceToA = VisualCenter.squaredDistance(postTickCenter, centerA)
        let distanceToB = VisualCenter.squaredDistance(postTickCenter, centerB)
        #expect(distanceToB < distanceToA, "monster must move toward B (the nearest player), got d(A)=\(distanceToA) d(B)=\(distanceToB)")

        let dx = centerB.x - monsterCenter.x
        let dy = centerB.y - monsterCenter.y
        #expect(dx == 0 && dy < 0, "test setup must place B due north of the monster so facing distinguishes B from A")
        // The same Heading(dx:dy:) conversion runMonsterTick uses, so Float rounding matches.
        let expectedDegrees = Heading(dx: Float(dx), dy: Float(dy)).degrees
        #expect(monsterFrame.facing == expectedDegrees, "expected heading \(expectedDegrees), got \(monsterFrame.facing)")
    }

    @Test func `monster stops chasing after player leaves the aggro radius`() async throws {
        let logger = Logger(label: "test.monster.aggro-release")
        let sector = makeAggroSector(monsterOrigin: GridPoint(x: 200, y: 200))
        let monster = try #require(sector.monsterSpawns.first)
        let monsterCenter = FeetMask.center(forSpriteAt: monster.spawnOrigin, spriteSize: monster.spawnedMonsterSize)

        // Phase 1: chase a player inside the aggro radius. Tear down and capture the broadcast
        // count BEFORE moving on — reading a still-draining outbox races the background drain.
        let phase1Outbox = ConnectionOutbox(highWatermark: 1024)
        let phase1Sink = FrameRecorder()
        let phase1Drain = startOutboxDrain(outbox: phase1Outbox, into: phase1Sink)
        let phase1Actor = PerSectorActor(staticSector: sector, logger: logger, monsterSpawnThreshold: Self.singleSpawnThreshold)

        let nearPosition = playerPositionForFeetCenter(x: monsterCenter.x + 100, y: monsterCenter.y)
        _ = try await PerSectorActorClient.attachPlayer(
            actor: phase1Actor,
            nickname: "kiter",
            sector: sector,
            position: nearPosition,
            outbox: phase1Outbox
        )
        for _ in 0 ..< Self.singleSpawnTicks {
            _ = await phase1Actor.runAITick()
        }
        phase1Outbox.finish()
        await phase1Drain.value
        let phase1Frames = await phase1Sink.snapshot()
        let phase1MonsterIndex = try requireMonsterIndex(in: phase1Frames)
        let chasingCount = countMonsterBroadcasts(in: phase1Frames, entityIndex: phase1MonsterIndex)
        #expect(chasingCount >= 4, "phase 1 must produce chase broadcasts, got \(chasingCount)")

        // Phase 2: same sector, but the player attaches well outside the aggro radius, so the
        // closest-target gate rejects it and no monster `serverPosition` frames accumulate.
        let phase2Outbox = ConnectionOutbox(highWatermark: 1024)
        let phase2Sink = FrameRecorder()
        let phase2Drain = startOutboxDrain(outbox: phase2Outbox, into: phase2Sink)
        let phase2Actor = PerSectorActor(staticSector: sector, logger: logger, monsterSpawnThreshold: Self.singleSpawnThreshold)

        let farPosition = playerPositionForFeetCenter(x: monsterCenter.x + 400, y: monsterCenter.y + 400)
        _ = try await PerSectorActorClient.attachPlayer(
            actor: phase2Actor,
            nickname: "kiter2",
            sector: sector,
            position: farPosition,
            outbox: phase2Outbox
        )
        for _ in 0 ..< Self.singleSpawnTicks {
            _ = await phase2Actor.runAITick()
        }
        phase2Outbox.finish()
        await phase2Drain.value
        let phase2Frames = await phase2Sink.snapshot()
        let phase2MonsterIndex = try requireMonsterIndex(in: phase2Frames)
        let idleCount = countMonsterBroadcasts(in: phase2Frames, entityIndex: phase2MonsterIndex)
        #expect(idleCount == 0, "monster must not broadcast when the only player is out of aggro range, got \(idleCount) frames")
    }

    // MARK: - Helpers

    private func makeAggroSector(monsterOrigin: GridPoint) -> Sector {
        // The 128x36 spawn box (width == sprite width; height == the 128-sprite feet height,
        // 128/4 + 4 = 36) collapses the 4 px-grid placement to the single 4-aligned `monsterOrigin`,
        // so the spawn position is deterministic and the chase geometry is predictable.
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 512, height: 512),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: [],
            monsterSpawns: [
                MonsterSpawn(
                    spawnOrigin: monsterOrigin,
                    spawnBoxSize: GridSize(width: 128, height: 36),
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

    /// Top-left position for a 32x48 player sprite whose feet-center lands at `(x, y)`.
    /// Feet-center = (px + 16, py + 40) for the 32x48 cell (feet height 16).
    private func playerPositionForFeetCenter(x: Int32, y: Int32) -> GridPoint {
        GridPoint(x: Int16(clamping: x - 16), y: Int16(clamping: y - 40))
    }

    /// The single live monster's entity index from a drained frame snapshot.
    private func requireMonsterIndex(
        in frames: [Data],
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws -> Int16 {
        let monster = frames.compactMap(IntegrationTestFixtures.entityPayload(of:))
            .first { $0.type == .monster }
        return try #require(monster, "no monster entity was broadcast", sourceLocation: sourceLocation).entityIndex
    }

    private func countMonsterBroadcasts(in frames: [Data], entityIndex: Int16) -> Int {
        frames.compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            .count(where: { $0.entityIndex == entityIndex })
    }
}
