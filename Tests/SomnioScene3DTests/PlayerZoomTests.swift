import Foundation
import Testing
@testable import SomnioScene3D

struct PlayerZoomTests {
    @Test func `a fresh zoom sits at the default magnification`() {
        #expect(PlayerZoom().factor == 1)
    }

    @Test func `scroll up zooms in and scroll down zooms out multiplicatively`() {
        var zoom = PlayerZoom()
        let zoomedInChanged = zoom.applyScroll(deltaY: 10)
        #expect(zoomedInChanged)
        let zoomedIn = zoom.factor
        #expect(zoomedIn > 1)
        #expect(abs(zoomedIn - exp(10 * PlayerZoom.scrollGain)) < 1e-12)

        let zoomedOutChanged = zoom.applyScroll(deltaY: -10)
        #expect(zoomedOutChanged)
        // Multiplicative steps are symmetric: the opposite delta returns to the start.
        #expect(abs(zoom.factor - 1) < 1e-12)
    }

    @Test(arguments: [
        (1000.0, PlayerZoom.maxFactor),
        (-1000.0, PlayerZoom.minFactor)
    ])
    func `a large scroll clamps at the range end`(deltaY: Double, expected: Double) {
        var zoom = PlayerZoom()
        zoom.applyScroll(deltaY: deltaY)
        #expect(zoom.factor == expected)

        // Further scrolling past the clamp reports no change, so the caller can pass the
        // event back to the responder chain.
        let changedPastClamp = zoom.applyScroll(deltaY: deltaY)
        #expect(!changedPastClamp)
        #expect(zoom.factor == expected)
    }

    @Test func `a scroll away from a clamp end immediately reports a change`() {
        var zoom = PlayerZoom()
        zoom.applyScroll(deltaY: 1000)
        let changed = zoom.applyScroll(deltaY: -1)
        #expect(changed)
        #expect(zoom.factor < PlayerZoom.maxFactor)
    }

    @Test func `clamping bounds any factor into the permitted range`() {
        #expect(PlayerZoom.clamped(0) == PlayerZoom.minFactor)
        #expect(PlayerZoom.clamped(100) == PlayerZoom.maxFactor)
        #expect(PlayerZoom.clamped(1.25) == 1.25)
    }
}
