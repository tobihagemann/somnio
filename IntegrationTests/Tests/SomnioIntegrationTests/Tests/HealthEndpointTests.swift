import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import Logging
import NIOCore
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct HealthEndpointTests {
    @Test func `health returns 200 ok when database is reachable`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.health.up")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await testClient.execute(uri: "/health", method: .get) { response in
                    #expect(response.status == .ok)
                    let body = try JSONDecoder().decode([String: String].self, from: Data(buffer: response.body))
                    #expect(body["status"] == "ok")
                    #expect(body["db"] == "ok")
                }
            }
        }
    }

    @Test func `health returns 503 degraded when database is unreachable`() async {
        let logger = Logger(label: "test.health.down")
        // Port 1 is reserved (TCPMUX); dialing it fails fast on every platform. The 1 s
        // per-dial timeout on the pool keeps the eventual failure inside the test's 5 s
        // probe budget even when the pool's exponential backoff kicks in.
        var configuration = PostgresClient.Configuration(
            host: "127.0.0.1",
            port: 1,
            username: "ignored",
            password: "ignored",
            database: "ignored",
            tls: .disable
        )
        configuration.options.connectTimeout = .seconds(1)
        let unreachableClient = PostgresClient(configuration: configuration, backgroundLogger: logger)

        await withTaskGroup(of: Void.self) { group in
            group.addTask { await unreachableClient.run() }
            await runDegradedProbe(client: unreachableClient, logger: logger)
            group.cancelAll()
        }
    }

    // MARK: - Helpers

    private func runDegradedProbe(client: PostgresClient, logger: Logger) async {
        do {
            let connectionDependencies = try await makeStubConnectionDependencies(logger: logger)
            let adminDependencies = try await makeStubAdminDependencies(
                worldRouter: connectionDependencies.worldRouter,
                worldClock: connectionDependencies.worldClock,
                logger: logger
            )
            let application = makeSomnioServerApplication(
                configuration: connectionDependencies.configuration,
                postgres: client,
                dependencies: connectionDependencies,
                adminDependencies: adminDependencies
            )
            try await application.test(.live) { testClient in
                // PostgresNIO 1.21+'s pool retries failed dials with exponential backoff
                // before tripping the circuit breaker and surfacing the failure to the
                // `/health` handler. The full retry budget runs ~60 s wall-clock on a local
                // docker-compatible runtime — far past `HummingbirdTesting`'s hardcoded
                // 20 s `LiveTestFramework` read timeout — so the probe runs through a
                // `URLSession` request whose `timeoutInterval` can be lifted to 120 s.
                let port = try #require(testClient.port)
                await runProbe(port: port)
            }
        } catch {
            Issue.record("degraded /health probe setup threw: \(error)")
        }
    }

    private func runProbe(port: Int) async {
        guard let url = URL(string: "http://localhost:\(port)/health") else {
            Issue.record("could not build /health URL for port \(port)")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 120
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let httpResponse = try #require(response as? HTTPURLResponse)
            #expect(httpResponse.statusCode == 503)
            let body = try JSONDecoder().decode([String: String].self, from: data)
            #expect(body["status"] == "degraded")
            #expect(body["db"] == "unreachable")
        } catch {
            Issue.record("/health probe threw: \(error)")
        }
    }

    private func makeStubConnectionDependencies(logger: Logger) async throws -> ConnectionDependencies {
        let worldRouter = try await WorldRouter(
            sectors: [:],
            characters: IntegrationStubCharacterRepository(),
            npcDialogStates: IntegrationStubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClock = WorldClockService(
            worldRouter: worldRouter,
            worldClocks: IntegrationStubWorldClockRepository(),
            initialClock: .bootDefault,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: IntegrationStubAccountRepository(),
            characters: IntegrationStubCharacterRepository(),
            inventories: IntegrationStubInventoryRepository(),
            registrations: IntegrationStubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: worldRouter,
            worldClock: worldClock,
            configuration: ServerConfiguration(
                httpHost: "127.0.0.1",
                httpPort: 0,
                adminToken: "test",
                sectorsDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
            ),
            logger: logger
        )
    }

    private func makeStubAdminDependencies(
        worldRouter: WorldRouter,
        worldClock: WorldClockService,
        logger: Logger
    ) async throws -> AdminConnectionDependencies {
        let logsDirectory = FileManager.default
            .temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        return AdminConnectionDependencies(
            worldRouter: worldRouter as any AdminWorldRouter,
            worldClock: worldClock,
            serverVersion: "test-version",
            logsDirectory: logsDirectory,
            gameplayLogFileName: "gameplay-log.log",
            adminLogFileName: "admin-log.log",
            logger: logger
        )
    }
}
