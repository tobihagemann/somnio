import AppKit
import Foundation
import Testing
@testable import SomnioApp

@MainActor
struct KeyboardSamplerTests {
    @Test func `WASD key codes flip the corresponding held flags`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 13, down: true) // W
        sampler.updateForTest(keyCode: 0, down: true) // A
        sampler.updateForTest(keyCode: 1, down: true) // S
        sampler.updateForTest(keyCode: 2, down: true) // D
        var expected = KeyboardSampler.Held()
        expected.w = true
        expected.a = true
        expected.s = true
        expected.d = true
        #expect(sampler.snapshot == expected)
    }

    @Test func `each arrow key drives the matching WASD direction bit`() {
        func heldAfter(_ keyCode: UInt16) -> KeyboardSampler.Held {
            let sampler = KeyboardSampler()
            sampler.updateForTest(keyCode: keyCode, down: true)
            return sampler.snapshot
        }
        var up = KeyboardSampler.Held(); up.w = true
        var down = KeyboardSampler.Held(); down.s = true
        var left = KeyboardSampler.Held(); left.a = true
        var right = KeyboardSampler.Held(); right.d = true
        #expect(heldAfter(126) == up) // Up -> W
        #expect(heldAfter(125) == down) // Down -> S
        #expect(heldAfter(123) == left) // Left -> A
        #expect(heldAfter(124) == right) // Right -> D
    }

    @Test func `arrow keys are consumed during gameplay so they don't leak to the responder chain`() {
        let sampler = KeyboardSampler()
        sampler.isGameplayActive = true
        #expect(sampler.shouldConsume(keyCode: 126, modifierFlags: []) == true) // Up
        #expect(sampler.shouldConsume(keyCode: 124, modifierFlags: []) == true) // Right
    }

    @Test func `keyUp clears the bit`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 13, down: true)
        sampler.updateForTest(keyCode: 13, down: false)
        #expect(sampler.snapshot.w == false)
    }

    @Test func `right shift key code does not affect leftShift state`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 60, down: true) // RShift
        sampler.updateForTest(keyCode: 61, down: true) // ROption
        #expect(sampler.snapshot.leftShift == false)
        #expect(sampler.snapshot.leftOption == false)
    }

    @Test func `left shift key code flips leftShift bit`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 56, down: true) // LShift
        sampler.updateForTest(keyCode: 58, down: true) // LOption
        #expect(sampler.snapshot.leftShift == true)
        #expect(sampler.snapshot.leftOption == true)
    }

    @Test func `clearHeldKeys clears every bit (mirrors didResignActiveNotification and chat-focus paths)`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 13, down: true)
        sampler.updateForTest(keyCode: 56, down: true)
        sampler.clearHeldKeys()
        #expect(sampler.snapshot == KeyboardSampler.Held())
    }

    @Test func `disabling gameplay clears held keys so they don't resume on reactivation`() {
        let sampler = KeyboardSampler()
        sampler.isGameplayActive = true
        sampler.updateForTest(keyCode: 13, down: true) // W held while active
        #expect(sampler.snapshot.w == true)
        // Capture released mid-hold (e.g. an overlay opens): the keyUp won't be consumed, so
        // the held bit must be cleared here to avoid phantom movement when gameplay resumes.
        sampler.isGameplayActive = false
        #expect(sampler.snapshot == KeyboardSampler.Held())
    }

    @Test func `shouldConsume gates WASD on gameplay state and lets command shortcuts through`() {
        let sampler = KeyboardSampler()
        // Inactive: nothing consumed, so keys reach the responder chain (text fields, menus).
        #expect(sampler.shouldConsume(keyCode: 13, modifierFlags: []) == false)

        sampler.isGameplayActive = true
        // Active: bare WASD consumed; Shift/Option (tempo) combos still consumed.
        #expect(sampler.shouldConsume(keyCode: 13, modifierFlags: []) == true) // W
        #expect(sampler.shouldConsume(keyCode: 1, modifierFlags: [.shift]) == true) // Shift-S (run)
        #expect(sampler.shouldConsume(keyCode: 2, modifierFlags: [.option]) == true) // Option-D (walk)
        // Active: Command/Control combos pass through so menu shortcuts still work.
        #expect(sampler.shouldConsume(keyCode: 13, modifierFlags: [.command]) == false) // Cmd-W
        #expect(sampler.shouldConsume(keyCode: 1, modifierFlags: [.control]) == false) // Ctrl-S
        // Active: non-gameplay keys are never consumed.
        #expect(sampler.shouldConsume(keyCode: 12, modifierFlags: []) == false) // Q
    }
}
