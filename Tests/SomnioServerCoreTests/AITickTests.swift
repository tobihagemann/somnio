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

    //
    // These spawn a single monster on the first tick via `monsterSpawnThreshold: 0`, then assert
    // the same-tick chase behaviour. With the single-cell spawn box (see `makeMonsterSpawn`) the
    // monster materializes at the 4-aligned spawn origin, so positions are deterministic. The
    // monster is the only entity that broadcasts `serverPosition` here (the player never calls
    // `handlePosition`), so the first decoded `serverPosition` is the monster's chase frame.

    @Test func `branch zero monster moves toward an in radius player`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monsterFrame = try #require(decodeServerPositions(in: frames).first)
        // Monster spawned at (200, 200); player feet-center is south-east of the monster's, so a
        // single chase step lands at ≈(204, 204) facing east (45° tie-break favors horizontal).
        #expect(monsterFrame.x > 200)
        #expect(monsterFrame.y > 200)
        #expect(monsterFrame.facing == Direction.east.rawValue || monsterFrame.facing == Direction.south.rawValue)
    }

    @Test func `branch zero monster idles when no player is in radius`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 1024, height: 1024),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 0, y: 0), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 900, y: 900)),
            inventory: [],
            outbox: outbox
        )
        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        // The spawn emits an `entity` frame for the monster but no `serverPosition`, so any
        // `serverPosition` would have come from the chase branch.
        #expect(decodeServerPositions(in: frames).isEmpty)
    }

    @Test func `attaching after a chase delivers the post tick monster facing in the entity frame`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 100, y: 100)),
            inventory: [],
            outbox: outboxA
        )
        // Player A's feet-center is north-west of the spawned monster's, so one chase tick orients
        // the monster west on the 45° tie-break. Confirm a second player's join sequence carries
        // that post-tick facing rather than the seed default (`.south`).
        _ = await actor.runAITick()

        let outboxB = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "bob", at: GridPoint(x: 0, y: 0)),
            inventory: [],
            outbox: outboxB
        )
        outboxB.finish()
        let framesB = await collect(outbox: outboxB)
        let monsterEntity = decodeEntities(in: framesB).first { $0.type == .monster }
        let entityFrame = try #require(monsterEntity)
        #expect([Direction.west.rawValue, Direction.north.rawValue].contains(entityFrame.facing))
    }

    @Test(arguments: [true, false])
    func `branch zero monster targets the nearest in radius player regardless of attach order`(
        closerFirst: Bool
    ) async throws {
        // Monster spawns at (200, 200), feet-center (216, 240). alice (320, 200) feet-center
        // (336, 240) → dx 120; bob (50, 200) feet-center (66, 240) → dx -150. alice is closer, so
        // the closest-target gate selects her regardless of attach order and faces the monster east.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
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
        let frame = try #require(decodeServerPositions(in: aliceFrames).first)
        #expect(frame.facing == Direction.east.rawValue)
    }

    @Test func `branch zero monster blocked by sector edge broadcasts facing without moving`() async throws {
        // Boundary-rejection sentinel (exercises the feet-box bounds gate). The monster spawns at
        // (48, 208) in a 512x256 sector, so its feet box already sits flush on the bottom edge
        // (feet maxY == 256). The player below the floor pulls it south, but the one-step chase
        // would push the feet box past the edge, so the move is rejected — only the facing updates.
        let sector = makeSector(
            dimensions: GridSize(width: 4, height: 2),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 48, y: 208), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 48, y: 260)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let broadcast = try #require(decodeServerPositions(in: frames).first)
        #expect(broadcast.x == 48)
        #expect(broadcast.y == 208)
        #expect(broadcast.facing == Direction.south.rawValue)
    }

    @Test func `branch zero monster blocked by collision broadcasts facing without moving`() async throws {
        // Monster spawns at (200, 200), chases the player at (250, 250): proposed step ≈ (204, 204),
        // feet box (204, 236, 32, 16). A mask at (232, 248, 2, 2) overlaps that feet box but not the
        // spawn feet box (200, 232, 32, 16), so the spawn is clean while the chase move is rejected.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)],
            collisionMasks: [CollisionMask(x: 232, y: 248, width: 2, height: 2)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 250, y: 250)),
            inventory: [],
            outbox: outbox
        )

        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let broadcast = try #require(decodeServerPositions(in: frames).first)
        #expect(broadcast.x == 200)
        #expect(broadcast.y == 200)
        #expect(broadcast.facing == Direction.east.rawValue)
    }

    @Test func `non zero ai script index monster idles even when player is in radius`() async throws {
        // Branch 0 is the only ported AI; any other index stays still even with a player well
        // inside the aggro radius. The spawn still materializes the monster, but `runMonsterTick`
        // skips it, so no `serverPosition` is ever broadcast.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 1)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
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
        #expect(decodeServerPositions(in: frames).isEmpty)
    }

    // MARK: - Monster spawn cadence

    @Test func `the default monster spawn threshold is the faithful 1199 ticks`() {
        #expect(PerSectorActor.defaultMonsterSpawnThreshold == 1199)
    }

    @Test func `no monster exists at boot`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        // Attach without running a tick: the join sequence must carry no monster (nothing spawned).
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 10, y: 10)),
            inventory: [],
            outbox: outbox
        )
        outbox.finish()
        let frames = await collect(outbox: outbox)
        #expect(decodeEntities(in: frames).allSatisfy { $0.type != .monster })
    }

    @Test func `a monster spawns on the tick the timer reaches the threshold, not before`() async throws {
        // With threshold T the counter reaches T on tick T and spawns on tick T+1. After exactly T
        // ticks no monster exists; after T+1 a monster entity has been broadcast.
        let threshold: Int16 = 3
        func monsterCount(afterTicks ticks: Int) async throws -> Int {
            let sector = makeSector(
                dimensions: GridSize(width: 1024, height: 1024),
                monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
            )
            let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: threshold)
            let outbox = ConnectionOutbox(highWatermark: 1024)
            // Player far from the spawn so no chase noise — only the spawn `entity` lands.
            _ = try await actor.attach(
                character: makeCharacter(name: "alice", at: GridPoint(x: 900, y: 900)),
                inventory: [],
                outbox: outbox
            )
            for _ in 0 ..< ticks {
                _ = await actor.runAITick()
            }
            outbox.finish()
            let frames = await collect(outbox: outbox)
            return decodeEntities(in: frames).count { $0.type == .monster }
        }
        try await #expect(monsterCount(afterTicks: Int(threshold)) == 0)
        try await #expect(monsterCount(afterTicks: Int(threshold) + 1) == 1)
    }

    @Test func `the sector never exceeds the live monster cap`() async throws {
        // A wide spawn box (≈24 non-overlapping 32 px cells) so all `perSectorMonsterCap` monsters
        // find distinct feet-clear cells — each placement avoids the live monsters already spawned,
        // so they never stack. Seeded RNG keeps the sampled cells deterministic.
        let sector = makeSector(
            dimensions: GridSize(width: 1024, height: 1024),
            monsterSpawns: [makeWideMonsterSpawn(at: GridPoint(x: 200, y: 200), boxWidth: 768)]
        )
        let actor = PerSectorActor(
            staticSector: sector,
            logger: testLogger,
            rng: SeededGenerator(seed: 7),
            monsterSpawnThreshold: 0
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 900, y: 900)),
            inventory: [],
            outbox: outbox
        )
        // Threshold 0 spawns a monster every tick until the sector-wide cap is reached; running
        // well past the cap must not exceed it.
        for _ in 0 ..< 10 {
            _ = await actor.runAITick()
        }
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let spawnedIndices = Set(decodeEntities(in: frames).filter { $0.type == .monster }.map(\.entityIndex))
        #expect(spawnedIndices.count == SomnioConstants.perSectorMonsterCap)
    }

    @Test func `a spawned monster is placed clear of static masks`() async throws {
        // A wide spawn box overlapping a mask at its left edge: the placement retry must land the
        // monster on a cell whose feet box clears the mask.
        let mask = CollisionMask(x: 200, y: 232, width: 32, height: 16)
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeWideMonsterSpawn(at: GridPoint(x: 200, y: 200), boxWidth: 256)],
            collisionMasks: [mask]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 10, y: 10)),
            inventory: [],
            outbox: outbox
        )
        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let monster = try #require(decodeEntities(in: frames).first { $0.type == .monster })
        let feet = FeetMask.rect(
            forSpriteAt: GridPoint(x: monster.x, y: monster.y),
            spriteSize: GridSize(width: monster.maskWidth, height: monster.maskHeight)
        )
        #expect(!CollisionMaskOverlap.intersects(feet, [mask]))
    }

    @Test func `a fully blocked spawn box keeps the timer armed and spawns once a cell frees`() async throws {
        // A blocker player occupies the single spawn cell at (200, 200), so placement finds no clear
        // cell. With a positive threshold (2), ticks 1-2 advance the cooldown to armed; tick 3 is
        // armed but blocked, so no monster materializes (the old unchecked fallback would have stacked
        // one onto the blocker) AND the cooldown must stay armed. After the blocker detaches, the very
        // next tick spawns. If a regression reset the cooldown on the failed attempt, that next tick
        // would not yet be re-armed and no monster would appear — so exactly one monster proves both
        // the no-fallback fix and the stays-armed retry.
        let sector = makeSector(
            dimensions: GridSize(width: 1024, height: 1024),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 2)
        let observerOutbox = ConnectionOutbox(highWatermark: 4096)
        _ = try await actor.attach(
            character: makeCharacter(name: "observer", at: GridPoint(x: 900, y: 900)),
            inventory: [],
            outbox: observerOutbox
        )
        let blockerOutbox = ConnectionOutbox(highWatermark: 1024)
        let blockerIndex = try await actor.attach(
            character: makeCharacter(name: "blocker", at: GridPoint(x: 200, y: 200)),
            inventory: [],
            outbox: blockerOutbox
        )

        // Ticks 1-2 advance the cooldown to the threshold; tick 3 is armed but blocked (no spawn,
        // cooldown stays armed).
        for _ in 0 ..< 3 {
            _ = await actor.runAITick()
        }
        await actor.detach(entityIndex: blockerIndex, leftGame: false)
        _ = await actor.runAITick() // still armed + cell now free -> spawns immediately

        observerOutbox.finish()
        let frames = await collect(outbox: observerOutbox)
        let spawned = decodeEntities(in: frames).filter { $0.type == .monster }
        #expect(spawned.count == 1)
    }

    @Test func `a spawned monster entity is broadcast to an already-attached player`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        // Player attaches before any spawn; the later spawn must still reach its outbox.
        _ = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 10, y: 10)),
            inventory: [],
            outbox: outbox
        )
        _ = await actor.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        #expect(decodeEntities(in: frames).contains { $0.type == .monster })
    }

    // MARK: - Combat carve-out

    @Test func `monster combat is inert across two hundred ticks`() async throws {
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
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
        let leaveCount = messages.count(where: { message in
            if case .leave = message { return true }
            return false
        })
        #expect(damageSayCount == 0)
        #expect(leaveCount == 0)
    }

    // MARK: - Player move gate vs monsters

    @Test func `handlePosition accepts a player move onto a monster's feet box (monsters are not player blockers)`() async throws {
        // Monsters move every AI tick, so the client's monster view is routinely a frame stale. The
        // player move gate excludes monsters (the monster AI keeps monsters off players instead), so
        // a step whose feet box overlaps a monster is accepted rather than snapped back — the player
        // isn't rubber-banded when walking near a chasing monster.
        let sector = makeSector(
            dimensions: GridSize(width: 512, height: 512),
            monsterSpawns: [makeMonsterSpawn(at: GridPoint(x: 200, y: 200), aiScriptIndex: 0)]
        )
        let actor = PerSectorActor(staticSector: sector, logger: testLogger, monsterSpawnThreshold: 0)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        // Player attaches ~268 px away — outside the 192 px aggro radius — so the spawn tick leaves
        // the monster stationary at (200, 200).
        let playerIndex = try await actor.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 10, y: 10)),
            inventory: [],
            outbox: outbox
        )
        _ = await actor.runAITick() // spawns the idle monster at (200, 200)

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 200, y: 200, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: playerIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: playerIndex)
        #expect(snapshot?.character.position == GridPoint(x: 200, y: 200))

        // The overlapping move must not snap the player back to their own outbox.
        outbox.finish()
        let snappedBack = await decodeServerPositions(in: collect(outbox: outbox))
            .contains { $0.entityIndex == playerIndex }
        #expect(!snappedBack)
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
        // 32x48 sprite cell (box == mask, so no centering offset): with feet-center proximity the
        // NPC's feet center sits ~(origin + (16, 40)), within the 64 px interaction radius of a
        // player standing at adjacent grid coordinates.
        NPC(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: 32, height: 48),
            maskSize: GridSize(width: 32, height: 48),
            name: "test-npc",
            figure: 0,
            direction: 0,
            behaviorTag: 0,
            dialogScript: dialogScript
        )
    }

    private func makeMonsterSpawn(at origin: GridPoint, aiScriptIndex: Int16) -> MonsterSpawn {
        // 32x48 sprite. The spawn box is sized so the 4 px-grid placement range collapses to a
        // single cell (width == sprite width; height == feet height = 48/4 + 4 = 16), making the
        // spawn position deterministic at a 4-aligned `origin`, independent of the RNG.
        MonsterSpawn(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: 32, height: 16),
            spawnedMonsterSize: GridSize(width: 32, height: 48),
            name: "test-monster",
            figure: 0,
            bounded: false,
            spawnHP: 100,
            spawnBalance: 100,
            spawnMana: 100,
            aiScriptIndex: aiScriptIndex
        )
    }

    /// Monster spawn with a wide spawn box so placement samples multiple cells (used to verify
    /// collision-free placement when part of the box is blocked).
    private func makeWideMonsterSpawn(at origin: GridPoint, boxWidth: Int16) -> MonsterSpawn {
        MonsterSpawn(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: boxWidth, height: 16),
            spawnedMonsterSize: GridSize(width: 32, height: 48),
            name: "test-monster",
            figure: 0,
            bounded: false,
            spawnHP: 100,
            spawnBalance: 100,
            spawnMana: 100,
            aiScriptIndex: 0
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
