import SomnioCore
import Testing
@testable import SomnioServerCore

/// Pins the derived NPC dialog cooldown cap so a future edit to either input — the shared
/// wall-clock policy or the server tick cadence — or the derivation itself surfaces as a
/// failing test rather than a silent gameplay-timing change.
struct DialogCooldownCapTests {
    @Test func `dialog cooldown cap derives to 59 from the cooldown seconds and tick interval`() {
        // 3.0 s / 0.05 s = 60 ticks per cooldown; the cap is the `==`-gate value reached
        // before the next tick emits, so `60 - 1 = 59`.
        #expect(SomnioConstants.npcDialogCooldownSeconds == 3.0)
        #expect(AITickService.defaultAITickIntervalSeconds == 0.05)
        #expect(NPCRuntime.dialogCooldownCap == 59)
    }
}
