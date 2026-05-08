import Foundation
import Logging
import PostgresNIO
import SomnioCore

public protocol AccountRepository: Sendable {
    func create(name: String, passwordHash: String, email: String) async throws -> Account
    func findByName(_ name: String) async throws -> Account?
    func findById(_ id: UUID) async throws -> Account?
}

public actor PostgresAccountRepository: AccountRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    public func create(name: String, passwordHash: String, email: String) async throws -> Account {
        let id = UUID()
        let createdAt = Date()
        try await client.query(
            """
            INSERT INTO accounts (id, name, password_hash, email, created_at)
            VALUES (\(id), \(name), \(passwordHash), \(email), \(createdAt))
            """,
            logger: logger
        )
        return Account(id: id, name: name, passwordHash: passwordHash, email: email, createdAt: createdAt)
    }

    /// Looks up via the `name_normalized` generated column so case- and Unicode-confusable
    /// variants of the registered name resolve to the same row.
    public func findByName(_ name: String) async throws -> Account? {
        let rows = try await client.query(
            """
            SELECT id, name, password_hash, email, created_at
            FROM accounts
            WHERE name_normalized = LOWER(NORMALIZE(\(name), NFKC))
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeAccount()
        }
        return nil
    }

    public func findById(_ id: UUID) async throws -> Account? {
        let rows = try await client.query(
            """
            SELECT id, name, password_hash, email, created_at
            FROM accounts
            WHERE id = \(id)
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeAccount()
        }
        return nil
    }
}

private extension PostgresRow {
    func decodeAccount() throws -> Account {
        let (id, name, passwordHash, email, createdAt) = try decode(
            (UUID, String, String, String, Date).self
        )
        return Account(
            id: id,
            name: name,
            passwordHash: passwordHash,
            email: email,
            createdAt: createdAt
        )
    }
}
