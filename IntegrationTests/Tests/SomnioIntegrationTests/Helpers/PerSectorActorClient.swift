import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioServerCore
import Testing

/// Shared in-process test fixtures that several suites need verbatim:
///
/// - `attachPlayer`: builds the canonical "test dummy" `Character` (figure 0, female,
///   south-facing, full energy) and attaches it to a `PerSectorActor` at an explicit
///   position with the starter inventory.
/// - `waitForCheckpoint`: polls `PostgresCharacterRepository.findByName` until the row's
///   `last_seen` strictly advances past a snapshot captured *after* registration. Using a
///   strict `>` against a post-registration baseline (not just `>=` against test start)
///   keeps the registration write from satisfying the gate before the WS-close
///   `persistCheckpoint` transaction has actually landed.
enum PerSectorActorClient {
    static func attachPlayer(
        actor: PerSectorActor,
        nickname: String,
        sector: Sector,
        position: GridPoint,
        outbox: ConnectionOutbox
    ) async throws -> Int16 {
        let character = Character(
            id: UUID(),
            name: nickname,
            figure: 0,
            gender: .female,
            currentSector: sector.name,
            position: position,
            facing: Heading(cardinal: .south),
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
        )
        return try await actor.attach(
            character: character,
            inventory: StarterInventory.rows,
            outbox: outbox
        )
    }
}

enum CharacterCheckpointPoller {
    /// Resolve a `Character` row whose `last_seen` is strictly after `precloseLastSeen`.
    /// 5 s budget × 100 ms steps mirrors the persistence-test timing established by the
    /// checkpoint-persistence suites. The strict `>` comparator is what distinguishes a fresh
    /// `persistCheckpoint` write from the registration row whose `last_seen` already sits
    /// at `Date()` when the test began.
    static func waitForFreshCheckpoint(
        characters: PostgresCharacterRepository,
        nickname: String,
        after precloseLastSeen: Date,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws -> Character {
        var persisted: Character?
        for _ in 0 ..< 50 {
            try await Task.sleep(for: .milliseconds(100))
            if let candidate = try await characters.findByName(nickname),
               candidate.lastSeen > precloseLastSeen {
                persisted = candidate
                break
            }
        }
        return try #require(persisted, sourceLocation: sourceLocation)
    }

    /// Resolve the character row once the WS-close cleanup has had a chance to commit.
    /// Used as the baseline-capturing step for the strict-advance checkpoint round-trip: the
    /// row may carry either the registration `lastSeen` or the post-close
    /// `persistCheckpoint` value when first observed; both serve as a valid lower bound
    /// for the next session's strict `>` advance.
    static func waitForCharacterRowToAppear(
        characters: PostgresCharacterRepository,
        nickname: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws -> Character {
        var observed: Character?
        for _ in 0 ..< 50 {
            try await Task.sleep(for: .milliseconds(100))
            if let candidate = try await characters.findByName(nickname) {
                observed = candidate
                break
            }
        }
        return try #require(observed, sourceLocation: sourceLocation)
    }
}
