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
}
