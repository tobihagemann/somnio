import Foundation

/// The legacy outdoor day/night ambient curve on the 0–100 brightness scale: the per-hour
/// brightening/dimming staircases, the five-bucket minute step, and the final smoothing pass.
/// Owned here once and consumed by both render paths — the SpriteKit tint (`DayNightTint`,
/// still serving the editor preview) and the RealityKit sun (`DayNightSun`) — so the curve
/// cannot drift between them. Generic over the consumer's floating-point type so each
/// renderer keeps its native precision (`CGFloat` vs `Float`) bit-for-bit and SomnioCore
/// stays free of CoreGraphics.
public enum DayNightAmbient {
    /// The smoothed outdoor ambient value: the raw staircase pulled a quarter of the way
    /// toward full brightness, so night floors dim rather than black.
    public static func smoothedOutdoorAmbient<Value: BinaryFloatingPoint>(
        hour: Int16, minute: Int16, brightness: Value
    ) -> Value {
        let raw = outdoorAmbient(hour: hour, minute: minute, brightness: brightness)
        return 100 - (100 - raw) * 0.75
    }

    private static func outdoorAmbient<Value: BinaryFloatingPoint>(
        hour: Int16, minute: Int16, brightness: Value
    ) -> Value {
        let perMinuteStep = Value(minute / 12) * (brightness / 20)
        if hour >= 22 || hour <= 5 {
            return 1
        }
        if hour <= 9 {
            return brighteningAmbient(hour: hour, brightness: brightness) + perMinuteStep
        }
        if hour <= 17 {
            return brightness
        }
        return dimmingAmbient(hour: hour, brightness: brightness) - perMinuteStep
    }

    private static func brighteningAmbient<Value: BinaryFloatingPoint>(hour: Int16, brightness: Value) -> Value {
        switch hour {
        case 6: return 1
        case 7: return brightness / 4
        case 8: return brightness / 2
        case 9: return brightness * 0.75
        default: return 1
        }
    }

    private static func dimmingAmbient<Value: BinaryFloatingPoint>(hour: Int16, brightness: Value) -> Value {
        switch hour {
        case 18: return brightness
        case 19: return brightness * 0.75
        case 20: return brightness / 2
        case 21: return brightness / 4
        default: return 1
        }
    }
}
