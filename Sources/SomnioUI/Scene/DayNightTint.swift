import CoreGraphics
import Foundation
import SomnioCore

/// Translates the world-clock `(hour, minute)` and a sector's authored light setting
/// into the ambient-light value the SpriteKit scene applies as a tint pass. Indoor
/// sectors bypass the day/night case and return the authored brightness verbatim;
/// outdoor sectors run the per-hour curve and the final smoothing pass.
public enum DayNightTint {
    public static func ambientLight(hour: Int16, minute: Int16, sectorLight: LightSetting) -> CGFloat {
        let brightness = CGFloat(sectorLight.brightness)
        if sectorLight.indoor {
            return brightness
        }
        let raw = outdoorAmbient(hour: hour, minute: minute, brightness: brightness)
        return 100 - (100 - raw) * 0.75
    }

    private static func outdoorAmbient(hour: Int16, minute: Int16, brightness: CGFloat) -> CGFloat {
        let perMinuteStep = CGFloat(minute / 12) * (brightness / 20)
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

    private static func brighteningAmbient(hour: Int16, brightness: CGFloat) -> CGFloat {
        switch hour {
        case 6: return 1
        case 7: return brightness / 4
        case 8: return brightness / 2
        case 9: return brightness * 0.75
        default: return 1
        }
    }

    private static func dimmingAmbient(hour: Int16, brightness: CGFloat) -> CGFloat {
        switch hour {
        case 18: return brightness
        case 19: return brightness * 0.75
        case 20: return brightness / 2
        case 21: return brightness / 4
        default: return 1
        }
    }
}
