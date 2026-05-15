import ArgumentParser
import Foundation
import SomnioCore
import Testing
@testable import SomnioCLICore

struct AdminConnectionResolverTests {
    @Test func `flag wins over the environment for the URL`() throws {
        let resolved = try AdminConnectionResolver.resolve(
            serverURL: "wss://flag.example/admin",
            environment: [
                "SOMNIO_ADMIN_URL": "wss://env.example/admin",
                "SOMNIO_ADMIN_TOKEN": "env-token"
            ]
        )
        #expect(resolved.url == "wss://flag.example/admin")
        #expect(resolved.token == "env-token")
    }

    @Test func `environment supplies both URL and token when no flag is set`() throws {
        let resolved = try AdminConnectionResolver.resolve(
            serverURL: nil,
            environment: [
                "SOMNIO_ADMIN_URL": "wss://env.example/admin",
                "SOMNIO_ADMIN_TOKEN": "env-token"
            ]
        )
        #expect(resolved.url == "wss://env.example/admin")
        #expect(resolved.token == "env-token")
    }

    @Test func `wss URLs are accepted regardless of host`() throws {
        let resolved = try AdminConnectionResolver.resolve(
            serverURL: "wss://prod.example/admin",
            environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
        )
        #expect(resolved.url == "wss://prod.example/admin")
    }

    @Test func `loopback plaintext URLs are accepted`() throws {
        let resolved = try AdminConnectionResolver.resolve(
            serverURL: "ws://127.0.0.1:8080/admin",
            environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
        )
        #expect(resolved.url == "ws://127.0.0.1:8080/admin")
    }

    @Test func `URLs with userinfo are rejected with a ValidationError`() {
        // The userinfo bypass closes the URL.host vs WebSocketClient parser-disagreement
        // attack: Foundation reports `host == "localhost"` for the URL below (passing
        // the loopback gate), but the WebSocket layer would dial `attacker.example`,
        // leaking the bearer token over plaintext.
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "ws://attacker.example:80@localhost/admin",
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
            )
        }
    }

    @Test func `non loopback plaintext URLs are rejected with a ValidationError`() {
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "ws://prod.example/admin",
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
            )
        }
    }

    @Test func `non ws schemes are rejected with a ValidationError`() {
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "http://prod.example/admin",
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
            )
        }
    }

    @Test func `uppercase WSS scheme is rejected to prevent plaintext bearer leakage`() {
        // `URL.scheme` preserves case (`URL(string: "WSS://...")?.scheme == "WSS"`), and
        // the swift-websocket client compares the scheme case-sensitively when deciding
        // whether to enable TLS. The resolver must reject any non-lowercase scheme so a
        // typo can't bypass the guard and ship the bearer header over plain TCP.
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "WSS://prod.example/admin",
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
            )
        }
    }

    @Test func `uppercase WS scheme is rejected for the same reason`() {
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "WS://127.0.0.1:8080/admin",
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"]
            )
        }
    }

    @Test func `debug build falls back to the loopback dev defaults`() throws {
        let resolved = try AdminConnectionResolver.resolve(
            serverURL: nil,
            environment: [:],
            isDebug: true
        )
        #expect(resolved.url == AdminDebugDefaults.websocketURL)
        #expect(resolved.token == AdminDebugDefaults.bearerToken)
    }

    @Test func `release build rejects missing URL with a ValidationError`() {
        // Pinned via `isDebug: false` so the assertion exercises the production guard
        // even when the test target itself was compiled in DEBUG mode.
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: nil,
                environment: ["SOMNIO_ADMIN_TOKEN": "tok"],
                isDebug: false
            )
        }
    }

    @Test func `release build rejects missing token with a ValidationError`() {
        #expect(throws: ValidationError.self) {
            try AdminConnectionResolver.resolve(
                serverURL: "wss://prod.example/admin",
                environment: [:],
                isDebug: false
            )
        }
    }
}
