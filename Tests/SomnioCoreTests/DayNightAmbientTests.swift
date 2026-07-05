import Foundation
import Testing
@testable import SomnioCore

/// Pins the shared outdoor ambient staircase both render paths consume (`DayNightTint` at
/// `CGFloat`, `DayNightSun` at `Float`). The consumers' own suites keep their behavioral
/// checks; the curve contract lives here once.
struct DayNightAmbientTests {
    @Test(arguments: [Int16(22), Int16(23), Int16(0), Int16(3), Int16(5)])
    func `night hours sit on the smoothed night floor`(hour: Int16) {
        let value = DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: 0, brightness: Double(100))
        let nightFloor: Double = 100 - (100 - 1) * 0.75
        #expect(value == nightFloor)
    }

    @Test(arguments: [Int16(10), Int16(12), Int16(15), Int16(17)])
    func `daylight hours pass the authored brightness through`(hour: Int16) {
        #expect(DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: 0, brightness: Double(100)) == 100)
    }

    @Test func `the morning staircase brightens per hour and per five-bucket minute step`() {
        let six = DayNightAmbient.smoothedOutdoorAmbient(hour: 6, minute: 0, brightness: Double(100))
        let sixLate = DayNightAmbient.smoothedOutdoorAmbient(hour: 6, minute: 48, brightness: Double(100))
        let seven = DayNightAmbient.smoothedOutdoorAmbient(hour: 7, minute: 0, brightness: Double(100))
        let nine = DayNightAmbient.smoothedOutdoorAmbient(hour: 9, minute: 0, brightness: Double(100))
        let nightFloor: Double = 100 - (100 - 1) * 0.75
        #expect(six == nightFloor)
        #expect(six < sixLate)
        #expect(six < seven)
        #expect(seven < nine)
        // Minute buckets step at every 12 minutes: bucket 4 adds 4 x brightness/20.
        let expectedLate = 100 - (100 - (1 + 4 * 100.0 / 20)) * 0.75
        #expect(abs(sixLate - expectedLate) < 0.0001)
    }

    @Test func `the evening staircase dims per hour minus the minute step`() {
        let eighteen = DayNightAmbient.smoothedOutdoorAmbient(hour: 18, minute: 0, brightness: Double(100))
        let eighteenLate = DayNightAmbient.smoothedOutdoorAmbient(hour: 18, minute: 48, brightness: Double(100))
        let twentyOne = DayNightAmbient.smoothedOutdoorAmbient(hour: 21, minute: 0, brightness: Double(100))
        #expect(eighteen == 100)
        #expect(eighteenLate < eighteen)
        #expect(twentyOne < eighteenLate)
    }

    @Test func `brightness above one hundred passes through the smoothing pass unclamped`() {
        let value = DayNightAmbient.smoothedOutdoorAmbient(hour: 12, minute: 0, brightness: Double(200))
        let expected: Double = 100 - (100 - 200) * 0.75
        #expect(value == expected)
    }

    @Test(arguments: [
        (Int16(6), Int16(36)), (Int16(9), Int16(59)), (Int16(12), Int16(0)),
        (Int16(19), Int16(24)), (Int16(23), Int16(0))
    ])
    func `the Float and Double instantiations agree within Float precision`(hour: Int16, minute: Int16) {
        // Each renderer instantiates the generic at its own type (Float vs CGFloat); the
        // curve must not diverge between them beyond representation error.
        let asFloat = DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: minute, brightness: Float(85))
        let asDouble = DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: minute, brightness: Double(85))
        #expect(abs(Double(asFloat) - asDouble) < 0.001)
    }
}
