import ArgumentParser
import Foundation
import Testing
@testable import SomnioCLICore

/// Parse-only routing tests for the admin CLI command tree. Uses `parseAsRoot(_:)` so we
/// can assert which subcommand each argv slice resolves to and which arguments it
/// captures, without spawning the network transport or a subprocess. The actual transport
/// + render path is covered by `AdminTransportTests` and `AdminOutputTests`.
struct SomnioCLIToolRoutingTests {
    @Test func `argument-less verbs resolve to their commands`() throws {
        try assertParses(arguments: ["log"], as: SomnioCLITool.Log.self)
        try assertParses(arguments: ["weblog"], as: SomnioCLITool.Weblog.self)
        try assertParses(arguments: ["players"], as: SomnioCLITool.Players.self)
        try assertParses(arguments: ["time"], as: SomnioCLITool.Time.self)
        try assertParses(arguments: ["version"], as: SomnioCLITool.Version.self)
    }

    @Test func `log rm and weblog rm route to their delete subcommands`() throws {
        try assertParses(arguments: ["log", "rm"], as: SomnioCLITool.LogRemove.self)
        try assertParses(arguments: ["weblog", "rm"], as: SomnioCLITool.WeblogRemove.self)
    }

    @Test func `say joins variadic arguments and exposes the message tokens`() throws {
        let parsed = try parse(["say", "hello", "world"], as: SomnioCLITool.Say.self)
        #expect(parsed.message == ["hello", "world"])
    }

    @Test func `say without arguments parses to an empty message list`() throws {
        let parsed = try parse(["say"], as: SomnioCLITool.Say.self)
        #expect(parsed.message.isEmpty)
    }

    @Test func `kick captures the name positional argument`() throws {
        let parsed = try parse(["kick", "Saibot"], as: SomnioCLITool.Kick.self)
        #expect(parsed.name == "Saibot")
    }

    @Test func `kick without a name argument fails to parse`() {
        #expect(throws: (any Error).self) {
            _ = try SomnioCLITool.parseAsRoot(["kick"])
        }
    }

    @Test func `unrecognized verb is rejected by ArgumentParser`() {
        #expect(throws: (any Error).self) {
            _ = try SomnioCLITool.parseAsRoot(["totally-bogus"])
        }
    }

    // MARK: - Helpers

    private func assertParses<T: ParsableCommand>(arguments: [String], as type: T.Type, sourceLocation: SourceLocation = #_sourceLocation) throws {
        let command = try SomnioCLITool.parseAsRoot(arguments)
        #expect(command is T, "expected \(T.self), got \(Swift.type(of: command))", sourceLocation: sourceLocation)
    }

    private func parse<T: ParsableCommand>(_ arguments: [String], as type: T.Type) throws -> T {
        let command = try SomnioCLITool.parseAsRoot(arguments)
        guard let typed = command as? T else {
            throw ParseError.wrongType(expected: T.self, got: Swift.type(of: command))
        }
        return typed
    }

    enum ParseError: Error {
        case wrongType(expected: Any.Type, got: Any.Type)
    }
}
