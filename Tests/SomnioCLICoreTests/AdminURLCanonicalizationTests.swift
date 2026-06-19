import Foundation
import Testing
@testable import SomnioCLICore

/// Exercises the `AdminTransport.dialableURL` host-agreement gate that sits between
/// `SecureTransportValidator.validate` and the swift-websocket dial.
struct AdminURLCanonicalizationTests {
    @Test(arguments: [
        // Canonical ASCII hosts: validator and dialer agree, so the gate returns the
        // string verbatim — query, explicit port, and path preserved.
        "ws://localhost:8080/admin", // the live-fixture form, proven to connect
        "wss://example.com:8443/admin", // explicit port
        "wss://example.com/admin?x=1" // query must survive (not piecemeal-rebuilt away)
    ])
    func `returns agreeing URLs unchanged`(rawURL: String) throws {
        #expect(try AdminTransport.dialableURL(rawURL) == rawURL)
    }

    @Test(arguments: [
        // `validate`-passing but host-disagreeing: the swift-websocket parser would see a
        // different host than Foundation validated, so the gate fails closed.
        "wss://\u{2603}.example/admin", // raw-Unicode/IDN host (snowman)
        "wss://ex%41mple.com/admin", // percent-encoded host
        "ws://[::1]:8080/admin", // bracketed IPv6 literal — un-dialable by the parser anyway
        "ws://localhost#evil.com/admin" // fragment: Foundation host `localhost`, dialer host `localhost#evil.com`
    ])
    func `rejects host-disagreeing URLs`(rawURL: String) {
        do {
            let result = try AdminTransport.dialableURL(rawURL)
            Issue.record("expected rejection of \(rawURL), got \(result)")
        } catch let AdminTransportError.invalidTransportURL(reason) {
            #expect(reason == .invalidURL)
        } catch {
            Issue.record("expected invalidTransportURL(.invalidURL), got \(error)")
        }
    }
}
