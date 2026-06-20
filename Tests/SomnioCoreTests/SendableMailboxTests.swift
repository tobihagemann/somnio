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

    @Test func `concurrent producers lose no elements`() async {
        let (mailbox, stream) = SendableMailbox<Int>.make()
        let producers = 1000
        await withTaskGroup(of: Void.self) { group in
            for value in 0 ..< producers {
                group.addTask { mailbox.enqueue(value) }
            }
        }
        mailbox.finish()
        var collected: [Int] = []
        for await value in stream {
            collected.append(value)
        }
        #expect(collected.count == producers)
        #expect(Set(collected) == Set(0 ..< producers))
    }

    @Test func `finish racing post-finish enqueues stays consistent`() async {
        let (mailbox, stream) = SendableMailbox<Int>.make()
        let baseline = 50
        for value in 0 ..< baseline {
            mailbox.enqueue(value)
        }
        let racers = 1000
        await withTaskGroup(of: Void.self) { group in
            group.addTask { mailbox.finish() }
            for value in 0 ..< racers {
                group.addTask { mailbox.enqueue(baseline + value) }
            }
        }
        #expect(mailbox.isFinished)
        var collected: [Int] = []
        for await value in stream {
            collected.append(value)
        }
        #expect(Set(collected).count == collected.count)
        #expect(Set(collected).isSubset(of: Set(0 ..< (baseline + racers))))
        #expect(collected.count >= baseline)
        #expect(collected.count <= baseline + racers)
    }
}
