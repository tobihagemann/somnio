import CoreGraphics
import Foundation
import SomnioCore

/// Translates the world-clock `(hour, minute)` and a sector's authored light setting
/// into the ambient-light value the SpriteKit scene applies as a tint pass. Indoor
/// sectors bypass the day/night case and return the authored brightness verbatim;
/// outdoor sectors run the shared `DayNightAmbient` staircase at `CGFloat`.
public enum DayNightTint {
    public static func ambientLight(hour: Int16, minute: Int16, sectorLight: LightSetting) -> CGFloat {
        let brightness = CGFloat(sectorLight.brightness)
        if sectorLight.indoor {
            return brightness
        }
        return DayNightAmbient.smoothedOutdoorAmbient(hour: hour, minute: minute, brightness: brightness)
    }
}
