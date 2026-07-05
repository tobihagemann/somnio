import Foundation
import simd
import SomnioCore

/// One frame of the day/night lighting rig: the sun's orientation plus the intensities and
/// color `WorldScene3D` applies to its retained sun and ambient-fill lights.
public struct SunState: Equatable, Sendable {
    public var orientation: simd_quatf
    /// Directional (sun) light intensity in lux.
    public var sunIntensity: Float
    /// Linear RGB sun tint: warm at the horizon, neutral at height, cool at night.
    public var sunColor: SIMD3<Float>
    /// Fill-light intensity in lux, standing in for sky ambience so the shadow side never
    /// drops to black.
    public var ambientIntensity: Float

    public init(orientation: simd_quatf, sunIntensity: Float, sunColor: SIMD3<Float>, ambientIntensity: Float) {
        self.orientation = orientation
        self.sunIntensity = sunIntensity
        self.sunColor = sunColor
        self.ambientIntensity = ambientIntensity
    }
}

/// Pure mapping from the world clock and a sector's authored light setting to the 3D sun
/// state — the RealityKit counterpart of the SpriteKit tint's `DayNightTint.ambientLight`,
/// driven by the same shared `DayNightAmbient` staircase (the retained 2D helper keeps
/// serving the editor preview). Kept free of RealityKit like `OrthographicCameraRig` so the
/// curve is unit-testable without a live renderer; the intensity constants are
/// prototype-time tunables, not fixed contracts.
public enum DayNightSun {
    /// Sun lux at full daylight; every other brightness scales proportionally, mirroring the
    /// legacy 0–100 ambient scale.
    static let fullSunIntensity: Float = 6000
    /// Fill lux at full daylight, keeping shadowed faces readable under the fixed camera.
    static let fullAmbientIntensity: Float = 1200
    /// The outdoor sun arc runs sunrise→sunset across these world-clock hours; outside them
    /// the night sky holds a fixed dim overhead light (the curve's night floor).
    static let dayStartHour: Float = 6
    static let dayEndHour: Float = 22
    /// Peak sun elevation at midday, in radians. Below ~90° so shadows always have a direction.
    static let maximumElevation: Float = 65 * .pi / 180
    /// Southward lean of the whole arc so midday shadows fall visibly under the 3/4 camera
    /// instead of vanishing beneath their casters.
    static let southwardLean: Float = 0.35

    static let daylightColor = SIMD3<Float>(1, 1, 1)
    static let horizonColor = SIMD3<Float>(1, 0.72, 0.5)
    static let nightColor = SIMD3<Float>(0.7, 0.8, 1)

    /// Fixed orientations for the two arc-less cases: indoor sectors (authored brightness,
    /// no sun) and outdoor night (the dim "moon"). The indoor key keeps the 2D bake's
    /// top-left screen direction but stands much steeper than any sun: ceiling lights throw
    /// short shadows, and a low key indoors reads as evening sunlight through a window.
    static let indoorOrientation = OrthographicCameraRig.lookRotation(from: normalize(SIMD3<Float>(-0.4, 1, 0.28)), to: .zero)
    static let nightOrientation = OrthographicCameraRig.lookRotation(from: normalize(SIMD3<Float>(-0.2, 1, 0.3)), to: .zero)

    /// Indoor fill fraction of the outdoor fill: with no sky the fill stands in for walls
    /// and lamps bouncing light everywhere, so indoor contrast stays softer than under the
    /// sun — but a full-strength fill would cancel the key's modeling entirely.
    static let indoorAmbientScale: Float = 0.65
    /// Indoor key fraction of the outdoor sun: lamps are dimmer than daylight, and a
    /// full-sun key indoors reads overexposed.
    static let indoorSunScale: Float = 0.8

    public static func state(hour: Int16, minute: Int16, sectorLight: LightSetting) -> SunState {
        if sectorLight.indoor {
            let level = Float(sectorLight.brightness) / 100
            return SunState(
                orientation: indoorOrientation,
                sunIntensity: level * indoorSunScale * fullSunIntensity,
                sunColor: daylightColor,
                ambientIntensity: level * indoorAmbientScale * fullAmbientIntensity
            )
        }
        let level = ambientLight(hour: hour, minute: minute, brightness: Float(sectorLight.brightness)) / 100
        let time = Float(hour) + Float(minute) / 60
        guard time >= dayStartHour, time < dayEndHour else {
            return SunState(
                orientation: nightOrientation,
                sunIntensity: level * fullSunIntensity,
                sunColor: nightColor,
                ambientIntensity: level * fullAmbientIntensity
            )
        }
        let progress = (time - dayStartHour) / (dayEndHour - dayStartHour)
        let elevation = maximumElevation * sin(progress * .pi)
        // The sun rises east (+X), arcs through the leaning south, and sets west (-X).
        let horizontal = normalize(SIMD3<Float>(cos(progress * .pi), 0, southwardLean))
        let skyDirection = horizontal * cos(elevation) + SIMD3<Float>(0, 1, 0) * sin(elevation)
        let warmth = elevation / maximumElevation
        return SunState(
            orientation: OrthographicCameraRig.lookRotation(from: skyDirection, to: .zero),
            sunIntensity: level * fullSunIntensity,
            sunColor: simd_mix(horizonColor, daylightColor, SIMD3<Float>(repeating: warmth)),
            ambientIntensity: level * fullAmbientIntensity
        )
    }

    /// The outdoor ambient value on the legacy 0–100 scale — the shared `DayNightAmbient`
    /// staircase instantiated at `Float`. Internal so curve tests can pin the sun's input
    /// without going through the intensity scaling.
    static func ambientLight(hour: Int16, minute: Int16, brightness: Float) -> Float {
        DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: minute, brightness: brightness)
    }
}
