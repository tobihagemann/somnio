import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// The login success path, and the request gate on session-token issuance that sits inside it.
///
/// Reaching any of this needs a character *and* its sector: `completeAuthenticatedJoin` answers
/// `badCredentials` on an empty `findByAccount` and again on a sector the router does not hold, so
/// the dependencies here supply both. The gate itself is the invariant that keeps `helloVersion` at
/// 3 rather than locking out every released macOS player.
struct LoginTokenIssuanceTests {
    /// A login that asked for a token gets one, and its raw value is the one the repository issued.
    @Test func `a login requesting a session token receives one`() async throws {
        let sessions = StubSessionRepository()
        let world = try await makeWorld(sessions: sessions)
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.completeAuthenticatedJoin(
            accountId: world.accountId,
            on: connection,
            dependencies: world.dependencies,
            issueSessionToken: true
        )
        outbox.finish()

        let messages = await collectMessages(from: outbox)
        #expect(messages.map(\.tag).contains(.loginResult))
        let token = messages.compactMap { message -> SessionTokenMessage? in
            guard case let .sessionToken(payload) = message else { return nil }
            return payload
        }.first
        let issued = try #require(token)
        #expect(await sessions.isStored(token: issued.token))
        #expect(issued.expiresInSeconds > 0)
    }

    /// The other direction: `completeAuthenticatedJoin` asked not to issue emits no `sessionToken`
    /// frame at all.
    ///
    /// This pins that helper's own behaviour, *not* the wire gate — it hands `issueSessionToken`
    /// in directly, downstream of `message.requestSessionToken == true`, so loosening that
    /// expression to `!= false` leaves this test green. The test that fails on it is
    /// `a login omitting requestSessionToken is answered without a token`, which drives
    /// `LoginHandler.handle`; keep that one when trimming.
    @Test func `a login that did not ask receives no session token`() async throws {
        let sessions = StubSessionRepository()
        let world = try await makeWorld(sessions: sessions)
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.completeAuthenticatedJoin(
            accountId: world.accountId,
            on: connection,
            dependencies: world.dependencies,
            issueSessionToken: false
        )
        outbox.finish()

        let tags = await collectMessages(from: outbox).map(\.tag)
        #expect(tags.contains(.loginResult))
        #expect(!tags.contains(.sessionToken))
    }

    /// Issuance failure is swallowed on purpose — the player is already authenticated, so losing a
    /// token must not cost them the session. Asserting the join still completes is what pins that:
    /// a `try` that escaped instead would drop the character on the floor after `loginResult.ok`.
    @Test func `a failed token issuance still completes the join`() async throws {
        let world = try await makeWorld(sessions: FailingSessionRepository())
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.completeAuthenticatedJoin(
            accountId: world.accountId,
            on: connection,
            dependencies: world.dependencies,
            issueSessionToken: true
        )
        outbox.finish()

        let tags = await collectMessages(from: outbox).map(\.tag)
        #expect(tags.contains(.loginResult))
        #expect(!tags.contains(.sessionToken))
        // The join proceeded past issuance rather than aborting on it.
        #expect(tags.contains(.enterSector))
    }

    /// A join that fails at `PerSectorActor.attach` issues no token and answers with a terminal
    /// frame rather than going quiet.
    ///
    /// The token is a 30-day row in `sessions`; minting it before the player is in the world means a
    /// failed attach leaves a durable credential behind a session that never existed, and nothing
    /// revokes it because the catch has no token to name. The `badCredentials` half is the other
    /// side of the same defect: the client already has `loginResult.ok`, so without a second frame it
    /// waits in `awaitingEnterSector` forever — neither client times that state out.
    ///
    /// Attach is failed through the encoder rather than through a new stub seam: `attach` throws in
    /// exactly two ways, entity-index exhaustion (65,535 occupied slots, unreachable in a test) and
    /// `SomnioMessageEncoder.encode` refusing an oversized frame. `WireObject.modelID` is an
    /// unbounded `String`, so one object carrying more than `maxFrameLength` of it makes the very
    /// first `enterSector` send throw — the real production branch, driven with no production code
    /// bent to reach it.
    @Test func `a join that fails to attach issues no token and reports the failure`() async throws {
        let sessions = StubSessionRepository()
        let oversizedObject = Object(
            x: 0,
            y: 0,
            modelID: String(repeating: "a", count: Int(SomnioProtocolConstants.maxFrameLength) + 1),
            sourceWidth: 32,
            sourceHeight: 32,
            priority: 0
        )
        let world = try await makeWorld(sessions: sessions, objects: [oversizedObject])
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.completeAuthenticatedJoin(
            accountId: world.accountId,
            on: connection,
            dependencies: world.dependencies,
            issueSessionToken: true
        )
        outbox.finish()

        let messages = await collectMessages(from: outbox)
        let results = messages.compactMap { message -> LoginResultCode? in
            guard case let .loginResult(payload) = message else { return nil }
            return payload.result
        }
        // The `.ok` anchors the test on the attach having been reached at all; the `.badCredentials`
        // is the frame that unwedges the client.
        #expect(results == [.ok, .badCredentials])
        #expect(!messages.map(\.tag).contains(.enterSector))
        #expect(!messages.map(\.tag).contains(.sessionToken))
        // The `sessions` row is the durable half, and the absent frame does not pin it: issuance
        // persists before it sends, so a token minted here would survive its full 30-day lifetime
        // with the client that would have carried it already torn down.
        #expect(await sessions.issuedCount == 0)

        // The router slot is released too — a second attempt is answered `.ok` again rather than
        // `.alreadyLoggedIn`, which is what a leaked registration would produce and which would lock
        // the player out until the row aged off.
        let retryConnection = ConnectionActor(dependencies: world.dependencies)
        let retryOutbox = await retryConnection.connectionOutbox
        await LoginHandler.completeAuthenticatedJoin(
            accountId: world.accountId,
            on: retryConnection,
            dependencies: world.dependencies,
            issueSessionToken: false
        )
        retryOutbox.finish()
        let retryResults = await collectMessages(from: retryOutbox).compactMap { message -> LoginResultCode? in
            guard case let .loginResult(payload) = message else { return nil }
            return payload.result
        }
        #expect(retryResults.first == .ok)
    }

    /// A resumed connection must be indistinguishable from a fresh login downstream.
    @Test func `redeeming a live token joins the world`() async throws {
        let sessions = StubSessionRepository()
        let world = try await makeWorld(sessions: sessions)
        let issued = try await sessions.issue(accountId: world.accountId, lifetime: 3600)
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await SessionHandler.handleRedeem(
            RedeemSessionMessage(token: issued.token),
            on: connection,
            dependencies: world.dependencies
        )
        outbox.finish()

        let messages = await collectMessages(from: outbox)
        let results = messages.compactMap { message -> LoginResultCode? in
            guard case let .loginResult(payload) = message else { return nil }
            return payload.result
        }
        #expect(results == [.ok])
        #expect(messages.map(\.tag).contains(.enterSector))
        // No rotation on redemption: the plan records that minting a replacement before
        // `WorldRouter.register` succeeds would invalidate the credential on the first
        // `alreadyLoggedIn` answer and break the bounded resume retry.
        #expect(!messages.map(\.tag).contains(.sessionToken))
        #expect(await sessions.isStored(token: issued.token))
    }

    /// The degraded-database branch: with Postgres briefly unreachable the lookup *throws* rather
    /// than answering "not found", and the `catch` is the only thing that turns that into a frame
    /// the client can act on. Without it the client sits in `awaitingLoginResult` with no world, no
    /// form, and no error.
    @Test func `a redeem that throws answers badCredentials rather than nothing`() async throws {
        let world = try await makeWorld(sessions: FailingSessionRepository())
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await SessionHandler.handleRedeem(
            RedeemSessionMessage(token: "any"),
            on: connection,
            dependencies: world.dependencies
        )
        outbox.finish()

        let results = await collectMessages(from: outbox).compactMap { message -> LoginResultCode? in
            guard case let .loginResult(payload) = message else { return nil }
            return payload.result
        }
        #expect(results == [.badCredentials])
    }

    /// The same degraded path on the authenticated half. `revoked: false` is a truthful answer here
    /// — the row may well still exist — and it is what lets the client clear local storage and stop
    /// claiming a session it cannot verify.
    @Test func `a revoke that throws answers rather than going silent`() async throws {
        let world = try await makeWorld(sessions: FailingSessionRepository())
        let connection = ConnectionActor(dependencies: world.dependencies)
        await connection.markAttached(entityIndex: 1, sectorName: "A", accountId: world.accountId)
        let outbox = await connection.connectionOutbox

        await SessionHandler.handleRevoke(
            RevokeSessionMessage(token: "any"),
            accountId: world.accountId,
            on: connection,
            dependencies: world.dependencies
        )
        outbox.finish()

        let revoked = await collectMessages(from: outbox).compactMap { message -> Bool? in
            guard case let .sessionRevoked(payload) = message else { return nil }
            return payload.revoked
        }
        #expect(revoked == [false])
    }

    // MARK: - Helpers

    private struct World {
        let dependencies: ConnectionDependencies
        let accountId: UUID
    }

    /// Drives `LoginHandler.handle` rather than `completeAuthenticatedJoin`, so the gate expression
    /// `message.requestSessionToken == true` is the thing under test rather than a Bool the test
    /// hands in. Loosening it to `!= false` would issue a token to every released macOS player,
    /// whose `Login` omits the field entirely — and an unrecognized inbound tag closes their
    /// connection.
    @Test func `a login omitting requestSessionToken is answered without a token`() async throws {
        let sessions = StubSessionRepository()
        let world = try await makeAuthenticatedWorld(sessions: sessions, name: "gated", password: "hunter2-long")
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.handle(
            LoginMessage(nickname: "gated", password: "hunter2-long"),
            on: connection,
            dependencies: world.dependencies
        )
        outbox.finish()

        let tags = await collectMessages(from: outbox).map(\.tag)
        // Anchored on the join having actually happened, so the negative below cannot pass because
        // the handler bailed at a guard before ever reaching the gate.
        #expect(tags.contains(.enterSector))
        #expect(!tags.contains(.sessionToken))
    }

    @Test func `a login setting requestSessionToken is answered with one`() async throws {
        let sessions = StubSessionRepository()
        let world = try await makeAuthenticatedWorld(sessions: sessions, name: "asker", password: "hunter2-long")
        let connection = ConnectionActor(dependencies: world.dependencies)
        let outbox = await connection.connectionOutbox

        await LoginHandler.handle(
            LoginMessage(nickname: "asker", password: "hunter2-long", requestSessionToken: true),
            on: connection,
            dependencies: world.dependencies
        )
        outbox.finish()

        let tags = await collectMessages(from: outbox).map(\.tag)
        #expect(tags.contains(.enterSector))
        #expect(tags.contains(.sessionToken))
    }

    /// A one-sector world holding one character, which is the minimum `completeAuthenticatedJoin`
    /// needs to get past both of its guards.
    private func makeWorld(
        sessions: any SessionRepository,
        accountId: UUID = UUID(),
        characterName: String = "tester",
        accounts: StubAccountRepository = StubAccountRepository(),
        objects: [Object] = []
    ) async throws -> World {
        let character = Character(
            id: UUID(),
            name: characterName,
            figure: 0,
            gender: .male,
            currentSector: "A",
            position: GridPoint(x: 64, y: 64),
            facing: Heading(cardinal: .south),
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
        )
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: objects,
            collisionMasks: [],
            portals: [],
            npcs: [],
            monsterSpawns: []
        )
        let dependencies = try await makeStubConnectionDependencies(
            sessions: sessions,
            sectors: ["A": Sector(body: body, name: "A")],
            characters: StubCharacterRepository(charactersByAccount: [accountId: [character]]),
            accounts: accounts
        )
        return World(dependencies: dependencies, accountId: accountId)
    }

    /// A world whose account repository resolves `name`, so `LoginHandler.handle` gets past its
    /// credential guard and actually evaluates the request gate.
    private func makeAuthenticatedWorld(
        sessions: any SessionRepository,
        name: String,
        password: String
    ) async throws -> World {
        let accountId = UUID()
        let hasher = PasswordHasher(logger: Logger(label: "test.login-gate"))
        let account = try await Account(
            id: accountId,
            name: name,
            passwordHash: hasher.hash(password),
            email: "gate@example.invalid",
            createdAt: Date()
        )
        return try await makeWorld(
            sessions: sessions,
            accountId: accountId,
            characterName: name,
            accounts: StubAccountRepository(accountsByName: [name: account])
        )
    }

    private func collectMessages(from outbox: ConnectionOutbox) async -> [SomnioMessage] {
        await collect(outbox: outbox).compactMap { try? SomnioMessageDecoder.decode($0) }
    }
}

/// A session repository whose every operation throws.
///
/// `DisabledSessionRepository` fails closed on `issue` alone and answers the read paths with "not
/// found", so it exercises the *refusal* branches but never the `catch` blocks. Those are a
/// different behaviour: when Postgres is briefly unreachable — the pool's circuit breaker holds
/// that state for around a minute — `redeem` and `revoke` throw, and the `catch` in each
/// `SessionHandler` entry point is the only thing that turns the throw into a frame the client can
/// act on rather than silence that strands it mid-handshake. `DisabledSessionRepository` answers
/// rather than throwing, so it reaches none of them.
private struct FailingSessionRepository: SessionRepository {
    /// Distinguishable from a real database error, so a test asserting on the degraded path cannot
    /// pass on some unrelated throw.
    struct Failure: Error, Equatable {}

    func issue(accountId _: UUID, lifetime _: TimeInterval) async throws -> IssuedSession {
        throw Failure()
    }

    func redeem(token _: String) async throws -> ResolvedSession? {
        throw Failure()
    }

    @discardableResult
    func revoke(token _: String, accountId _: UUID) async throws -> Bool {
        throw Failure()
    }

    @discardableResult
    func deleteExpired(asOf _: Date) async throws -> Int {
        throw Failure()
    }
}
