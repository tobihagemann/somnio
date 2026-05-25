import SomnioCore
import Testing
@testable import SomnioEditor

@MainActor
struct SpawnFormStateTests {
    @Test(arguments: [
        (Direction.south, Int16(0)),
        (Direction.west, Int16(1)),
        (Direction.east, Int16(2)),
        (Direction.north, Int16(3))
    ])
    func `buildNPC writes the legacy richtung encoding, not the Direction rawValue`(direction: Direction, expected: Int16) {
        let form = SpawnFormState()
        form.name = "Libus"
        form.direction = direction
        // Picking north must persist legacy richtung 3, not Direction.north.rawValue (0), so the
        // saved bytes match the original on-disk encoding.
        #expect(form.buildNPC().direction == expected)
    }
}
