import Foundation
import Logging
import NIOSSL

/// Production transport-trust anchor. The release build ships its own pinned trust
/// root so a CA compromise (or a corporate proxy a player happens to trust) cannot
/// silently MitM the login flow. The packaging shell rewrites this file alongside
/// `GameplayServerURL.swift` to populate the operator-provided PEM bundle and
/// delete the `#error` directive; both must be done before a release build will
/// compile, satisfying R23's hardcoded-credential guarantee.
///
/// Debug builds skip pinning so loopback `ws://` and developer `wss://` endpoints
/// against staging continue to work without trust-store gymnastics.
enum GameplayServerTrust {
    /// Resolves the production pinning configuration. In debug builds returns `.skipPinning`.
    /// In release builds returns `.pinned(TLSConfiguration)` if the PEM literal parses, or
    /// `.refused(reason)` if the PEM is malformed — that case must propagate as a connect
    /// refusal rather than fall back to system trust.
    enum Resolution {
        case skipPinning
        case pinned(TLSConfiguration)
        case refused(reason: String)
    }

    static func resolve() -> Resolution {
        #if DEBUG
            return .skipPinning
        #else
            do {
                let certificates = try NIOSSLCertificate.fromPEMBytes(Array(gameplayProductionTrustRootPEM.utf8))
                var configuration = TLSConfiguration.makeClientConfiguration()
                configuration.trustRoots = .certificates(certificates)
                configuration.certificateVerification = .fullVerification
                return .pinned(configuration)
            } catch {
                Logger(label: "de.tobiha.somnio.app.transport.pin").error(
                    "production trust-root PEM failed to parse",
                    metadata: ["error": "\(error)"]
                )
                return .refused(reason: "\(error)")
            }
        #endif
    }
}

#if !DEBUG
    #error("Replace gameplayProductionTrustRootPEM in GameplayServerPin.swift with the operator-provided PEM trust root before shipping a release build, alongside the matching gameplayProductionURL in GameplayServerURL.swift.")
    let gameplayProductionTrustRootPEM: String = ""
#endif
