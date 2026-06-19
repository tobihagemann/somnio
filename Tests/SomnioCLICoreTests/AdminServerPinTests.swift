import Foundation
import NIOSSL
import Testing
@testable import SomnioCLICore

struct AdminServerPinTests {
    @Test func `debug build returns skipPinning`() {
        // `resolve()` hard-codes `.skipPinning` under `#if DEBUG`. The test suite always
        // runs under DEBUG, so this is the only path callable from tests; the release-only
        // PEM-parse path is covered by the `swift build -c release` smoke check.
        guard case .skipPinning = AdminServerTrust.resolve() else {
            Issue.record("expected .skipPinning in debug build")
            return
        }
    }

    @Test func `pinned configuration parses the committed roots with full verification`() throws {
        let configuration = try AdminServerTrust.makePinnedConfiguration(fromPEM: adminProductionTrustRootPEM)
        #expect(configuration.certificateVerification == .fullVerification)

        let roots = try NIOSSLCertificate.fromPEMBytes(Array(adminProductionTrustRootPEM.utf8))
        #expect(roots.count == 2)
        // Pin the trust anchors explicitly: a dropped `trustRoots =` assignment would leave
        // `.fullVerification` against the system store — the silent downgrade pinning prevents.
        #expect(configuration.trustRoots == .certificates(roots))
    }

    @Test func `makePinnedConfiguration throws on a malformed PEM`() {
        // The throw is the load-bearing seam: in a release build it drives `resolve()`'s
        // fail-closed `.refused` branch. A regression making this non-throwing would
        // silently downgrade to system trust.
        #expect(throws: (any Error).self) {
            try AdminServerTrust.makePinnedConfiguration(fromPEM: "not a certificate")
        }
    }

    @Test func `release resolution pins the committed roots`() {
        // The release path of `resolve()` (untestable in a DEBUG build) delegates here.
        guard case .pinned = AdminServerTrust.resolution(fromPEM: adminProductionTrustRootPEM) else {
            Issue.record("expected .pinned for the committed roots")
            return
        }
    }

    @Test func `release resolution fails closed on a malformed PEM`() {
        // A malformed production PEM must yield `.refused` (which `send` surfaces as
        // `pinningRefused`), never a silent downgrade to system trust.
        guard case .refused = AdminServerTrust.resolution(fromPEM: "not a certificate") else {
            Issue.record("expected .refused for a malformed PEM")
            return
        }
    }

    @Test func `embedded literal matches the committed release-trust-roots pem`() throws {
        let literalCertificates = try NIOSSLCertificate.fromPEMBytes(Array(adminProductionTrustRootPEM.utf8))

        let pemURL = Self.repositoryRoot
            .appendingPathComponent("Scripts")
            .appendingPathComponent("release-trust-roots.pem")
        let pemText = try String(contentsOf: pemURL, encoding: .utf8)
        // Strip the documentation header so only certificate blocks reach the parser,
        // mirroring how `Scripts/inject-release-transport.sh` embeds the player roots.
        let pemBody = pemText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
            .joined(separator: "\n")
        let committedCertificates = try NIOSSLCertificate.fromPEMBytes(Array(pemBody.utf8))

        let literalDER = try literalCertificates.map { try $0.toDERBytes() }
        let committedDER = try committedCertificates.map { try $0.toDERBytes() }
        #expect(literalDER == committedDER)
    }

    /// Repository root, anchored off this file's path so the drift guard finds the
    /// committed `.pem` regardless of the working directory:
    /// `Tests/SomnioCLICoreTests/AdminServerPinTests.swift` → up three components.
    private static let repositoryRoot: URL = .init(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}
