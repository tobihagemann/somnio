import Logging
import Testing
@testable import SomnioData

struct PasswordHasherTests {
    private static let logger = Logger(label: "test.passwordhasher")

    @Test func `hash and verify round trip`() async throws {
        let hasher = PasswordHasher(logger: Self.logger)
        let encoded = try await hasher.hash("hunter2")
        let matched = try await hasher.verify("hunter2", against: encoded)
        #expect(matched == true)
    }

    @Test func `wrong password against valid PHC returns false`() async throws {
        let hasher = PasswordHasher(logger: Self.logger)
        let encoded = try await hasher.hash("hunter2")
        let matched = try await hasher.verify("hunter3", against: encoded)
        #expect(matched == false)
    }

    @Test func `malformed PHC string throws decoding error with non-empty message`() async throws {
        let hasher = PasswordHasher(logger: Self.logger)
        do {
            _ = try await hasher.verify("hunter2", against: "$argon2id$not-a-real-hash")
            Issue.record("expected verify to throw on a malformed PHC string")
        } catch let PasswordHasherError.argon2(code, message) {
            #expect(code != 0)
            #expect(!message.isEmpty)
        }
    }

    @Test func `encoded form parses with default parameters`() async throws {
        let hasher = PasswordHasher(logger: Self.logger)
        let encoded = try await hasher.hash("hunter2")
        #expect(encoded.hasPrefix("$argon2id$v=19$m=19456,t=2,p=1$"))
        let segments = encoded.split(separator: "$", omittingEmptySubsequences: true)
        // segments: ["argon2id", "v=19", "m=19456,t=2,p=1", "<salt>", "<hash>"]
        #expect(segments.count == 5)
    }

    @Test func `hashing the same password twice produces different PHC strings`() async throws {
        // Salt freshness regression guard: a static or repeated salt would silently weaken
        // every stored hash without changing this suite's other assertions.
        let hasher = PasswordHasher(logger: Self.logger)
        let first = try await hasher.hash("hunter2")
        let second = try await hasher.hash("hunter2")
        #expect(first != second)
    }

    @Test func `verifyAccountPassword returns true on matching hash`() async throws {
        let hasher = PasswordHasher(logger: Self.logger)
        let encoded = try await hasher.hash("hunter2")
        let matched = try await hasher.verifyAccountPassword("hunter2", against: encoded)
        #expect(matched == true)
    }

    @Test func `verifyAccountPassword returns false for nil hash and pays comparable Argon2 cost`() async throws {
        // The whole purpose of the `nil` branch is to equalize timing against the unknown-account
        // path; a regression that early-returns `false` without doing Argon2 work would silently
        // turn `verifyAccountPassword` back into a username-existence oracle. Wall-time
        // assertions are flaky on shared CI, so the regression sentinel here is "the unknown
        // branch takes a non-trivial fraction of the hash branch's wall time" rather than a
        // strict equality.
        let hasher = PasswordHasher(logger: Self.logger)
        // Untimed warm-up so the timed measurements below both run against an already-mapped
        // 19 MiB allocation pattern; otherwise the first-call cost can dwarf the second-call
        // cost and let a genuine `return false` regression slip past the ratio assertion.
        _ = try await hasher.hash("warm-up")

        let hashStart = ContinuousClock.now
        _ = try await hasher.hash("baseline")
        let hashElapsed = ContinuousClock.now - hashStart

        let nilStart = ContinuousClock.now
        let result = try await hasher.verifyAccountPassword("anything", against: nil)
        let nilElapsed = ContinuousClock.now - nilStart

        #expect(result == false)
        // Both branches now run warm and should take comparable time. Allow a generous
        // floor for jitter on shared CI, but stay well above the microsecond range a
        // `return false` shortcut would land in.
        #expect(nilElapsed >= hashElapsed / 2, "unknown-account verify path skipped Argon2 work — timing oracle regression")
    }
}
