import Foundation
import SomnioCore
import Testing

@MainActor
struct WorldRenderSurfaceTests {
    @Test func `the default sub-pixel updatePosition rounds onto the grid variant`() {
        let surface = GridOnlyRenderSurface()
        surface.updatePosition(entityID: 3, to: SubpixelPoint(x: 10.6, y: -2.4), facing: Heading(cardinal: .east))
        #expect(surface.positions == [GridPoint(x: 11, y: -2)])
    }

    @Test func `gridRounded resolves half-pixel ties away from zero on both signs`() {
        // Pins the collapse rule against a silent drift to nearest-even or truncation.
        #expect(SubpixelPoint(x: 10.5, y: -10.5).gridRounded == GridPoint(x: 11, y: -11))
        #expect(SubpixelPoint(x: -0.5, y: 0.5).gridRounded == GridPoint(x: -1, y: 1))
    }

    @Test func `gridRounded clamps out-of-domain magnitudes into the Int16 pixel grid`() {
        // A plain Int16(...) conversion would trap here; the documented rule clamps.
        #expect(SubpixelPoint(x: 40000, y: -40000).gridRounded == GridPoint(x: Int16.max, y: Int16.min))
    }
}

/// Minimal conformer without the sub-pixel method, standing in for a renderer that can only
/// place entities on the integer grid — pins the protocol's default rounding fallback.
@MainActor
private final class GridOnlyRenderSurface: WorldRenderSurface {
    private(set) var positions: [GridPoint] = []

    func load(sector _: Sector, awaitingPlayerPlacement _: Bool) {}

    func placeEntity(_: WorldEntity) {}

    func updatePosition(entityID _: Int16, to position: GridPoint, facing _: Heading) {
        positions.append(position)
    }

    func animateEntity(_: Int16, to _: GridPoint, facing _: Heading, duration _: TimeInterval) {}

    func updateDayNightTint(hour _: Int16, minute _: Int16, sectorLight _: LightSetting) {}

    func showSpeechBubble(above _: Int16, lines _: [String], lifetimeMs _: Int) {}

    func removeEntity(id _: Int16) {}

    func showSplash() {}
}
