import Testing
@testable import SomnioServerCore

/// Coverage for `PerSectorActor.nextFreeIndex` — the pure occupancy probe that keeps a wrapped
/// `Int16` allocation cursor from overwriting a still-live slot. Driven directly with a
/// `Set<Int16>`-backed predicate so the wrap and exhaustion paths are covered without 65K attaches.
struct EntityIndexAllocatorTests {
    @Test func `returns the start index when it is free`() {
        let occupied: Set<Int16> = []
        #expect(PerSectorActor.nextFreeIndex(startingAt: 5, isOccupied: { occupied.contains($0) }) == 5)
    }

    @Test func `skips an occupied start to the next free index`() {
        let occupied: Set<Int16> = [5]
        #expect(PerSectorActor.nextFreeIndex(startingAt: 5, isOccupied: { occupied.contains($0) }) == 6)
    }

    @Test func `wraps Int16.max to Int16.min rather than to 1`() {
        // The silent-overwrite regression: `advance(Int16.max)` wraps to `Int16.min` (skipping only
        // 0), so an occupied `Int16.max` must probe into the negative range, not jump to 1.
        let occupied: Set<Int16> = [.max]
        #expect(PerSectorActor.nextFreeIndex(startingAt: .max, isOccupied: { occupied.contains($0) }) == .min)
    }

    @Test func `skips past Int16.min after wrapping from Int16.max`() {
        let occupied: Set<Int16> = [.max, .min]
        #expect(PerSectorActor.nextFreeIndex(startingAt: .max, isOccupied: { occupied.contains($0) }) == Int16.min + 1)
    }

    @Test func `returns nil when every index is occupied`() {
        // Returning the start (an occupied index) would re-introduce the overwrite; the probe must
        // surface exhaustion as nil so the caller can fail closed.
        #expect(PerSectorActor.nextFreeIndex(startingAt: 1, isOccupied: { _ in true }) == nil)
    }
}
