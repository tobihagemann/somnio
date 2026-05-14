import CoreGraphics
import Testing
@testable import SomnioUI

struct HUDBarTests {
    @Test(arguments: [
        (Int16(0), Int16(100), CGFloat(0)),
        (Int16(50), Int16(100), CGFloat(74)),
        (Int16(100), Int16(100), CGFloat(148)),
        (Int16(150), Int16(100), CGFloat(148)),
        (Int16(-10), Int16(100), CGFloat(0)),
        (Int16(50), Int16(0), CGFloat(0))
    ])
    func `foreground width`(current: Int16, max: Int16, expected: CGFloat) {
        #expect(HUDBarPair.foregroundWidth(current: current, max: max) == expected)
    }
}
