import Foundation
import SomnioCore
import SomnioData

/// Shared repository doubles. Most answer the "do nothing" contract; `StubAccountRepository`
/// and `StubCharacterRepository` take an overridable fixture, and `StubSessionRepository`
/// records call counts. What lives here is decided by how many suites need it, not by whether
/// it records: a double more than one suite drives belongs in this file, and one only a single
/// suite drives stays `private` beside that suite — `FailingSessionRepository` in
/// `LoginTokenIssuanceTests.swift` is that pattern.
///
/// Public because `SomnioTestSupport` is a library product. The no-op stubs are consumed by
/// `SomnioServerCoreTests` and `SomnioCLICoreTests`; `StubSessionRepository` additionally by
/// `SomnioDataTests` and by the sibling `IntegrationTests` package.
public struct StubAccountRepository: AccountRepository {
    /// Accounts `findByName` answers with, keyed by name.
    ///
    /// Empty by default, which is the "do nothing" contract every existing caller wants. It is
    /// overridable because empty is not neutral for `LoginHandler.handle`: an unresolvable name
    /// short-circuits at the `guard let account, verified` before the request gate on session-token
    /// issuance, so `message.requestSessionToken == true` — the expression that keeps `helloVersion`
    /// at 3 — is unreachable from a unit test while this answers `nil`.
    private let accountsByName: [String: Account]

    public init(accountsByName: [String: Account] = [:]) {
        self.accountsByName = accountsByName
    }

    public func create(name _: String, passwordHash _: String, email _: String) async throws -> Account {
        fatalError("StubAccountRepository: create is not used by these tests")
    }

    public func findByName(_ name: String) async throws -> Account? {
        // Exact, case-sensitive subscripting, where `PostgresAccountRepository` matches
        // `name_normalized = LOWER(NORMALIZE($1, NFKC))`. Deliberately not reimplemented here:
        // a second copy of the confusables rule could agree with itself while disagreeing with
        // the column, so this double answers only the exact name a test planted. The
        // consequence is that no test backed by it can establish production's behaviour for a
        // case- or NFKC-equivalent name — deleting the `LOWER(NORMALIZE(...))` from the SQL
        // would fail nothing here. That predicate is covered by
        // `IntegrationTests/.../AccountRepositoryTests.swift`, which resolves a name by a
        // different case and by an NFKC-equivalent spelling against the real generated column.
        accountsByName[name]
    }

    public func findById(_: UUID) async throws -> Account? {
        nil
    }
}

public struct StubCharacterRepository: CharacterRepository {
    /// Characters `findByAccount` answers with, keyed by account.
    ///
    /// Empty by default, which is the "do nothing" contract every existing caller wants. It is
    /// overridable because empty is not neutral for `LoginHandler`: `completeAuthenticatedJoin`
    /// returns `badCredentials` the moment the lookup comes back empty, so *every* path past that
    /// point — the attach, the request-gated token issuance, the join sequence — is unreachable
    /// from a unit test while this answers `[]`.
    private let charactersByAccount: [UUID: [Character]]

    public init(charactersByAccount: [UUID: [Character]] = [:]) {
        self.charactersByAccount = charactersByAccount
    }

    public func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("StubCharacterRepository: create is not used by these tests")
    }

    public func findByAccount(_ accountId: UUID) async throws -> [Character] {
        charactersByAccount[accountId] ?? []
    }

    public func findByName(_: String) async throws -> Character? {
        nil
    }

    public func snapshot(_: Character) async throws -> Bool {
        false
    }

    public func persistCheckpoint(character _: Character, inventory _: [InventoryRow]) async throws -> Bool {
        false
    }
}

public struct StubInventoryRepository: InventoryRepository {
    public init() {}

    public func loadAll(forCharacter _: UUID) async throws -> [InventoryRow] {
        []
    }

    public func replaceAll(forCharacter _: UUID, rows _: [InventoryRow]) async throws {}
}

public struct StubRegistrationRepository: RegistrationRepository {
    public init() {}

    // swiftlint:disable:next function_parameter_count
    public func register(
        name _: String,
        passwordHash _: String,
        email _: String,
        gender _: Gender,
        figure _: Int16,
        starterInventory _: [InventoryRow]
    ) async throws -> (Account, Character) {
        fatalError("StubRegistrationRepository: register is not used by these tests")
    }
}

public struct StubNPCDialogStateRepository: NPCDialogStateRepository {
    public init() {}

    public func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    public func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    public func allKeys() async throws -> [NPCDialogStateKey] {
        []
    }

    public func upsert(_: NPCDialogState) async throws {}
    public func reset(sectorName _: String, npcIndex _: Int16) async throws {}
    public func deleteOrphans(_: [NPCDialogStateKey]) async throws {}
}

public struct StubWorldClockRepository: WorldClockRepository {
    public init() {}

    public func load() async throws -> WorldClock {
        .bootDefault
    }

    public func save(_: WorldClock) async throws {}
}

/// In-memory session store. Unlike `DisabledSessionRepository` (which fails closed and can only
/// ever exercise the *failure* branches), this one actually issues, resolves, and revokes.
///
/// Reaching the success paths of `LoginHandler.issueToken` and `SessionHandler.handleRedeem` takes
/// more than this stub alone: both run only after `completeAuthenticatedJoin` has found a character
/// and resolved its sector, so the dependencies must also carry a `StubCharacterRepository` holding
/// one and a `WorldRouter` holding that character's sector. `makeStubConnectionDependencies` takes
/// both.
///
/// An actor rather than a struct because it holds mutable state; `Sendable` conformance then comes
/// for free instead of through `@unchecked`.
public actor StubSessionRepository: SessionRepository {
    /// Raw token to `(accountId, expiresAt)`. Keyed by the raw value rather than a digest — this is
    /// a test double, and keeping the raw token lets a test assert against what it handed out.
    private var issued: [String: (accountId: UUID, expiresAt: Date)] = [:]
    private var nextTokenNumber = 0

    public init() {}

    public func issue(accountId: UUID, lifetime: TimeInterval) async throws -> IssuedSession {
        nextTokenNumber += 1
        let token = "stub-token-\(nextTokenNumber)"
        let expiresAt = Date().addingTimeInterval(lifetime)
        issued[token] = (accountId, expiresAt)
        return IssuedSession(token: token, expiresAt: expiresAt)
    }

    public func redeem(token: String) async throws -> ResolvedSession? {
        redeemCallCount += 1
        guard let entry = issued[token], entry.expiresAt > Date() else { return nil }
        return ResolvedSession(accountId: entry.accountId, expiresAt: entry.expiresAt)
    }

    @discardableResult
    public func revoke(token: String, accountId: UUID) async throws -> Bool {
        revokeCallCount += 1
        // Scoped on the account to match the shape callers see, but this is an independent
        // implementation: deleting the `AND account_id` predicate from `PostgresSessionRepository`
        // would not fail any test backed by this double. The SQL is covered by
        // `IntegrationTests/.../SessionRepositoryTests.swift`, which revokes with a foreign account
        // and asserts the row survives — and which skips silently without a container runtime.
        guard let entry = issued[token], entry.accountId == accountId else { return false }
        issued.removeValue(forKey: token)
        return true
    }

    @discardableResult
    public func deleteExpired(asOf now: Date) async throws -> Int {
        let expired = issued.filter { $0.value.expiresAt <= now }
        for key in expired.keys {
            issued.removeValue(forKey: key)
        }
        return expired.count
    }

    /// Test seam: whether a raw token is still stored, so a logout test can assert the row is gone
    /// rather than only that an acknowledgement was sent.
    public func isStored(token: String) -> Bool {
        issued[token] != nil
    }

    /// Redeem attempts that reached this repository.
    ///
    /// Exists so a handler test can assert a guard fired *before* the lookup. Asserting the response
    /// alone cannot: an over-cap token is refused either way, so the test passes with the guard
    /// deleted and an unauthenticated frame driving an unbounded digest over attacker-supplied bytes.
    public private(set) var redeemCallCount = 0

    /// Revoke attempts that reached this repository.
    ///
    /// The counterpart to `redeemCallCount`, for the identical reason: `handleRevoke` carries the
    /// same byte-cap guard, and `revoked: false` is the answer whether the guard fired or the lookup
    /// simply missed. Without this the revoke half of that pair is unpinnable — and it is the half
    /// reachable while authenticated.
    public private(set) var revokeCallCount = 0

    /// Tokens this repository has minted, including any later revoked or expired away.
    ///
    /// The counterpart to the two call counts above, for a case they cannot express: a test asserting
    /// that a *failed* join persisted no token has no token value to hand `isStored`, and the absence
    /// of a `sessionToken` frame does not distinguish "never issued" from "issued and the frame was
    /// dropped". A row persists for its full 30-day lifetime with nothing left to revoke it, so
    /// "issuance never ran" is the property worth pinning.
    public var issuedCount: Int {
        nextTokenNumber
    }

    /// Test seam: plants a token with an explicit expiry, so expired and unknown redemption paths
    /// can be driven without waiting.
    public func plant(token: String, accountId: UUID, expiresAt: Date) {
        issued[token] = (accountId, expiresAt)
    }
}
