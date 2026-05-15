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

    @Test func `resetForTest clears every bit (mirrors didResignActiveNotification path)`() {
        let sampler = KeyboardSampler()
        sampler.updateForTest(keyCode: 13, down: true)
        sampler.updateForTest(keyCode: 56, down: true)
        sampler.resetForTest()
        #expect(sampler.snapshot == KeyboardSampler.Held())
    }
}
