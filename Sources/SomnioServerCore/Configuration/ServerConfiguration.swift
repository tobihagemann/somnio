import Foundation
import SomnioCore
import SomnioData

/// Runtime configuration for the gameplay server, resolved from process environment variables.
///
/// Mirrors `resolvePostgresConfiguration` in shape: a `static func resolve(environment:isDebug:)`
/// that reads `[String: String]` injected by the caller. Release builds reject missing required
/// values rather than silently falling back to development defaults.
public struct ServerConfiguration: Sendable, Equatable {
    public var httpHost: String
    public var httpPort: Int
    public var adminToken: String
    public var sectorsDirectory: URL
    public var checkpointInterval: Duration
    public var outboxHighWatermark: Int

    public init(
        httpHost: String,
        httpPort: Int,
        adminToken: String,
        sectorsDirectory: URL,
        checkpointInterval: Duration = .seconds(30),
        outboxHighWatermark: Int = 1024
    ) {
        self.httpHost = httpHost
        self.httpPort = httpPort
        self.adminToken = adminToken
        self.sectorsDirectory = sectorsDirectory
        self.checkpointInterval = checkpointInterval
        self.outboxHighWatermark = outboxHighWatermark
    }

    public static let defaultHttpHost: String = "0.0.0.0"
    public static let defaultHttpPort: Int = AdminDebugDefaults.port
    /// Debug-only fallback so a fresh dev clone with no env can still spin up `/admin`. Release
    /// builds require an explicit token via `SOMNIO_ADMIN_TOKEN`. Re-exported from
    /// `SomnioCore.AdminDebugDefaults` so the CLI and server can't silently drift.
    public static let debugAdminToken: String = AdminDebugDefaults.bearerToken
    /// Debug-only fallback resolved against the working directory at boot. Release builds
    /// require `SOMNIO_SECTORS_DIR` so a misconfigured deployment fails closed instead of
    /// loading the bundled test fixtures.
    public static let debugSectorsDirectoryRelativePath: String = "Tests/SomnioMapFixturesTestSupport/MapFixtures"

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isDebug: Bool = isDebugBuild
    ) throws -> ServerConfiguration {
        let httpHost = environment["SOMNIO_HTTP_HOST"] ?? defaultHttpHost
        let httpPort: Int
        if let raw = environment["SOMNIO_HTTP_PORT"] {
            guard let parsed = Int(raw), (1 ... 65535).contains(parsed) else {
                throw ServerStartupError.invalidPort(raw)
            }
            httpPort = parsed
        } else {
            httpPort = defaultHttpPort
        }
        let adminToken: String
        if let token = environment["SOMNIO_ADMIN_TOKEN"], !token.isEmpty {
            adminToken = token
        } else if isDebug {
            adminToken = debugAdminToken
        } else {
            throw ServerStartupError.missingAdminTokenInRelease
        }
        let sectorsDirectory: URL
        if let raw = environment["SOMNIO_SECTORS_DIR"], !raw.isEmpty {
            sectorsDirectory = URL(fileURLWithPath: raw, isDirectory: true)
        } else if isDebug {
            let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            sectorsDirectory = cwd.appendingPathComponent(debugSectorsDirectoryRelativePath, isDirectory: true)
        } else {
            throw ServerStartupError.missingSectorsDirectoryInRelease
        }
        return ServerConfiguration(
            httpHost: httpHost,
            httpPort: httpPort,
            adminToken: adminToken,
            sectorsDirectory: sectorsDirectory
        )
    }
}
