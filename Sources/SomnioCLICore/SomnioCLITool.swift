import ArgumentParser
import Foundation
import Logging
import SomnioCore
import SomnioProtocol

/// Top-level admin CLI command. Subcommands run a single authenticated request/response
/// round-trip against the gameplay server's `/admin` WebSocket and print the localized
/// response to stdout.
///
/// The `@available` annotation is required by `AsyncParsableCommand.main()` at runtime —
/// without it the binary aborts before parsing any argument.
@available(macOS 10.15, macCatalyst 13, iOS 13, tvOS 13, watchOS 6, *)
public struct SomnioCLITool: AsyncParsableCommand {
    public static let configuration = CommandConfiguration(
        commandName: "somniocli",
        abstract: "Somnio admin CLI.",
        subcommands: [
            Log.self,
            Weblog.self,
            Players.self,
            Time.self,
            Say.self,
            Kick.self,
            Version.self
        ]
    )

    public init() {}
}

// MARK: - Shared options

struct AdminConnectionOptions: ParsableArguments {
    @Option(name: .customLong("server-url"), help: "Admin WebSocket URL (env: SOMNIO_ADMIN_URL).")
    var serverURL: String?
}

enum AdminConnectionResolver {
    static func resolve(
        serverURL: String?,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isDebug: Bool = cliIsDebugBuild
    ) throws -> (url: String, token: String) {
        let resolvedURL = serverURL ?? environment["SOMNIO_ADMIN_URL"] ?? (isDebug ? AdminDebugDefaults.websocketURL : nil)
        let resolvedToken = environment["SOMNIO_ADMIN_TOKEN"] ?? (isDebug ? AdminDebugDefaults.bearerToken : nil)

        guard let url = resolvedURL else {
            throw ValidationError("--server-url is required (or set SOMNIO_ADMIN_URL).")
        }
        guard let token = resolvedToken else {
            throw ValidationError("SOMNIO_ADMIN_TOKEN environment variable is required.")
        }
        do {
            try SecureTransportValidator.validate(url)
        } catch SecureTransportValidationError.invalidURL {
            throw ValidationError("--server-url is not a valid URL.")
        } catch SecureTransportValidationError.unsupportedScheme {
            throw ValidationError("--server-url must use the ws:// or wss:// scheme (lowercase).")
        } catch SecureTransportValidationError.insecureRemoteURL {
            throw ValidationError(
                "Refusing to send the admin token over plaintext ws://. Use wss:// for remote endpoints."
            )
        } catch SecureTransportValidationError.userinfoNotAllowed {
            throw ValidationError(
                "--server-url must not embed user:password@host. Pass the bearer token via SOMNIO_ADMIN_TOKEN."
            )
        }
        return (url, token)
    }
}

/// Compile-time DEBUG flag exposed as a runtime value so `AdminConnectionResolver.resolve`
/// can be tested with `isDebug: false` even when the test suite itself runs under DEBUG.
let cliIsDebugBuild: Bool = {
    #if DEBUG
        return true
    #else
        return false
    #endif
}()

// MARK: - Per-verb execution

private func runVerb(
    _ request: AdminRequest,
    connection: AdminConnectionOptions
) async throws {
    LoggingConfiguration.bootstrap()
    let logger = Logger(label: "de.tobiha.somnio.cli.admin")
    let resolved = try AdminConnectionResolver.resolve(serverURL: connection.serverURL)
    do {
        let response = try await AdminTransport.send(
            request,
            to: resolved.url,
            token: resolved.token,
            logger: logger
        )
        print(AdminOutput.render(response))
    } catch {
        print(
            String(format: L.string("The error %@ occurred."), "\(error)")
        )
        throw ExitCode.failure
    }
}

// MARK: - Subcommands

extension SomnioCLITool {
    struct Log: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "log",
            abstract: "Read the gameplay log.",
            subcommands: [LogRemove.self]
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.log, connection: connection)
        }
    }

    struct LogRemove: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "rm",
            abstract: "Delete the gameplay log."
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.logRemove, connection: connection)
        }
    }

    struct Weblog: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "weblog",
            abstract: "Read the admin log.",
            subcommands: [WeblogRemove.self]
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.weblog, connection: connection)
        }
    }

    struct WeblogRemove: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "rm",
            abstract: "Delete the admin log."
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.weblogRemove, connection: connection)
        }
    }

    struct Players: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "players",
            abstract: "Show the number of logged-in players."
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.players, connection: connection)
        }
    }

    struct Time: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "time",
            abstract: "Show the in-game world clock."
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.time, connection: connection)
        }
    }

    struct Say: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "say",
            abstract: "Broadcast a message to every logged-in player."
        )

        @OptionGroup var connection: AdminConnectionOptions
        @Argument var message: [String] = []

        func run() async throws {
            let joined = message.joined(separator: " ")
            // Empty message is a no-op with no echo: the wire-protocol's empty-say handler
            // returns no response, so short-circuiting here avoids opening a connection only
            // to wait for a frame that never arrives.
            guard !joined.isEmpty else { return }
            try await runVerb(.say(text: joined), connection: connection)
        }
    }

    struct Kick: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "kick",
            abstract: "Disconnect a character by name."
        )

        @OptionGroup var connection: AdminConnectionOptions
        @Argument var name: String

        func run() async throws {
            try await runVerb(.kick(name: name), connection: connection)
        }
    }

    struct Version: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "version",
            abstract: "Show the server version."
        )

        @OptionGroup var connection: AdminConnectionOptions

        func run() async throws {
            try await runVerb(.version, connection: connection)
        }
    }
}
