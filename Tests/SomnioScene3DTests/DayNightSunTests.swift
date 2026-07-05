import Foundation
import simd
import SomnioCore
import Testing
@testable import SomnioScene3D

struct DayNightSunTests {
    private let outdoor = LightSetting(indoor: false, brightness: 100)
    private let outdoorBright = LightSetting(indoor: false, brightness: 200)
    private let indoor75 = LightSetting(indoor: true, brightness: 75)

    /// Direction the sun's light travels (its forward axis) under a state's orientation.
    private func lightDirection(of state: SunState) -> SIMD3<Float> {
        state.orientation.act(SIMD3<Float>(0, 0, -1))
    }

    @Test(arguments: [Int16(0), Int16(6), Int16(12), Int16(21), Int16(23)])
    func `indoor sectors hold authored brightness with a fixed orientation regardless of hour`(hour: Int16) {
        let state = DayNightSun.state(hour: hour, minute: 30, sectorLight: indoor75)
        #expect(state == DayNightSun.state(hour: 12, minute: 0, sectorLight: indoor75))
        #expect(state.orientation == DayNightSun.indoorOrientation)
        #expect(state.sunIntensity == 0.75 * DayNightSun.indoorSunScale * DayNightSun.fullSunIntensity)
        #expect(state.ambientIntensity == 0.75 * DayNightSun.indoorAmbientScale * DayNightSun.fullAmbientIntensity)
    }

    @Test(arguments: [Int16(22), Int16(23), Int16(0), Int16(3), Int16(5)])
    func `night hours hold the dim overhead moon at the curve's night floor`(hour: Int16) {
        let state = DayNightSun.state(hour: hour, minute: 0, sectorLight: outdoor)
        let nightFloor: Float = (100 - (100 - 1) * 0.75) / 100
        #expect(state.orientation == DayNightSun.nightOrientation)
        #expect(abs(state.sunIntensity - nightFloor * DayNightSun.fullSunIntensity) < 0.001)
        #expect(state.sunColor == DayNightSun.nightColor)
    }

    @Test func `dawn light comes in low from the east`() {
        let dawn = DayNightSun.state(hour: 6, minute: 0, sectorLight: outdoor)
        let direction = lightDirection(of: dawn)
        // The sun rises in the east (+X sky), so its light travels westward and level.
        #expect(direction.x < 0)
        #expect(abs(direction.y) < 0.01)
    }

    @Test func `midday sun stands at peak elevation`() {
        let midday = DayNightSun.state(hour: 14, minute: 0, sectorLight: outdoor)
        let direction = lightDirection(of: midday)
        #expect(abs(-direction.y - sin(DayNightSun.maximumElevation)) < 0.01)
        #expect(midday.sunColor == DayNightSun.daylightColor)
        #expect(midday.sunIntensity == DayNightSun.fullSunIntensity)
    }

    @Test func `dusk light comes in from the west`() {
        let dusk = DayNightSun.state(hour: 21, minute: 30, sectorLight: outdoor)
        let direction = lightDirection(of: dusk)
        #expect(direction.x > 0)
        // Near the horizon the tint warms toward the sunset color.
        #expect(dusk.sunColor.z < DayNightSun.daylightColor.z)
    }

    @Test func `the sun orientation tracks the arc between morning and midday`() {
        let morning = lightDirection(of: DayNightSun.state(hour: 8, minute: 0, sectorLight: outdoor))
        let midday = lightDirection(of: DayNightSun.state(hour: 14, minute: 0, sectorLight: outdoor))
        #expect(morning.y > midday.y)
        #expect(morning.x < midday.x)
    }

    @Test func `minutes brighten within a brightening hour`() {
        let atHour = DayNightSun.state(hour: 6, minute: 0, sectorLight: outdoor)
        let lateInHour = DayNightSun.state(hour: 6, minute: 48, sectorLight: outdoor)
        #expect(lateInHour.sunIntensity > atHour.sunIntensity)
        #expect(lateInHour.ambientIntensity > atHour.ambientIntensity)
    }

    @Test(arguments: [Int16(10), Int16(12), Int16(15), Int16(17)])
    func `daylight hours run at full intensity`(hour: Int16) {
        let state = DayNightSun.state(hour: hour, minute: 0, sectorLight: outdoor)
        #expect(state.sunIntensity == DayNightSun.fullSunIntensity)
        #expect(state.ambientIntensity == DayNightSun.fullAmbientIntensity)
    }

    @Test func `outdoor brightness above one hundred passes through the smoothing pass unclamped`() {
        let state = DayNightSun.state(hour: 12, minute: 0, sectorLight: outdoorBright)
        let expected: Float = (100 - (100 - 200) * 0.75) / 100
        #expect(abs(state.sunIntensity - expected * DayNightSun.fullSunIntensity) < 0.001)
    }

    @Test func `the ported ambient curve matches the SpriteKit tint staircase`() {
        // Spot-pin the shared curve shape: night floor, hour-six floor, dimming evening.
        let nightFloor: Float = 100 - (100 - 1) * 0.75
        #expect(DayNightSun.ambientLight(hour: 23, minute: 0, brightness: 100) == nightFloor)
        #expect(DayNightSun.ambientLight(hour: 6, minute: 0, brightness: 100) == nightFloor)
        let nineteen = DayNightSun.ambientLight(hour: 19, minute: 0, brightness: 100)
        let twenty = DayNightSun.ambientLight(hour: 20, minute: 0, brightness: 100)
        #expect(twenty < nineteen)
    }
}
