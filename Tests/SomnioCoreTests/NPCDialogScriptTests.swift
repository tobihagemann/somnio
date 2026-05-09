import Foundation
import Testing
@testable import SomnioCore

struct NPCDialogScriptTests {
    @Test func `single step script with no separator yields one entry`() {
        let npc = makeNPC(dialogScript: "Hello, $name.")
        #expect(npc.dialogSteps == ["Hello, $name."])
    }

    @Test func `two step script splits on the separator`() {
        let npc = makeNPC(dialogScript: "Step one.\n---\nStep two.")
        #expect(npc.dialogSteps == ["Step one.", "Step two."])
    }

    @Test func `internal whitespace inside a step is preserved`() {
        // Only the surrounding `\n` is trimmed; spaces and tabs inside the step survive.
        let npc = makeNPC(dialogScript: "\n  hi   $name\t\n")
        #expect(npc.dialogSteps == ["  hi   $name\t"])
    }

    @Test func `empty dialog script yields empty array`() {
        let npc = makeNPC(dialogScript: "")
        #expect(npc.dialogSteps.isEmpty)
    }

    private func makeNPC(dialogScript: String) -> NPC {
        NPC(
            spawnOrigin: GridPoint(x: 0, y: 0),
            spawnBoxSize: GridSize(width: 0, height: 0),
            maskSize: GridSize(width: 0, height: 0),
            name: "tester",
            figure: 0,
            direction: 0,
            behaviorTag: 0,
            dialogScript: dialogScript
        )
    }
}
