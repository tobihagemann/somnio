import Foundation
import Testing
@testable import SomnioCore

struct WorldClockTests {
    @Test func `boot default`() {
        let c = WorldClock.bootDefault
        #expect(c.second == 0)
        #expect(c.minute == 0)
        #expect(c.hour == 12)
        #expect(c.day == 1)
        #expect(c.month == 1)
        #expect(c.year == 500)
    }

    @Test func `increment second`() {
        var c = WorldClock(second: 5, minute: 0, hour: 12, day: 1, month: 1, year: 500)
        let wire = c.tick()
        #expect(c.second == 6)
        #expect(wire == WorldClock.WireTime(hour: 12, minute: 0))
    }

    @Test func `minute rollover`() {
        var c = WorldClock(second: 59, minute: 5, hour: 12, day: 1, month: 1, year: 500)
        let wire = c.tick()
        #expect(c.second == 0)
        #expect(c.minute == 6)
        #expect(wire == WorldClock.WireTime(hour: 12, minute: 6))
    }

    @Test func `hour rollover at midnight`() {
        // From 23:59:59 → wire shows hour=24, internal state rolls to 00:00:00 day+1.
        var c = WorldClock(second: 59, minute: 59, hour: 23, day: 1, month: 1, year: 500)
        let wire = c.tick()
        #expect(wire == WorldClock.WireTime(hour: 24, minute: 0))
        #expect(c.second == 0)
        #expect(c.minute == 0)
        #expect(c.hour == 0)
        #expect(c.day == 2)
        #expect(c.month == 1)
        #expect(c.year == 500)
    }

    @Test func `day rollover`() {
        // Day 28→1, month++.
        var c = WorldClock(second: 59, minute: 59, hour: 23, day: 28, month: 1, year: 500)
        let wire = c.tick()
        #expect(wire == WorldClock.WireTime(hour: 24, minute: 0))
        #expect(c.day == 1)
        #expect(c.month == 2)
        #expect(c.year == 500)
    }

    @Test func `month rollover`() {
        // Month 12→1, year++.
        var c = WorldClock(second: 59, minute: 59, hour: 23, day: 28, month: 12, year: 500)
        let wire = c.tick()
        #expect(wire == WorldClock.WireTime(hour: 24, minute: 0))
        #expect(c.day == 1)
        #expect(c.month == 1)
        #expect(c.year == 501)
    }

    @Test func `non hour rollover does not emit 24`() {
        var c = WorldClock(second: 59, minute: 11, hour: 12, day: 1, month: 1, year: 500)
        let wire = c.tick()
        #expect(wire == WorldClock.WireTime(hour: 12, minute: 12))
    }

    @Test func `non midnight hour rollover increments hour without resetting`() {
        // 12:59:59 → wire emits hour=13, internal state moves to 13:00:00 (no day rollover).
        var c = WorldClock(second: 59, minute: 59, hour: 12, day: 5, month: 7, year: 500)
        let wire = c.tick()
        #expect(wire == WorldClock.WireTime(hour: 13, minute: 0))
        #expect(c.second == 0)
        #expect(c.minute == 0)
        #expect(c.hour == 13)
        #expect(c.day == 5)
        #expect(c.month == 7)
        #expect(c.year == 500)
    }
}
