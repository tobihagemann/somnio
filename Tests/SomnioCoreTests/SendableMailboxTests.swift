import Foundation
import Testing
@testable import SomnioCore

struct SendableMailboxTests {
    @Test func `enqueue is observable on the drain stream`() async {
        let (mailbox, stream) = SendableMailbox<Int>.make()
        mailbox.enqueue(1)
        mailbox.enqueue(2)
        mailbox.enqueue(3)
        mailbox.finish()
        var collected: [Int] = []
        for await value in stream {
            collected.append(value)
        }
        #expect(collected == [1, 2, 3])
    }

    @Test func `finish is idempotent`() async {
        let (mailbox, stream) = SendableMailbox<Int>.make()
        mailbox.finish()
        mailbox.finish()
        mailbox.finish()
        #expect(mailbox.isFinished)
        var count = 0
        for await _ in stream {
            count += 1
        }
        #expect(count == 0)
    }

    @Test func `enqueue after finish is silently dropped`() async {
        let (mailbox, stream) = SendableMailbox<Int>.make()
        mailbox.finish()
        mailbox.enqueue(99)
        var collected: [Int] = []
        for await value in stream {
            collected.append(value)
        }
        #expect(collected == [])
    }

    @Test func `isFinished reflects post-finish state`() {
        let (mailbox, _) = SendableMailbox<Int>.make()
        #expect(mailbox.isFinished == false)
        mailbox.finish()
        #expect(mailbox.isFinished == true)
    }
}
