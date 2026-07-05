import Foundation
import SomnioCore
import Testing

struct HeadingTests {
    @Test(arguments: [
        (Float(0), Float(0)),
        (Float(359.5), Float(359.5)),
        (Float(360), Float(0)),
        (Float(540), Float(180)),
        (Float(-90), Float(270)),
        (Float(-360), Float(0)),
        (Float(-0.0), Float(0)),
        (Float(720.25), Float(0.25))
    ])
    func `init normalizes any degree value into the half-open range`(input: Float, expected: Float) {
        #expect(Heading(degrees: input).degrees == expected)
    }

    @Test(arguments: [Float.nan, .infinity, -.infinity])
    func `init collapses a non-finite value to zero`(input: Float) {
        #expect(Heading(degrees: input).degrees == 0)
    }

    @Test(arguments: [
        (Direction.south, Float(0)),
        (Direction.east, Float(90)),
        (Direction.north, Float(180)),
        (Direction.west, Float(270))
    ])
    func `cardinal bridge round-trips through degrees and nearestCardinal`(cardinal: Direction, degrees: Float) {
        let heading = Heading(cardinal: cardinal)
        #expect(heading.degrees == degrees)
        #expect(heading.nearestCardinal == cardinal)
    }

    @Test(arguments: [
        (Direction.south, Float(0)),
        (Direction.east, .pi / 2),
        (Direction.north, .pi),
        (Direction.west, 3 * .pi / 2)
    ])
    func `radians matches the yaw convention for each cardinal`(cardinal: Direction, radians: Float) {
        #expect(Heading(cardinal: cardinal).radians == radians)
    }

    @Test(arguments: [
        // Each bucket boundary is owned by the higher bucket; 0/360 wraps into south.
        (Float(45), Direction.east),
        (Float(135), Direction.north),
        (Float(225), Direction.west),
        (Float(315), Direction.south),
        (Float(44.9), Direction.south),
        (Float(134.9), Direction.east),
        (Float(224.9), Direction.north),
        (Float(314.9), Direction.west),
        (Float(359.9), Direction.south),
        (Float(360), Direction.south)
    ])
    func `nearestCardinal buckets boundaries deterministically`(degrees: Float, expected: Direction) {
        #expect(Heading(degrees: degrees).nearestCardinal == expected)
    }

    @Test(arguments: [
        // Independent literal expectations pin the axis convention (dx east, dy south),
        // so a swapped-argument or sign defect cannot hide behind a mirrored formula.
        (Float(0), Float(100), Float(0)), // due south
        (Float(100), Float(0), Float(90)), // due east
        (Float(0), Float(-100), Float(180)), // due north
        (Float(-100), Float(0), Float(270)), // due west
        (Float(100), Float(100), Float(45)), // south-east diagonal
        (Float(-100), Float(100), Float(315)) // south-west diagonal
    ])
    func `vector initializer maps floor-axis deltas onto the heading convention`(dx: Float, dy: Float, expected: Float) {
        #expect(abs(Heading(dx: dx, dy: dy).angularDistance(to: Heading(degrees: expected))) < 0.001)
    }

    @Test func `a zero vector resolves to south rather than a non-finite heading`() {
        #expect(Heading(dx: 0, dy: 0) == Heading(cardinal: .south))
    }

    @Test func `angularDistance measures the shortest arc across the wrap seam`() {
        #expect(Heading(degrees: 359).angularDistance(to: Heading(degrees: 1)) == 2)
        #expect(Heading(degrees: 1).angularDistance(to: Heading(degrees: 359)) == -2)
        #expect(Heading(degrees: 10).angularDistance(to: Heading(degrees: 30)) == 20)
        #expect(Heading(degrees: 30).angularDistance(to: Heading(degrees: 10)) == -20)
        #expect(Heading(degrees: 90).angularDistance(to: Heading(degrees: 90)) == 0)
        #expect(abs(Heading(degrees: 0).angularDistance(to: Heading(degrees: 180))) == 180)
    }

    @Test(arguments: [Float(0), 90.5, 137.5, 270, 359.75])
    func `codable round-trips as a bare JSON number`(degrees: Float) throws {
        let heading = Heading(degrees: degrees)
        let encoded = try JSONEncoder().encode(heading)
        #expect(try JSONDecoder().decode(Heading.self, from: encoded) == heading)
    }

    @Test func `decoding normalizes an out-of-range persisted value`() throws {
        let decoded = try JSONDecoder().decode(Heading.self, from: Data("-90".utf8))
        #expect(decoded == Heading(cardinal: .west))
    }
}
