import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct LoginRegisterHandlerTests {
    @Test func `register success enqueues registerResult ok`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            let actor = ConnectionActor(dependencies: dependencies)
            let outbox = await actor.connectionOutbox

            await RegisterHandler.handle(
                RegisterMessage(
                    nickname: "newcomer",
                    password: "secret-pass",
                    passwordRepeat: "secret-pass",
                    characterClass: CharacterClass.fighter.rawValue,
                    gender: Gender.male.rawValue,
                    email: "newcomer@example.com"
                ),
                on: actor,
                dependencies: dependencies
            )
            outbox.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
            #expect(!frames.isEmpty)
            try IntegrationTestFixtures.expectLastRegisterResult(.ok, in: frames)
        }
    }

    @Test func `register fails when password repeat does not match`() async throws {
        try await TestHarness.withDatabase { client in
            try await runRegisterFailure(
                client: client,
                nickname: "alice",
                password: "passwordA",
                passwordRepeat: "passwordB",
                email: "alice@example.com"
            )
        }
    }

    @Test func `register fails when password is shorter than the minimum`() async throws {
        try await TestHarness.withDatabase { client in
            try await runRegisterFailure(
                client: client,
                nickname: "shorty",
                password: "abc",
                passwordRepeat: "abc",
                email: "shorty@example.com"
            )
        }
    }

    @Test func `duplicate nickname through the handler maps to nicknameExists`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            let actorA = ConnectionActor(dependencies: dependencies)
            let actorB = ConnectionActor(dependencies: dependencies)

            await RegisterHandler.handle(
                makeRegister(nickname: "duplicate", email: "first@example.com"),
                on: actorA,
                dependencies: dependencies
            )

            let outboxB = await actorB.connectionOutbox
            await RegisterHandler.handle(
                makeRegister(nickname: "DUPLICATE", email: "second@example.com"),
                on: actorB,
                dependencies: dependencies
            )
            outboxB.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outboxB)
            try IntegrationTestFixtures.expectLastRegisterResult(.nicknameExists, in: frames)
        }
    }

    @Test func `login success streams the join sequence`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            try await registerLoginUser(dependencies: dependencies)

            let loginActor = ConnectionActor(dependencies: dependencies)
            let outbox = await loginActor.connectionOutbox
            await LoginHandler.handle(
                LoginMessage(nickname: "loginuser", password: "passw0rd"),
                on: loginActor,
                dependencies: dependencies
            )
            outbox.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
            #expect(frames.count >= 5)
            let messages = try frames.map { try SomnioMessageDecoder.decode($0) }
            if case let .loginResult(result) = messages.first {
                #expect(result.result == .ok)
            } else {
                Issue.record("expected loginResult.ok first")
            }
            let tags = messages.map(\.tag)
            #expect(tags.contains(.enterSector))
            #expect(tags.contains(.mainCharacter))
            #expect(tags.contains(.inventory))
            #expect(tags.contains(.energy))
        }
    }

    @Test func `login with unknown nickname returns badCredentials`() async throws {
        try await TestHarness.withDatabase { client in
            try await runLoginFailure(
                client: client,
                nickname: "ghost",
                password: "passw0rd"
            )
        }
    }

    @Test func `login with wrong password for an existing account returns badCredentials`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            try await registerLoginUser(dependencies: dependencies)

            let actor = ConnectionActor(dependencies: dependencies)
            let outbox = await actor.connectionOutbox
            await LoginHandler.handle(
                LoginMessage(nickname: "loginuser", password: "wrongpass"),
                on: actor,
                dependencies: dependencies
            )
            outbox.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
            try IntegrationTestFixtures.expectLastLoginResult(.badCredentials, in: frames)
        }
    }

    @Test func `second login for the same account returns alreadyLoggedIn`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            try await registerLoginUser(dependencies: dependencies)

            let firstActor = ConnectionActor(dependencies: dependencies)
            await LoginHandler.handle(
                LoginMessage(nickname: "loginuser", password: "passw0rd"),
                on: firstActor,
                dependencies: dependencies
            )

            let secondActor = ConnectionActor(dependencies: dependencies)
            let outbox = await secondActor.connectionOutbox
            await LoginHandler.handle(
                LoginMessage(nickname: "loginuser", password: "passw0rd"),
                on: secondActor,
                dependencies: dependencies
            )
            outbox.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
            try IntegrationTestFixtures.expectLastLoginResult(.alreadyLoggedIn, in: frames)
        }
    }

    @Test func `register fails when nickname exceeds the identifier length cap`() async throws {
        try await TestHarness.withDatabase { client in
            let oversized = String(repeating: "a", count: RegisterHandler.maxIdentifierLength + 1)
            try await runRegisterFailure(
                client: client,
                nickname: oversized,
                password: "passw0rd",
                passwordRepeat: "passw0rd",
                email: "long@example.com"
            )
        }
    }

    @Test func `register fails when email exceeds the identifier length cap`() async throws {
        try await TestHarness.withDatabase { client in
            let oversized = String(repeating: "a", count: RegisterHandler.maxIdentifierLength + 1)
            try await runRegisterFailure(
                client: client,
                nickname: "longemail",
                password: "passw0rd",
                passwordRepeat: "passw0rd",
                email: oversized
            )
        }
    }

    @Test func `login fails when password exceeds the maximum length`() async throws {
        try await TestHarness.withDatabase { client in
            let oversized = String(repeating: "x", count: LoginHandler.maxPasswordLength + 1)
            try await runLoginFailure(
                client: client,
                nickname: "ghost",
                password: oversized
            )
        }
    }

    @Test func `login fails when nickname exceeds the maximum length`() async throws {
        try await TestHarness.withDatabase { client in
            let oversized = String(repeating: "n", count: LoginHandler.maxNicknameLength + 1)
            try await runLoginFailure(
                client: client,
                nickname: oversized,
                password: "passw0rd"
            )
        }
    }

    @Test func `register with malformed class raw returns failure`() async throws {
        try await TestHarness.withDatabase { client in
            let dependencies = try makeDependencies(client: client)
            let actor = ConnectionActor(dependencies: dependencies)
            let outbox = await actor.connectionOutbox

            await RegisterHandler.handle(
                RegisterMessage(
                    nickname: "malformed-class",
                    password: "passw0rd",
                    passwordRepeat: "passw0rd",
                    characterClass: 99,
                    gender: Gender.male.rawValue,
                    email: "m@example.com"
                ),
                on: actor,
                dependencies: dependencies
            )
            outbox.finish()

            let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
            try IntegrationTestFixtures.expectLastRegisterResult(.failure, in: frames)
        }
    }

    // MARK: - Helpers

    private func makeDependencies(client: PostgresClient) throws -> ConnectionDependencies {
        let logger = Logger(label: "test.login-register-handler")
        return try IntegrationTestFixtures.makeConnectionDependencies(
            client: client,
            sectors: IntegrationTestFixtures.defaultSectors(),
            logger: logger
        )
    }

    private func registerLoginUser(dependencies: ConnectionDependencies) async throws {
        let registrationActor = ConnectionActor(dependencies: dependencies)
        await RegisterHandler.handle(
            RegisterMessage(
                nickname: "loginuser",
                password: "passw0rd",
                passwordRepeat: "passw0rd",
                characterClass: CharacterClass.fighter.rawValue,
                gender: Gender.female.rawValue,
                email: "loginuser@example.com"
            ),
            on: registrationActor,
            dependencies: dependencies
        )
    }

    private func runRegisterFailure(
        client: PostgresClient,
        nickname: String,
        password: String,
        passwordRepeat: String,
        email: String
    ) async throws {
        let dependencies = try makeDependencies(client: client)
        let actor = ConnectionActor(dependencies: dependencies)
        let outbox = await actor.connectionOutbox

        await RegisterHandler.handle(
            RegisterMessage(
                nickname: nickname,
                password: password,
                passwordRepeat: passwordRepeat,
                characterClass: CharacterClass.fighter.rawValue,
                gender: Gender.male.rawValue,
                email: email
            ),
            on: actor,
            dependencies: dependencies
        )
        outbox.finish()
        let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
        try IntegrationTestFixtures.expectLastRegisterResult(.failure, in: frames)
    }

    private func runLoginFailure(client: PostgresClient, nickname: String, password: String) async throws {
        let dependencies = try makeDependencies(client: client)
        let actor = ConnectionActor(dependencies: dependencies)
        let outbox = await actor.connectionOutbox

        await LoginHandler.handle(
            LoginMessage(nickname: nickname, password: password),
            on: actor,
            dependencies: dependencies
        )
        outbox.finish()
        let frames = await IntegrationTestFixtures.collectFrames(from: outbox)
        try IntegrationTestFixtures.expectLastLoginResult(.badCredentials, in: frames)
    }

    private func makeRegister(nickname: String, email: String) -> RegisterMessage {
        RegisterMessage(
            nickname: nickname,
            password: "passw0rd",
            passwordRepeat: "passw0rd",
            characterClass: CharacterClass.fighter.rawValue,
            gender: Gender.male.rawValue,
            email: email
        )
    }
}
