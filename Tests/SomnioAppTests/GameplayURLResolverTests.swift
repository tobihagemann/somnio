import Foundation
import SomnioCore
import Testing
@testable import SomnioApp

struct GameplayURLResolverTests {
    @Test func `debug build with no env var returns the loopback default`() throws {
        let url = try GameplayURLResolver.resolve(environment: [:])
        #expect(url == "ws://127.0.0.1:8080/ws")
    }

    @Test func `loopback override is accepted via env var`() throws {
        // IPv6 hostnames carry literal `[]` brackets per RFC 3986; the bare `::1` form
        // is not a valid URL, so the loopback set is exercised through the textual
        // URLs the client would actually construct.
        for url in [
            "ws://localhost:8080/ws",
            "ws://127.0.0.1:8080/ws",
            "ws://[::1]:8080/ws",
            "wss://localhost:8443/ws",
            "wss://127.0.0.1:8443/ws"
        ] {
            let resolved = try GameplayURLResolver.resolve(environment: ["SOMNIO_SERVER_URL": url])
            #expect(resolved == url)
        }
    }

    @Test func `non-loopback ws is rejected`() {
        #expect(throws: SecureTransportValidationError.insecureRemoteURL) {
            try GameplayURLResolver.resolve(environment: ["SOMNIO_SERVER_URL": "ws://192.0.2.1:8080/ws"])
        }
    }

    @Test func `non-loopback wss override is rejected (env-var injection guard)`() {
        // The debug override is restricted to loopback even for `wss://`. A tampered
        // shell profile or `launchctl setenv` cannot redirect the client to a
        // credential-harvesting remote endpoint.
        #expect(throws: SecureTransportValidationError.insecureRemoteURL) {
            try GameplayURLResolver.resolve(environment: ["SOMNIO_SERVER_URL": "wss://attacker.example/ws"])
        }
    }

    @Test func `uppercase scheme is rejected`() {
        #expect(throws: SecureTransportValidationError.unsupportedScheme) {
            try GameplayURLResolver.resolve(environment: ["SOMNIO_SERVER_URL": "WSS://example.com/ws"])
        }
    }

    @Test func `unsupported scheme is rejected`() {
        #expect(throws: SecureTransportValidationError.unsupportedScheme) {
            try GameplayURLResolver.resolve(environment: ["SOMNIO_SERVER_URL": "http://example.com/ws"])
        }
    }

    @Test func `userinfo in env-var override is rejected`() {
        // The userinfo bypass closes the URL.host vs WebSocketClient parser-disagreement
        // attack.
        #expect(throws: SecureTransportValidationError.userinfoNotAllowed) {
            try GameplayURLResolver.resolve(
                environment: ["SOMNIO_SERVER_URL": "ws://attacker.example:80@localhost/ws"]
            )
        }
    }
}
