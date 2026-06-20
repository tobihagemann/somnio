import SomnioCore
import Testing
@testable import SomnioServerCore

/// Coverage for the observe-only movement-anomaly helpers: `movementReferenceVerdict` (is an
/// accepted move implausibly far?) and `anomalyLogDecision` (per-entity rate-limit/coalesce). Both
/// are pure, so they are driven directly without the actor or a clock.
struct MovementVerdictTests {
    @Test func `a short hop within the running budget is not flagged`() {
        let verdict = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0),
            to: GridPoint(x: 10, y: 0),
            elapsed: .milliseconds(50),
            toleranceFactor: 2.0,
            flatSlackPixels: 128,
            minElapsedSeconds: 0.05
        )
        #expect(verdict.distance == 10)
        #expect(!verdict.exceeded)
    }

    @Test func `a far hop over a tiny elapsed is flagged`() {
        let verdict = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0),
            to: GridPoint(x: 1000, y: 0),
            elapsed: .milliseconds(10),
            toleranceFactor: 2.0,
            flatSlackPixels: 128,
            minElapsedSeconds: 0.05
        )
        #expect(verdict.exceeded)
    }

    @Test func `a far hop over a long idle gap is not flagged`() {
        // First move after idle: the elapsed interval is large, so the cap scales up and the same
        // distance that flags over a tiny elapsed is legitimate here.
        let verdict = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0),
            to: GridPoint(x: 1000, y: 0),
            elapsed: .seconds(10),
            toleranceFactor: 2.0,
            flatSlackPixels: 128,
            minElapsedSeconds: 0.05
        )
        #expect(!verdict.exceeded)
    }

    @Test func `the min-elapsed floor caps a near-zero gap instead of shrinking to slack only`() {
        // With elapsed below the floor, the cap uses the floor (0.05s): 240 * 0.05 * 2 + 128 = 152.
        // A 140px hop sits under the floored cap but would exceed the slack-only cap (128) it would
        // get without the floor.
        let verdict = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0),
            to: GridPoint(x: 140, y: 0),
            elapsed: .zero,
            toleranceFactor: 2.0,
            flatSlackPixels: 128,
            minElapsedSeconds: 0.05
        )
        #expect(!verdict.exceeded)
        #expect(abs(verdict.referenceCap - 152) < 1e-6)
    }

    @Test func `a fractional sub-second elapsed contributes to the cap (attoseconds term not dropped)`() {
        // 0.5s is above the 0.05s floor and lives entirely in the attoseconds component (its whole
        // seconds are 0). The cap must reflect it: 240 * 0.5 * 2 + 128 = 368. A 300px hop sits under
        // that, but would exceed the 152 cap the move gets if the attoseconds term were dropped to 0.
        let verdict = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0),
            to: GridPoint(x: 300, y: 0),
            elapsed: .milliseconds(500),
            toleranceFactor: 2.0,
            flatSlackPixels: 128,
            minElapsedSeconds: 0.05
        )
        #expect(!verdict.exceeded)
        #expect(abs(verdict.referenceCap - 368) < 1e-6)
    }

    @Test func `a move exactly at the reference cap is not flagged (strict greater-than boundary)`() {
        // With elapsed .zero, no floor, and a zero speed term, the cap equals the flat slack (100):
        // a 100px move sits exactly at the cap (`distance > cap` is false) and 101px tips over it.
        let atCap = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0), to: GridPoint(x: 100, y: 0), elapsed: .zero,
            toleranceFactor: 2.0, flatSlackPixels: 100, minElapsedSeconds: 0
        )
        let justOver = PerSectorActor.movementReferenceVerdict(
            from: GridPoint(x: 0, y: 0), to: GridPoint(x: 101, y: 0), elapsed: .zero,
            toleranceFactor: 2.0, flatSlackPixels: 100, minElapsedSeconds: 0
        )
        #expect(atCap.referenceCap == 100)
        #expect(!atCap.exceeded)
        #expect(justOver.exceeded)
    }

    @Test func `the flat slack absorbs a small move at zero elapsed`() {
        let from = GridPoint(x: 0, y: 0)
        let to = GridPoint(x: 100, y: 0)
        let withSlack = PerSectorActor.movementReferenceVerdict(
            from: from, to: to, elapsed: .zero,
            toleranceFactor: 2.0, flatSlackPixels: 128, minElapsedSeconds: 0
        )
        let withoutSlack = PerSectorActor.movementReferenceVerdict(
            from: from, to: to, elapsed: .zero,
            toleranceFactor: 2.0, flatSlackPixels: 0, minElapsedSeconds: 0
        )
        #expect(!withSlack.exceeded)
        #expect(withoutSlack.exceeded)
    }

    @Test func `the anomaly log emits once per interval and coalesces suppressed counts`() {
        // First anomaly (no prior log) emits with zero suppressed.
        let first = PerSectorActor.anomalyLogDecision(sinceLastLog: nil, suppressedCount: 0, interval: .seconds(5))
        #expect(first.shouldLog)
        #expect(first.suppressedSinceLast == 0)
        #expect(first.nextSuppressedCount == 0)

        // A burst within the interval stays silent and accumulates the suppressed count.
        let second = PerSectorActor.anomalyLogDecision(sinceLastLog: .seconds(1), suppressedCount: 0, interval: .seconds(5))
        #expect(!second.shouldLog)
        #expect(second.nextSuppressedCount == 1)
        let third = PerSectorActor.anomalyLogDecision(sinceLastLog: .seconds(2), suppressedCount: 1, interval: .seconds(5))
        #expect(!third.shouldLog)
        #expect(third.nextSuppressedCount == 2)

        // Once the interval elapses, the next anomaly emits and reports the coalesced count.
        let fourth = PerSectorActor.anomalyLogDecision(sinceLastLog: .seconds(6), suppressedCount: 2, interval: .seconds(5))
        #expect(fourth.shouldLog)
        #expect(fourth.suppressedSinceLast == 2)
        #expect(fourth.nextSuppressedCount == 0)
    }

    @Test func `a gap exactly equal to the interval re-emits (gate is strict less-than)`() {
        // The gate is `sinceLastLog < interval`, so a gap of exactly one interval is not suppressed —
        // it emits and reports the coalesced count. Pins the boundary against a `<` -> `<=` regression.
        let decision = PerSectorActor.anomalyLogDecision(sinceLastLog: .seconds(5), suppressedCount: 3, interval: .seconds(5))
        #expect(decision.shouldLog)
        #expect(decision.suppressedSinceLast == 3)
        #expect(decision.nextSuppressedCount == 0)
    }
}
