import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct AccountRepositoryTests {
    @Test func `register and load round trip`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account"))
            let created = try await repo.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            let fetched = try #require(try await repo.findByName("alice"))
            #expect(fetched.id == created.id)
            #expect(fetched.passwordHash == "hash")
            #expect(fetched.email == "alice@example.com")
        }
    }

    @Test func `duplicate name insert raises an error`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account"))
            _ = try await repo.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            await #expect(throws: PSQLError.self) {
                _ = try await repo.create(name: "alice", passwordHash: "other", email: "other@example.com")
            }
        }
    }

    @Test func `findById round trips via primary key`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account.findById"))
            let created = try await repo.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            let fetched = try #require(try await repo.findById(created.id))
            #expect(fetched.id == created.id)
            #expect(fetched.name == "alice")
        }
    }

    @Test func `findById returns nil for an unknown id`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account.findById.miss"))
            let fetched = try await repo.findById(UUID())
            #expect(fetched == nil)
        }
    }

    @Test func `findByName is case insensitive via name_normalized`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account.findByName.case"))
            _ = try await repo.create(name: "Alice", passwordHash: "hash", email: "alice@example.com")
            let lower = try #require(try await repo.findByName("alice"))
            let upper = try #require(try await repo.findByName("ALICE"))
            #expect(lower.name == "Alice")
            #expect(upper.id == lower.id)
        }
    }

    @Test func `NFKC-equivalent name collides with the existing one`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresAccountRepository(client: client, logger: Logger(label: "test.account.findByName.confusable"))
            _ = try await repo.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            // Full-width "ａｌｉｃｅ" (U+FF41 U+FF4C U+FF49 U+FF43 U+FF45) NFKC-normalizes
            // to ASCII "alice" and collides with the existing row. (Cyrillic А / Latin A
            // are visually identical but are not NFKC-equivalent — different scripts entirely
            // — so a confusables-attack defense at this layer can't catch them; that needs
            // a separate confusables/script-mixing check.)
            await #expect(throws: (any Error).self) {
                _ = try await repo.create(
                    name: "\u{FF41}\u{FF4C}\u{FF49}\u{FF43}\u{FF45}",
                    passwordHash: "hash2",
                    email: "evil@example.com"
                )
            }
        }
    }
}
