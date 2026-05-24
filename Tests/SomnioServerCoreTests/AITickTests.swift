import Foundation
import Logging
import SomnioCore
import SomnioProtocol
import Testing
@testable import SomnioServerCore

/// Coverage for `PerSectorActor.runAITick()` — the deterministic test seam the AI tick
/// services exercises on a `Duration` cadence. Tests drive the mutator directly, no sleep.
struct AITickTests {
    // MARK: - NPC dialog branches

    @Test func `npc dialog emit fires on first tick when targeting and in radius`() async throws {
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "Hello, $name.\n---\nFollow up.")]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        let digest = await actor.runAITick()

        outbox.finish()
        let frames = await collect(outbox: outbox)
        let serverSayTexts = decodeServerSays(in: frames)
        #expect(serverSayTexts.contains("Hello, alice."))
        #expect(digest.dialogUpserts.count == 1)
        #expect(digest.dialogUpserts.first?.scriptStep == 2)
        #expect(digest.dialogResets.isEmpty)
    }

    @Test func `npc dialog wraps after the final step and clears targeting`() async throws {
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "Step one.\n---\nStep two.")]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        // Tick once to emit step 1, then advance cooldown back to 59 across 59 idle ticks
        // (in-radius branch d), then emit step 2 — the final step.
        _ = await actor.runAITick()
        for _ in 0 ..< 59 {
            _ = await actor.runAITick()
        }
        let finalDigest = await actor.runAITick()

        // Final step emit triggers a reset, not an upsert: cursor wrap clears the persisted
        // row so the next bump restarts from step 1.
        #expect(finalDigest.dialogResets.count == 1)
        #expect(finalDigest.dialogUpserts.isEmpty)

        // A subsequent tick with no targeting must not emit (idle branch a).
        let idleDigest = await actor.runAITick()
        #expect(idleDigest.dialogUpserts.isEmpty)
        #expect(idleDigest.dialogResets.isEmpty)
    }

    @Test func `out of radius branch resets cursor and emits a digest reset`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 1024, height: 1024),
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.\n---\nthird.")]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        // Emit step 1 (cursor advances to step 2 / scriptStepIndex == 1).
        _ = await actor.runAITick()

        // Player walks far outside the npc interaction radius. Next tick takes branch (c).
        await actor.handlePosition(
            PositionMessage(
                entityIndex: 0,
                x: 800,
                y: 800,
                facing: Direction.south.rawValue,
                tempo: Tempo.default.rawValue
            ),
            from: entityIndex
        )
        let digest = await actor.runAITick()
        #expect(digest.dialogResets.count == 1)
        #expect(digest.dialogResets.first?.npcIndex == 1)
        #expect(digest.dialogUpserts.isEmpty)
        // The reset must clear targeting AND rewind the cursor — confirm by running one
        // more idle tick and asserting it produces no further reset (branch (a) takes
        // over). A regression that left `targetingEntity` set or didn't rewind
        // `scriptStepIndex` would re-fire branch (c) on the next tick.
        let idleDigest = await actor.runAITick()
        #expect(idleDigest.dialogResets.isEmpty)
        #expect(idleDigest.dialogUpserts.isEmpty)
    }

    @Test func `target leaving the sector resets cursor and emits a digest reset`() async throws {
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.")]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)
        _ = await actor.runAITick()

        // Detach (mirrors a portal hop or disconnect) so the targeting entity is no longer
        // present in the sector.
        await actor.detach(entityIndex: entityIndex, leftGame: false)
        let digest = await actor.runAITick()
        #expect(digest.dialogResets.count == 1)
        // Subsequent ticks must idle (branch (a)) rather than re-fire the reset; regression
        // sentinel for `resetTargeting` actually clearing `targetingEntity` and rewinding
        // `scriptStepIndex` to 0.
        let idleDigest = await actor.runAITick()
        #expect(idleDigest.dialogResets.isEmpty)
    }

    @Test func `in radius below cooldown advances ticks without emitting`() async throws {
        // The default-seeded cooldownTicks is at the cap, so the first in-radius tick after
        // a bump emits step 1 immediately and resets the cooldown to 0. The next cap-many
        // in-radius ticks walk the cooldown back up via branch (d) without emitting; the
        // tick after that fires the final step.
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "step.\n---\nstep two.")]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)
        _ = await actor.runAITick() // emit step 1, cooldown -> 0

        for _ in 0 ..< 59 {
            let digest = await actor.runAITick()
            #expect(digest.dialogUpserts.isEmpty)
            #expect(digest.dialogResets.isEmpty)
        }
        // Cooldown is now at the cap; the next tick takes branch (e) and emits step 2 (final).
        let final = await actor.runAITick()
        #expect(final.dialogResets.count == 1)
        // Frame-level regression sentinel: the cooldown window should produce no
        // `serverSay` frames (only the first emit + the final emit). A regression that kept
        // the digest empty but still broadcasted dialog text every tick would slip past the
        // digest-only assertions above.
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let serverSays = decodeServerSays(in: frames)
        #expect(serverSays.count == 2)
        #expect(serverSays.contains("step."))
        #expect(serverSays.contains("step two."))
    }

    // MARK: - Cursor seeding

    @Test func `stale persisted cursor clamps to step 1 on init`() async throws {
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.\n---\nthird.")]
        )
        // Persisted scriptStep = 7 (1-based) is invalid for a 3-step script. Init must clamp
        // to 0-based 0 (= scriptStep 1) without crashing on the first emit.
        let actor = PerSectorActor(
            staticSector: sector,
            logger: testLogger,
            initialDialogCursors: [1: 7]
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        let digest = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let texts = decodeServerSays(in: frames)
        #expect(texts.contains("first."))
        #expect(digest.dialogUpserts.first?.scriptStep == 2)
    }

    @Test(arguments: [
        Int16(0), // 1-based zero is invalid; lower-bound guard clamps.
        Int16(-1), // negative; same guard clamps.
        Int16.min // corrupt extreme; the reordered guard prevents a trap subtraction.
    ])
    func `out of range persisted cursor clamps without trapping`(persisted: Int16) async throws {
        let sector = makeSector(
            npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.\n---\nthird.")]
        )
        // `resolveSeedStepIndex` clamps before subtracting, so a corrupt `Int16.min`
        // persisted cursor cannot trap on the `persisted - 1` step. After clamp the
        // runtime cursor is `0`; the first emit must therefore be the first dialog line.
        let actor = PerSectorActor(
            staticSector: sector,
            logger: testLogger,
            initialDialogCursors: [1: persisted]
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let texts = decodeServerSays(in: frames)
        #expect(texts.contains("first."))
    }

    @Test func `empty script with persisted cursor takes the no op branch on emit`() async throws {
        let sector = makeSector(npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "")])
        let actor = PerSectorActor(
            staticSector: sector,
            logger: testLogger,
            initialDialogCursors: [1: 3]
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)

        // Empty script: branch (e) clears targeting and emits nothing.
        let digest = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let texts = decodeServerSays(in: frames)
        #expect(texts.isEmpty)
        #expect(digest.dialogUpserts.isEmpty)
        #expect(digest.dialogResets.isEmpty)
    }

    // MARK: - Monster aggro + chase

    @Test func `branch zero monster moves toward an in radius player`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let positions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        let monsterFrame = try #require(positions.first)
        // Monster started at (200, 200) and should have moved toward (250, 250). Manhattan
        // 100 >= 6 so the Euclidean step lands at ≈(4, 4).
        #expect(monsterFrame.x > 200)
        #expect(monsterFrame.y > 200)
        #expect(monsterFrame.facing == Direction.east.rawValue || monsterFrame.facing == Direction.south.rawValue)
        // Player slot lives at entityIndex 2; only the monster's broadcast lands.
        _ = entityIndex
    }

    @Test func `branch zero monster idles when no player is in radius`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 1024, height: 1024),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 0, y: 0), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 900, y: 900)),
            inventory: [],
            outbox: outbox
        )
        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        // The join sequence emits an `entity` frame for the monster but no `serverPosition`,
        // so any monster-keyed `serverPosition` would have come from the chase branch.
        let monsterPositions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        #expect(monsterPositions.isEmpty)
    }

    @Test func `attaching after a chase delivers the post tick monster facing in the entity frame`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 100, y: 100)),
            inventory: [],
            outbox: outboxA
        )
        // Player A is north-west of the monster (centers (164,164) vs (264,264), distance
        // squared 20000 < radius² 36864). One chase tick orients the monster west on the
        // 45° diagonal tie-break. Confirm the join sequence for a second player carries
        // that post-tick facing rather than the seed default.
        _ = await actor.runAITick()

        let outboxB = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "bob", at: GridPoint(x: 0, y: 0)),
            inventory: [],
            outbox: outboxB
        )
        outboxB.finish()
        let framesB = await collect(outbox: outboxB)
        let monsterEntity = decodeEntities(in: framesB)
            .first { $0.entityIndex == 1 && $0.type == .monster }
        let entityFrame = try #require(monsterEntity)
        // The default facing on `MonsterSpawnRuntime` is `.south` (rawValue 2). After a
        // post-tick orientation toward (50, 50), the runtime facing should be `.west`
        // (rawValue 3) or `.north` (rawValue 0). The join sequence must reflect that
        // post-tick value rather than the seed default.
        #expect([Direction.west.rawValue, Direction.north.rawValue].contains(entityFrame.facing))
    }

    // MARK: - Combat carve-out

    @Test func `monster combat is inert across two hundred ticks`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 4096)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        for _ in 0 ..< 200 {
            _ = await actor.runAITick()
        }
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let messages = frames.compactMap { try? SomnioMessageDecoder.decode($0) }
        let damageSayCount = messages.count(where: { message in
            if case let .serverSay(say) = message { return say.text.lowercased().contains("dmg") }
            return false
        })
        let monsterLeaveCount = messages.count(where: { message in
            if case let .leave(leave) = message { return leave.entityIndex == 1 }
            return false
        })
        #expect(damageSayCount == 0)
        #expect(monsterLeaveCount == 0)
    }

    @Test(arguments: [
        // (closerFirst, label) — runs the same sector setup with the two attach orders
        // swapped so the result must be order-independent. A regression to "first in-radius
        // player wins" would pass when iteration happens to surface the closer player
        // first, so both orders must be checked.
        (true, "closer attached first"),
        (false, "closer attached second")
    ])
    func `branch zero monster targets the nearest in radius player regardless of attach order`(closerFirst: Bool, label _: String) async throws {
        // Monster center is at (264, 264) (mask 128 around (200, 200)).
        // alice at (320, 200) → center (384, 264), monster→player dx=120, distance² = 14400.
        // bob at (50, 200)   → center (114, 264), monster→player dx=-150, distance² = 22500.
        // alice is the closer target; the closest-target gate must select her regardless of
        // attach/iteration order, and the dominant-axis tie-break with `dx > 0` orients the
        // monster east.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let aliceOutbox = ConnectionOutbox(highWatermark: 1024)
        let bobOutbox = ConnectionOutbox(highWatermark: 1024)
        let attachAlice = {
            _ = try await actor.attach(
                character: makeCharacter(name: "alice", at: GridPoint(x: 320, y: 200)),
                inventory: [],
                outbox: aliceOutbox
            )
        }
        let attachBob = {
            _ = try await actor.attach(
                character: makeCharacter(name: "bob", at: GridPoint(x: 50, y: 200)),
                inventory: [],
                outbox: bobOutbox
            )
        }
        if closerFirst {
            try await attachAlice()
            try await attachBob()
        } else {
            try await attachBob()
            try await attachAlice()
        }

        _ = await actor.runAITick()
        aliceOutbox.finish()
        bobOutbox.finish()
        let aliceFrames = await collect(outbox: aliceOutbox)
        let monsterPosition = decodeServerPositions(in: aliceFrames)
            .first { $0.entityIndex == 1 }
        let frame = try #require(monsterPosition)
        #expect(frame.facing == Direction.east.rawValue)
    }

    @Test func `branch zero monster takes the close range step at exact center coincidence`() async throws {
        // Monster mask 128 at (200, 200): center (264, 264). Player mask 128 at (200, 200):
        // center also (264, 264). manhattan == 0 < 6 takes the close-range else branch.
        // dx == dy == 0 → step (0, 0) → no movement. The chase still broadcasts the post-
        // tick facing: dominant-axis with horizontal tie-break (`|dx|>=|dy|` is true at
        // 0/0), and `dx > 0` is false → `.west`.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 200, y: 200)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monsterPositions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        let broadcast = try #require(monsterPositions.first)
        // No movement — close-range path with dx=dy=0 keeps the position pinned.
        #expect(broadcast.x == 200)
        #expect(broadcast.y == 200)
        // Tie-break facing pinned: `|0|>=|0|` is true, `0 > 0` is false → west.
        #expect(broadcast.facing == Direction.west.rawValue)
    }

    @Test func `branch zero monster blocked by sector edge broadcasts facing without moving`() async throws {
        // Boundary-rejection sentinel (mirrors the collision-blocked test but exercises the
        // `isInside` gate, not `collides`): the player is attached at the sector floor of a
        // short 2-tile-tall sector, so the monster's one-step chase lands exactly on the
        // half-open bottom edge and `isInside` rejects it — the monster broadcasts its updated
        // facing without moving. (`attach` does not validate the player's out-of-floor position.)
        let sector = makeSector(
            dimensions: GridSize(width: 4, height: 2),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 50, y: 250), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 50, y: 256)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monsterPositions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        let broadcast = try #require(monsterPositions.first)
        // Position unchanged from the spawn origin; only the facing has been updated.
        #expect(broadcast.x == 50)
        #expect(broadcast.y == 250)
        #expect(broadcast.facing == Direction.south.rawValue)
    }

    @Test func `branch zero monster blocked by collision broadcasts facing without moving`() async throws {
        // Monster center (264, 264), player center (314, 314); chase wants east+south.
        // Compute the proposed step: dx=50, dy=50, manhattan=100>=6, length=sqrt(5000)≈70.71,
        // step.x = round(50*6/70.71) ≈ 4, step.y same. Proposed = (204, 204). Place a 1x1
        // collision mask there so the position commit is rejected but the broadcast still
        // fires with the unchanged position and the new facing.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)],
            collisionMasks: [CollisionMask(x: 204, y: 204, width: 1, height: 1)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monsterPositions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        let broadcast = try #require(monsterPositions.first)
        // Position unchanged from the spawn origin; only the facing has been updated.
        #expect(broadcast.x == 200)
        #expect(broadcast.y == 200)
        #expect(broadcast.facing == Direction.east.rawValue)
    }

    @Test func `non zero ai script index monster idles even when player is in radius`() async throws {
        // Branch 0 is the only ported AI; any other index must stay still even when a
        // player is well inside the aggro radius. Without this gate, removing the
        // `aiScriptIndex == 0` check in `runMonsterTick` would silently start chasing.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 1)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        for _ in 0 ..< 5 {
            _ = await actor.runAITick()
        }
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monsterPositions = decodeServerPositions(in: frames).filter { $0.entityIndex == 1 }
        #expect(monsterPositions.isEmpty)
    }

    // MARK: - Helpers

    private func makeSector(
        dimensions: GridSize = GridSize(width: 8, height: 8),
        npcs: [NPC] = [],
        monsterSpawns: [MonsterSpawn] = [],
        collisionMasks: [CollisionMask] = []
    ) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: dimensions,
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: collisionMasks,
            portals: [],
            npcs: npcs,
            monsterSpawns: monsterSpawns
        )
        return Sector(body: body, name: "TestSector")
    }

    private func makeNPC(at origin: GridPoint, dialogScript: String) -> NPC {
        // 128 px mask matches the legacy single-tile NPC convention so the visual center
        // sits one tile-half from the spawn origin, well inside the player's interaction
        // radius when both are at adjacent grid coordinates.
        NPC(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: 128, height: 128),
            maskSize: GridSize(width: 128, height: 128),
            name: "test-npc",
            figure: 0,
            direction: 0,
            behaviorTag: 0,
            dialogScript: dialogScript
        )
    }

    private func makeMonsterSpawn(at origin: GridPoint, aiScriptIndex: Int16) -> MonsterSpawn {
        MonsterSpawn(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: 128, height: 128),
            spawnedMonsterSize: GridSize(width: 128, height: 128),
            name: "test-monster",
            figure: 0,
            bounded: false,
            spawnHP: 100,
            spawnBalance: 100,
            spawnMana: 100,
            aiScriptIndex: aiScriptIndex
        )
    }

    private func makeCharacter(name: String, at position: GridPoint) -> Character {
        Character(
            id: UUID(),
            name: name,
            figure: 0,
            gender: .male,
            currentSector: "TestSector",
            position: position,
            facing: .south,
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
        )
    }

    private var testLogger: Logger {
        Logger(label: "test.ai-tick")
    }

    private func collect(outbox: ConnectionOutbox) async -> [Data] {
        var frames: [Data] = []
        for await frame in outbox.stream {
            frames.append(frame)
        }
        return frames
    }

    private func decodeServerSays(in frames: [Data]) -> [String] {
        frames.compactMap { frame in
            guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
            if case let .serverSay(say) = message { return say.text }
            return nil
        }
    }

    private func decodeServerPositions(in frames: [Data]) -> [PositionMessage] {
        frames.compactMap { frame in
            guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
            if case let .serverPosition(position) = message { return position }
            return nil
        }
    }

    private func decodeEntities(in frames: [Data]) -> [EntityMessage] {
        frames.compactMap { frame in
            guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
            if case let .entity(entity) = message { return entity }
            return nil
        }
    }
}
