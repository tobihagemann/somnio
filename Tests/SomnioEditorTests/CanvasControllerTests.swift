import CoreGraphics
import Testing
@testable import SomnioEditor

@MainActor
struct CanvasControllerTests {
    @Test func `gridCoordinate removes the margin so the inset sector origin maps to zero`() {
        // The sector is inset by `margin` of scroll padding; its top-left lands at grid 0.
        #expect(CanvasController.gridCoordinate(forLocal: 128, margin: 128) == 0)
        #expect(CanvasController.gridCoordinate(forLocal: 256, margin: 128) == 128)
    }

    @Test func `gridCoordinate yields negative coords inside the overflow margin`() {
        #expect(CanvasController.gridCoordinate(forLocal: 64, margin: 128) == -64)
    }

    @Test func `gridCoordinate floors fractional points downward`() {
        #expect(CanvasController.gridCoordinate(forLocal: 200.9, margin: 0) == 200)
        #expect(CanvasController.gridCoordinate(forLocal: 127.5, margin: 128) == -1)
    }
}
