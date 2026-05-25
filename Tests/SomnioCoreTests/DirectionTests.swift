import SomnioCore
import Testing

struct DirectionTests {
    @Test(arguments: [
        (Direction.south, Int16(0)),
        (Direction.west, Int16(1)),
        (Direction.east, Int16(2)),
        (Direction.north, Int16(3))
    ])
    func `legacyRichtung maps each direction to the original S-W-E-N row order`(direction: Direction, richtung: Int16) {
        #expect(direction.legacyRichtung == richtung)
        #expect(Direction(legacyRichtung: richtung) == direction)
    }

    @Test func `legacyRichtung round-trips for every direction`() {
        for direction in Direction.allCases {
            #expect(Direction(legacyRichtung: direction.legacyRichtung) == direction)
        }
    }

    @Test func `init returns nil for an out-of-range richtung`() {
        #expect(Direction(legacyRichtung: 4) == nil)
        #expect(Direction(legacyRichtung: -1) == nil)
    }
}
