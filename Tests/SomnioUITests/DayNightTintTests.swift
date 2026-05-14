import CoreGraphics
import Testing
@testable import SomnioCore
@testable import SomnioUI

struct DayNightTintTests {
    private let outdoor = LightSetting(indoor: false, brightness: 100)
    private let outdoorBright = LightSetting(indoor: false, brightness: 200)
    private let indoor75 = LightSetting(indoor: true, brightness: 75)
    private let indoor100 = LightSetting(indoor: true, brightness: 100)

    @Test func `indoor sectors return their authored brightness verbatim regardless of hour`() {
        #expect(DayNightTint.ambientLight(hour: 0, minute: 0, sectorLight: indoor75) == 75)
        #expect(DayNightTint.ambientLight(hour: 12, minute: 30, sectorLight: indoor100) == 100)
        #expect(DayNightTint.ambientLight(hour: 23, minute: 45, sectorLight: indoor75) == 75)
    }

    @Test(arguments: [Int16(22), Int16(23), Int16(24), Int16(0), Int16(3), Int16(5)])
    func `night hours route to the night floor under outdoor sectors`(hour: Int16) {
        let value = DayNightTint.ambientLight(hour: hour, minute: 0, sectorLight: outdoor)
        let expected: CGFloat = 100 - (100 - 1) * 0.75
        #expect(value == expected)
    }

    @Test func `outdoor brightness above one hundred passes through the smoothing pass unclamped`() {
        let value = DayNightTint.ambientLight(hour: 12, minute: 0, sectorLight: outdoorBright)
        let expected: CGFloat = 100 - (100 - 200) * 0.75
        #expect(value == expected)
    }

    @Test func `hour six starts at the night floor and brightens per minute`() {
        let atHour = DayNightTint.ambientLight(hour: 6, minute: 0, sectorLight: outdoor)
        let lateInHour = DayNightTint.ambientLight(hour: 6, minute: 48, sectorLight: outdoor)
        #expect(atHour < lateInHour)
        #expect(atHour == 100 - (100 - 1) * 0.75)
    }

    @Test(arguments: [
        (Int16(0), Int16(0)),
        (Int16(11), Int16(0)),
        (Int16(12), Int16(1)),
        (Int16(23), Int16(1)),
        (Int16(24), Int16(2)),
        (Int16(36), Int16(3)),
        (Int16(48), Int16(4)),
        (Int16(59), Int16(4))
    ])
    func `minute steps follow a five-bucket staircase across the hour`(minute: Int16, bucketIndex: Int16) {
        let value = DayNightTint.ambientLight(hour: 6, minute: minute, sectorLight: outdoor)
        let perMinuteStep = CGFloat(100) / 20 * CGFloat(bucketIndex)
        let expected = 100 - (100 - (1 + perMinuteStep)) * 0.75
        #expect(abs(value - expected) < 0.0001)
    }

    @Test func `hours seven through nine brighten relative to hour six`() {
        let six = DayNightTint.ambientLight(hour: 6, minute: 0, sectorLight: outdoor)
        let seven = DayNightTint.ambientLight(hour: 7, minute: 0, sectorLight: outdoor)
        let eight = DayNightTint.ambientLight(hour: 8, minute: 0, sectorLight: outdoor)
        let nine = DayNightTint.ambientLight(hour: 9, minute: 0, sectorLight: outdoor)
        #expect(six < seven)
        #expect(seven < eight)
        #expect(eight < nine)
    }

    @Test(arguments: [Int16(10), Int16(12), Int16(15), Int16(17)])
    func `hours ten through seventeen are full daylight after smoothing`(hour: Int16) {
        let value = DayNightTint.ambientLight(hour: hour, minute: 0, sectorLight: outdoor)
        #expect(value == 100)
    }

    @Test func `hour eighteen dims from full daylight`() {
        let seventeen = DayNightTint.ambientLight(hour: 17, minute: 0, sectorLight: outdoor)
        let eighteen = DayNightTint.ambientLight(hour: 18, minute: 0, sectorLight: outdoor)
        let eighteenLate = DayNightTint.ambientLight(hour: 18, minute: 48, sectorLight: outdoor)
        #expect(eighteen == seventeen)
        #expect(eighteenLate < eighteen)
    }

    @Test func `hours nineteen through twenty-one continue dimming`() {
        let eighteen = DayNightTint.ambientLight(hour: 18, minute: 0, sectorLight: outdoor)
        let nineteen = DayNightTint.ambientLight(hour: 19, minute: 0, sectorLight: outdoor)
        let twenty = DayNightTint.ambientLight(hour: 20, minute: 0, sectorLight: outdoor)
        let twentyOne = DayNightTint.ambientLight(hour: 21, minute: 0, sectorLight: outdoor)
        #expect(nineteen < eighteen)
        #expect(twenty < nineteen)
        #expect(twentyOne < twenty)
    }
}
