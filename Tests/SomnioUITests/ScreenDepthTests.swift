import CoreGraphics
import Testing
@testable import SomnioUI

struct ScreenDepthTests {
    @Test func `entity depth follows the feet-line formula`() {
        // (legacyY + height - height/4 + 4) / 4 + mindestpriority(1).
        #expect(ScreenDepth.entity(legacyY: 0, height: 48) == 11)
    }

    @Test func `a lower entity renders in front of a higher one`() {
        // Larger legacyY (further south, lower on screen) must yield a larger depth so it sorts
        // in front — the core painter's-algorithm invariant.
        let higher = ScreenDepth.entity(legacyY: 100, height: 48)
        let lower = ScreenDepth.entity(legacyY: 200, height: 48)
        #expect(lower > higher)
    }

    @Test func `a priority-class-1 object outranks a class-0 object at the same feet line`() {
        let base = ScreenDepth.object(legacyY: 0, height: 48, priority: 0)
        let lifted = ScreenDepth.object(legacyY: 0, height: 48, priority: 1)
        #expect(lifted > base)
        // The lift is exactly hoechstpriority(480) folded through the /4 depth scale.
        #expect(lifted - base == 120)
    }
}
