import Foundation
import Testing
@testable import SomnioCore

struct SecureTransportValidatorTests {
    // MARK: - validate

    @Test func `lowercase wss against any host is accepted`() throws {
        try SecureTransportValidator.validate("wss://prod.example.com/ws")
    }

    @Test func `lowercase ws against loopback is accepted`() throws {
        for url in ["ws://localhost:8080/ws", "ws://127.0.0.1:8080/ws", "ws://[::1]:8080/ws"] {
            try SecureTransportValidator.validate(url)
        }
    }

    @Test func `uppercase scheme is rejected`() {
        for url in ["WSS://example.com/ws", "Ws://localhost/", "WS://127.0.0.1/"] {
            #expect(throws: SecureTransportValidationError.unsupportedScheme) {
                try SecureTransportValidator.validate(url)
            }
        }
    }

    @Test func `non-loopback ws is rejected`() {
        #expect(throws: SecureTransportValidationError.insecureRemoteURL) {
            try SecureTransportValidator.validate("ws://192.0.2.1:8080/ws")
        }
    }

    @Test func `unsupported scheme is rejected`() {
        for url in ["http://example.com/", "https://example.com/", "ftp://localhost/"] {
            #expect(throws: SecureTransportValidationError.unsupportedScheme) {
                try SecureTransportValidator.validate(url)
            }
        }
    }

    @Test func `URL with userinfo is rejected outright`() {
        // The exact attack: Foundation's parser reports host == "localhost" so the
        // loopback gate passes, but WebSocketClient dials "attacker.example" and
        // leaks credentials over plaintext. Userinfo rejection forecloses any
        // parser-disagreement variant.
        for url in [
            "ws://attacker.example:80@localhost/ws",
            "wss://user:pass@example.com/ws",
            "ws://user@localhost/ws"
        ] {
            #expect(throws: SecureTransportValidationError.userinfoNotAllowed) {
                try SecureTransportValidator.validate(url)
            }
        }
    }

    @Test func `garbage string is rejected`() {
        #expect(throws: SecureTransportValidationError.invalidURL) {
            try SecureTransportValidator.validate("")
        }
    }

    // MARK: - validateHostAgreement

    @Test(arguments: [
        "ws://localhost:8080/ws", // canonical loopback
        "wss://example.com:8443/ws", // explicit port
        "wss://example.com/ws?x=1" // query preserved by the caller, not rejected here
    ])
    func `host agreement accepts canonical ASCII hosts`(url: String) throws {
        try SecureTransportValidator.validateHostAgreement(url)
    }

    @Test(arguments: [
        "wss://\u{2603}.example/ws", // raw-Unicode/IDN host (snowman)
        "wss://ex%41mple.com/ws", // percent-encoded host
        "ws://[::1]:8080/ws", // bracketed IPv6 literal
        "ws://localhost#evil.com/ws" // fragment: Foundation host `localhost`, dialer host `localhost#evil.com`
    ])
    func `host agreement rejects parser-disagreeing hosts`(url: String) {
        #expect(throws: SecureTransportValidationError.invalidURL) {
            try SecureTransportValidator.validateHostAgreement(url)
        }
    }

    // MARK: - validateLoopbackOnly

    @Test func `loopback override accepts wss to loopback`() throws {
        for url in ["wss://localhost:8443/ws", "wss://127.0.0.1:8443/ws"] {
            try SecureTransportValidator.validateLoopbackOnly(url)
        }
    }

    @Test func `loopback override rejects wss to remote host`() {
        #expect(throws: SecureTransportValidationError.insecureRemoteURL) {
            try SecureTransportValidator.validateLoopbackOnly("wss://attacker.example/ws")
        }
    }

    @Test func `loopback override propagates userinfo rejection from validate`() {
        #expect(throws: SecureTransportValidationError.userinfoNotAllowed) {
            try SecureTransportValidator.validateLoopbackOnly("wss://user@localhost/ws")
        }
    }
}
