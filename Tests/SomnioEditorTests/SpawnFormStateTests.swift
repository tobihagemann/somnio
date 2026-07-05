import SomnioCore
import Testing
@testable import SomnioEditor

@MainActor
struct SpawnFormStateTests {
    @Test(arguments: [Direction.south, .west, .east, .north])
    func `buildNPC bridges the discrete picker direction to the cardinal heading`(direction: Direction) {
        let form = SpawnFormState()
        form.name = "Libus"
        form.direction = direction
        // The picker stays 4-directional; the persisted NPC carries the continuous heading,
        // so the built NPC must face the picked cardinal's exact degrees.
        #expect(form.buildNPC().facing == Heading(cardinal: direction))
    }
}
