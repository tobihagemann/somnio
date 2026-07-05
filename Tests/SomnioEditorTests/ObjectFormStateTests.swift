import SomnioCore
import Testing
@testable import SomnioEditor

@MainActor
struct ObjectFormStateTests {
    @Test func `the model picker options come from the committed registry`() {
        // The picker can only author ids the runtime resolves; the committed registry seeds
        // both the option list and the default selection.
        #expect(EditorDefaults.objectModelIDs.contains("door"))
        #expect(EditorDefaults.objectModelIDs.contains(EditorDefaults.defaultObjectModelID))
        #expect(EditorDefaults.floorMaterialIDs == ["grass-meadow", "stone-arena", "wood-warm"])
        #expect(EditorDefaults.floorMaterialIDs.contains(EditorDefaults.defaultFloorMaterialID))
    }

    @Test func `buildObject carries the picked model id and footprint`() {
        let form = ObjectFormState()
        form.x = 128
        form.y = 96
        form.modelID = "bookshelf"
        form.sourceWidth = 64
        form.sourceHeight = 96
        form.priority = 2
        #expect(form.buildObject() == Object(
            x: 128, y: 96, modelID: "bookshelf", sourceWidth: 64, sourceHeight: 96, priority: 2
        ))
    }

    @Test func `reset re-seeds the registry default model id at the tapped point`() {
        let form = ObjectFormState()
        form.modelID = "tent"
        form.priority = 5
        form.reset(at: GridPoint(x: 32, y: 64))
        #expect(form.x == 32)
        #expect(form.y == 64)
        #expect(form.modelID == EditorDefaults.defaultObjectModelID)
        #expect(form.priority == 0)
    }
}
